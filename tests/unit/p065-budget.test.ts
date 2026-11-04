import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CallBudget, CallBudgetExpired } from '../../src/ledger/call-budget.js';
import { Ledger, LedgerCommitUncertain, LedgerCleanupFailed } from '../../src/ledger/ledger.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { budgetFixture, TestBudgetClock } from './p065-budget-fixture.js';
import { existsSync } from 'node:fs';
import { p065SupervisorSeed, p065WorkloadFixture } from './p065-budget-fixture.js';
import { readContext, readEvents, readEvidence, readLink, readRun, refValue } from '../../src/ledger/records.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { taskDigest } from '../../src/core/lifecycle.js';
import { hashClaim } from './b45-handshake-fixture.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';

for (const elapsed of [29.999, 30, 30.001])
  test(`P065 original boundary ${elapsed} ms; zero remains intentional only for numeric API`, async () => {
    const f = await budgetFixture();
    try {
      const b = f.clock.budget();
      f.clock.advance(elapsed);
      let calls = 0;
      const operation = f.ledger.transaction(() => ++calls, b);
      if (elapsed < 30) assert.equal(await operation, 1);
      else {
        await assert.rejects(operation, CallBudgetExpired);
        assert.equal(calls, 0);
      }
      assert.equal(await f.ledger.transaction(() => 'legacy nonblocking', 0), 'legacy nonblocking');
    } finally {
      await f.close();
    }
  });

test('P065 earlier trusted cap tightens without reset; unknown timing adds nothing', () => {
  const clock = new TestBudgetClock(),
    b = clock.budget();
  clock.advance(7);
  b.tighten(25);
  b.tighten(1000);
  assert.equal(b.remaining(), 18);
  clock.advance(18);
  assert.throws(() => b.check(), CallBudgetExpired);
  const unknown = clock.budget();
  assert.equal(unknown.diagnostics().enclosingDeadline, 'unavailable');
  assert.equal(unknown.remaining(), 30);
  assert.throws(() => new CallBudget(clock, clock.time + 1), /invalid_budget_clock/);
});

test('P065 acquire-await handoff owns cleanup before a queued expiry', async () => {
  const f = await budgetFixture();
  try {
    let callbacks = 0,
      rollback = 0;
    f.db.exec = (sql: string) => {
      f.exec(sql);
      if (sql === 'BEGIN IMMEDIATE') queueMicrotask(() => f.clock.advance(30));
      if (sql === 'ROLLBACK') rollback++;
    };
    await assert.rejects(
      f.ledger.transaction(() => callbacks++, f.clock.budget()),
      CallBudgetExpired
    );
    assert.equal(callbacks, 0);
    assert.equal(rollback, 1);
    const other = new DatabaseSync(f.file);
    other.exec('BEGIN IMMEDIATE; ROLLBACK');
    other.close();
  } finally {
    await f.close();
  }
});

test('P065 queued expiry never enters the protected callback', async () => {
  const f = await budgetFixture();
  try {
    const blocker = new DatabaseSync(f.file);
    blocker.exec('BEGIN IMMEDIATE');
    const first = f.ledger.transaction(() => 1);
    let called = false;
    const second = f.ledger.transaction(() => {
      called = true;
    }, f.clock.budget());
    f.clock.advance(31);
    blocker.exec('ROLLBACK');
    blocker.close();
    await first;
    await assert.rejects(second, CallBudgetExpired);
    assert.equal(called, false);
  } finally {
    await f.close();
  }
});

test('P065 one cumulative contention allowance across transactions, actual oversleep retained', async () => {
  const f = await budgetFixture();
  try {
    const blocker = new DatabaseSync(f.file);
    blocker.exec('BEGIN IMMEDIATE');
    const b = f.clock.budget();
    f.clock.sleepExtra = 25;
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('body'), b),
      CallBudgetExpired
    );
    assert.equal(b.diagnostics().waitMs, 26);
    blocker.exec('ROLLBACK');
    blocker.close();
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('reset allowance'), b),
      CallBudgetExpired
    );
    assert.equal(b.diagnostics().attempts, 1);
  } finally {
    await f.close();
  }
});

test('P065 preparation is charged to 30 ms, not mislabeled as lock waiting', async () => {
  const f = await budgetFixture();
  try {
    const b = f.clock.budget();
    f.clock.advance(29);
    await f.ledger.transaction(() => 1, b);
    assert.equal(b.diagnostics().waitMs, 0);
    f.clock.advance(1);
    await assert.rejects(
      f.ledger.transaction(() => 2, b),
      CallBudgetExpired
    );
  } finally {
    await f.close();
  }
});

test('P065 fresh intent expiry rolls back every requested row and acceptance event', async () => {
  const f = await budgetFixture();
  try {
    const b = f.clock.budget();
    await assert.rejects(
      acceptIntent(f.ledger, f.input, b, undefined, {}, () => f.clock.advance(30)),
      CallBudgetExpired
    );
    for (const table of ['runs', 'links', 'claims', 'slots', 'idempotency', 'events'])
      assert.equal(f.count(table), 0, table);
  } finally {
    await f.close();
  }
});

test('P065 authorized canonical replay survives late lookup, rolls back incidental work and bypasses new admission', async () => {
  const f = await budgetFixture();
  try {
    const original = await acceptIntent(f.ledger, f.input);
    const base = f.ledger.transaction.bind(f.ledger);
    f.ledger.transaction = (callback, budget) =>
      base((tx) => {
        const result = callback(tx);
        if (tx.isPriorDurableResult(result)) {
          tx.run('UPDATE callers SET last_seen_at=12345');
          f.clock.advance(31);
        }
        return result;
      }, budget);
    const b = f.clock.budget();
    const replay = await acceptIntent(f.ledger, { ...f.input, capabilityVerified: false }, b, undefined, {
      maxActiveRunsPerOwner: 1,
      maxActiveRuns: 1,
    });
    assert.deepEqual(replay, { ...original, replayed: true });
    assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
    assert.equal(f.count('runs'), 1);
    assert.equal(f.count('idempotency'), 1);
    assert.equal(f.count('events'), 1);
    assert.equal(b.diagnostics().overrunMs, 1);
  } finally {
    await f.close();
  }
});

test('P065 marker cannot preserve a newly written row or rescue a failing/thenable callback', async () => {
  const f = await budgetFixture();
  try {
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.get('UPDATE callers SET last_seen_at=2 RETURNING caller_id');
        return tx.priorDurableResult({ ok: true });
      }, f.clock.budget()),
      /prior_result_depends_on_transaction/
    );
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.priorDurableResult({ ok: true });
        throw new Error('after_marker');
      }, f.clock.budget()),
      /after_marker/
    );
    await assert.rejects(
      f.ledger.transaction((tx) => tx.priorDurableResult(Promise.resolve(1)), f.clock.budget()),
      /must_be_synchronous/
    );
    assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
  } finally {
    await f.close();
  }
});

test('P065 even a falsy callback exception rolls back and cannot return a marker', async () => {
  const f = await budgetFixture();
  try {
    for (const failure of [undefined, null, false, 0, '']) {
      let rejected = false;
      try {
        await f.ledger.transaction((tx) => {
          tx.priorDurableResult({ ok: true });
          tx.run('UPDATE callers SET last_seen_at=77');
          throw failure;
        }, f.clock.budget());
      } catch (error) {
        rejected = true;
        assert.equal(error, failure);
      }
      assert.equal(rejected, true);
      assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
    }
  } finally {
    await f.close();
  }
});

test('P065 successful-late COMMIT preserves result and is never rolled back', async () => {
  const f = await budgetFixture();
  try {
    let rollbacks = 0;
    f.db.exec = (sql: string) => {
      f.exec(sql);
      if (sql === 'COMMIT') f.clock.advance(31);
      if (sql === 'ROLLBACK') rollbacks++;
    };
    const b = f.clock.budget();
    const result = await acceptIntent(f.ledger, f.input, b);
    assert.equal(result.replayed, false);
    assert.equal(f.count('runs'), 1);
    assert.equal(rollbacks, 0);
    assert.equal(b.diagnostics().overrunMs, 1);
    f.db.exec = f.exec;
    assert.equal((await acceptIntent(f.ledger, f.input, f.clock.budget())).replayed, true);
  } finally {
    await f.close();
  }
});

for (const committed of [false, true])
  test(`P065 COMMIT acknowledgement failure committed=${committed} is uncertain, never busy/audited/retried`, async () => {
    const f = await budgetFixture();
    try {
      let commits = 0;
      f.db.exec = (sql: string) => {
        if (sql === 'COMMIT') {
          commits++;
          if (committed) f.exec(sql);
          throw new Error('SQLITE_BUSY acknowledgement lost');
        }
        f.exec(sql);
      };
      await assert.rejects(acceptIntent(f.ledger, f.input, f.clock.budget()), LedgerCommitUncertain);
      assert.equal(commits, 1);
      const db = new DatabaseSync(f.file),
        fresh = new Ledger(db, f.ledger.ledgerId, 20);
      try {
        assert.equal(Number(db.prepare("SELECT count(*) AS n FROM events WHERE kind='intent.rejected'").get()!.n), 0);
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n), committed ? 1 : 0);
        const result = await acceptIntent(fresh, f.input, f.clock.budget());
        assert.equal(result.replayed, committed);
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n), 1);
      } finally {
        await fresh.close();
      }
    } finally {
      await f.close();
    }
  });

test('P065 rollback failure isolates connection and cannot masquerade as clean budget refusal', async () => {
  const f = await budgetFixture();
  try {
    f.db.exec = (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback_fault');
      f.exec(sql);
    };
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.run('UPDATE callers SET last_seen_at=7');
        f.clock.advance(31);
      }, f.clock.budget()),
      LedgerCleanupFailed
    );
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('dirty reuse')),
      /ledger_closed/
    );
    const other = new DatabaseSync(f.file);
    assert.equal(other.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
    other.close();
  } finally {
    await f.close();
  }
});

test('P065 known prior result survives incidental rollback failure only with connection isolation', async () => {
  const f = await budgetFixture();
  try {
    f.db.exec = (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback_fault');
      f.exec(sql);
    };
    const prior = { id: 'already-durable' };
    assert.equal(
      await f.ledger.transaction((tx) => {
        const result = tx.priorDurableResult(prior);
        tx.run('UPDATE callers SET last_seen_at=8');
        return result;
      }, f.clock.budget()),
      prior
    );
    await assert.rejects(
      f.ledger.transaction(() => 1),
      /ledger_closed/
    );
  } finally {
    await f.close();
  }
});

test('P065 earlier committed transaction and later writer share cumulative waiting without resetting 20 ms', async () => {
  const f = await budgetFixture();
  const blocker = new DatabaseSync(f.file);
  try {
    const b = f.clock.budget();
    blocker.exec('BEGIN IMMEDIATE');
    f.clock.sleep = async (ms) => {
      f.clock.advance(ms);
      if (f.clock.time >= 7) blocker.exec('ROLLBACK');
    };
    await f.ledger.transaction((tx) => tx.run('UPDATE callers SET last_seen_at=1001'), b);
    assert.equal(b.diagnostics().waitMs, 7);
    blocker.exec('BEGIN IMMEDIATE');
    f.clock.sleep = async (ms) => {
      f.clock.advance(ms);
    };
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('late operation body'), b),
      /ledger_busy|Ledger busy/
    );
    assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1001);
    assert.ok(b.diagnostics().waitMs <= 20);
    assert.ok(b.diagnostics().waitMs >= 14);
    blocker.exec('ROLLBACK');
  } finally {
    blocker.close();
    await f.close();
  }
});

test('P065 bounded diagnostics retain phase totals and mandatory rollback overrun', async () => {
  const f = await budgetFixture();
  try {
    const b = f.clock.budget();
    for (let n = 0; n < 100; n++) b.note('prepare');
    f.db.exec = (sql: string) => {
      f.exec(sql);
      if (sql === 'ROLLBACK') f.clock.advance(5);
    };
    await assert.rejects(
      f.ledger.transaction(() => {
        f.clock.advance(30);
      }, b),
      CallBudgetExpired
    );
    const d = b.diagnostics();
    assert.equal(d.phases.length, 64);
    assert.equal(d.phaseCounts.prepare, 100);
    assert.equal(d.phaseMs.rollback, 5);
    assert.equal(d.authorizationMs, 35);
    assert.equal(d.overrunMs, 5);
  } finally {
    await f.close();
  }
});

for (const method of ['run', 'get', 'all'] as const)
  test(`P065 ${method} counted mutation cannot create durable-result eligibility`, async () => {
    const f = await budgetFixture();
    try {
      await assert.rejects(
        f.ledger.transaction((tx) => {
          tx[method]('UPDATE callers SET last_seen_at=2 RETURNING caller_id');
          return tx.priorDurableResult({ ok: true });
        }, f.clock.budget()),
        /prior_result_depends_on_transaction/
      );
      assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
    } finally {
      await f.close();
    }
  });

test('P065 a different returned object cannot inherit an earlier durable marker', async () => {
  const f = await budgetFixture();
  try {
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.priorDurableResult({ ok: true });
        tx.run('UPDATE callers SET last_seen_at=2');
        f.clock.advance(31);
        return { ok: true };
      }, f.clock.budget()),
      CallBudgetExpired
    );
    assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
  } finally {
    await f.close();
  }
});

/** Construction/invariant checks only, not framed MCP or latency qualification. */
for (const [h, r] of [
  [1, 1],
  [2, 10],
] as const)
  for (const tool of [
    'delegate_status',
    'delegate_spawn',
    'delegate_resume',
    'delegate_cancel',
    'delegate_whoami',
    'delegate_report',
  ])
    test(`P065 workload fixture H=${h} R=${r} ${tool}`, { concurrency: false }, async (t) => {
      const { DelegationService } = await import('../../packages/hud-mcp/src/delegation.js');
      const close = DelegationService.prototype.close;
      const closed: InstanceType<typeof DelegationService>[] = [];
      t.mock.method(
        DelegationService.prototype,
        'close',
        async function (this: InstanceType<typeof DelegationService>) {
          closed.push(this);
          await close.call(this);
        }
      );
      const f = await p065WorkloadFixture(h, r, tool);
      try {
        const sourceId = f.parent.ref.sourceId;
        const seed = p065SupervisorSeed(f.meta.supervisor);
        assert.equal(f.initial.active.length, r);
        assert.equal(f.initial.slots.length, r);
        assert.equal(f.initial.claims.length, r);
        assert.equal(new Set(f.initial.slots.map((row) => row.slot_key)).size, r);
        assert.equal(new Set(f.initial.claims.map((row) => row.run_id)).size, r);
        assert.deepEqual(f.initial.active.map((row) => row.run_id).sort(), [...f.baselineIds].sort());
        const before = f.ledger.snapshot((tx) =>
          f.baselineIds.map((runId) => {
            const run = readRun(tx, runId);
            const index = runId === 'run-a' ? 0 : Number(runId.slice('p065-run-'.length));
            const supervisor: ProcessStamp = {
              ...seed,
              pid: 15000 + index,
              proc_start: String(15000 + index),
            };
            assert.equal(run.sourceId, sourceId);
            assert.deepEqual(run.supervisor, supervisor);
            assert.equal(run.launchPhase, 'submitted');
            assert.ok(['starting', 'running', 'cancelling', 'uncertain'].includes(run.state));
            assert.ok(run.heartbeatSeq >= 2);
            assert.deepEqual(
              readEvents(tx, runId)
                .filter((event) => event.kind === 'supervisor.registered')
                .map((event) => event.payload),
              [{ sourceId, bindingGeneration: run.expectedGeneration, supervisor }]
            );
            const claim = tx.get('SELECT * FROM claims WHERE run_id=?', runId);
            assert.ok(claim);
            assert.equal(claim.source_id, sourceId);
            assert.equal(claim.supervisor_pid, supervisor.pid);
            assert.equal(claim.supervisor_proc_start, supervisor.proc_start);
            assert.equal(claim.state, f.targets.some((target) => target.runId === runId) ? 'redeemed' : 'armed');
            assert.equal(tx.all('SELECT slot_key FROM slots WHERE run_id=?', runId).length, 1);
            if (index !== 0)
              assert.equal(
                readLink(tx, run.linkId).taskDigest,
                taskDigest(f.spawnArgs.brief, hashClaim('Synthetic task bytes.'), 'codex', sourceId, 'implementer')
              );
            return run;
          })
        );
        const pulses = await f.pulse();
        assert.equal(pulses.length, r);
        for (let i = 0; i < r; i++) {
          assert.equal(pulses[i]?.seq, before[i].heartbeatSeq + 1);
          const after = f.ledger.snapshot((tx) => readRun(tx, before[i].runId));
          assert.equal(after.heartbeatSeq, before[i].heartbeatSeq + 1);
          assert.deepEqual(after.supervisor, before[i].supervisor);
          const prior = before[i];
          assert.ok(prior.heartbeatAt !== null && prior.heartbeatMonoMs !== null);
          assert.ok(after.heartbeatAt !== null && after.heartbeatAt > prior.heartbeatAt);
          assert.ok(after.heartbeatMonoMs !== null && after.heartbeatMonoMs > prior.heartbeatMonoMs);
        }
        assert.equal(f.services.length, h);
        assert.equal(f.actors.length, h);
        assert.equal(new Set(f.actors.map((actor) => actor.registration.caller.callerId)).size, h);
        assert.equal(new Set(f.actors.map((actor) => actor.authority.contextId)).size, h);
        assert.equal(new Set(f.actors.map((actor) => actor.authority.evidence.processKey)).size, h);
        for (let i = 0; i < h; i++) {
          const actor = f.actors[i];
          const proof = f.source(i);
          assert.equal(actor.registration.source?.sourceId, sourceId);
          assert.equal(actor.registration.caller.sourceId, sourceId);
          assert.deepEqual(proof.sessionRef, actor.ref);
          assert.equal(proof.processKey, actor.authority.evidence.processKey);
          assert.deepEqual(
            proof.scopePremise,
            f.ledger.snapshot((tx) => scopeSnapshot(tx, f.ledger.ledgerId, proof.processKey))
          );
          assert.equal(proof.scopePremise.kind, 'current');
          assert.deepEqual(proof.scopePremise.current?.sessionRef, actor.ref);
          const context = f.ledger.snapshot((tx) =>
            readContext(tx, actor.authority.contextId, actor.authority.generation)
          );
          assert.equal(context.callerId, actor.registration.caller.callerId);
          assert.equal(context.closedAt, null);
          assert.deepEqual(context.sessionRef, actor.ref);
        }
        assert.equal(f.targets.length, h);
        for (let i = 0; i < h; i++) {
          const target = f.targets[i];
          f.ledger.snapshot((tx) => {
            const run = readRun(tx, target.runId);
            const link = readLink(tx, run.linkId);
            const claim = tx.get('SELECT * FROM claims WHERE run_id=?', target.runId);
            assert.ok(claim);
            assert.equal(run.sourceId, sourceId);
            assert.deepEqual(run.supervisor, target.supervisor);
            assert.equal(claim.claim_hash, hashClaim(target.claim));
            assert.equal(claim.redeemed_context_id, target.child.authority.contextId);
            assert.equal(claim.redeemed_generation, target.child.authority.generation);
            assert.equal(claim.redeemed_session_ref, refValue(target.child.ref));
            assert.deepEqual(link.childRef, target.child.ref);
            assert.equal(link.state, 'bound');
            assert.equal(link.currentOwner, true);
            assert.equal(
              tx.all(
                'SELECT binding_id FROM child_bindings WHERE run_id=? AND caller_context_id=? AND context_generation=?',
                target.runId,
                target.child.authority.contextId,
                target.child.authority.generation
              ).length,
              1
            );
            if (tool === 'delegate_resume') {
              assert.equal(f.baselineIds.includes(target.runId), false);
              assert.equal(run.state, 'ended');
              assert.equal(claim.state, 'revoked');
              assert.equal(tx.all('SELECT slot_key FROM slots WHERE run_id=?', target.runId).length, 0);
              const evidence = readEvidence(tx, target.runId).find(
                (entry) => entry.evidenceId === `p065-terminal-${target.runId}`
              );
              assert.ok(evidence);
              assert.equal(evidence.validation, 'accepted');
              assert.deepEqual(evidence.payload.reconcileFacts, [
                {
                  evidenceId: evidence.evidenceId,
                  runId: target.runId,
                  sourceId,
                  bindingGeneration: 1,
                  supervisor: target.supervisor,
                  validation: 'accepted',
                  asOf: 1020,
                  observedAt: 1020,
                  fact: {
                    kind: 'scope_reconciled',
                    complete: true,
                    harnessTerminated: true,
                    launchersSealed: true,
                    nativeExit: null,
                  },
                },
              ]);
              assert.equal(f.args(i).expectedRun, target.runId);
            } else {
              assert.equal(f.baselineIds.includes(target.runId), true);
              assert.equal(claim.state, 'redeemed');
            }
          });
          if (tool === 'delegate_whoami' || tool === 'delegate_report') {
            assert.equal(f.actors[i], target.child);
            assert.notEqual(f.actors[i].authority.contextId, f.parent.authority.contextId);
          }
        }
        assert.equal(f.initial.totalRuns, r + (tool === 'delegate_resume' ? h : 0));
        assert.equal(f.population().active.length, r);
        if (h === 2 && (tool === 'delegate_whoami' || tool === 'delegate_report')) {
          const { HandshakeService } = await import('../../packages/hud-mcp/src/handshake.js');
          const crossed = new HandshakeService({
            ledger: f.ledger,
            registration: f.targets[1].child.registration,
            reader: f.reader,
            env: { HUD_CLAIM: f.targets[0].claim },
            now: f.now,
            home: f.root,
          });
          await assert.rejects(
            crossed.whoami({}, f.targets[1].child.authority),
            /claim_anchor_mismatch|claim_redeemed|claim_invalid/
          );
        }
      } finally {
        await f.dispose();
      }
      for (const service of [f.service, ...f.services])
        assert.equal(closed.filter((candidate) => candidate === service).length, 1);
      assert.equal(existsSync(f.root), false);
      await assert.rejects(
        f.ledger.transaction(() => 1),
        /ledger_closed/
      );
    });

test('P065 workload fixture rejects missing or malformed supervisor seeds', () => {
  const seed: ProcessStamp = {
    pid: 15000,
    proc_start: '15000',
    boot_id: 'synthetic-boot',
    pid_domain: 'synthetic-domain',
  };
  assert.deepEqual(p065SupervisorSeed(seed), seed);
  assert.throws(() => p065SupervisorSeed(null), /p065_invalid_supervisor_seed/);
  for (const [field, value] of [
    ['pid', 0],
    ['pid', 1.5],
    ['proc_start', ''],
    ['proc_start', 'not-a-start'],
    ['boot_id', ''],
    ['pid_domain', ''],
  ] as const) {
    const malformed = { ...seed };
    Reflect.set(malformed, field, value);
    assert.throws(() => p065SupervisorSeed(malformed), /p065_invalid_supervisor_seed/);
  }
  for (const field of ['pid', 'proc_start', 'boot_id', 'pid_domain']) {
    const malformed = { ...seed };
    Reflect.deleteProperty(malformed, field);
    assert.throws(() => p065SupervisorSeed(malformed), /p065_invalid_supervisor_seed/);
  }
});

test(
  'P065 workload fixture failed binding releases its service, ledger and temporary root',
  { concurrency: false },
  async (t) => {
    const { HandshakeService } = await import('../../packages/hud-mcp/src/handshake.js');
    const { DelegationService } = await import('../../packages/hud-mcp/src/delegation.js');
    const close = DelegationService.prototype.close;
    const closed: InstanceType<typeof DelegationService>[] = [];
    let captured: { root: string | undefined; ledger: Ledger } | undefined;
    t.mock.method(DelegationService.prototype, 'close', async function (this: InstanceType<typeof DelegationService>) {
      closed.push(this);
      await close.call(this);
    });
    const failure = new Error('synthetic_p065_binding_failure');
    t.mock.method(HandshakeService.prototype, 'whoami', async function (this: InstanceType<typeof HandshakeService>) {
      captured = { root: this['options'].home, ledger: this['options'].ledger };
      throw failure;
    });
    await assert.rejects(p065WorkloadFixture(2, 10, 'delegate_report'), (error) => error === failure);
    assert.ok(captured);
    const observed = captured;
    assert.ok(observed.root);
    assert.equal(closed.filter((service) => service['options'].ledger === observed.ledger).length, 1);
    assert.equal(existsSync(observed.root), false);
    await assert.rejects(
      observed.ledger.transaction(() => 1),
      /ledger_closed/
    );
  }
);

test(
  'P065 workload fixture failed population check releases every composed service',
  { concurrency: false },
  async (t) => {
    const { DelegationService } = await import('../../packages/hud-mcp/src/delegation.js');
    const close = DelegationService.prototype.close;
    const closed: InstanceType<typeof DelegationService>[] = [];
    t.mock.method(DelegationService.prototype, 'close', async function (this: InstanceType<typeof DelegationService>) {
      closed.push(this);
      await close.call(this);
    });
    const prepare = DatabaseSync.prototype.prepare;
    const failure = new Error('synthetic_p065_population_failure');
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (
        sql ===
        "SELECT run_id,supervisor_pid,heartbeat_seq FROM runs WHERE state IN ('starting','running','cancelling','uncertain') ORDER BY run_id"
      )
        throw failure;
      return prepare.call(this, sql);
    });
    await assert.rejects(p065WorkloadFixture(2, 10, 'delegate_status'), (error) => error === failure);
    assert.equal(closed.length, 3);
    assert.equal(new Set(closed).size, 3);
    const { ledger, home } = closed[0]['options'];
    assert.equal(
      closed.every((service) => service['options'].ledger === ledger && service['options'].home === home),
      true
    );
    assert.equal(existsSync(home), false);
    await assert.rejects(
      ledger.transaction(() => 1),
      /ledger_closed/
    );
  }
);

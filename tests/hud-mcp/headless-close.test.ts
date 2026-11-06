/** E4 ledger/MCP simulation, not a real-provider or owned-runner qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { TOOLS, validateToolArguments } from '../../packages/hud-mcp/src/tools.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { CallBudget } from '../../src/ledger/call-budget.js';
import { commitReconcile, readReconcileSnapshot, requestCancel } from '../../src/ledger/reconcile.js';
import { closeProgressIn, requestClose, validateCloseRequested, validateLinkClosed } from '../../src/ledger/close.js';
import { readLink, readRun, refValue } from '../../src/ledger/records.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import type { CloseOutcome, CloseProgress } from '../../src/core/types/close.js';
import type { ReconcileFact, ReconcileEvidence } from '../../src/core/types/execution.js';
import type { PreparedIntent } from '../../src/ledger/types.js';

type Reply = { ok: true; replayed: boolean; outcome: CloseOutcome; current: CloseProgress | null } |
  { ok: false; code: string };
const args = { linkId: 'link-a', expectedRun: 'run-a', request_key: 'synthetic-close' };
const complete: ReconcileFact = { kind: 'scope_reconciled', complete: true, harnessTerminated: true,
  launchersSealed: true, nativeExit: null };
async function fixture(options: { bind?: boolean; visible?: boolean } = {}) {
  const f = await handshakeFixture(options.visible);
  let launches = 0;
  const service = new DelegationService({ ledger: f.ledger, home: f.root, config: { version: 1, profiles: [] },
    registration: f.parent.registration, reader: f.reader, env: {}, hudRunPath: resolve('bin/hud-run'),
    capability: { verify: () => ({ ok: true, reason: null }) },
    launch: async () => { launches++; throw new Error('unexpected_launch'); } });
  const handshake = new HandshakeService({ ledger: f.ledger, registration: f.child.registration,
    reader: f.reader, env: { HUD_CLAIM: f.claim }, now: f.now });
  if (options.bind !== false) { await f.startup(); await handshake.whoami({}, f.child.authority); }
  function source() {
    return { ok: true as const, callId: 'synthetic-close-call', sessionRef: f.parent.ref,
      processKey: f.parent.authority.evidence.processKey, evidenceDigest: hashClaim('synthetic-close-source'),
      scopePremise: f.ledger.snapshot((tx) => scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)) };
  }
  const server = new HudMcpServer({ resolve: async () => source() }, service);
  async function call(input: Record<string, unknown> = args, tool = 'delegate_close'): Promise<Reply> {
    const response = await server.handle({ jsonrpc: '2.0', id: 'synthetic-rpc', method: 'tools/call',
      params: { name: tool, arguments: input } }) as { result?: { structuredContent: Reply }; error?: { code: number } };
    assert.equal(response.error, undefined);
    return response.result!.structuredContent;
  }
  function state(runId = 'run-a') {
    return f.ledger.snapshot((tx) => ({ link: readLink(tx, 'link-a'), run: readRun(tx, runId),
      close: closeProgressIn(tx, readLink(tx, 'link-a'), readRun(tx, runId)),
      events: tx.all('SELECT * FROM events ORDER BY seq'),
      cancels: tx.all("SELECT * FROM events WHERE kind='cancel.accepted' ORDER BY seq"),
      closes: tx.all("SELECT * FROM events WHERE kind='close.requested' ORDER BY seq"),
      closed: tx.all("SELECT * FROM events WHERE kind='link.closed' ORDER BY seq"),
      runs: tx.all('SELECT * FROM runs ORDER BY run_id'), claims: tx.all('SELECT * FROM claims ORDER BY run_id'),
      slots: tx.all('SELECT * FROM slots ORDER BY slot_key'), idempotency: tx.all('SELECT * FROM idempotency ORDER BY request_key'),
      changes: Number(tx.get('SELECT total_changes() AS n')!.n) }));
  }
  async function reconcile(facts: ReconcileFact[] = [complete], runId = 'run-a', change?: (fact: ReconcileEvidence) => void) {
    const snapshot = readReconcileSnapshot(f.ledger, runId);
    const at = Date.now();
    const supplied = facts.map((fact, i) => {
      const evidenceId = `synthetic-close-${snapshot.asOfSeq}-${i}`;
      const entry: ReconcileEvidence = { evidenceId, runId, sourceId: f.source.sourceId,
        bindingGeneration: snapshot.run.expectedGeneration, supervisor: snapshot.run.supervisor,
        validation: 'accepted', asOf: at, observedAt: at, fact };
      change?.(entry);
      return { record: { evidenceId, runId, linkId: 'link-a', kind: 'group_check' as const,
        producer: 'reconciler' as const, fingerprint: hashClaim(evidenceId), payload: {}, observedAt: at,
        validatedAt: at, validation: 'accepted' as const }, facts: [entry] };
    });
    return commitReconcile(f.ledger, snapshot, supplied, at);
  }
  return { ...f, service, handshake, server, source, call, state, reconcile, launches: () => launches,
    dispose: async () => { server.shutdown(); await service.close(); await f.close(); } };
}
function accepted(reply: Reply): asserts reply is Extract<Reply, { ok: true }> { assert.equal(reply.ok, true); }

test('E4 real MCP/service/SQLite acceptance, reconcile closure, immutable replay and read-only projections', async () => {
  const f = await fixture();
  try {
    const before = f.state();
    const first = await f.call(); accepted(first);
    const pending = f.state();
    assert.equal(first.current?.closeState, 'pending');
    assert.equal(first.outcome.status, 'accepted');
    assert.equal(pending.closes.length, 1); assert.equal(pending.cancels.length, 1);
    assert.equal(pending.closed.length, 0); assert.equal(pending.link.state, 'bound');
    assert.equal(pending.runs.length, before.runs.length); assert.equal(pending.slots.length, 1);
    assert.deepEqual(pending.claims, before.claims);
    assert.equal(pending.events.filter((e) => e.kind === 'intent.accepted').length,
      before.events.filter((e) => e.kind === 'intent.accepted').length);
    const replay = await f.call({ ...args, grace: 10000 }); accepted(replay);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.outcome, first.outcome);
    assert.equal(f.state().changes, pending.changes);
    assert.deepEqual(await f.call({ ...args, request_key: 'second' }), { ok: false, code: 'close_already_requested' });
    assert.deepEqual(await f.call({ ...args, grace: 1 }), { ok: false, code: 'idempotency_conflict' });
    assert.deepEqual(await f.call({ ...args, expectedRun: 'another' }), { ok: false, code: 'idempotency_conflict' });
    assert.deepEqual(await f.call({ ...args, linkId: 'another' }), { ok: false, code: 'idempotency_conflict' });
    await f.reconcile();
    const ended = f.state();
    assert.equal(ended.link.state, 'closed'); assert.equal(ended.link.currentOwner, false);
    assert.equal(ended.run.state, 'ended'); assert.equal(ended.slots.length, 0); assert.equal(ended.closed.length, 1);
    const terminal = ended.events.find((e) => e.kind === 'run.terminal')!;
    assert.equal(JSON.parse(String(terminal.payload)).terminalNote, 'cancel_timing_unknown');
    assert.equal(ended.run.exitCode, null); assert.equal(ended.run.exitSource, null);
    const after = await f.call(); accepted(after);
    assert.deepEqual(after.outcome, first.outcome); assert.equal(after.current?.closeState, 'closed');
    assert.equal(f.state().changes, ended.changes);
    const noop = await f.call({ ...args, request_key: 'closed-noop' }); accepted(noop);
    assert.equal(noop.outcome.status, 'already_closed'); assert.equal(f.state().closed.length, 1);
    const projectionBefore = f.state().changes;
    const status = await f.service.invoke(f.source(), 'delegate_status', { runId: 'run-a' }) as any;
    const list = await f.service.invoke(f.source(), 'delegate_list', {}) as any;
    const wait = await f.service.invoke(f.source(), 'delegate_wait', { runId: 'run-a', timeoutMs: 0 }) as any;
    assert.equal(status.close.closeState, 'closed'); assert.equal(status.resumable.resumable, false);
    assert.equal(list.items[0].close.closeState, 'closed'); assert.equal(wait.status.close.closeState, 'closed');
    assert.equal(f.state().changes, projectionBefore); assert.equal(f.launches(), 0);
  } finally { await f.dispose(); }
});

for (const chronology of ['before_exit', 'after_exit', 'unknown'] as const)
  test(`E4 preserves existing cancellation clock, grace and ${chronology} terminal classification`, async () => {
    const f = await fixture();
    try {
      await requestCancel(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), f.parent.authority, 1030, 17);
      const cancel = f.state().cancels;
      const reply = await f.call({ ...args, grace: 59000 }); accepted(reply);
      assert.equal(reply.outcome.effectiveGraceMs, 17); assert.deepEqual(f.state().cancels, cancel);
      await f.reconcile([complete, { kind: 'cancel', chronology }]);
      const s = f.state();
      assert.equal(s.run.state, chronology === 'before_exit' ? 'cancelled' : 'ended');
      assert.equal(s.link.state, 'closed'); assert.deepEqual(s.cancels, cancel);
      const terminal = JSON.parse(String(s.events.find((e) => e.kind === 'run.terminal')!.payload));
      assert.equal(terminal.terminalNote, chronology === 'unknown' ? 'cancel_timing_unknown' : null);
    } finally { await f.dispose(); }
  });

for (const proof of ['receipt', 'scope_reconciled'] as const)
  test(`E4 already-terminal ${proof} closes without another cancellation or rewritten terminal evidence`, async () => {
    const f = await fixture();
    try {
      await f.reconcile([{ ...complete, kind: proof, nativeExit: { code: 7, signal: null, source: 'wait_status' } }]);
      const before = f.state();
      const result = await f.call(); accepted(result);
      assert.equal(result.current?.closeState, 'closed'); assert.equal(result.outcome.cancelSeq, null);
      const after = f.state();
      assert.deepEqual(after.run, before.run); assert.deepEqual(after.cancels, []);
      assert.deepEqual(after.events.filter((e) => e.kind === 'run.terminal'), before.events.filter((e) => e.kind === 'run.terminal'));
      assert.equal(f.launches(), 0);
    } finally { await f.dispose(); }
  });

function resumeInput(f: Awaited<ReturnType<typeof fixture>>, requestKey: string): PreparedIntent {
  const original = f.input;
  const current = f.state();
  const at = Date.now();
  return { ...structuredClone(original), requestKey,
    params: { ...original.params, linkId: 'link-a', expectedRun: 'run-a' }, link: current.link,
    run: { ...original.run, operation: 'resume', runId: 'run-b', runSeq: 2,
      targetSessionRef: current.link.childRef, expectedGeneration: 2, createdAt: at,
      launchTokenHash: hashClaim('ticket-b'), launchDigest: hashClaim('launch-b'),
      launchCallId: 'call-b', launchCorrelationId: 'correlation-b' },
    claim: { ...original.claim, runId: 'run-b', expectedGeneration: 2, claimHash: hashClaim('claim-b'),
      issuedAt: at, expiresAt: at + 1800000 }, newSession: false };
}

test('E4 already-terminal N on a bound resume closes, with no cancellation or launch', async () => {
  const f = await fixture();
  try {
    await f.reconcile();
    await acceptIntent(f.ledger, resumeInput(f, 'resume-for-N'));
    await f.reconcile([{ kind: 'never_submitted', permanentFence: true, launchersSealed: true, noExecution: true },
      { kind: 'scope', state: 'gone', complete: true, harnessTerminated: true, launchersSealed: true }], 'run-b');
    const before = f.state('run-b'); assert.equal(before.run.state, 'failed');
    const result = await f.call({ ...args, expectedRun: 'run-b' }); accepted(result);
    assert.equal(result.current?.closeState, 'closed'); assert.equal(result.outcome.cancelSeq, null);
    assert.deepEqual(f.state('run-b').run, before.run);
  } finally { await f.dispose(); }
});

test('E4 resume commits first: expectedRun refusal; close commits first: fresh resume/handover fenced, replay untouched', async () => {
  const f = await fixture();
  try {
    await f.reconcile();
    const input = resumeInput(f, 'resume-first');
    const first = await acceptIntent(f.ledger, input);
    const before = f.state('run-b');
    assert.deepEqual(await f.call(), { ok: false, code: 'expected_run_mismatch' });
    assert.equal(f.state('run-b').changes, before.changes);
    const close = await f.call({ ...args, expectedRun: 'run-b' }); accepted(close);
    const count = f.state('run-b').changes;
    const replay = await acceptIntent(f.ledger, input);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.outcome, first.outcome);
    assert.equal(f.state('run-b').changes, count);
    await assert.rejects(acceptIntent(f.ledger, { ...input, requestKey: 'fresh-resume' }), /close_already_requested/);
    const handover: PreparedIntent = { ...structuredClone(input), requestKey: 'fresh-handover',
      params: { ...input.params, predecessor: 'link-a' },
      link: { ...input.link, linkId: 'link-b', predecessor: 'link-a', state: 'bound' },
      run: { ...input.run, linkId: 'link-b', operation: 'handover', runSeq: 1 } };
    await assert.rejects(acceptIntent(f.ledger, handover), /close_already_requested/);
    assert.equal(f.state('run-b').changes, count);
  } finally { await f.dispose(); }
});

for (const options of [{ bind: false }, { visible: true }])
  test(`E4 unsupported target ${JSON.stringify(options)} has no close/cancel/surface effect`, async () => {
    const f = await fixture(options);
    try {
      const before = f.state();
      assert.deepEqual(await f.call(), { ok: false,
        code: options.visible ? 'unsupported_close_target' : 'unconfirmed_close_target' });
      assert.equal(f.state().changes, before.changes); assert.equal(f.launches(), 0);
      // Existing fixed-run cancellation remains independent for these targets.
      await requestCancel(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), f.parent.authority, 1030);
      assert.equal(f.state().cancels.length, 1); assert.equal(f.state().closes.length, 0);
    } finally { await f.dispose(); }
  });

test('E4 strict schema rejects owner/context/target/admin/generation overrides and invalid inputs', () => {
  const definition = TOOLS.find((tool) => tool.name === 'delegate_close')!;
  assert.ok(definition); assert.equal(validateToolArguments(definition, args), true);
  for (const key of ['owner', 'ownerKey', 'callerContext', 'targetSessionRef', 'bindingGeneration', 'processStamp', 'backend', 'admin'])
    assert.equal(validateToolArguments(definition, { ...args, [key]: 'forged' }), false);
  for (const grace of [-1, 60001, 1.5, null, '1']) assert.equal(validateToolArguments(definition, { ...args, grace }), false);
  for (const expectedRun of ['', '../run-a', 'a'.repeat(129), null])
    assert.equal(validateToolArguments(definition, { ...args, expectedRun }), false);
  const { expectedRun: _unused, ...missing } = args;
  assert.equal(validateToolArguments(definition, missing), false);
  assert.equal(validateToolArguments(definition, { ...args, request_key: '' }), false);
  assert.equal(validateToolArguments(definition, { ...args, request_key: 'x'.repeat(257) }), false);
});

test('E4 current authority required even for replay; retirement after acceptance does not undo fixed intent', async () => {
  const f = await fixture();
  try {
    const first = await f.call(); accepted(first);
    await f.ledger.transaction((tx) => tx.run("UPDATE caller_contexts SET closed_at=2000 WHERE context_id=?", f.parent.context.contextId));
    const before = f.state();
    assert.deepEqual(await f.call(), { ok: false, code: 'stale_context' });
    assert.equal(f.state().changes, before.changes);
    await f.reconcile();
    assert.equal(f.state().link.state, 'closed'); assert.equal(f.state().closed.length, 1);
    assert.deepEqual(f.state().closes, before.closes);
  } finally { await f.dispose(); }
});

test('E4 wrong owner and same session id under another source/thread cannot control', async () => {
  const f = await fixture();
  try {
    const before = f.state();
    await assert.rejects(requestClose(f.ledger, args, f.child.authority, Date.now()), /unauthorized/);
    for (const ref of [{ ...f.parent.ref, sourceId: 'b'.repeat(64) }, { ...f.parent.ref, threadId: 'other-thread' }]) {
      await assert.rejects(f.service.invoke({ ...f.source(), sessionRef: ref }, 'delegate_close', args), /stale_context/);
    }
    assert.equal(f.state().changes, before.changes);
    const local = { kind: 'local_user' as const, uid: 1, ownerUid: 1, invocationId: 'local',
      hudHomeOwned: true, ledgerOwned: true, privatePaths: true };
    await assert.rejects(requestClose(f.ledger, args, local, Date.now()), /unsupported/);
  } finally { await f.dispose(); }
});

for (const change of ['revoked', 'generation', 'target'] as const)
  test(`E4 ${change} after acceptance preserves intent and never closes a successor`, async () => {
    const f = await fixture();
    try {
      const first = await f.call(); accepted(first);
      await f.ledger.transaction((tx) => {
        if (change === 'revoked') tx.run("UPDATE links SET state='revoked',current_owner=0 WHERE link_id='link-a'");
        if (change === 'generation') {
          // Corruption fixture keeps SQL foreign keys valid while invalidating the
          // frozen close generation and authoritative supervisor registration.
          tx.run('PRAGMA defer_foreign_keys=ON');
          tx.run("UPDATE runs SET expected_generation=2 WHERE run_id='run-a'");
          tx.run("UPDATE claims SET expected_generation=2 WHERE run_id='run-a'");
          tx.run("UPDATE child_bindings SET binding_generation=2 WHERE run_id='run-a'");
        }
        if (change === 'target') tx.run("UPDATE links SET child_ref=? WHERE link_id='link-a'", refValue(f.parent.ref));
      });
      const before = f.state();
      const replay = await f.call(); accepted(replay); assert.deepEqual(replay.outcome, first.outcome);
      assert.equal(replay.current?.closeState, 'incompatible'); assert.equal(f.state().changes, before.changes);
      if (change === 'generation') await assert.rejects(f.reconcile(), /supervisor_registration_unknown/);
      else await f.reconcile();
      assert.notEqual(f.state().link.state, 'closed'); assert.equal(f.state().closed.length, 0);
      assert.deepEqual(f.state().closes, before.closes);
    } finally { await f.dispose(); }
  });

for (const scenario of ['supervisor_dead', 'unknown_scope', 'leader_only', 'wrong_scope', 'conflict'] as const)
  test(`E4 ${scenario} cannot fabricate closure or release execution slots`, async () => {
    const f = await fixture();
    try {
      accepted(await f.call());
      const facts: ReconcileFact[] = scenario === 'supervisor_dead' ? [{ kind: 'supervisor', state: 'dead' }] :
        scenario === 'unknown_scope' ? [{ kind: 'scope', state: 'unknown', complete: false, harnessTerminated: false, launchersSealed: false }] :
          scenario === 'leader_only' ? [{ ...complete, complete: false, launchersSealed: false }] :
            scenario === 'conflict' ? [complete, { kind: 'conflict', cause: 'scope_conflict' }] : [complete];
      await f.reconcile(facts, 'run-a', scenario === 'wrong_scope' ? (fact) => {
        fact.supervisor = { ...f.meta.supervisor, proc_start: '99999' };
      } : undefined);
      const s = f.state(); assert.notEqual(s.link.state, 'closed'); assert.equal(s.closed.length, 0);
      assert.equal(s.slots.length, 1); assert.equal(s.close.closeState, 'pending');
    } finally { await f.dispose(); }
  });

test('E4 rollback at acceptance and finalization leaves no half-close; existing reconciler recovers', async () => {
  const f = await fixture();
  try {
    await f.ledger.transaction((tx) => tx.run(`CREATE TRIGGER fail_close BEFORE INSERT ON events
      WHEN NEW.kind='close.requested' BEGIN SELECT RAISE(ABORT,'synthetic_close_crash'); END`));
    assert.deepEqual(await f.call(), { ok: false, code: 'internal_error' });
    assert.equal(f.state().closes.length, 0); assert.equal(f.state().cancels.length, 0);
    assert.equal(f.state().idempotency.filter((r) => r.request_key === args.request_key).length, 0);
    await f.ledger.transaction((tx) => tx.run('DROP TRIGGER fail_close'));
    accepted(await f.call());
    await f.ledger.transaction((tx) => tx.run(`CREATE TRIGGER fail_finish BEFORE INSERT ON events
      WHEN NEW.kind='link.closed' BEGIN SELECT RAISE(ABORT,'synthetic_finish_crash'); END`));
    await assert.rejects(f.reconcile(), /synthetic_finish_crash/);
    const pending = f.state(); assert.equal(pending.link.state, 'bound'); assert.equal(pending.slots.length, 1);
    assert.equal(pending.events.filter((e) => e.kind === 'run.terminal').length, 0);
    await f.ledger.transaction((tx) => tx.run('DROP TRIGGER fail_finish'));
    await f.reconcile(); await f.reconcile([]);
    assert.equal(f.state().closed.length, 1); assert.equal(f.state().link.state, 'closed');
  } finally { await f.dispose(); }
});

test('E4 closed run rejects late report/binding and retains restrictive target history', async () => {
  const f = await fixture();
  try {
    accepted(await f.call()); await f.reconcile();
    const targetHistory = f.state().run.targetSessionRef;
    const report = await f.handshake.report({ runId: 'run-a', status: 'completed', summary: 'Synthetic late report' }, f.child.authority);
    assert.equal(report.ok, false);
    await assert.rejects(f.handshake.whoami({}, f.child.authority));
    assert.equal(f.state().link.state, 'closed'); assert.deepEqual(f.state().run.targetSessionRef, targetHistory);
    const input = structuredClone(f.input);
    input.requestKey = 'nested-after-close'; input.authority = f.child.authority;
    input.link = { ...input.link, linkId: 'nested', parentCaller: 'child', parentContextId: f.child.context.contextId,
      parentRef: f.child.ref };
    input.run = { ...input.run, linkId: 'nested', runId: 'nested-run' }; input.claim.runId = 'nested-run';
    await assert.rejects(acceptIntent(f.ledger, input), /nested_delegation_not_supported/);
  } finally { await f.dispose(); }
});

test('E4 original receipt budget is shared through source authorization and close acceptance', async () => {
  const f = await fixture();
  let time = 0;
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const server = new HudMcpServer({ resolve: async () => { time = 250; return f.source(); } }, f.service, () => true, clock);
  try {
    const before = f.state();
    const reply = await server.handle({ jsonrpc: '2.0', id: 'budget', method: 'tools/call',
      params: { name: 'delegate_close', arguments: args } }) as any;
    assert.deepEqual(reply.result.structuredContent, { ok: false, code: 'busy' });
    assert.equal(f.state().changes, before.changes);
    time = 0; const budget = new CallBudget(clock); time = 250;
    await assert.rejects(requestClose(f.ledger, args, f.parent.authority, Date.now(), budget), /ledger_busy/);
    assert.equal(f.state().changes, before.changes);
  } finally { server.shutdown(); await f.dispose(); }
});

test('E4 versioned events reject extension fields and invalid references', async () => {
  const f = await fixture();
  try {
    accepted(await f.call());
    const payload = JSON.parse(String(f.state().closes[0].payload));
    assert.doesNotThrow(() => validateCloseRequested(payload));
    assert.throws(() => validateCloseRequested({ ...payload, admin: true }), /invalid_close_payload/);
    assert.throws(() => validateCloseRequested({ ...payload, version: 2 }), /invalid_close_payload/);
    assert.throws(() => validateCloseRequested({ ...payload, actor: { ...payload.actor, admin: true } }), /invalid_close_payload/);
    await f.reconcile();
    const closed = JSON.parse(String(f.state().closed[0].payload));
    assert.doesNotThrow(() => validateLinkClosed(closed));
    assert.throws(() => validateLinkClosed({ ...closed, terminalSeq: 0 }), /invalid_close_payload/);
    assert.throws(() => validateLinkClosed({ ...closed, surface: 'synthetic' }), /invalid_close_payload/);
  } finally { await f.dispose(); }
});

for (const failure of ['late_commit', 'unknown_commit', 'cleanup_failure'] as const)
  test(`E4 actual close transaction retains existing ${failure} semantics`, async () => {
    const f = await fixture();
    const { DatabaseSync } = await import('node:sqlite');
    const { Ledger, LedgerCommitUncertain, LedgerCleanupFailed } = await import('../../src/ledger/ledger.js');
    const db = new DatabaseSync(resolve(f.root, 'ledger.sqlite'));
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
    let time = 0;
    const calls: string[] = [];
    const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
    const adapter = {
      exec(sql: string) {
        calls.push(sql);
        if (failure === 'cleanup_failure' && sql === 'ROLLBACK') throw new Error('synthetic_cleanup_failure');
        db.exec(sql);
        if (sql === 'COMMIT' && failure === 'late_commit') time += 300;
        if (sql === 'COMMIT' && failure === 'unknown_commit') throw new Error('synthetic_commit_response_lost');
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    };
    const ledger = new Ledger(adapter as unknown as InstanceType<typeof DatabaseSync>, f.ledger.ledgerId, 20);
    try {
      if (failure === 'late_commit') {
        const result = await requestClose(ledger, args, f.parent.authority, Date.now(), new CallBudget(clock));
        assert.equal(result.outcome.status, 'accepted'); assert.equal(time, 300);
      } else if (failure === 'unknown_commit') {
        await assert.rejects(requestClose(ledger, args, f.parent.authority, Date.now(), new CallBudget(clock)), LedgerCommitUncertain);
        await assert.rejects(ledger.transaction(() => assert.fail('poisoned connection reused')), /ledger_closed/);
      } else {
        await assert.rejects(requestClose(ledger, { ...args, expectedRun: 'wrong' }, f.parent.authority, Date.now(), new CallBudget(clock)), LedgerCleanupFailed);
        await assert.rejects(ledger.transaction(() => assert.fail('poisoned connection reused')), /ledger_closed/);
      }
      assert.equal(calls.filter((sql) => sql === 'COMMIT').length, failure === 'cleanup_failure' ? 0 : 1);
      assert.equal(f.state().closes.length, failure === 'cleanup_failure' ? 0 : 1);
      assert.equal(f.state().cancels.length, failure === 'cleanup_failure' ? 0 : 1);
    } finally { await ledger.close(); await f.dispose(); }
  });

test('E4 already-terminal pending close finalizes on existing reconcile without another state transition', async () => {
  const f = await fixture();
  try {
    const slot = f.ledger.snapshot((tx) => tx.get('SELECT * FROM slots WHERE run_id=?', 'run-a')!);
    await f.reconcile();
    // Controlled retained-slot fixture: absence of a slot is independently required.
    await f.ledger.transaction((tx) => tx.run(
      'INSERT INTO slots(slot_key,session_ref,run_id,holder,acquired_at) VALUES(?,?,?,?,?)',
      slot.slot_key, slot.session_ref, slot.run_id, slot.holder, slot.acquired_at));
    const reply = await f.call(); accepted(reply); assert.equal(reply.current?.closeState, 'pending');
    const terminal = f.state().events.filter((e) => e.kind === 'run.terminal');
    await f.ledger.transaction((tx) => tx.run('DELETE FROM slots WHERE run_id=?', 'run-a'));
    // A replay must NOT repair this pending close after cleanup is independently complete.
    const replay = await f.call(); accepted(replay); assert.equal(replay.current?.closeState, 'pending');
    await f.reconcile([]);
    assert.equal(f.state().link.state, 'closed');
    assert.deepEqual(f.state().events.filter((e) => e.kind === 'run.terminal'), terminal);
  } finally { await f.dispose(); }
});

test('E4 committed terminal row without accepted terminal evidence remains pending', async () => {
  const f = await fixture();
  try {
    await f.reconcile();
    const evidenceId = f.state().run.terminalEvidenceId;
    await f.ledger.transaction((tx) => tx.run("UPDATE evidence SET validation='rejected' WHERE evidence_id=?", evidenceId));
    const reply = await f.call(); accepted(reply);
    assert.equal(reply.current?.closeState, 'pending'); assert.equal(f.state().closed.length, 0);
  } finally { await f.dispose(); }
});

test('E4 close atomically revokes remaining wake registration with link_closed once', async () => {
  const f = await fixture();
  const { recordWakeRegistered } = await import('../../src/ledger/notify-events.js');
  const { sessionOwnerKey } = await import('../../src/core/identity.js');
  try {
    const seq = await f.ledger.transaction((tx) => recordWakeRegistered(tx, 'link-a', {
      adapter: 'none', adapterVersion: 1, ownerKey: sessionOwnerKey(f.parent.ref), contextGeneration: 1,
      parentRef: f.parent.ref, parentStamp: null, target: {}, reason: 'synthetic_no_adapter',
    }, 1030));
    accepted(await f.call()); await f.reconcile(); await f.reconcile([]);
    const revoked = f.state().events.filter((event) => event.kind === 'wake.revoked');
    assert.equal(revoked.length, 1);
    assert.deepEqual(JSON.parse(String(revoked[0].payload)), { registrationSeq: seq, reason: 'link_closed' });
  } finally { await f.dispose(); }
});

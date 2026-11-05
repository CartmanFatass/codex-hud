import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HeadlessRunControl } from '../../src/core/run/control.js';
import { MemoryRunFactPort } from '../../src/core/run/fake-port.js';
import { currentDomain, processState, readProcess } from '../../src/core/run/process.js';
import { reconcileRun } from '../../src/core/execution.js';
import type { ReconcileDecision, ReconcileEvidence, ReconcileFact } from '../../src/core/types/execution.js';
import type { RunSnapshot } from '../../src/core/run/port.js';
import type { ProcessScope } from '../../src/core/types/supervision.js';
import { seedRun } from '../run/fixtures.js';
import { fixtureRun, FIXTURE_NOW } from '../fixtures/contracts/identity-execution.js';
import {
  assertCompletionEvidence,
  assertKillEvidence,
  captureKill,
  saveKillCapture,
  projectKillCapture,
  serializeKillPublication,
  type KillRecord,
} from './run-control-kill-fixture.js';

// Pure synthetic publication-shape regression, not process evidence.
test('RUNZ1-KILL K1 publication pseudonymizes embedded identities without mutating evidence', () => {
  const boot = 'SYNTHETIC_BOOT_MARKER_A',
    domain = 'SYNTHETIC_DOMAIN_MARKER_A';
  const boot2 = 'SYNTHETIC_BOOT_MARKER_B',
    domain2 = 'SYNTHETIC_DOMAIN_MARKER_B';
  const scopeId = `synthetic-run:${boot}:${domain}:71:9001`;
  const scopeId2 = `synthetic-run:${boot2}:${domain2}:72:9002`;
  const stamp = { pid: 71, proc_start: '9001', boot_id: boot, pid_domain: domain };
  const scope: ProcessScope = {
    scope_id: scopeId,
    scope_kind: 'pgid',
    boot_id: boot,
    pid_domain: domain,
    pgid: 71,
    sid: 71,
    group_leader: stamp,
  };
  const second = {
    ...scope,
    scope_id: scopeId2,
    boot_id: boot2,
    pid_domain: domain2,
    group_leader: { ...stamp, boot_id: boot2, pid_domain: domain2 },
  };
  const snapshot = seedRun('/synthetic/serializer', ['/synthetic/harness']).seed.snapshot;
  snapshot.run = fixtureRun({ supervisor: stamp, scopeRef: scope });
  const run = snapshot.run;
  snapshot.meta = {
    schema_version: 1,
    run_id: run.runId,
    link_id: run.linkId,
    source_id: run.sourceId,
    binding_generation: run.expectedGeneration,
    mode: 'headless',
    supervision_strategy: 'headless',
    supervisor: stamp,
    command_leader: stamp,
    harness: stamp,
    scope,
    launch_digest: 'synthetic-digest',
    profile_digest: 'synthetic-profile',
    launch_call_id: 'synthetic-call',
    launch_correlation_id: 'synthetic-correlation',
    created_at: FIXTURE_NOW,
    stdin_mode: 'closed',
    capture: 'file',
    launch_cwd: '/synthetic/serializer',
    project_origin: null,
  };
  snapshot.facts = [{ ...q(), supervisor: stamp }];
  snapshot.events = [
    {
      seq: 1,
      runId: run.runId,
      linkId: run.linkId,
      kind: 'synthetic.scope',
      at: FIXTURE_NOW,
      payload: JSON.parse(JSON.stringify({ scope, command: stamp })),
    },
  ];
  const records: KillRecord[] = [
    {
      sequence: 1,
      operation: 'startup',
      at: FIXTURE_NOW,
      input: [run.runId, stamp, snapshot.meta],
      before: snapshot,
      after: snapshot,
      result: { scope, second },
    },
    {
      sequence: 2,
      operation: 'reconcile',
      at: FIXTURE_NOW + 1,
      input: [run.runId, 0, snapshot.facts, FIXTURE_NOW],
      before: snapshot,
      after: snapshot,
      result: {
        scopeReference: scopeId,
        embeddedBoot: `prefix:${boot}:suffix`,
        embeddedDomain: `prefix:${domain}:suffix`,
        releaseSlot: false,
      },
    },
  ];
  const original = structuredClone({ records, snapshot });
  const projection = projectKillCapture('synthetic-publication', records, snapshot, {
    scope,
    supervisor: stamp,
    native_exit: null,
  });
  // Repeated receipt-shaped publication copies exercise the same generic serializer,
  // without pretending this synthetic projection is a valid production receipt.
  const payload = { ...projection, receiptCopies: [{ scope, supervisor: stamp }, { scope: second }] };
  const raw = [boot, domain, boot2, domain2, scopeId, scopeId2];
  const checkNoLeak = (json: string) => {
    assert.ok(
      raw.every((value) => !json.includes(value)),
      'embedded identity leaked'
    );
  };
  const serialized = serializeKillPublication(payload);
  checkNoLeak(serialized);
  const output = JSON.parse(serialized);
  assert.equal(output.final.run.scopeRef.scope_id, output.records[0].input[2].scope.scope_id);
  assert.equal(output.final.run.scopeRef.scope_id, output.exitFile.scope.scope_id);
  assert.equal(output.final.run.scopeRef.scope_id, output.receiptCopies[0].scope.scope_id);
  assert.notEqual(output.receiptCopies[0].scope.scope_id, output.receiptCopies[1].scope.scope_id);
  assert.notEqual(output.receiptCopies[0].scope.boot_id, output.receiptCopies[1].scope.boot_id);
  assert.equal(output.records[1].result.scopeReference, output.final.run.scopeRef.scope_id);
  assert.ok(output.records[1].result.embeddedBoot.includes(output.final.run.supervisor.boot_id));
  assert.ok(output.records[1].result.embeddedDomain.includes(output.final.run.supervisor.pid_domain));
  assert.equal(output.records[1].at, FIXTURE_NOW + 1);
  assert.equal(output.records[1].input[3], FIXTURE_NOW);
  assert.deepEqual(output.final.facts[0].fact, snapshot.facts[0].fact);
  assert.equal(output.records[1].result.releaseSlot, false);
  assert.deepEqual({ records, snapshot }, original, 'publication must not mutate original evidence');
  const legacy = JSON.stringify(payload, (key, value) =>
    key === 'boot_id' || key === 'pid_domain'
      ? `redacted-${createHash('sha256').update(String(value)).digest('hex')}`
      : value
  );
  assert.throws(() => checkNoLeak(legacy), /embedded identity leaked/);
  console.log('RUNZ1-KILL K1 old key-only serializer failed the embedded-identity assertion; synthetic markers only');
});

/** Assertion mutation controls on an actual captured Q boundary. The alleged
 * held outcomes and cancellation variants below are synthetic, never executions. */
function exerciseHeldControls(records: readonly KillRecord[], ended: RunSnapshot) {
  const original = records.find((r) => r.operation === 'reconcile' && r.before?.slotHeld && !r.after?.slotHeld)!;
  assert.ok(original, 'genuine captured releasing Q boundary');
  const originalBytes = JSON.stringify({ records, ended });
  const held = (modify: (facts: ReconcileEvidence[], now: number) => ReconcileEvidence[] = (facts) => facts) => {
    const record = structuredClone(original);
    const before = record.before!,
      after = record.after!;
    const input = record.input as [string, number, ReconcileEvidence[], number];
    before.facts = modify(before.facts, input[3]);
    input[2] = modify(input[2], input[3]);
    after.facts = [...structuredClone(before.facts), ...structuredClone(input[2])];
    after.slotHeld = true;
    after.claimState = before.claimState;
    after.run = { ...structuredClone(before.run), state: 'uncertain' };
    after.status.currentRun = structuredClone(after.run);
    after.status.terminalNote = null;
    after.status.reconciliation = {
      cause: 'scope_unknown',
      evidenceIds: after.facts.map((e) => e.evidenceId),
      missing: ['scope_unknown'],
      observedAt: input[3],
      allowedActions: [],
    };
    after.events = [
      ...structuredClone(before.events),
      {
        seq: before.events.length + 1,
        runId: before.run.runId,
        linkId: before.run.linkId,
        kind: 'run.reconciled',
        at: input[3],
        payload: { row: 'R-02-9', state: 'uncertain' },
      },
    ];
    record.result = {
      ...(record.result as ReconcileDecision),
      row: 'R-02-9',
      state: 'uncertain',
      releaseSlot: false,
      emitTransition: true,
      blockNewOperations: true,
      cause: 'scope_unknown',
      terminalNote: null,
      evidenceIds: after.facts.map((e) => e.evidenceId),
      auditEvidenceIds: [],
    };
    return { record, final: structuredClone(after) };
  };
  // Exact old held branch, kept executable so this is a behavioral control.
  const oldHeld = (record: KillRecord, final: RunSnapshot) => {
    assert.equal(final.run.exitCode, null);
    assert.equal(final.run.exitSignal, null);
    assert.equal(final.run.exitSource, null);
    assert.equal(final.slotHeld, true);
    assert.equal(final.receipt, null);
    assert.ok(!['ended', 'failed', 'cancelled'].includes(final.run.state));
    assert.equal(final.run.endedAt, null);
    assert.equal(final.run.terminalEvidenceId, null);
    assert.equal(record.before!.slotHeld && !record.after!.slotHeld, false);
    assert.equal(
      final.events.filter(
        (e) => e.kind === 'run.reconciled' && ['ended', 'failed', 'cancelled'].includes(String(e.payload.state))
      ).length,
      0
    );
    assert.equal(record.operation === 'receipt', false);
    return 'incomplete-proof';
  };
  for (const chronology of ['no-cancellation', 'absent', 'unknown', 'before_exit'] as const) {
    const example = held();
    const input = example.record.input as [string, number, ReconcileEvidence[], number];
    if (chronology !== 'no-cancellation') {
      for (const snapshot of [example.record.before!, example.record.after!, example.final]) {
        snapshot.run.cancelRequestedAt = input[3] - 1;
        snapshot.status.currentRun = structuredClone(snapshot.run);
      }
      if (chronology !== 'absent') {
        const template = input[2].find((e) => e.fact.kind === 'scope_reconciled')!;
        const cancel: ReconcileEvidence = {
          ...structuredClone(template),
          evidenceId: `synthetic-cancel-${chronology}`,
          fact: { kind: 'cancel', chronology },
        };
        input[2].push(cancel);
        example.record.after!.facts.push(structuredClone(cancel));
        example.final.facts.push(structuredClone(cancel));
        (example.record.result as ReconcileDecision).evidenceIds.push(cancel.evidenceId);
      }
    }
    assert.equal(oldHeld(example.record, example.final), 'incomplete-proof');
    assert.throws(
      () => assertKillEvidence([example.record], example.final, null),
      /eligible completion proof cannot remain held/
    );
    console.log(
      `RUNZ1-KILL K2 old held branch accepted coherent retained-Q counterexample (${chronology}); new assertion rejected it; synthetic outcome`
    );
  }
  const mutations: {
    name: string;
    blocked?: boolean;
    modify: (facts: ReconcileEvidence[], now: number) => ReconcileEvidence[];
  }[] = [
    { name: 'remove-Q', modify: (facts) => facts.filter((e) => e.fact.kind !== 'scope_reconciled') },
    ...(['complete', 'harnessTerminated', 'launchersSealed'] as const).map((key) => ({
      name: `incomplete-${key}`,
      modify: (facts: ReconcileEvidence[]) =>
        facts.map((e) => (e.fact.kind === 'scope_reconciled' ? { ...e, fact: { ...e.fact, [key]: false } } : e)),
    })),
    ...(['runId', 'sourceId', 'bindingGeneration', 'supervisor'] as const).map((key) => ({
      name: `wrong-${key}`,
      modify: (facts: ReconcileEvidence[]) =>
        facts.map((e) =>
          e.fact.kind === 'scope_reconciled'
            ? {
                ...e,
                [key]:
                  key === 'bindingGeneration'
                    ? e.bindingGeneration + 1
                    : key === 'supervisor'
                      ? { ...e.supervisor!, proc_start: 'wrong-start' }
                      : `wrong-${String(e[key])}`,
              }
            : e
        ),
    })),
    ...(['rejected', 'pending'] as const).map((validation) => ({
      name: validation,
      modify: (facts: ReconcileEvidence[]) =>
        facts.map((e) => (e.fact.kind === 'scope_reconciled' ? { ...e, validation } : e)),
    })),
    ...([null, -1, Number.NaN, 'future'] as const).map((time) => ({
      name: `invalid-time-${String(time)}`,
      blocked: true,
      modify: (facts: ReconcileEvidence[], now: number) =>
        facts.map((e) => (e.fact.kind === 'scope_reconciled' ? { ...e, asOf: time === 'future' ? now + 1 : time } : e)),
    })),
    ...(['live', 'undated-live', 'unsealed', 'explicit-conflict', 'scope-tie'] as const).map((kind) => ({
      name: kind,
      blocked: true,
      modify: (facts: ReconcileEvidence[]) =>
        facts.flatMap((e): ReconcileEvidence[] => {
          if (e.fact.kind !== 'scope_reconciled') return [e];
          const counter: ReconcileEvidence = {
            ...e,
            evidenceId: `synthetic-counter-${kind}`,
            asOf: kind === 'undated-live' ? null : e.asOf,
            fact:
              kind === 'explicit-conflict'
                ? { kind: 'conflict', cause: 'identity_conflict' }
                : {
                    kind: 'scope',
                    state: kind === 'unsealed' ? 'gone' : 'alive',
                    complete: kind === 'unsealed',
                    harnessTerminated: false,
                    launchersSealed: false,
                  },
          };
          const tie: ReconcileEvidence = {
            ...e,
            evidenceId: 'synthetic-tied-gone',
            fact: { kind: 'scope', state: 'gone', complete: true, harnessTerminated: true, launchersSealed: true },
          };
          return kind === 'scope-tie' ? [e, counter, tie] : [e, counter];
        }),
    })),
  ];
  for (const mutation of mutations) {
    const example = held(mutation.modify);
    assert.equal(
      assertKillEvidence([example.record], example.final, null),
      mutation.blocked ? 'blocked-proof' : 'incomplete-proof',
      mutation.name
    );
    const released = structuredClone(original);
    const input = released.input as [string, number, ReconcileEvidence[], number];
    released.before!.facts = mutation.modify(released.before!.facts, input[3]);
    input[2] = mutation.modify(input[2], input[3]);
    released.after!.facts = [...structuredClone(released.before!.facts), ...structuredClone(input[2])];
    assert.throws(() => assertKillEvidence([released], released.after!, null), assert.AssertionError, mutation.name);
    console.log(
      `RUNZ1-KILL K2 paired ${mutation.name}: coherent held allowed, alleged release rejected; synthetic description`
    );
  }
  const conflicting = held();
  const input = conflicting.record.input as [string, number, ReconcileEvidence[], number];
  for (const snapshot of [conflicting.record.before!, conflicting.record.after!, conflicting.final]) {
    snapshot.run.cancelRequestedAt = input[3] - 1;
    snapshot.status.currentRun = structuredClone(snapshot.run);
  }
  const template = input[2].find((e) => e.fact.kind === 'scope_reconciled')!;
  for (const chronology of ['before_exit', 'after_exit'] as const) {
    const fact: ReconcileEvidence = {
      ...template,
      evidenceId: `synthetic-conflicting-${chronology}`,
      fact: { kind: 'cancel', chronology },
    };
    input[2].push(fact);
    conflicting.record.after!.facts.push(structuredClone(fact));
    conflicting.final.facts.push(structuredClone(fact));
  }
  assert.equal(assertKillEvidence([conflicting.record], conflicting.final, null), 'blocked-proof');
  // A rejected CAS's offered Q is not a committed fact; an otherwise complete
  // captured live transaction remains a valid held result.
  const liveRecord = structuredClone(records.find((r) => r.operation === 'reconcile' && r.after?.slotHeld)!);
  const rejected = structuredClone(original);
  rejected.before = structuredClone(liveRecord.after!);
  rejected.after = structuredClone(rejected.before);
  (rejected.input as unknown[])[1] = rejected.before.revision - 1;
  rejected.result = null;
  assert.equal(assertKillEvidence([liveRecord, rejected], rejected.after!, null), 'incomplete-proof');
  assert.throws(() => assertKillEvidence([rejected], rejected.after!, null), /no successful reconciliation boundary/);
  assert.equal(JSON.stringify({ records, ended }), originalBytes, 'controls must leave actual capture unchanged');
}

async function barrier(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `fixture event deadline: ${label}`);
    await sleep(5);
  }
}

// Explicit synthetic table facts exercise policy but never enter real-process proofs.
const tableRun = fixtureRun({ state: 'running', cancelRequestedAt: FIXTURE_NOW - 100 });
function tableFact(fact: ReconcileFact, patch: Partial<ReconcileEvidence> = {}): ReconcileEvidence {
  return {
    evidenceId: `synthetic-${fact.kind}`,
    runId: tableRun.runId,
    sourceId: tableRun.sourceId,
    bindingGeneration: tableRun.expectedGeneration,
    supervisor: tableRun.supervisor,
    validation: 'accepted',
    asOf: FIXTURE_NOW,
    observedAt: FIXTURE_NOW,
    fact,
    ...patch,
  };
}
const q = () =>
  tableFact({
    kind: 'scope_reconciled',
    complete: true,
    harnessTerminated: true,
    launchersSealed: true,
    nativeExit: null,
  });
const chronology = (value: 'before_exit' | 'after_exit' | 'unknown') =>
  tableFact({ kind: 'cancel', chronology: value }, { evidenceId: `synthetic-cancel-${value}` });
const tableCases: {
  name: string;
  facts: () => ReconcileEvidence[];
  state?: 'ended' | 'cancelled';
  note?: 'cancel_timing_unknown' | null;
}[] = [
  { name: 'no completion evidence', facts: () => [] },
  {
    name: 'complete Q with before_exit',
    facts: () => [q(), chronology('before_exit')],
    state: 'cancelled',
    note: null,
  },
  { name: 'complete Q with absent chronology', facts: () => [q()], state: 'ended', note: 'cancel_timing_unknown' },
  {
    name: 'complete Q with unknown chronology',
    facts: () => [q(), chronology('unknown')],
    state: 'ended',
    note: 'cancel_timing_unknown',
  },
  { name: 'complete Q with after_exit', facts: () => [q(), chronology('after_exit')], state: 'ended', note: null },
  ...(['complete', 'harnessTerminated', 'launchersSealed'] as const).map((key) => ({
    name: `incomplete ${key}`,
    facts: () => {
      const e = q();
      e.fact = { ...e.fact, [key]: false } as ReconcileFact;
      return [e];
    },
  })),
  { name: 'wrong run', facts: () => [{ ...q(), runId: 'another-synthetic-run' }] },
  {
    name: 'wrong source',
    facts: () => [{ ...q(), sourceId: `${tableRun.sourceId}-other` as typeof tableRun.sourceId }],
  },
  { name: 'wrong generation', facts: () => [{ ...q(), bindingGeneration: tableRun.expectedGeneration + 1 }] },
  {
    name: 'wrong supervisor',
    facts: () => [{ ...q(), supervisor: { ...tableRun.supervisor!, proc_start: 'other-start' } }],
  },
  { name: 'rejected validation', facts: () => [{ ...q(), validation: 'rejected' }] },
  { name: 'pending validation', facts: () => [{ ...q(), validation: 'pending' }] },
  ...([null, -1, Number.NaN, FIXTURE_NOW + 1] as const).map((asOf) => ({
    name: `invalid fact time ${String(asOf)}`,
    facts: () => [{ ...q(), asOf }],
  })),
  {
    name: 'conflicting live evidence',
    facts: () => [
      q(),
      tableFact({ kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false }),
    ],
  },
  {
    name: 'undated live evidence',
    facts: () => [
      q(),
      tableFact(
        { kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false },
        { asOf: null }
      ),
    ],
  },
  {
    name: 'unresolved identity conflict',
    facts: () => [q(), tableFact({ kind: 'conflict', cause: 'identity_conflict' })],
  },
  {
    name: 'conflicting cancellation evidence',
    facts: () => [q(), chronology('before_exit'), chronology('after_exit')],
  },
];
for (const entry of tableCases) {
  test(`RUNZ1-KILL table: ${entry.name}`, () => {
    const facts = entry.facts();
    const decision = reconcileRun(tableRun, facts, FIXTURE_NOW);
    assert.equal(decision.releaseSlot, entry.state !== undefined);
    if (entry.state) {
      assert.equal(decision.state, entry.state);
      assert.equal(decision.terminalNote, entry.note);
      assertCompletionEvidence(tableRun, facts, FIXTURE_NOW, decision);
    } else {
      assert.ok(!['ended', 'failed', 'cancelled'].includes(decision.state));
      // Mutation assertion control: an alleged released answer must also be rejected
      // independently, rather than simply agreeing with reconcileRun's answer.
      const forged = { ...reconcileRun(tableRun, [q()], FIXTURE_NOW), evidenceIds: facts.map((e) => e.evidenceId) };
      assert.throws(() => assertCompletionEvidence(tableRun, facts, FIXTURE_NOW, forged), assert.AssertionError);
    }
  });
}

test('RUNZ1-KILL real live original holds slot, then reaped fixed scope gives receiptless Q exactly once', async () => {
  assert.equal(process.platform, 'linux', 'real proof requires Linux, never silently skip');
  assert.ok(existsSync('/usr/bin/python3'), 'existing RUNZ1 fixture requires python3');
  const home = mkdtempSync(join(tmpdir(), 'hud-runz1-kill-'));
  const child = spawn('/usr/bin/python3', [resolve('tests/unit/runz1-fixture.py'), home, 'zombie'], {
    detached: true,
    env: { ...process.env, HOME: home, HUD_HOME: join(home, 'hud') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let capture: ReturnType<typeof captureKill> | undefined;
  let data: ReturnType<typeof seedRun> | undefined;
  let port: MemoryRunFactPort | undefined;
  try {
    const ready = once(child.stdout, 'data');
    const deadline = setTimeout(() => child.stdin.end('cleanup\n'), 5000);
    try {
      await Promise.race([
        ready,
        exited.then(() => {
          throw new Error(`fixture exited before ready: ${stderr}`);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    const leader = readProcess(Number(readFileSync(join(home, 'leader'), 'utf8')));
    assert.ok(leader, 'positively identified live original leader');
    assert.equal(processState(leader.stamp), 'alive');
    const scope: ProcessScope = {
      scope_id: 'synthetic-runz1-kill',
      scope_kind: 'pgid',
      ...currentDomain(),
      pgid: leader.pgid,
      sid: leader.sid,
      group_leader: leader.stamp,
    };
    data = seedRun(home, ['/synthetic/harness']);
    port = new MemoryRunFactPort(data.seed);
    capture = captureKill(port, () => data!.seed.snapshot);
    const { run } = data.seed.snapshot;
    await port.register(run.runId, data.ticket, run.launchDigest, leader.stamp);
    await port.phase(run.runId, leader.stamp, 'submitting');
    await port.phase(run.runId, leader.stamp, 'submitted');
    await port.startup(run.runId, leader.stamp, {
      schema_version: 1,
      run_id: run.runId,
      link_id: run.linkId,
      source_id: run.sourceId,
      binding_generation: run.expectedGeneration,
      mode: 'headless',
      supervision_strategy: 'headless',
      supervisor: leader.stamp,
      command_leader: leader.stamp,
      harness: leader.stamp,
      scope,
      launch_digest: run.launchDigest,
      profile_digest: data.input.profileDigest,
      launch_call_id: 'synthetic-call',
      launch_correlation_id: 'synthetic-correlation',
      created_at: run.createdAt,
      stdin_mode: 'closed',
      capture: 'file',
      launch_cwd: home,
      project_origin: null,
    });
    const control = new HeadlessRunControl(
      port,
      home,
      { kind: 'trusted_local', uid: process.getuid!(), invocationId: 'synthetic-runz1-kill' },
      capture.launcher
    );
    await control.reconcile(run.runId);
    const live = await port.read(run.runId);
    assert.equal(processState(leader.stamp), 'alive');
    assert.equal(assertKillEvidence(capture.records, live, null), 'incomplete-proof');
    assert.ok(!live.facts.some((e) => e.fact.kind === 'receipt' || e.fact.kind === 'scope_reconciled'));
    saveKillCapture('controlled-live', capture.records, live, home);

    // Fixed original identity, event barriers, then an explicit single reconcile.
    // No mocked proof, injected Q, optimistic sleep, or polling for a passing proof.
    writeFileSync(join(home, 'terminate'), 'go');
    await barrier(() => readProcess(leader.stamp.pid)?.state === 'Z', 'leader terminated');
    child.stdin.write('reap\n');
    await barrier(() => existsSync(join(home, 'reaped')), 'owned leader reaped');
    assert.equal(processState(leader.stamp), 'dead');
    assert.throws(() => process.kill(-scope.pgid, 0), { code: 'ESRCH' });
    await control.reconcile(run.runId);
    const ended = await port.read(run.runId);
    assert.equal(assertKillEvidence(capture.records, ended, null), 'receiptless-Q');
    assert.equal(ended.run.state, 'ended');
    assert.deepEqual(ended.meta, live.meta, 'same fixed startup identity throughout');
    assert.equal(existsSync(join(home, 'runs', run.runId, 'exit.json')), false);
    const oldPredicate = () => {
      if (!ended.receipt) assert.equal(ended.slotHeld, true);
    };
    assert.throws(oldPredicate, { name: 'AssertionError', code: 'ERR_ASSERTION', actual: false, expected: true });
    console.log('RUNZ1-KILL legacy assertion rejected actual valid receiptless Q: false !== true');

    for (const mutation of ['remove-Q', 'incomplete-Q', 'wrong-binding'] as const) {
      const forged = structuredClone(capture.records) as KillRecord[];
      const final = structuredClone(ended);
      const mutate = (facts: ReconcileEvidence[]) =>
        facts.flatMap((e) => {
          if (e.fact.kind !== 'scope_reconciled') return [e];
          if (mutation === 'remove-Q') return [];
          if (mutation === 'wrong-binding') return [{ ...e, runId: 'wrong-synthetic-run' }];
          return [{ ...e, fact: { ...e.fact, harnessTerminated: false } }];
        });
      for (const record of forged) {
        if (record.before) record.before.facts = mutate(record.before.facts);
        if (record.after) record.after.facts = mutate(record.after.facts);
        if (record.operation === 'reconcile') {
          const input = record.input as [string, number, ReconcileEvidence[], number];
          input[2] = mutate(input[2]);
        }
      }
      final.facts = mutate(final.facts);
      assert.throws(() => assertKillEvidence(forged, final, null), assert.AssertionError);
      console.log(
        `RUNZ1-KILL assertion negative control rejected ${mutation}; cloned description, not a production defect`
      );
    }
    exerciseHeldControls(capture.records, ended);
    const beforeIdempotence = structuredClone(ended);
    await control.reconcile(run.runId);
    const repeated = await port.read(run.runId);
    assert.equal(assertKillEvidence(capture.records, repeated, null), 'receiptless-Q');
    assert.equal(repeated.run.state, beforeIdempotence.run.state);
    assert.equal(repeated.run.endedAt, beforeIdempotence.run.endedAt);
    assert.equal(repeated.run.terminalEvidenceId, beforeIdempotence.run.terminalEvidenceId);
    assert.equal(repeated.status.terminalNote, beforeIdempotence.status.terminalNote);
    assert.equal(capture.records.filter((r) => r.operation === 'group.launch').length, 0);
    assert.equal(capture.records.filter((r) => r.operation === 'receipt').length, 0);
    saveKillCapture('controlled-Q', capture.records, repeated, home);
  } finally {
    try {
      if (capture && port && data)
        saveKillCapture('controlled-final', capture.records, await port.read(data.input.runId), home);
    } finally {
      child.stdin.end('cleanup\n');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const [code, signal] = await exited;
        assert.equal(code, 0, `owned fixture cleanup: ${signal} ${stderr}`);
      } finally {
        clearTimeout(timer);
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

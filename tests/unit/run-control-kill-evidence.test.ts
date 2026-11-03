import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import type { ReconcileEvidence, ReconcileFact } from '../../src/core/types/execution.js';
import type { ProcessScope } from '../../src/core/types/supervision.js';
import { seedRun } from '../run/fixtures.js';
import { fixtureRun, FIXTURE_NOW } from '../fixtures/contracts/identity-execution.js';
import {
  assertCompletionEvidence,
  assertKillEvidence,
  captureKill,
  saveKillCapture,
  type KillRecord,
} from './run-control-kill-fixture.js';

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

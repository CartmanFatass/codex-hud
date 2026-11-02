import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { notifyFixture, nextIntent, acceptIntent, reportFor, factEvidence, completion } from './b21-fixture.js';
import { capacityProjection } from '../../src/core/capacity.js';
import { loadLimits } from '../../src/core/link/limits.js';
import { openLinkLedgerReader } from '../../src/core/link-ledger-read.js';
import { projectLinkTree } from '../../src/core/link/index.js';
import { linkExecution } from '../../src/core/link/execution.js';
import { reconcileDescriptor } from '../../src/core/link/actions.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { readCapacity } from '../../src/ledger/intents.js';
import { sessionOwnerKey } from '../../src/core/identity.js';
import { insertRecord } from '../../src/ledger/records.js';
const options = { skip: !ledgerRuntimeSupported() };

async function snapshot(f: Awaited<ReturnType<typeof notifyFixture>>) {
  const reader = await openLinkLedgerReader(join(f.root, 'ledger.sqlite'));
  try {
    const read = reader.read();
    assert.equal(read.state, 'available');
    return read.snapshot;
  } finally {
    reader.close();
  }
}

test('B10A capacity full shares admission counting on real SQLite and retains every occupant', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  for (let i = 0; i < 3; i++) assert.ok((await acceptIntent(f.ledger, nextIntent(f, `capacity-${i}`))).runId);
  const s = await snapshot(f);
  const view = capacityProjection(s.runs, s.links, f.parent.ref);
  const admitted = f.ledger.snapshot((tx) => readCapacity(tx, sessionOwnerKey(f.parent.ref)));
  assert.equal(view.full, true);
  assert.equal(view.mine, 4);
  assert.equal(view.mineLimit, 4);
  assert.equal(view.active, 4);
  assert.equal(view.limit, 6);
  assert.deepEqual(view.occupants, admitted.occupants);
  assert.equal(
    capacityProjection(
      s.runs,
      s.links.map((link) => ({ ...link, parentRef: null })),
      f.parent.ref
    ).mine,
    0
  );
});

test('B10A uncertain occupant holds capacity and exposes reconciliation cause/missing', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await f.ledger.transaction((tx) => {
    tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'");
    insertRecord(tx, 'events', {
      runId: 'run-a',
      linkId: 'link-a',
      kind: 'run.reconciliation',
      payload: { cause: 'supervisor_dead' },
      at: 1100,
    });
  });
  const s = await snapshot(f);
  const run = s.runs[0];
  assert.equal(capacityProjection(s.runs, s.links, f.parent.ref).occupants[0].state, 'uncertain');
  assert.deepEqual(linkExecution(run, s.events).reconciliation, {
    cause: 'supervisor_dead',
    missing: ['supervisor_dead'],
  });
});

test('B10A visible cancelling remains nonterminal and holds its slot', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const input = nextIntent(f, 'visible');
  input.run.mode = 'visible';
  input.params.mode = 'visible';
  input.run.supervisionStrategy = 'wrapper';
  await acceptIntent(f.ledger, input);
  await f.ledger.transaction((tx) =>
    tx.run("UPDATE runs SET state='cancelling',cancel_requested_at=1100 WHERE run_id='run-visible'")
  );
  const s = await snapshot(f);
  const tree = projectLinkTree({
    ledger: { state: 'available', snapshot: s, claimChecks: [], conflictTargets: new Map(), reason: null },
    roots: [{ kind: 'delegationIntent', linkId: 'link-visible' }],
    sessions: [],
    nowMs: 1200,
  });
  const node = tree.nodes.find((node) => node.currentRun?.runId === 'run-visible')!;
  assert.equal(node.currentRun?.mode, 'visible');
  assert.equal(node.currentRun?.state, 'cancelling');
  assert.equal(node.execution.isRunTerminal, false);
  assert.equal(capacityProjection(s.runs, s.links, f.parent.ref).active, 2);
});

test('B10A completed visible run waits for close with accepted report and capacity intact', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await reportFor(f, 'completed');
  const input = nextIntent(f, 'visible');
  input.run.mode = 'visible';
  input.params.mode = 'visible';
  input.run.supervisionStrategy = 'wrapper';
  await acceptIntent(f.ledger, input);
  const prior = await snapshot(f);
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'child_bindings', { ...prior.bindings[0], bindingId: 'binding-visible', runId: 'run-visible' });
    insertRecord(tx, 'reports', {
      ...prior.reports[0],
      reportId: 'report-visible',
      runId: 'run-visible',
      linkId: 'link-visible',
      childBindingId: 'binding-visible',
    });
    insertRecord(tx, 'events', {
      runId: 'run-visible',
      linkId: 'link-visible',
      kind: 'report.received',
      payload: { reportId: 'report-visible' },
      at: 1100,
    });
  });
  const s = await snapshot(f);
  assert.equal(s.reports[0].status, 'completed');
  assert.equal(s.runs.find((r) => r.runId === 'run-visible')!.mode, 'visible');
  assert.equal(linkExecution(s.runs[0], s.events).isRunTerminal, false);
  assert.equal(capacityProjection(s.runs, s.links, f.parent.ref).active, 2);
});

test('B10A terminal evidence follows newest exact-run event and old writers remain null', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const termination = {
    outcome: 'completed',
    requestedCause: 'retire_after_report',
    attribution: 'unknown',
    observed: { exitCode: null, signal: null, escalatedTo: 'INT', scopeEvidence: 'Q' },
  };
  await commitReconcile(
    f.ledger,
    readReconcileSnapshot(f.ledger, 'run-a'),
    [factEvidence(f, 'terminal-b10a', completion, 1200)],
    1200
  );
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'events', {
      runId: 'run-a',
      linkId: 'link-a',
      kind: 'run.terminal',
      payload: { terminalNote: 'retire_timing_unknown', termination },
      at: 1200,
    });
  });
  const s = await snapshot(f);
  assert.deepEqual(linkExecution(s.runs[0], s.events).terminal, { note: 'retire_timing_unknown', termination });
  const old = s.events.map((e) => (e.kind === 'run.terminal' ? { ...e, payload: { terminalNote: 'future' } } : e));
  assert.deepEqual(linkExecution(s.runs[0], old).terminal, { note: null, termination: null });
  assert.equal(capacityProjection(s.runs, s.links, f.parent.ref).active, 0);
});

test(
  'B10A limits loader defaults/configures safely and copy-only reconcile safely quotes HUD_HOME',
  options,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    assert.deepEqual(loadLimits(f.root), {
      limits: { maxActiveRuns: 6, maxActiveRunsPerOwner: 4 },
      source: 'default',
      reason: null,
    });
    writeFileSync(join(f.root, 'delegate.json'), JSON.stringify({ version: 1, limits: { maxActiveRuns: 8 } }));
    assert.equal(loadLimits(f.root).limits.maxActiveRuns, 8);
    assert.equal(loadLimits(f.root).source, 'configured');
    writeFileSync(join(f.root, 'delegate.json'), JSON.stringify({ version: 1, limits: { maxActiveRuns: 0 } }));
    assert.equal(loadLimits(f.root).reason, 'limits_unavailable');
    const home = "/tmp/synthetic ' home $(exit 9) `exit 8`";
    const action = reconcileDescriptor(home, 'link-a', 'run-a');
    const result = spawnSync(
      '/bin/sh',
      ['-c', 'hud() { printf "%s\\n" "$HUD_HOME" "$@"; }; ' + action.displayCommand],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, home + '\nrun\nreconcile\nrun-a\n');
    assert.equal(action.delivery, 'copy_only');
    assert.throws(() => reconcileDescriptor('/tmp/synthetic', 'link-a', '--bad'));
  }
);

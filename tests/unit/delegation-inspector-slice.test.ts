import assert from 'node:assert/strict';
import test from 'node:test';
import { stripAnsi } from '../../src/render/colors.js';
import { buildVm, NOW, S } from '../fixtures/b10b-delegation.js';
import { draw, press } from '../fixtures/b10b-s3.js';

function inspect(vm: ReturnType<typeof buildVm>['vm'], key: string) {
  const frame = draw(vm, { selected: key, width: 110, height: 40 });
  const opened = press(frame, 'enter');
  assert.equal(opened.state.preview, 'agent');
  return draw(vm, { state: opened.state, width: 110, height: 40 }).lines.map(stripAnsi).join('\n');
}

test('delegation Inspector uses selected node observation and reports, never the other node', () => {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(), label: null },
    {
      id: 'one',
      parent: 'main',
      harness: 'codex',
      label: 'selected-one',
      status: S.working(),
      model: 'model-one',
      report: { status: 'completed', summary: 'report-one', at: 10 },
    },
    {
      id: 'two',
      parent: 'main',
      harness: 'codex',
      label: 'other-two',
      status: S.working(),
      model: 'model-two',
      report: { status: 'failed', summary: 'report-two', at: 10 },
    },
  ]);
  const text = inspect(built.vm, built.keys.one);
  assert.match(text, /selected-one/);
  assert.match(text, /model-one/);
  assert.match(text, /report-one/);
  assert.doesNotMatch(text, /model-two|report-two/);
  assert.match(text, /Action: unavailable/);
  assert.match(text, /Output rate: unavailable/);
});

test('missing current observation is not replaced by previous-run model', () => {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(), label: null },
    { id: 'one', parent: 'main', harness: 'codex', label: 'target', status: S.working(), model: 'old-secret' },
  ]);
  const node = built.vm.tree.nodes.find((item) => item.key === built.keys.one)!;
  node.lastObservation = node.observation;
  node.observation = null;
  const text = inspect(built.vm, built.keys.one);
  assert.match(text, /No current observation/);
  assert.doesNotMatch(text, /old-secret/);
});

test('root coverage keeps omitted as a subset and unknown descendants uncounted', () => {
  const built = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working(), label: null }]);
  built.vm.tree.counts.knownUnloaded = 3;
  built.vm.tree.counts.omitted = 1;
  built.vm.tree.counts.unknownDescendants = true;
  const text = inspect(built.vm, built.keys.main);
  assert.match(text, /Known not loaded: 3 · including omitted: 1/);
  assert.match(text, /Children unknown/);
});

test('degraded ledger does not present absent retained reports as confirmed empty', () => {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(), label: null },
    { id: 'one', parent: 'main', harness: 'codex', label: 'target', status: S.working() },
  ]);
  built.vm.tree.ledger.state = 'degraded';
  built.vm.tree.ledger.reason = 'ledger_busy';
  const text = inspect(built.vm, built.keys.one);
  assert.match(text, /ledger_busy · retained view/);
  assert.doesNotMatch(text, /none yet/);
});

test('Inspector explains disabled Open and the copy-only recovery in the selected frame', () => {
  const built = buildVm([
    { id: 'main', root: true, status: S.working() },
    { id: 'stale', parent: 'main', run: { mode: 'visible' }, hostCheck: 'stale', status: S.working() },
    { id: 'mismatch', parent: 'main', run: { mode: 'visible' }, hostCheck: 'mismatch', status: S.working() },
    {
      id: 'uncertain',
      parent: 'main',
      run: { mode: 'visible', state: 'uncertain' },
      pane: '4',
      status: { cls: 'uncertain', reason: 'scope_unknown' },
      reconcile: true,
    },
    {
      id: 'ended',
      parent: 'main',
      run: { state: 'ended', endedAt: NOW },
      status: S.exited(NOW),
      report: { status: 'completed', at: NOW },
    },
  ]);
  assert.match(inspect(built.vm, built.keys.stale), /Open unavailable · locator stale/);
  assert.match(inspect(built.vm, built.keys.mismatch), /Open unavailable · occupant mismatch/);
  const uncertain = inspect(built.vm, built.keys.uncertain);
  assert.match(uncertain, /Open unavailable · run uncertain/);
  assert.match(uncertain, /Reconcile available · copy only/);
  assert.doesNotMatch(uncertain, /HUD_HOME|hud run reconcile/);
  assert.match(inspect(built.vm, built.keys.ended), /resume not verified on this machine/);
});

test('root Inspector reports conflict rows omitted by the projection', () => {
  const built = buildVm([
    { id: 'main', root: true, status: S.working() },
    ...Array.from({ length: 204 }, (_, i) => ({
      id: `conflict-${i}`,
      parent: 'main',
      relationOnly: true,
      conflict: { count: 2, since: 10 },
    })),
  ]);
  assert.match(inspect(built.vm, built.keys.main), /Conflict rows not shown: 5/);
});

test('Inspector presents the selected run reconciliation cause without inventing missing evidence', () => {
  const built = buildVm([
    { id: 'main', root: true, status: S.working() },
    {
      id: 'uncertain',
      parent: 'main',
      runSeq: 3,
      run: { mode: 'visible', state: 'uncertain', reconciliation: 'scope_unknown', heartbeatAt: 1700000000000 },
      status: { cls: 'uncertain', reason: 'scope_unknown' },
      reconcile: true,
    },
    { id: 'other', parent: 'main', run: { reconciliation: 'supervisor_dead' }, status: S.working() },
  ]);
  const text = inspect(built.vm, built.keys.uncertain);
  assert.match(text, /Run sequence: 3/);
  assert.match(text, /Heartbeat: 2023-11-14T22:13:20.000Z/);
  assert.match(text, /Reconciliation cause: scope unknown/);
  assert.doesNotMatch(text, /supervisor dead|missing:|Exit:/);
});

test('visible cancellation explains that automatic delivery is unavailable', () => {
  const built = buildVm([
    { id: 'main', root: true, status: S.working() },
    {
      id: 'visible',
      parent: 'main',
      run: { mode: 'visible', state: 'cancelling', cancelRequestedAt: 100 },
      status: S.working(),
      report: { status: 'failed', at: 100 },
    },
    {
      id: 'headless',
      parent: 'main',
      run: { mode: 'headless', state: 'cancelling', cancelRequestedAt: 100 },
      status: S.working(),
    },
  ]);
  assert.match(inspect(built.vm, built.keys.visible), /Still running — automatic cancellation is unavailable/);
  assert.doesNotMatch(inspect(built.vm, built.keys.headless), /automatic cancellation is unavailable/);
});

test('terminal Inspector separates outcome, cause, attribution and sourced exit', () => {
  const built = buildVm([
    { id: 'main', root: true, status: S.working() },
    {
      id: 'ended',
      parent: 'main',
      run: { state: 'ended', endedAt: Date.now(), exit: { code: 1, signal: null, source: 'wait_status' } },
      status: S.exited(Date.now()),
    },
  ]);
  const node = built.vm.tree.nodes.find((item) => item.key === built.keys.ended)!;
  node.execution.terminal = {
    note: 'cancel_timing_unknown',
    termination: {
      outcome: 'completed',
      requestedCause: 'user_cancel',
      attribution: 'unknown',
      observed: { exitCode: 1, signal: null, escalatedTo: null, scopeEvidence: 'Q' },
    },
  };
  const text = inspect(built.vm, built.keys.ended);
  assert.match(text, /Outcome: completed/);
  assert.match(text, /Requested cause: user cancel/);
  assert.match(text, /Attribution: unknown/);
  assert.match(text, /Terminal note: cancel timing unknown/);
  assert.match(text, /Exit: 1 \(wait_status\)/);
  node.currentRun!.exitSource = null;
  const unknown = inspect(built.vm, built.keys.ended);
  assert.match(unknown, /Exit: unavailable/);
  assert.doesNotMatch(unknown, /Exit: 1/);
});

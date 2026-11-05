import assert from 'node:assert/strict';
import test from 'node:test';
import { stripAnsi } from '../../src/render/colors.js';
import { buildVm, S } from '../fixtures/b10b-delegation.js';
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

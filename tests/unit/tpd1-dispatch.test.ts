import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifacts } from '../../src/core/run/artifacts.js';
import {
  dispatchDelegationAction,
  delegationPickerLabel,
  withInputRefresh,
  delegationActivityTarget,
} from '../../src/utils/delegation-actions.js';
import { S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { draw, press } from '../fixtures/b10b-s3.js';

const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(300)), label: null };
function view(mode: 'headless' | 'visible', reconcile = false) {
  const built = buildVm([
    root,
    {
      id: 'worker',
      parent: 'main',
      harness: 'codex',
      label: 'worker',
      status: S.working(ago(100)),
      run: { state: 'running', mode },
      reconcile,
      pane: 'pane 4',
    },
  ]);
  const frame = draw(built.vm, { selected: built.keys.worker, width: 80, height: 24 });
  return { ...built, frame };
}
test('R from the displayed frame copies exactly the displayed descriptor, and stale selection refuses', async () => {
  const { vm, frame } = view('headless', true);
  const action = press(frame, 'resume-reconcile').action;
  assert.equal(action?.type, 'delegation-copy');
  if (!action || action.type !== 'delegation-copy') throw new Error('missing action');
  const seen: string[] = [];
  const ports = {
    home: '/nonexistent',
    copy: async (text: string) => {
      seen.push(text);
      return true;
    },
  };
  assert.equal(
    await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports),
    'Reconcile command copied.'
  );
  assert.deepEqual(seen, [action.descriptor.displayCommand]);
  assert.match(await dispatchDelegationAction(action, frame.delegation?.vm, vm, false, ports), /changed/);
  assert.equal(seen.length, 1);
});
test('L from the displayed frame exposes a verified log path; missing logs are unavailable', async () => {
  const { vm, frame } = view('headless');
  const action = press(frame, 'log').action;
  assert.equal(action?.type, 'delegation-log');
  if (!action || action.type !== 'delegation-log') throw new Error('missing action');
  const home = mkdtempSync(join(tmpdir(), 'tpd1-'));
  try {
    const node = vm.tree.nodes.find((n) => n.key === action.key)!;
    const artifacts = RunArtifacts.create(home, node.currentRun!.runId);
    const logs = artifacts.openLogs();
    closeSync(logs.stdout);
    closeSync(logs.stderr);
    const ports = { home, copy: async () => false };
    assert.equal(
      await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports),
      `Log: ${join(artifacts.directory, 'stdout.log')}`
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('o uses the host interface and rechecks current selection after locate', async () => {
  const { vm, frame } = view('visible');
  const action = press(frame, 'open-session').action;
  assert.equal(action?.type, 'delegation-open');
  if (!action || action.type !== 'delegation-open') throw new Error('missing action');
  const calls: string[] = [];
  const host = {
    locate: async (_target: unknown) => {
      calls.push('locate');
      return {} as never;
    },
    focus: async (_locator: never) => {
      calls.push('focus');
    },
  };
  const ports = { home: '/nonexistent', copy: async () => false, host, isCurrent: () => true };
  assert.equal(await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports), 'Opened run.');
  assert.deepEqual(calls, ['locate', 'focus']);
  ports.isCurrent = () => false;
  assert.match(await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports), /changed/);
  assert.deepEqual(calls, ['locate', 'focus', 'locate']);
});

test('narrow picker labels reject whitespace and main collisions', () => {
  const built = buildVm([
    { ...root, harness: 'codex' },
    { id: 'a', parent: 'main', native: true, harness: 'codex', label: 'a', status: S.working(ago(10)) },
    { id: 'b', parent: 'main', native: true, harness: 'codex', label: 'b', status: S.working(ago(10)) },
  ]);
  const a = built.vm.tree.nodes.find((n) => n.key === built.keys.a)!;
  const b = built.vm.tree.nodes.find((n) => n.key === built.keys.b)!;
  a.native = { title: 'a', kind: null, pickerLabel: 'alpha beta' };
  b.native = { title: 'b', kind: null, pickerLabel: 'alphabeta' };
  assert.equal(delegationPickerLabel(built.vm, 'main-0001', 'a-0001'), undefined);
  b.native.pickerLabel = 'Main[default]';
  assert.equal(delegationPickerLabel(built.vm, 'main-0001', 'main-0001'), undefined);
  b.native.pickerLabel = 'other';
  assert.equal(delegationPickerLabel(built.vm, 'main-0001', 'main-0001'), 'Main [default]');
});

test('input dispatch acts on its drawn epoch before requesting refresh', async () => {
  const { vm, frame } = view('headless', true);
  let epoch = 7;
  const drawnEpoch = epoch;
  let copied = '';
  const result = withInputRefresh(
    true,
    () => {
      const action = press(frame, 'resume-reconcile').action;
      if (!action || action.type !== 'delegation-copy') throw new Error('missing action');
      return dispatchDelegationAction(action, frame.delegation?.vm, vm, epoch === drawnEpoch, {
        home: '/nonexistent',
        copy: async (text) => {
          copied = text;
          return true;
        },
      });
    },
    () => {
      epoch++;
    }
  );
  assert.equal(await result, 'Reconcile command copied.');
  assert.ok(copied);
  assert.equal(epoch, 8);
});

test('activity target uses projected keys and refuses missing or ambiguous identities', () => {
  const { vm } = view('headless');
  const node = vm.tree.nodes.find((n) => n.identity.kind === 'session' && n.identity.ref.sessionId === 'worker-0001')!;
  assert.deepEqual(delegationActivityTarget(vm, 'main-0001', 'worker-0001'), { root: false, key: node.key });
  assert.deepEqual(delegationActivityTarget(vm, 'main-0001', 'main-0001'), { root: true, key: null });
  assert.equal(delegationActivityTarget(vm, 'main-0001', 'missing'), null);
  vm.tree.nodes.push({ ...node, key: 'duplicate' });
  assert.equal(delegationActivityTarget(vm, 'main-0001', 'worker-0001'), null);
});

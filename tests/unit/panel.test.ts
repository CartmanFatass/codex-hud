/**
 * The subagent panel: what it shows, what it hides, and what it refuses to
 * claim. The rule under test throughout is that an agent nobody has heard
 * from is reported as unheard-from, not as running and not as finished.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyKey,
  countExpired,
  initialPanelState,
  reconcileSelection,
  visibleRows,
  type PanelState,
} from '../../src/render/panel-state.js';
import { renderPanelPlain, formatAge } from '../../src/render/subagent-tree-view.js';
import { summarizeSubagents } from '../../src/collectors/subagent-tree.js';
import { parseTreeKey } from '../../src/utils/tree-keys.js';
import { FIXED_NOW, makeNestedTree, node, treeOf, at } from '../fixtures/hud-data.js';

const NOW = FIXED_NOW.getTime();

function stateWith(overrides: Partial<PanelState> = {}): PanelState {
  return { ...initialPanelState(), ...overrides };
}

test('an agent with no observed events is neither running nor done', () => {
  const summary = summarizeSubagents(makeNestedTree().nodes);
  assert.equal(summary.total, 6);
  assert.equal(summary.running, 1);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 2);
  assert.equal(summary.active, 1, 'unknown agents must not inflate the running count');
});

test('collapsing a branch hides its descendants', () => {
  const tree = makeNestedTree();
  const open = visibleRows(tree.nodes, stateWith());
  assert.deepEqual(open.map((row) => row.node.id), ['a1', 'a1b1', 'a1b2', 'a1b2c1', 'a2', 'a3']);

  const folded = visibleRows(tree.nodes, stateWith({ collapsed: new Set(['a1']) }));
  assert.deepEqual(folded.map((row) => row.node.id), ['a1', 'a2', 'a3']);
});

test('a filter keeps the ancestors that locate a match', () => {
  const tree = makeNestedTree();
  const rows = visibleRows(tree.nodes, stateWith({ filter: 'failed' }));

  assert.deepEqual(rows.map((row) => row.node.id), ['a1', 'a1b2']);
  assert.equal(rows[0].context, true, 'the parent is shown only as context');
  assert.equal(rows[1].context, false, 'the failing agent is the match');
});

test('the unknown filter finds agents nobody has heard from', () => {
  const rows = visibleRows(makeNestedTree().nodes, stateWith({ filter: 'unknown' }));
  const matches = rows.filter((row) => !row.context).map((row) => row.node.id);
  assert.deepEqual(matches, ['a1b2c1', 'a3']);
});

test('the selection follows the agent, not the row', () => {
  const before = makeNestedTree();
  let state = stateWith({ selectedId: 'a2' });

  // A new agent appears above the selection.
  const after = treeOf([node('a0', 'newcomer', 'running'), ...before.nodes]);
  state = reconcileSelection(state, after.nodes, visibleRows(after.nodes, state));
  assert.equal(state.selectedId, 'a2', 'a new sibling must not steal the selection');
});

test('a selection whose agent leaves the tree falls back to the first row', () => {
  const tree = treeOf([node('a1', 'explorer', 'running')]);
  const state = reconcileSelection(stateWith({ selectedId: 'gone' }), tree.nodes, visibleRows(tree.nodes, stateWith()));
  assert.equal(state.selectedId, 'a1');
});

test('a filtered-out agent keeps the selection', () => {
  const tree = makeNestedTree();
  const state = stateWith({ selectedId: 'a2', filter: 'failed' });
  const reconciled = reconcileSelection(state, tree.nodes, visibleRows(tree.nodes, state));
  assert.equal(reconciled.selectedId, 'a2', 'hiding a row is not the same as losing the agent');
});

test('left folds an open branch then steps out to the parent', () => {
  const tree = makeNestedTree();
  let state = stateWith({ selectedId: 'a1' });

  state = applyKey(state, 'left', visibleRows(tree.nodes, state)).state;
  assert.ok(state.collapsed.has('a1'), 'the first press folds');

  state = applyKey(state, 'right', visibleRows(tree.nodes, state)).state;
  assert.ok(!state.collapsed.has('a1'), 'right unfolds it again');

  state = { ...state, selectedId: 'a1b1' };
  state = applyKey(state, 'left', visibleRows(tree.nodes, state)).state;
  assert.equal(state.selectedId, 'a1', 'a leaf steps out to its parent');
});

test('enter opens the detail and escape walks back out', () => {
  const tree = makeNestedTree();
  let state = stateWith({ selectedId: 'a1b2' });

  state = applyKey(state, 'open', visibleRows(tree.nodes, state)).state;
  assert.equal(state.view, 'detail');

  const back = applyKey(state, 'back', visibleRows(tree.nodes, state));
  assert.equal(back.state.view, 'tree');
  assert.equal(back.close, false);

  const top = applyKey(back.state, 'back', visibleRows(tree.nodes, back.state));
  assert.equal(top.close, true, 'escape from the tree closes the panel');
});

test('the filter key cycles through the states', () => {
  const rows = visibleRows(makeNestedTree().nodes, stateWith());
  let state = stateWith();
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    state = applyKey(state, 'filter', rows).state;
    seen.push(state.filter);
  }
  assert.deepEqual(seen, ['active', 'failed', 'unknown', 'all']);
});

test('arrow keys and vi keys reach the same actions', () => {
  assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x41])), 'up');
  assert.equal(parseTreeKey(Buffer.from('k')), 'up');
  assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x42])), 'down');
  assert.equal(parseTreeKey(Buffer.from('j')), 'down');
  assert.equal(parseTreeKey(Buffer.from([0x1b, 0x5b, 0x44])), 'left');
  assert.equal(parseTreeKey(Buffer.from('h')), 'left');
  assert.equal(parseTreeKey(Buffer.from('\r')), 'open');
  assert.equal(parseTreeKey(Buffer.from([0x1b])), 'back');
  assert.equal(parseTreeKey(Buffer.from('q')), 'close');
  assert.equal(parseTreeKey(Buffer.from([0x03])), 'close');
});

test('a name containing q does not close the panel', () => {
  assert.equal(parseTreeKey(Buffer.from('aq')), 'none');
});

test('the panel names failure and silence differently', () => {
  const tree = makeNestedTree();
  const failed = renderPanelPlain({
    tree,
    state: stateWith({ view: 'detail', selectedId: 'a1b2' }),
    maxWidth: 40,
    nowMs: NOW,
  });
  assert.match(failed, /failed/);

  const silent = renderPanelPlain({
    tree,
    state: stateWith({ view: 'detail', selectedId: 'a3' }),
    maxWidth: 40,
    nowMs: NOW,
  });
  assert.match(silent, /no events seen/);
  assert.doesNotMatch(silent, /running|finished|stuck/);
});

test('the header counts success and failure separately', () => {
  const page = renderPanelPlain({
    tree: makeNestedTree(),
    state: stateWith(),
    maxWidth: 60,
    nowMs: NOW,
  });
  assert.match(page, /1 run/);
  assert.match(page, /2 ok/);
  assert.match(page, /1 fail/);
  assert.match(page, /2 \?/);
  assert.doesNotMatch(page, /done/);
});

test('freshness is reported as an age, never as a verdict', () => {
  assert.equal(formatAge(at(-18), NOW), '18s ago');
  assert.equal(formatAge(at(-12 * 60), NOW), '12m ago');
  assert.equal(formatAge(at(-3 * 3600), NOW), '3h ago');
  assert.equal(formatAge(undefined, NOW), null);
});

test('the session view shows plan steps and recorded tool results', () => {
  const page = renderPanelPlain({
    tree: makeNestedTree(),
    state: stateWith({ view: 'session' }),
    maxWidth: 40,
    nowMs: NOW,
    planProgress: {
      steps: [
        { step: 'Read collectors', status: 'completed' },
        { step: 'Add engine', status: 'in_progress' },
      ],
      completedSteps: 1,
      totalSteps: 2,
      lastUpdate: FIXED_NOW,
    },
    toolActivity: {
      recentCalls: [
        { id: 'c1', name: 'Bash', timestamp: at(-30), status: 'error', target: 'npm test', duration: 4200 },
      ],
      totalCalls: 1,
      callsByType: { Bash: 1 },
      lastUpdateTime: FIXED_NOW,
    },
  });
  assert.match(page, /Tasks 1\/2/);
  assert.match(page, /Read collectors/);
  assert.match(page, /Bash/);
  assert.match(page, /npm test/);
});

test('the panel fits its column at every width it is given', () => {
  for (const width of [18, 20, 24, 32, 40]) {
    for (const view of ['tree', 'detail', 'session', 'help'] as const) {
      const lines = renderPanelPlain({
        tree: makeNestedTree(),
        state: stateWith({ view, selectedId: 'a1b2' }),
        maxWidth: width,
        nowMs: NOW,
      }).split('\n');
      for (const line of lines) {
        assert.ok(line.length <= width, `${view} at ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
});

test('finished agents leave the unfiltered view once the linger window passes', () => {
  const minute = 60_000;
  const tree = treeOf([
    node('run', 'live', 'running'),
    { ...node('fresh', 'fresh', 'completed'), statusAt: new Date(NOW - 1 * minute) },
    { ...node('old', 'old', 'completed'), statusAt: new Date(NOW - 10 * minute) },
    { ...node('failed', 'failed', 'error'), statusAt: new Date(NOW - 60 * minute) },
    { ...node('quiet', 'quiet', 'unknown'), lastEventAt: new Date(NOW - 10 * minute) },
    {
      ...node('parent', 'parent', 'completed', { children: [node('child', 'child', 'running', { depth: 2 })] }),
      statusAt: new Date(NOW - 30 * minute),
    },
  ]);
  const state = stateWith({ lingerMs: 3 * minute });
  const ids = (s: PanelState) => visibleRows(tree.nodes, s, NOW).map((row) => row.node.id);
  assert.deepEqual(ids(state), ['run', 'fresh', 'failed', 'parent', 'child']);
  const parent = visibleRows(tree.nodes, state, NOW).find((row) => row.node.id === 'parent')!;
  assert.equal(parent.context, true, 'a long-finished parent stays only to show whose child is running');
  assert.equal(countExpired(tree.nodes, state, NOW), 2);
  assert.equal(ids({ ...state, showAll: true }).length, 7);
  assert.equal(ids({ ...state, lingerMs: 0 }).length, 7, 'zero keeps every agent');
  assert.deepEqual(ids({ ...state, filter: 'unknown' }), ['quiet'], 'an explicit filter shows every match');
  assert.deepEqual(ids(state).slice(0, 2), ids({ ...state, lingerMs: 3 * minute }).slice(0, 2));
});

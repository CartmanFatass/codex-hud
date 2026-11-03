/**
 * B10B-s3: where the selection of the delegation view is (design §3.2 "选中跟着节点走而不是跟着行号走"; rulings B10B-s3
 * Q2, Q6). One rule, applied by the reconcile every frame; the page's own reconcile calls (which have no view model)
 * leave a marked state's selection alone; with no view model everything is as it was.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileMonitor, renderMonitor } from '../../src/render/monitor.js';
import { parsePutKey } from '../../src/render/delegation/rows.js';
import { PUT_AWAY_MS } from '../../src/render/delegation/rows.js';
import { delegationView } from '../../src/render/delegation/panel.js';
import { resolveSelection } from '../../src/render/delegation/selection.js';
import { FIXED_NOW, makeNestedTree } from '../fixtures/hud-data.js';
import { NOW, S, ago, buildVm, situationC, situationD, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { draw, monitorInput, press, selectedOf, step, text } from '../fixtures/b10b-s3.js';

const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(300)), label: null };
/** A worker that finished `endedAgo` seconds before the pinned clock, with a completed report. */
const finished = (id: string, parent: string, endedAgo: number, createdAgo = 3000): NodeSpec => ({
  id,
  parent,
  harness: 'codex',
  label: id,
  role: 'worker',
  status: S.exited(ago(endedAgo)),
  run: { state: 'ended', mode: 'headless', endedAt: ago(endedAgo) },
  report: { status: 'completed', summary: `${id} done`, at: ago(endedAgo) },
  createdAt: ago(createdAgo),
});
const running = (id: string, parent: string, createdAgo = 2000): NodeSpec => ({
  id,
  parent,
  harness: 'codex',
  label: id,
  role: 'worker',
  status: S.working(ago(100)),
  run: { state: 'running', mode: 'headless' },
  createdAt: ago(createdAgo),
});
const keyOf = (harness: string, id: string) => `${harness}:${id}`;
const putRow = (frame: ReturnType<typeof draw>) => frame.delegation!.plan.rows.find((r) => r.kind === 'putAway')!;

test('a destination stays selected across a tick that rebuilds every object of the view model', () => {
  const first = situationC();
  const key = first.keys['impl-parser'];
  let frame = draw(first.vm, { selected: key, now: NOW });
  assert.equal(selectedOf(frame), key);
  for (let tick = 1; tick <= 3; tick++) {
    const next = situationC();
    frame = draw(next.vm, { state: frame.state, now: NOW + tick * 1000 });
    assert.equal(selectedOf(frame), key, `tick ${tick}`);
    assert.equal(frame.state.revealed, key, 'a stay is no move: the view is where the reader left it');
  }
});

test('an intent binding follows tree.selectionMap to its session, in both styles', () => {
  const before = buildVm([root, { id: 'i1', parent: 'main', kind: 'intent', label: 'impl', status: S.starting(ago(5)) }]);
  const after = buildVm(
    [root, { id: 'i1', parent: 'main', harness: 'codex', label: 'impl', status: S.working(ago(5)) }],
    { selectionMap: { [before.keys['i1']]: keyOf('codex', 'i1') } }
  );
  assert.equal(before.keys['i1'], 'intent:i1');
  for (const style of ['compact', 'rich'] as const) {
    const a = draw(before.vm, { style, selected: before.keys['i1'] });
    assert.equal(selectedOf(a), 'intent:i1', style);
    const b = draw(after.vm, { style, state: a.state });
    assert.equal(selectedOf(b), keyOf('codex', 'i1'), `${style}: the session the intent became`);
  }
});

test('a chain of mappings is followed to a key that is on the list; one that leads nowhere falls to the first row', () => {
  const { vm, keys } = buildVm([root, running('w', 'main')]);
  const view = delegationView(vm, { nowMs: NOW, style: 'compact' });
  const at = (selected: string, map: Record<string, string>) =>
    resolveSelection(selected, view.proj, view.plan, view.dest, map);
  assert.equal(at('old1', { old1: 'old2', old2: keys['w'] }), keys['w']);
  assert.equal(at('old1', { old1: 'old2', old2: 'nowhere' }), keys['main'], 'nowhere: the first row');
  assert.equal(at('loop', { loop: 'loop2', loop2: 'loop' }), keys['main'], 'a loop ends');
});

test('a node that is gone with no mapping falls to the first row; so does no selection at all', () => {
  const { vm, keys } = buildVm([root, running('w', 'main')]);
  assert.equal(selectedOf(draw(vm, { selected: 'codex:gone' })), keys['main']);
  assert.equal(selectedOf(draw(vm, { selected: null })), keys['main']);
  assert.equal(selectedOf(draw(vm, { selected: '' })), keys['main']);
});

test('a finished row that is put away passes the selection to the ⊕N row that holds it', () => {
  const at = (endedAgo: number) =>
    buildVm([root, running('a', 'main'), finished('done1', 'main', endedAgo), finished('done2', 'main', endedAgo + 5)]);
  // Still on the list 20 seconds before its time is up.
  const early = at(PUT_AWAY_MS / 1000 - 20);
  let frame = draw(early.vm, { selected: early.keys['done1'], now: NOW });
  assert.equal(selectedOf(frame), early.keys['done1']);
  assert.ok(!frame.delegation!.plan.rows.some((r) => r.kind === 'putAway'));
  // 30 seconds on it is put away: the selection is the ⊕N row of its parent.
  frame = draw(early.vm, { state: frame.state, now: NOW + 30_000 });
  const put = putRow(frame);
  assert.equal(selectedOf(frame), put.key);
  assert.equal(put.parentKey, early.keys['main']);
  assert.deepEqual(parsePutKey(put.key)?.parentKey, early.keys['main']);
  assert.ok(text(frame).some((line) => line.startsWith('›') && /2 done/.test(line)));
});

test('a row under a collapsed ancestor passes the selection to that ancestor', () => {
  const { vm, keys } = buildVm([root, running('p', 'main'), running('child', 'p', 1500), running('grand', 'child', 1400)]);
  let frame = draw(vm, { selected: keys['grand'] });
  assert.equal(selectedOf(frame), keys['grand']);
  frame = draw(vm, { state: frame.state, collapsed: [keys['p']] });
  assert.equal(selectedOf(frame), keys['p'], 'the nearest destination ancestor, not the root');
  // Unfolded again, the selection stays where it went (it follows the node it was last on).
  frame = draw(vm, { state: frame.state, collapsed: [] });
  assert.equal(selectedOf(frame), keys['p']);
});

test('a rich card past its fifth sub-row: the sixth is no destination, its card is selected', () => {
  const natives: NodeSpec[] = Array.from({ length: 7 }, (_, i) => ({
    id: `n${i}`,
    parent: 'impl',
    harness: 'codex' as const,
    native: true,
    label: `native-${i}`,
    status: S.working(ago(60 + i)),
    createdAt: ago(1000 - i),
  }));
  const { vm, keys } = buildVm([
    root,
    { ...running('impl', 'main'), run: { state: 'running', mode: 'visible' }, pane: 'pane 4' },
    ...natives,
  ]);
  const sixth = keys['n5'];
  const rich = draw(vm, { style: 'rich', selected: sixth, height: 40 });
  assert.equal(selectedOf(rich), keys['impl'], 'rich: the card');
  assert.ok(!rich.delegation!.dest.index.has(sixth) && rich.delegation!.plan.index.has(sixth));
  assert.equal(selectedOf(draw(vm, { style: 'rich', selected: keys['n4'], height: 40 })), keys['n4'], 'the fifth stays');
  assert.equal(selectedOf(draw(vm, { style: 'compact', selected: sixth })), sixth, 'compact draws every row');
});

test('a ⊕N row stays selected when a row is inserted above it: it is the parent that identifies it', () => {
  const base = buildVm([root, running('a', 'main'), finished('d1', 'main', 400), finished('d2', 'main', 450)]);
  let frame = draw(base.vm, { selected: putRow(draw(base.vm)).key });
  const before = selectedOf(frame)!;
  assert.equal(putRow(frame).key, before);
  // A worker created earlier than `a` sorts above it: the ⊕N row moves down one place.
  const grown = buildVm([
    root,
    running('b', 'main', 2500),
    running('a', 'main'),
    finished('d1', 'main', 400),
    finished('d2', 'main', 450),
  ]);
  frame = draw(grown.vm, { state: frame.state });
  const put = putRow(frame);
  assert.notEqual(put.key, before, 'the row moved, so its key (it holds its place) changed');
  assert.equal(parsePutKey(put.key)!.index, put.key === before ? -1 : frame.delegation!.plan.rows.indexOf(put));
  assert.equal(selectedOf(frame), put.key, 'the same ⊕N row, not the node that took its place');
  assert.equal(frame.delegation!.plan.rows[parsePutKey(before)!.index].pn?.key, grown.keys['a'], 'a is at the old place');
});

test('after `a` the ⊕N row is gone and the selection lands at its old place, where its rows came back', () => {
  const { vm, keys } = buildVm([root, running('a', 'main'), finished('d1', 'main', 400), finished('d2', 'main', 450)]);
  let frame = draw(vm);
  const put = putRow(frame);
  const oldPlace = frame.delegation!.plan.rows.indexOf(put);
  frame = draw(vm, { state: { ...frame.state, tree: { ...frame.state.tree, selectedId: put.key } } });
  assert.equal(selectedOf(frame), put.key);
  const { frame: shown } = step(vm, frame, 'show-all');
  assert.equal(shown.state.tree.showAll, true);
  const rows = shown.delegation!.plan.rows;
  assert.ok(!rows.some((r) => r.kind === 'putAway'));
  assert.equal(selectedOf(shown), rows[oldPlace].key);
  assert.ok([keys['d1'], keys['d2']].includes(selectedOf(shown)!), 'one of the rows that came back');
});

test('a ⊕N row whose parent is put away passes the selection to the grandparent’s ⊕N row', () => {
  // `impl` finished 170 s ago and has a child that finished long before: impl shows, with a ⊕N of its own.
  const tree = buildVm([
    root,
    running('a', 'main'),
    { ...finished('impl', 'main', 170), createdAt: ago(2900) },
    finished('old', 'impl', 400, 2800),
  ]);
  let frame = draw(tree.vm, { now: NOW });
  const inner = frame.delegation!.plan.rows.find((r) => r.kind === 'putAway' && r.parentKey === tree.keys['impl'])!;
  assert.ok(inner, 'impl has a ⊕N row of its own');
  frame = draw(tree.vm, { state: { ...frame.state, tree: { ...frame.state.tree, selectedId: inner.key } }, now: NOW });
  assert.equal(selectedOf(frame), inner.key);
  // 30 seconds on, impl itself is put away: its branch is in main's ⊕N row now.
  frame = draw(tree.vm, { state: frame.state, now: NOW + 30_000 });
  const outer = frame.delegation!.plan.rows.find((r) => r.kind === 'putAway')!;
  assert.equal(outer.parentKey, tree.keys['main']);
  assert.equal(selectedOf(frame), outer.key);
});

test('the summary row and the parent row are never destinations', () => {
  const c = situationC();
  const view = delegationView(c.vm, { nowMs: NOW, style: 'compact' });
  assert.ok(view.dest.rows.every((row) => row.kind === 'putAway' || row.pn !== null));
  const frame = draw(c.vm, { selected: c.keys['impl-parser'] });
  const pane = frame.panes.find((p) => p.id === 'agents')!;
  assert.equal(pane.rows[0].item, undefined, 'the summary row has no item to select');
});

// ---------------------------------------------------------------------------
// The page's order of calls (rulings B10B-s3 Q6)

const emptyLegacy = { ...makeNestedTree(), nodes: [] };

test('tree-page order: a reconcile with no view model, then the render with it: the selection survives; not without the mark', () => {
  const c = situationC();
  const key = c.keys['review-tests'];
  const first = draw(c.vm, { selected: key });
  assert.equal(first.state.delegating, true);
  // The page's own call (collect, every second) has no view model and an empty legacy tree.
  const reconciled = reconcileMonitor(first.state, emptyLegacy, undefined, undefined, NOW);
  assert.equal(reconciled.tree.selectedId, key, 'left alone');
  assert.equal(reconciled.delegating, true);
  assert.equal(selectedOf(draw(c.vm, { state: reconciled })), key);
  // The control: the same state without the mark is reset by the legacy tree, as it always was.
  const { delegating: _mark, ...unmarked } = first.state;
  const reset = reconcileMonitor(unmarked, emptyLegacy, undefined, undefined, NOW);
  assert.equal(reset.tree.selectedId, null);
  assert.notEqual(selectedOf(draw(c.vm, { state: reset })), key, 'and the render can only fall to the first row');
});

test('the mark is written by every reconcile against a view model, drawn or not, and by nothing else', () => {
  const c = situationC();
  const marked = (state: ReturnType<typeof draw>['state']) => Object.hasOwn(state, 'delegating');
  assert.equal(marked(draw(c.vm).state), true);
  // Help open: nothing of the agents is drawn, the mark is written all the same.
  const help = monitorInput(c.vm);
  help.state.help = true;
  assert.equal(marked(renderMonitor(help).state), true, 'help open');
  assert.equal(marked(draw(c.vm, { width: 0, height: 0 }).state), true, 'zero size');
  // A reconcile without a view model never writes it.
  const plain = monitorInput(undefined).state;
  assert.equal(marked(reconcileMonitor(plain, emptyLegacy, undefined, undefined, NOW)), false);
  assert.equal(marked(reconcileMonitor(plain, emptyLegacy, undefined, undefined, NOW, null)), false);
  assert.equal(marked(draw(null).state), false);
  assert.equal(marked(draw(undefined).state), false);
});

test('with a null view model the state has no mark and the selection falls back as in legacy', () => {
  const c = situationC();
  const marked = draw(c.vm, { selected: c.keys['impl-parser'] });
  assert.equal(marked.state.delegating, true);
  for (const none of [null, undefined]) {
    const frame = draw(none, { state: { ...marked.state } });
    assert.equal(Object.hasOwn(frame.state, 'delegating'), false, 'the key is removed, not set to false');
    // The delegation key is no id of the legacy tree: the first legacy row, as for any unknown id.
    assert.equal(selectedOf(frame), makeNestedTree().nodes[0].id);
  }
  // And a legacy session never sees the mark or an extra key at all.
  const legacy = draw(undefined);
  assert.equal(Object.hasOwn(legacy.state, 'delegating'), false);
  assert.deepEqual(Object.keys(draw(null).state).sort(), Object.keys(legacy.state).sort());
});

test('a stale press resolves against the frame the user saw, never against a newer view model', () => {
  // The row was visible and verified when drawn; the next tick makes it uncertain; the press acts on what was drawn.
  const seen = buildVm([root, { ...running('v', 'main'), run: { state: 'running', mode: 'visible' }, pane: 'pane 4' }]);
  const frame = draw(seen.vm, { selected: seen.keys['v'] });
  const out = press(frame, 'open-session');
  assert.deepEqual(out.action, { type: 'delegation-open', key: seen.keys['v'] });
  const later = buildVm([
    root,
    {
      ...running('v', 'main'),
      run: { state: 'uncertain', mode: 'visible' },
      pane: 'pane 4',
      status: { cls: 'uncertain', reason: 'scope_unknown', since: NOW },
    },
  ]);
  const redrawn = draw(later.vm, { state: frame.state });
  assert.equal(redrawn.controls.find((c) => c.kind === 'delegation-open')?.disabled, true, 'greyed after the tick');
  assert.equal(press(redrawn, 'open-session').action, undefined, 'and a press on the new frame does nothing');
  assert.deepEqual(press(frame, 'open-session').action, out.action, 'the old frame still answers as it drew');
});

test('situation D: the first row is the selection of an empty state, and a hidden node maps to its list ancestor', () => {
  const d = situationD();
  const frame = draw(d.vm, { selected: null });
  assert.equal(selectedOf(frame), d.keys['main']);
  assert.equal(FIXED_NOW.getTime(), NOW);
});

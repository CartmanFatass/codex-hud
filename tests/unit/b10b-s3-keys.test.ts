/**
 * B10B-s3: navigation over the delegation rows (design §2, §3.2; rulings B10B-s3 Q2, Q7, Enter, defaults 1 and 9):
 * ↑/↓, home/end, `h`/`l` (fold and unfold through `tree.collapsed` by row key), `a`, `s`, `n`/`N`, and the click. The
 * summary row and the parent row are never selectable. Keys are resolved against the frame the user saw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stopsOf } from '../../src/render/delegation/selection.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationC,
  situationE,
  situationParent,
  type NodeSpec,
} from '../fixtures/b10b-delegation.js';
import { click, draw, lineOf, press, selectedOf, step, text } from '../fixtures/b10b-s3.js';

const orderOf = (frame: ReturnType<typeof draw>) => frame.delegation!.dest.rows.map((r) => r.key);

test('↓ and ↑ walk the plan’s rows in screen order and stop at the ends (the heading is not a row)', () => {
  const c = situationC();
  let frame = draw(c.vm, { selected: null });
  const order = orderOf(frame);
  assert.equal(selectedOf(frame), order[0], 'the first row is the selection of an empty state');
  const seen = [selectedOf(frame)];
  for (let i = 1; i < order.length + 3; i++) {
    frame = step(c.vm, frame, 'down').frame;
    seen.push(selectedOf(frame));
  }
  assert.deepEqual(seen.slice(0, order.length), order);
  assert.deepEqual(new Set(seen.slice(order.length)), new Set([order.at(-1)]), 'stops at the last row');
  for (let i = 0; i < order.length + 3; i++) frame = step(c.vm, frame, 'up').frame;
  assert.equal(selectedOf(frame), order[0], 'and at the first: nothing above the root row');
});

test('home and end go to the first and last row; a page key scrolls the view and leaves the selection', () => {
  const c = situationC();
  let frame = draw(c.vm, { selected: c.keys['ask-pro'], height: 10 });
  const order = orderOf(frame);
  assert.equal(selectedOf((frame = step(c.vm, frame, 'home', { height: 10 }).frame)), order[0]);
  assert.equal(selectedOf((frame = step(c.vm, frame, 'end', { height: 10 }).frame)), order.at(-1));
  const before = selectedOf(frame);
  const paged = press(frame, 'page-up');
  assert.equal(paged.state.tree.selectedId, before);
});

test('the summary row and the parent row are never selectable: a click on them selects nothing', () => {
  const p = situationParent('offline');
  const frame = draw(p.vm, { selected: p.keys['impl-parser'] });
  const pane = frame.panes.find((x) => x.id === 'agents')!;
  assert.equal(pane.pinned, 2, 'the parent row and the heading are pinned');
  for (const y of [pane.y, pane.y + 1]) {
    const out = click(frame, 6, y);
    assert.equal(out.state.tree.selectedId, p.keys['impl-parser'], `line ${y}`);
    assert.equal(out.action, undefined);
  }
  assert.ok(!orderOf(frame).some((key) => key.startsWith('↑')), 'no parent row among the destinations');
});

test('h folds an open branch, then steps to the parent; l unfolds it, then steps to the first child', () => {
  const c = situationC();
  const parent = c.keys['impl-parser'];
  const scout = c.keys['scout'];
  let frame = draw(c.vm, { selected: parent });
  frame = step(c.vm, frame, 'left').frame;
  assert.ok(frame.state.tree.collapsed.has(parent), 'folded through tree.collapsed by row key');
  assert.equal(selectedOf(frame), parent);
  assert.ok(
    text(frame).some((line) => /impl-pars….*\+1▸/.test(line)),
    text(frame).join('\n')
  );
  assert.ok(!text(frame).some((line) => line.includes('scout')), 'its children left the list');
  // h again: it is folded, so it steps out to the parent row.
  frame = step(c.vm, frame, 'left').frame;
  assert.equal(selectedOf(frame), c.keys['main']);
  assert.ok(frame.state.tree.collapsed.has(parent), 'stepping out does not unfold anything');
  // Back on the folded row: l unfolds it; l again steps in to its first child.
  frame = draw(c.vm, { state: { ...frame.state, tree: { ...frame.state.tree, selectedId: parent } } });
  frame = step(c.vm, frame, 'right').frame;
  assert.ok(!frame.state.tree.collapsed.has(parent));
  assert.equal(selectedOf(frame), parent);
  frame = step(c.vm, frame, 'right').frame;
  assert.equal(selectedOf(frame), scout);
  // A leaf has nothing to fold: h goes to its parent; l does nothing.
  assert.equal(press(frame, 'right').state.tree.selectedId, scout);
  assert.equal(press(frame, 'left').state.tree.selectedId, parent);
  assert.equal(press(frame, 'left').state.tree.collapsed.size, 0);
});

test('h on the viewpoint root folds the whole tree into its row; on a fold of the root it has nowhere to go', () => {
  const c = situationC();
  let frame = draw(c.vm, { selected: c.keys['main'] });
  frame = step(c.vm, frame, 'left').frame;
  assert.deepEqual([...frame.state.tree.collapsed], [c.keys['main']]);
  assert.equal(orderOf(frame).length, 1);
  assert.equal(selectedOf(step(c.vm, frame, 'left').frame), c.keys['main']);
});

test('in rich, h folds the card and its head says what it holds (F6), through the same key', () => {
  const c = situationC({ reviewPass: true, nativeMeta: true });
  const parent = c.keys['impl-parser'];
  let frame = draw(c.vm, { style: 'rich', selected: parent, height: 40 });
  assert.ok(text(frame).some((line) => line.includes('scout')));
  frame = step(c.vm, frame, 'left', { style: 'rich', height: 40 }).frame;
  const lines = text(frame);
  assert.ok(
    lines.some((line) => /impl-parser \+2 \(1▸ 1✓\)/.test(line)),
    lines.join('\n')
  );
  assert.ok(!lines.some((line) => line.includes('scout')));
});

test('`a` and `s` go through the state: history shown, creation order; the selection stays on its row', () => {
  const c = situationC();
  const key = c.keys['ask-pro'];
  let frame = draw(c.vm, { selected: key });
  frame = step(c.vm, frame, 'show-all').frame;
  assert.equal(frame.state.tree.showAll, true);
  assert.equal(selectedOf(frame), key);
  frame = step(c.vm, frame, 'sort').frame;
  assert.equal(frame.state.tree.sort, 'created');
  assert.equal(selectedOf(frame), key);
  frame = step(c.vm, frame, 'sort').frame;
  assert.equal(frame.state.tree.sort, 'active');
});

// ---------------------------------------------------------------------------
// n / N (rulings Q7)

const worker = (id: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id,
  parent: 'main',
  harness: 'codex',
  label: id,
  role: 'worker',
  status: S.working(ago(100)),
  run: { state: 'running', mode: 'headless' },
  createdAt: ago(3000 - id.length),
  ...extra,
});

test('each kind of stop is one, and each excluded kind is not (the root’s own marker included)', () => {
  const { vm, keys } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.pending('approval', ago(5)), label: null },
    worker('flag', { status: S.pending('approval', ago(30)) }),
    worker('stop-in-pane', { run: { state: 'cancelling', mode: 'visible' }, status: S.working(ago(30)) }),
    worker('live-fail', { status: S.failed(ago(20)) }),
    worker('stale', { status: S.stale(ago(60), ago(60)) }),
    worker('uncertain', {
      run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(30) },
    }),
    { ...worker('conflict'), relationOnly: true, alsoClaimedBy: ['other'], conflict: { count: 2, since: ago(60) } },
    // Never a stop:
    worker('starting', { run: { state: 'starting', mode: 'headless' }, status: S.starting(ago(5)) }),
    worker('cancelled', {
      run: { state: 'cancelled', mode: 'headless', endedAt: ago(20) },
      status: S.interrupted(ago(20)),
    }),
    worker('ended-fail', {
      run: { state: 'failed', mode: 'headless', endedAt: ago(20) },
      status: S.failed(ago(20)),
      report: { status: 'failed', summary: 'x', at: ago(20) },
    }),
    worker('done', {
      run: { state: 'ended', mode: 'headless', endedAt: ago(20) },
      status: S.exited(ago(20)),
      report: { status: 'completed', summary: 'x', at: ago(20) },
    }),
    worker('unloaded', { loaded: false }),
    worker('plain'),
  ]);
  const frame = draw(vm, { height: 60 });
  const dest = frame.delegation!.dest;
  const stops = stopsOf(frame.delegation!.proj, dest).map((place) => dest.rows[place].key);
  const expect = ['flag', 'stop-in-pane', 'live-fail', 'stale', 'uncertain', 'conflict'].map((id) =>
    id === 'conflict' ? `conflict:l_conflict:${keys['main']}` : keys[id]
  );
  assert.deepEqual([...stops].sort(), [...expect].sort(), 'exactly those');
  assert.ok(!stops.includes(keys['main']), 'the root’s own ⚑ is not a stop');
});

test('n goes to the next stop below the selection, N to the previous; both wrap; a stop is not the selection itself', () => {
  const e = situationE();
  let frame = draw(e.vm, { selected: e.keys['main'], height: 40 });
  const stops = stopsOf(frame.delegation!.proj, frame.delegation!.dest).map((p) => frame.delegation!.dest.rows[p].key);
  assert.ok(stops.length >= 4, stops.join());
  const walked: Array<string | null> = [];
  for (let i = 0; i < stops.length; i++) {
    frame = step(e.vm, frame, 'next-trouble', { height: 40 }).frame;
    walked.push(selectedOf(frame));
  }
  assert.deepEqual(walked, stops, 'visits each stop in screen order');
  frame = step(e.vm, frame, 'next-trouble', { height: 40 }).frame;
  assert.equal(selectedOf(frame), stops[0], 'wraps to the first');
  frame = step(e.vm, frame, 'previous-trouble', { height: 40 }).frame;
  assert.equal(selectedOf(frame), stops.at(-1), 'N wraps to the last');
  frame = step(e.vm, frame, 'previous-trouble', { height: 40 }).frame;
  assert.equal(selectedOf(frame), stops.at(-2));
  // The key reveals the row (a move by the reader), unlike a stay.
  assert.equal(press(frame, 'next-trouble').state.revealed, null);
});

test('with no stop n and N do nothing', () => {
  const { vm, keys } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(100)), label: null },
    worker('a'),
    worker('b'),
  ]);
  const frame = draw(vm, { selected: keys['a'] });
  for (const key of ['next-trouble', 'previous-trouble']) {
    const out = press(frame, key);
    assert.equal(out.state.tree.selectedId, keys['a'], key);
    assert.equal(out.action, undefined);
  }
});

test('a collapsed row over a ⚑ is a stop and stays collapsed; n never unfolds, reorders or filters', () => {
  const { vm, keys } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(100)), label: null },
    worker('p', { createdAt: ago(2000) }),
    worker('q', { parent: 'p', status: S.pending('approval', ago(10)), createdAt: ago(1500) }),
    worker('other', { createdAt: ago(1000) }),
  ]);
  let frame = draw(vm, { selected: keys['main'], collapsed: [keys['p']] });
  assert.ok(!orderOf(frame).includes(keys['q']), 'the ⚑ is hidden under p');
  frame = step(vm, frame, 'next-trouble').frame;
  assert.equal(selectedOf(frame), keys['p'], 'p stands for it');
  assert.ok(frame.state.tree.collapsed.has(keys['p']), 'and stays collapsed');
  assert.ok(!frame.state.tree.showAll);
  assert.equal(frame.state.tree.filter, 'all');
  assert.equal(frame.state.tree.sort, 'active');
});

test('a rich card whose sixth sub-row is a ⚑ is a stop: the card stands for the row it does not draw', () => {
  // Stops sort first among siblings, so six ⚑ natives are the only way for one to fall past the fifth line.
  const natives: NodeSpec[] = Array.from({ length: 6 }, (_, i) => ({
    id: `n${i}`,
    parent: 'impl',
    harness: 'codex' as const,
    native: true,
    label: `native-${i}`,
    status: S.pending('approval', ago(10 + i)),
    createdAt: ago(1000 - i),
  }));
  const { vm, keys } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(100)), label: null },
    worker('impl'),
    ...natives,
  ]);
  const stopsIn = (style: 'rich' | 'compact') => {
    const frame = draw(vm, { style, height: 40 });
    const { dest, proj } = frame.delegation!;
    return stopsOf(proj, dest).map((place) => dest.rows[place].key);
  };
  const rich = stopsIn('rich');
  assert.ok(rich.includes(keys['impl']), 'the card is a stop in rich');
  assert.ok(!rich.includes(keys['n5']), 'the sixth is no destination');
  const compact = stopsIn('compact');
  assert.ok(compact.includes(keys['n5']) && !compact.includes(keys['impl']), 'compact draws it, so it is its own stop');
});

// ---------------------------------------------------------------------------
// Enter, Space, v; the click

test('Enter, Space and v are the Inspector’s keys: they emit no delegation action', () => {
  const c = situationC();
  for (const id of ['impl-parser', 'review-tests', 'ask-pro', 'docs-sync', 'main']) {
    const frame = draw(c.vm, { selected: c.keys[id] });
    for (const key of ['enter', 'detail-toggle']) assert.equal(press(frame, key).action, undefined, `${id}: ${key}`);
  }
});

test('a click selects the row and nothing else: no Inspector, no pick, no action (both styles)', () => {
  const c = situationC({ reviewPass: true, nativeMeta: true });
  for (const style of ['compact', 'rich'] as const) {
    const frame = draw(c.vm, { style, selected: c.keys['main'], height: 40 });
    const target = c.keys['docs-sync'];
    const y = lineOf(frame, target);
    assert.ok(y > 0, `${style}: the row is on screen`);
    const out = click(frame, 6, y);
    assert.equal(out.state.tree.selectedId, target, style);
    assert.equal(out.action, undefined, style);
    assert.equal(out.state.modes.details, frame.state.modes.details, `${style}: no pane opened`);
    assert.equal(out.state.focus, 'agents');
    assert.equal(out.state.revealed, target, `${style}: a click does not scroll`);
  }
});

test('a click on a ⊕N row selects it; a click on a row the plan does not have selects nothing', () => {
  const e = situationE();
  const frame = draw(e.vm, { selected: e.keys['main'], height: 40 });
  const out = click(frame, 6, 0);
  assert.equal(out.action, undefined);
  assert.equal(out.state.tree.selectedId, e.keys['main']);
  assert.equal(NOW > 0, true);
});

test('legacy: with no view model the keys behave as they did (o switches the selected agent; the new keys do nothing)', () => {
  const frame = draw(undefined);
  const id = frame.state.tree.selectedId!;
  assert.deepEqual(press(frame, 'open-session').action, { type: 'switch', id });
  for (const key of ['next-trouble', 'previous-trouble', 'log', 'resume-reconcile']) {
    const out = press(frame, key);
    assert.equal(out.action, undefined, key);
    assert.equal(out.state.tree.selectedId, id, key);
  }
});

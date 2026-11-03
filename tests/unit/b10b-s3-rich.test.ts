/**
 * B10B-s3: a rich card’s sub-rows are rows of their own (rulings B10B-s3 default 9): a click on one selects it and does
 * not scroll, a key move to one reveals it, the card that holds the selected sub-row never folds on its own, and the
 * sub-rows past the fifth are not destinations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { click, draw, lineOf, press, selectedOf, step, text } from '../fixtures/b10b-s3.js';

const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(300)), label: null };
const card = (id: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id,
  parent: 'main',
  harness: 'codex',
  label: id,
  role: 'worker',
  status: S.working(ago(100)),
  run: { state: 'running', mode: 'headless' },
  createdAt: ago(2000),
  ...extra,
});
const native = (id: string, parent: string, i: number, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id,
  parent,
  harness: 'codex',
  native: true,
  label: `native-${id}`,
  status: S.working(ago(60 + i)),
  createdAt: ago(1000 - i),
  ...extra,
});

test('a sub-row’s line is the sub-row’s own item and belongs to its card; the card’s other lines are the card’s', () => {
  const { vm, keys } = buildVm([root, card('impl'), native('n0', 'impl', 0), native('n1', 'impl', 1)]);
  const frame = draw(vm, { style: 'rich', selected: keys['impl'], height: 24 });
  const rows = frame.panes.find((p) => p.id === 'agents')!.rows;
  const lines = rows.filter((r) => r.key === `card:${keys['impl']}`);
  const sub = lines.filter((r) => r.item !== keys['impl']);
  assert.deepEqual(
    sub.map((r) => r.item),
    [keys['n0'], keys['n1']]
  );
  assert.ok(sub.every((r) => r.of === keys['impl']));
  assert.ok(lines.filter((r) => r.item === keys['impl']).every((r) => r.of === undefined));
  assert.ok(lines.length >= 5, 'head, delegation line, two sub-rows, foot');
});

test('a click on a sub-row’s line selects it and does not scroll; the selection draws on that line', () => {
  const { vm, keys } = buildVm([root, card('impl'), native('n0', 'impl', 0), native('n1', 'impl', 1)]);
  const frame = draw(vm, { style: 'rich', selected: keys['main'], height: 24 });
  const y = lineOf(frame, keys['n1']);
  assert.ok(y > 0);
  const out = click(frame, 8, y);
  assert.equal(out.state.tree.selectedId, keys['n1']);
  assert.equal(out.state.revealed, keys['n1'], 'a click is in view already: no scroll');
  assert.equal(out.action, undefined);
  const redrawn = draw(vm, { style: 'rich', state: out.state, height: 24 });
  assert.match(text(redrawn)[y], /native-n1/);
  assert.ok(redrawn.lines[y] !== frame.lines[y], 'the line is drawn selected');
});

test('keys walk into a card’s sub-rows and out again, one row at a time', () => {
  const { vm, keys } = buildVm([
    root,
    card('a'),
    native('n0', 'a', 0),
    native('n1', 'a', 1),
    card('b', { createdAt: ago(1900) }),
  ]);
  let frame = draw(vm, { style: 'rich', selected: keys['a'], height: 30 });
  const walk: Array<string | null> = [];
  for (let i = 0; i < 3; i++) {
    frame = step(vm, frame, 'down', { style: 'rich', height: 30 }).frame;
    walk.push(selectedOf(frame));
  }
  assert.deepEqual(walk, [keys['n0'], keys['n1'], keys['b']]);
  frame = step(vm, frame, 'up', { style: 'rich', height: 30 }).frame;
  assert.equal(selectedOf(frame), keys['n1']);
});

test('a key move to a sub-row reveals it; a stay does not move the view', () => {
  const natives = Array.from({ length: 5 }, (_, i) => native(`n${i}`, 'z', i));
  const cards = ['a', 'b', 'c', 'd'].map((id, i) => card(id, { createdAt: ago(2000 - i) }));
  const { vm, keys } = buildVm([root, ...cards, card('z', { createdAt: ago(1500) }), ...natives]);
  const o = { style: 'rich' as const, height: 9 };
  let frame = draw(vm, { ...o, selected: keys['z'] });
  for (let i = 0; i < 4; i++) frame = step(vm, frame, 'down', o).frame;
  const selected = selectedOf(frame)!;
  assert.ok(Object.values(keys).includes(selected));
  const pane = frame.panes.find((p) => p.id === 'agents')!;
  const y = lineOf(frame, selected);
  assert.ok(y >= pane.y + (pane.pinned ?? 0) && y < pane.y + pane.height, `row ${selected} is in view at ${y}`);
  const again = draw(vm, { ...o, state: frame.state });
  assert.equal(again.state.scroll.agents, frame.state.scroll.agents, 'redrawing does not scroll');
});

test('the card that holds the selected sub-row never folds on its own; its unselected siblings do', () => {
  const finishedCard = (id: string, i: number): NodeSpec =>
    card(id, {
      status: S.exited(ago(30)),
      run: { state: 'ended', mode: 'headless', endedAt: ago(30) },
      report: { status: 'completed', summary: `${id} done`, at: ago(30) },
      createdAt: ago(2000 - i),
    });
  const ids = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  const specs = [root, ...ids.map(finishedCard), native('sub', 'f3', 0, { status: S.exited(ago(30)) })];
  const { vm, keys } = buildVm(specs);
  const heads = (selected: string | null) =>
    text(draw(vm, { style: 'rich', selected, height: 40 })).filter(
      (line) => /f[0-6]\b/.test(line) && !/native-/.test(line)
    );
  // Seven finished cards beside each other fold at once (more than five siblings).
  const none = heads(keys['main']);
  assert.ok(
    none.every((line) => line.includes('─') || line.includes('✓')),
    'folded'
  );
  assert.ok(!none.some((line) => /┌/.test(line)), none.join('\n'));
  // Select the sub-row of f3: f3’s card is drawn whole, the others stay folded.
  const withSub = heads(keys['sub']);
  assert.equal(withSub.filter((line) => /┌|›/.test(line)).length, 1, withSub.join('\n'));
  const frame = draw(vm, { style: 'rich', selected: keys['sub'], height: 40 });
  assert.ok(
    text(frame).some((line) => /native-sub/.test(line)),
    'and its sub-row is on screen'
  );
  assert.equal(selectedOf(frame), keys['sub']);
});

test('sub-rows past the fifth are no destinations: ↓ from the fifth leaves the card, and a click on the +N line selects the card', () => {
  const natives = Array.from({ length: 7 }, (_, i) => native(`n${i}`, 'impl', i));
  const { vm, keys } = buildVm([root, card('impl'), ...natives, card('after', { createdAt: ago(1900) })]);
  const o = { style: 'rich' as const, height: 30 };
  let frame = draw(vm, { ...o, selected: keys['n4'] });
  frame = step(vm, frame, 'down', o).frame;
  assert.equal(selectedOf(frame), keys['after'], 'n5 and n6 are folded into +2 (…): next is the following card');
  const folded = draw(vm, { ...o, selected: keys['impl'] });
  const fold = text(folded).findIndex((line) => /\+2 \(/.test(line));
  assert.ok(fold > 0, text(folded).join('\n'));
  assert.equal(click(folded, 8, fold).state.tree.selectedId, keys['impl'], 'the +N line belongs to the card');
  assert.equal(press(folded, 'down').state.tree.selectedId, keys['n0']);
});

test('moving onto a card with sub-rows scrolls the whole card into view, its foot included', () => {
  const cards = ['a', 'b', 'c', 'd'].map((id, i) => card(id, { createdAt: ago(2000 - i) }));
  const { vm, keys } = buildVm([
    root,
    ...cards,
    card('z', { createdAt: ago(1500) }),
    native('n0', 'z', 0),
    native('n1', 'z', 1),
  ]);
  const o = { style: 'rich' as const, height: 11 };
  let frame = draw(vm, { ...o, selected: keys['d'] });
  frame = step(vm, frame, 'down', o).frame;
  assert.equal(selectedOf(frame), keys['z']);
  const pane = frame.panes.find((p) => p.id === 'agents')!;
  const lines = pane.rows.map((row, i) => ({ row, i })).filter(({ row }) => row.key === `card:${keys['z']}`);
  const foot = lines.at(-1)!.i - pane.offset + pane.y;
  assert.ok(foot >= pane.y + (pane.pinned ?? 0) && foot < pane.y + pane.height, `the foot is at ${foot}, in view`);
  assert.match(text(frame)[foot], /^ *└/);
});

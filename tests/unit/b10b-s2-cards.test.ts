/**
 * B10B-s2: rich cards and the accordion (design §3.5; rulings B10B-s2 Q10): the root card always; root natives
 * as cards, deeper natives as sub-rows (five, then `+N (…)`); `children unknown`; the fold order; the card cache.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi } from '../../src/render/colors.js';
import { cardCacheStats, lookId } from '../../src/render/delegation/cards.js';
import { glyphSet } from '../../src/render/delegation/glyphs.js';
import type { Say } from '../../src/render/delegation/style.js';
import { delegationAgentsRows } from '../../src/render/delegation/panel.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationA,
  situationB,
  situationC,
  situationD,
  situationE,
  situationG,
  situationH,
  type NodeSpec,
} from '../fixtures/b10b-delegation.js';

const ROOT: NodeSpec = {
  id: 'main',
  root: true,
  harness: 'claude',
  status: S.working(ago(60)),
  label: null,
  contextPercent: 30,
};
const rich = (specs: NodeSpec[], options: { width?: number; selected?: string; viewport?: number } = {}) => {
  const built = buildVm(specs);
  return delegationAgentsRows(built.vm, {
    width: options.width ?? 48,
    nowMs: NOW,
    style: 'rich',
    selectedId: options.selected ? built.keys[options.selected] : null,
    viewport: options.viewport,
  }).map((row) => stripAnsi(row.text));
};

test('the root is a card even with nothing under it', () => {
  const rows = delegationAgentsRows(situationA().vm, { width: 48, nowMs: NOW, style: 'rich' }).map((r) =>
    stripAnsi(r.text)
  );
  assert.match(rows[1], /^┌ ▸ main ─+ /);
  assert.match(rows[2], /^└ ◷3m10s ─/);
});

test('a card shows five native sub-rows at most, then one fold line with the rest by marker', () => {
  const specs: NodeSpec[] = [ROOT, { id: 'w', parent: 'main', status: S.working(ago(100)), role: 'implementer' }];
  for (let i = 0; i < 7; i++)
    specs.push({
      id: `n${i}`,
      parent: 'w',
      native: true,
      label: null,
      nativeMeta: { title: `sub-${i}`, kind: 'research' },
      status: i === 6 ? S.pending('approval', ago(5)) : S.working(ago(50 + i)),
      createdAt: ago(500 - i),
    });
  const rows = rich(specs);
  const at = rows.findIndex((r) => r.includes('┌ ▸') && r.includes(' w '));
  const body = rows.slice(
    at + 1,
    rows.findIndex((r, i) => i > at && /^ {2}└/.test(r))
  );
  assert.equal(body[0].trim(), '│ implementer · ⊟ headless · bound 1h');
  const subs = body.slice(1, 6);
  assert.equal(subs.length, 5);
  assert.match(subs[0], /│ ⚑ ⌕ sub-6 · approval +5s$/, 'the trouble sub-row first');
  assert.equal(body[6].trim(), '│ +2 (2▸)');
  assert.equal(body.length, 7);
});

test('a card with children the tree did not list: `children unknown`, or `+N?` when some are folded', () => {
  const rows = rich([
    ROOT,
    { id: 'w', parent: 'main', status: S.working(ago(100)), continuation: true },
    {
      id: 'n',
      parent: 'w',
      native: true,
      label: null,
      nativeMeta: { title: 'scout', kind: 'research' },
      status: S.working(ago(30)),
    },
  ]);
  assert.ok(
    rows.some((r) => r.trim() === '│ children unknown'),
    rows.join('\n')
  );
  const specs: NodeSpec[] = [ROOT, { id: 'w', parent: 'main', status: S.working(ago(100)), continuation: true }];
  for (let i = 0; i < 6; i++)
    specs.push({ id: `n${i}`, parent: 'w', native: true, label: null, status: S.working(ago(30 + i)) });
  assert.ok(rich(specs).some((r) => r.trim() === '│ +1? (1▸)'));
});

test('root natives are cards; a native under a native is a sub-row of that card', () => {
  const rows = rich([
    { ...ROOT, harness: 'codex' },
    {
      id: 'l1',
      parent: 'main',
      native: true,
      label: null,
      nativeMeta: { title: 'lead', kind: 'fix' },
      status: S.working(ago(90)),
    },
    {
      id: 'l2',
      parent: 'l1',
      native: true,
      label: null,
      nativeMeta: { title: 'helper', kind: 'research' },
      status: S.working(ago(40)),
    },
    {
      id: 'l3',
      parent: 'l2',
      native: true,
      label: null,
      nativeMeta: { title: 'deep', kind: 'summary' },
      status: S.working(ago(20)),
    },
  ]);
  assert.ok(
    rows.some((r) => /^ {2}┌ ▸ ⚒ lead ─/.test(r)),
    rows.join('\n')
  );
  assert.ok(rows.some((r) => /^ {2}│ ▸ ⌕ helper +◷0m40s$/.test(r)));
  assert.ok(
    rows.some((r) => /^ {2}│ ▸ ∑ deep +◷0m20s$/.test(r)),
    'descendants at any depth inside the card'
  );
  assert.ok(!rows.some((r) => /┌ ▸ ⌕ helper/.test(r)));
});

test('a sub-row carries a badge only when its model differs from the card`s (not its own parent`s)', () => {
  const tree = (deepModel: string): NodeSpec[] => [
    { ...ROOT, harness: 'codex' },
    { id: 'w', parent: 'main', status: S.working(ago(90)), model: 'gpt-6.1-sol', effort: 'high' },
    {
      id: 'mid',
      parent: 'w',
      native: true,
      label: null,
      nativeMeta: { title: 'mid', kind: 'fix' },
      status: S.working(ago(40)),
      model: 'fable-5.1',
    },
    {
      id: 'deep',
      parent: 'mid',
      native: true,
      label: null,
      nativeMeta: { title: 'deep', kind: 'fix' },
      status: S.working(ago(20)),
      model: deepModel,
    },
  ];
  const deepRow = (rows: string[]) => rows.find((r) => r.includes(' deep '))!;
  // Same model as the card: no badge, although it differs from its own parent `mid`.
  assert.match(deepRow(rich(tree('gpt-6.1-sol'), { width: 80 })), /deep +◷0m20s$/);
  // Another model than the card's: the badge.
  assert.match(deepRow(rich(tree('fable-5.1'), { width: 80 })), /deep +\S.* ◷0m20s$/);
  assert.notEqual(deepRow(rich(tree('fable-5.1'), { width: 80 })), deepRow(rich(tree('gpt-6.1-sol'), { width: 80 })));
});

test('accordion: finished cards fold first, then the unselected live ones, the root last; trouble and the selection never', () => {
  const specs: NodeSpec[] = [
    ROOT,
    { id: 'flag', parent: 'main', status: S.pending('approval', ago(5)), createdAt: ago(900) },
    { id: 'live', parent: 'main', status: S.working(ago(100)), createdAt: ago(800) },
    { id: 'sel', parent: 'main', status: S.working(ago(100)), createdAt: ago(700) },
    {
      id: 'done',
      parent: 'main',
      run: { state: 'ended', mode: 'headless', endedAt: ago(60) },
      status: S.exited(ago(60)),
      report: { status: 'completed', summary: 'All good.', at: ago(60) },
      createdAt: ago(600),
    },
  ];
  const full = rich(specs, { selected: 'sel' });
  const tall = full.length;
  const ids = ['main', 'flag', 'live', 'sel', 'done'];
  const folded = (rows: string[]) =>
    rows.filter((r) => /^ *─ /.test(r)).map((r) => ids.find((id) => new RegExp(`\\b${id}\\b`).test(r))!);
  assert.deepEqual(folded(full), [], 'no viewport: nothing folds');
  assert.deepEqual(folded(rich(specs, { selected: 'sel', viewport: tall - 1 })), ['done']);
  assert.deepEqual(folded(rich(specs, { selected: 'sel', viewport: tall - 4 })), ['live', 'done']);
  const tiny = rich(specs, { selected: 'sel', viewport: 4 });
  assert.deepEqual(folded(tiny), ['main', 'live', 'done'], 'the root folds last');
  assert.ok(
    tiny.some((r) => /┌ ⚑ /.test(r)),
    'the trouble card never folds'
  );
  assert.ok(
    tiny.some((r) => /› ▸ /.test(r)),
    'the selected card never folds'
  );
  // A folded card is its compact row with `─` in the frame column.
  const row = tiny.find((r) => r.includes('live'))!;
  assert.match(row, /^ {2}─ ▸ ⌬ live +\S/);
});

test('accordion: more than five card siblings fold their finished cards at once', () => {
  const specs: NodeSpec[] = [ROOT];
  for (let i = 0; i < 5; i++)
    specs.push({ id: `w${i}`, parent: 'main', status: S.working(ago(100)), createdAt: ago(900 - i) });
  specs.push({
    id: 'done',
    parent: 'main',
    run: { state: 'ended', mode: 'headless', endedAt: ago(60) },
    status: S.exited(ago(60)),
    report: { status: 'completed', summary: 'ok', at: ago(60) },
  });
  const rows = rich(specs);
  assert.ok(
    rows.some((r) => /^ {2}─ ✓ ⌬ done/.test(r)),
    rows.join('\n')
  );
  assert.ok(rows.some((r) => /^ {2}┌ ▸ ⌬ w0 /.test(r)));
  // Five siblings: nothing folds.
  assert.ok(!rich(specs.filter((s) => s.id !== 'w4')).some((r) => /─ ✓ done/.test(r)));
});

test('card cache: an unchanged frame draws nothing again; the next second redraws only the feet of live cards', () => {
  const specs: NodeSpec[] = [
    ROOT,
    { id: 'w', parent: 'main', status: S.working(ago(100)) },
    {
      id: 'done',
      parent: 'main',
      run: { state: 'ended', mode: 'headless', endedAt: ago(7200) },
      status: S.exited(ago(7200)),
      report: { status: 'completed', summary: 'ok', at: ago(7200) },
    },
  ];
  const { vm } = buildVm(specs);
  const draw = (nowMs: number) =>
    delegationAgentsRows(vm, { width: 48, nowMs, style: 'rich', showHistory: true }).map((r) => r.text);
  const first = draw(NOW);
  const misses = cardCacheStats.misses;
  assert.deepEqual(draw(NOW), first);
  assert.equal(cardCacheStats.misses, misses, 'the same second: no card body is drawn again');
  const next = draw(NOW + 1000);
  assert.equal(cardCacheStats.misses, misses, 'a new second: the heads and bodies are reused');
  const changed = next.map((line, i) => (line === first[i] ? null : stripAnsi(line).trim())).filter(Boolean);
  assert.equal(changed.length, 2, 'the root and the live worker: their feet, nothing else');
  assert.ok(
    changed.every((line) => line!.startsWith('└ ◷')),
    changed.join('\n')
  );
});

test('a card is exactly as tall as its drawing: head first, foot last, no blank filler (every scenario, every width)', () => {
  const situations = [
    situationA,
    situationB,
    () => situationC({ reviewPass: true, nativeMeta: true }),
    situationD,
    situationE,
    situationG,
    situationH,
  ];
  for (const make of situations) {
    const built = make();
    for (const width of [32, 40, 48, 56, 80])
      for (const selected of [null, ...Object.values(built.keys)]) {
        const rows = delegationAgentsRows(built.vm, {
          width,
          nowMs: NOW,
          style: 'rich',
          selectedId: selected,
          showHistory: true,
        });
        const groups = new Map<string, string[]>();
        for (const row of rows) {
          if (!row.key?.startsWith('card:')) continue;
          const group = groups.get(row.key) ?? [];
          group.push(stripAnsi(row.text));
          groups.set(row.key, group);
        }
        for (const [key, lines] of groups) {
          if (lines.length === 1) continue; // folded
          assert.match(lines[0].trimStart(), /^[┌›]/, `${key} ${width}: head`);
          assert.match(lines.at(-1)!.trimStart(), /^└/, `${key} ${width}: foot last`);
          for (const line of lines) assert.notEqual(line.trim(), '', `${key} ${width}: no filler`);
        }
      }
  }
});

test('lookId is monotonic: a cleared table never hands out an id a cached card still carries (F2)', () => {
  const g = glyphSet(false);
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const say: Say = (word) => `${word}${i}`;
    const id = lookId(g, say);
    assert.ok(!seen.has(id), `look ${i} took a used id ${id}`);
    seen.add(id);
  }
});

test('a folded card and a sub-row are tiered by the panel width: the badge of a compact row at 48 (F3)', () => {
  const d = situationD();
  const compact = delegationAgentsRows(d.vm, { width: 48, nowMs: NOW, style: 'compact' }).map((r) => stripAnsi(r.text));
  const folded = delegationAgentsRows(d.vm, { width: 48, nowMs: NOW, style: 'rich', viewport: 16 }).map((r) =>
    stripAnsi(r.text)
  );
  for (const id of ['t-01', 't-12', 't-09']) {
    const row = compact.find((r) => r.includes(` ${id} `))!;
    const fold = folded.find((r) => r.includes(` ${id} `) && /^ *─ /.test(r))!;
    assert.ok(fold, `${id} folded: ${folded.join('\n')}`);
    assert.equal(fold.slice(-26), row.slice(-26), `${id}: the same right cluster (badge, meter, clock)`);
  }
});

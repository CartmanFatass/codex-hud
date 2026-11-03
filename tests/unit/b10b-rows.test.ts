/**
 * Design §3.2, §3.4, §3.6, §4.2: the tree's compact rows. Every row is exactly
 * the width it was asked for (any situation, any width, both icon sets, both
 * languages, selected or not); the field-shedding order of §4.2; trouble rows
 * without badge and meter; the history summary's 12-column rule; folds, deep
 * rows, conflict edges, the folded-history row; the order of siblings; and the
 * plan and row caches.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { cells, cellsOf } from '../fixtures/b10b-sgr.js';
import { setLanguage } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { projectDelegation } from '../../src/render/delegation/projection.js';
import {
  COARSE_CLOCK_ROWS,
  planRows,
  PUT_AWAY_MS,
  renderRow,
  renderRows,
  turnClockText,
  type RowOptions,
} from '../../src/render/delegation/rows.js';
import { plainSay } from '../../src/render/delegation/style.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationC,
  situationD,
  situationE,
  situationG,
  situationH,
  type Built,
  type NodeSpec,
} from '../fixtures/b10b-delegation.js';

const plain = (value: string): string => stripAnsi(value);

interface Draw {
  ascii?: boolean;
  selectedKey?: string | null;
  say?: typeof plainSay;
}

function draw(vm: DelegationViewModel, width: number, options: Partial<RowOptions> & Draw = {}): string[] {
  const { ascii, selectedKey, say, ...rest } = options;
  return renderRows(
    projectDelegation(vm),
    { nowMs: NOW, ...rest },
    { width, ascii, selectedKey, say: say ?? plainSay }
  ).map(plain);
}

const root = (): NodeSpec => ({ id: 'main', root: true, harness: 'claude', status: S.working(ago(30)), label: null });

function chain(depth: number): Built {
  const specs: NodeSpec[] = [root()];
  for (let i = 1; i <= depth; i++)
    specs.push({
      id: `a${i}`,
      parent: i === 1 ? 'main' : `a${i - 1}`,
      harness: 'codex',
      status: S.working(ago(60 + i)),
      createdAt: ago(600 - i),
      model: 'gpt-6.1-sol',
      contextPercent: 10 * i,
    });
  return buildVm(specs);
}

const SITUATIONS: Array<[string, () => Built, Partial<RowOptions>]> = [
  ['c', () => situationC({ reviewPass: true }), {}],
  ['d', situationD, {}],
  ['e', situationE, {}],
  ['g', situationG, {}],
  ['g history', situationG, { showHistory: true }],
  ['h', situationH, {}],
  ['deep', () => chain(7), {}],
];

test('every row is exactly the width asked for: situations x widths x icon sets x selection', () => {
  for (const [name, build, options] of SITUATIONS) {
    const built = build();
    const keys = Object.values(built.keys);
    for (let width = 20; width <= 100; width++) {
      for (const ascii of [false, true]) {
        for (const selectedKey of [null, keys[1] ?? null]) {
          for (const row of draw(built.vm, width, { ...options, ascii, selectedKey }))
            assert.equal(visualLength(row), width, `${name} w${width} ascii=${ascii} sel=${selectedKey}: |${row}|`);
        }
      }
    }
  }
});

test('Chinese words keep every row at exactly the width asked for', () => {
  const previous = setLanguage('zh');
  try {
    for (const [name, build, options] of SITUATIONS) {
      const built = build();
      for (let width = 20; width <= 100; width += 3) {
        const rows = renderRows(projectDelegation(built.vm), { nowMs: NOW, ...options }, { width }).map(plain);
        for (const row of rows) assert.equal(visualLength(row), width, `${name} w${width}: |${row}|`);
      }
    }
    const rows = renderRows(projectDelegation(situationC().vm), { nowMs: NOW }, { width: 80 }).map(plain);
    assert.match(rows[1], /review-tests ⊟ · 审批 +10s$/);
  } finally {
    setLanguage(previous);
  }
});

test('ASCII rows hold only printable ASCII besides user-written names and the model badge', () => {
  // The model badge has its own switch (`glyphs`); with it on text, its `·` is the badge's, not this view's.
  const previous = setDisplayConfig({ glyphs: 'text' });
  try {
    for (const [name, build, options] of SITUATIONS) {
      for (const width of [24, 32, 40, 48, 80]) {
        for (const row of draw(build().vm, width, { ...options, ascii: true })) {
          const own = row.replace(/scout 中文 bou\S*/g, 'scout').replace(/\S*sol\S*/g, '');
          assert.doesNotMatch(own, /[^\x20-\x7e]/, `${name} ${width}: |${row}|`);
        }
      }
    }
  } finally {
    setDisplayConfig(previous);
  }
});

test('situation (c) at 80 columns', () => {
  assert.deepEqual(draw(situationC().vm, 80), [
    '  ▸ ✳ main                                              fable-5.1 ◕ ━╸──  ◷3m10s',
    ' ├ ⚑ π review-tests ⊟ · approval                                             10s',
    ' ├ ▸ ⌬ impl-parser                                        ★● 6.1sol ━━── ◷12m04s',
    ' │ └ ▸   scout 中文 boundaries                                            ◷1m00s',
    ' ├ ▸ ◎ ask-pro                                                            ◷4m00s',
    ' └ ✓ ⌬ docs-sync · Synced two reference sections.                             2m',
  ]);
});

test('situation (c): the field-shedding order at 56, 48, 40, 32 and 24 columns (§4.2)', () => {
  const at = (width: number) => draw(situationC().vm, width);
  assert.deepEqual(at(56), [
    '  ▸ ✳ main                      fable-5.1 ◕ ━╸──  ◷3m10s',
    ' ├ ⚑ π review-tests ⊟ · approval                     10s',
    ' ├ ▸ ⌬ impl-parser                ★● 6.1sol ━━── ◷12m04s',
    ' │ └ ▸   scout 中文 boundaries                    ◷1m00s',
    ' ├ ▸ ◎ ask-pro                                    ◷4m00s',
    ' └ ✓ ⌬ docs-sync · Synced two reference section…      2m',
  ]);
  // 48: the badge keeps its 13 columns; 40: the badge shrinks to the glyphs; 32: no badge, and the word goes before the name is cut
  // (the `⊟` the word made room for comes back).
  assert.match(at(48)[2], /★● 6\.1sol ━━── ◷12m04s$/);
  assert.match(at(40)[2], /★● ━━── ◷12m04s$/);
  assert.doesNotMatch(at(40)[2], /sol/);
  assert.deepEqual(at(32), [
    '  ▸ ✳ main          ━╸──  ◷3m10s',
    ' ├ ⚑ π review-tests ⊟        10s',
    ' ├ ▸ ⌬ impl-parser  ━━── ◷12m04s',
    ' │ └ ▸   scout 中文 bou…  ◷1m00s',
    ' ├ ▸ ◎ ask-pro            ◷4m00s',
    ' └ ✓ ⌬ docs-sync              2m',
  ]);
  // 24: the meter goes too, the name is cut, the clock stays.
  assert.deepEqual(at(24), [
    '  ▸ ✳ main        ◷3m10s',
    ' ├ ⚑ π review-t…     10s',
    ' ├ ▸ ⌬ impl-par… ◷12m04s',
    ' │ └ ▸   scout …  ◷1m00s',
    ' ├ ▸ ◎ ask-pro    ◷4m00s',
    ' └ ✓ ⌬ docs-sync      2m',
  ]);
});

test('trouble rows drop the badge and the meter at any width, and keep the word and the clock', () => {
  for (const build of [situationD, situationE, situationH]) {
    const rows = draw(build().vm, 80);
    const trouble = rows.filter((r) => /^ [├└┊] [⚑?⚠!] /.test(r) || /^ [├└┊] [⚑?⚠!]/.test(r));
    assert.ok(trouble.length > 0);
    for (const row of trouble) {
      assert.doesNotMatch(row, /★|◕|sol|[━╸]/, row);
      assert.match(row, /\d+[smhd]$/, row);
    }
  }
  assert.match(draw(situationD().vm, 80)[1], /^ ├ ⚑ π t-07 ⊟ · approval\s+10s$/);
  assert.match(draw(situationH().vm, 80)[1], /^ ├ ⚑ ⌬ impl-parser · stop in pane\s+2m$/);
});

test('below 40 columns the name keeps 8 columns and the word goes first; from 40 the word stays', () => {
  const e32 = draw(situationE().vm, 32);
  assert.match(e32[4], /^ ├ \? ⌬ impl-d\s+7m$/);
  assert.match(e32[5], /^ ├ ⚑ ◎ ask-pro\s+9m$/);
  // A short name already under 8: the word still fits beside it.
  assert.match(e32[3], /impl-c · conflict/);
  const e40 = draw(situationE().vm, 40);
  assert.match(e40[4], /impl-d · supervisor lost\s+7m$/);
  // The name is cut to its floor before it gives up more: never below 8 columns while it has them.
  const d32 = draw(situationD().vm, 32);
  assert.match(d32[1], /t-07 ⊟ · approval/);
  const long = buildVm([
    root(),
    {
      id: 'x',
      parent: 'main',
      harness: 'codex',
      label: 'a-very-long-worker-name',
      status: S.pending('approval', ago(10)),
      createdAt: ago(100),
    },
  ]);
  for (let width = 28; width <= 39; width++) {
    const row = draw(long.vm, width)[1];
    const name = /^ └ \S ⌬ (\S+)/.exec(row)?.[1] ?? '';
    assert.ok(visualLength(name.replace(/…/g, '.')) >= 8, `${width}: |${row}|`);
    assert.doesNotMatch(row, /approval/, `${width}: the word is gone below 40: |${row}|`);
  }
});

test('history rows say what they delivered: the summary after 12 free columns, else the word', () => {
  const rows80 = draw(situationC().vm, 80);
  assert.match(rows80[5], /docs-sync · Synced two reference sections\.\s+2m$/);
  // Cut by the column with an ellipsis, in muted text.
  assert.match(draw(situationC().vm, 48)[5], /docs-sync · Synced two reference…\s+2m$/);
  // Under 12 columns of room: the summary is not shown and `reported` says nothing a check mark does not.
  assert.match(draw(situationC().vm, 32)[5], /^ └ ✓ ⌬ docs-sync\s+2m$/);
  // A failure keeps `failed` when there is no room.
  const g = draw(situationG().vm, 32, { showHistory: true });
  assert.match(
    g.find((r) => r.includes('lint-fix'))!,
    /! π lint-fix · failed\s+31m$/
  );
  const g80 = draw(situationG().vm, 80, { showHistory: true });
  assert.match(
    g80.find((r) => r.includes('lint-fix'))!,
    /! π lint-fix · Lint rule 12 unresolved after three passes\.\s+31m$/
  );
  // No badge and no meter on history rows.
  assert.doesNotMatch(g80.filter((r) => /[✓!■]/.test(r.slice(0, 6))).join('\n'), /6\.1sol|[━╸]/);
});

test('a two-word state gives up its second word before the first is clipped (from 40 columns)', () => {
  const rowAt = (width: number) => draw(situationG().vm, width, { showHistory: true }).find((r) => r.includes('soak'))!;
  assert.match(rowAt(48), /^ ├ ■ ⌬ soak · ended · runtime limit\s+2h$/);
  assert.match(rowAt(43), /^ ├ ■ ⌬ soak · ended · runtime limit\s+2h$/);
  for (const width of [40, 41, 42]) {
    assert.match(rowAt(width), /^ ├ ■ ⌬ soak · ended\s+2h$/, `${width}: |${rowAt(width)}|`);
    assert.doesNotMatch(rowAt(width), /runti/, 'a whole field goes, no cut text');
  }
  // Below 40 the word goes first, as for every state (the second word with it).
  assert.match(rowAt(36), /^ ├ ■ ⌬ soak\s+2h$/);
});

test('situation (g) with history: every ending gets its word, newest at the bottom of its bucket', () => {
  const rows = draw(situationG().vm, 80, { showHistory: true });
  assert.deepEqual(
    rows.map((r) => r.replace(/\s+/g, ' ').trim().replace(/^[›]/, '')),
    [
      '▸ ✳ main fable-5.1 ◕ ━╸── ◷1m20s',
      '├ ▸ ⌬ impl-parser ⊟ ★● 6.1sol ━━── ◷12m04s',
      '├ ■ ⌬ t-old · ended 2d',
      '├ ✓ ⌬ t-07 · reported 3h',
      '├ ■ ⌬ soak · ended · runtime limit 2h',
      '├ ■ ⌬ bench · cancelled 1h',
      '├ ! π lint-fix · Lint rule 12 unresolved after three passes. 31m',
      '└ ✓ ⌬ docs-sync · Synced two reference sections. 14m',
    ]
  );
});

test('finished rows fold into one `✓ N done` row once the linger window has passed, and `a` brings them back', () => {
  const folded = draw(situationG().vm, 80);
  assert.equal(folded.length, 3);
  assert.match(folded[2], /^ └ ✓ 6 done · t-old t-07 soak bench lint-fix docs-sync\s+⊕6$/);
  const d = draw(situationD().vm, 80);
  assert.match(d[7], /^ └ ✓ 9 done · t-02 t-03 t-04 t-05 t-06 t-14 t-15 t-16 …\s+⊕9$/);
  // Narrow: fewer names, the ellipsis, the count still last.
  assert.match(draw(situationD().vm, 40)[7], /^ └ ✓ 9 done · t-02 t-03 t-04 t-05 …\s+⊕9$/);
  assert.match(draw(situationD().vm, 24)[7], /⊕9$/);
  // Just inside the window nothing folds; at the window it does.
  const justNow = buildVm([
    root(),
    {
      id: 'w',
      parent: 'main',
      harness: 'codex',
      run: { state: 'ended', mode: 'headless', endedAt: NOW - PUT_AWAY_MS + 1000 },
      status: S.exited(NOW - PUT_AWAY_MS + 1000),
      report: { status: 'completed', summary: '', at: NOW - PUT_AWAY_MS + 1000 },
      createdAt: ago(900),
    },
  ]);
  assert.doesNotMatch(draw(justNow.vm, 60)[1], /done/);
  assert.doesNotMatch(draw(justNow.vm, 60, { nowMs: NOW + 999 })[1], /done/);
  assert.match(draw(justNow.vm, 60, { nowMs: NOW + 1000 })[1], /1 done · w/);
});

test('a finished subtree with an unfinished descendant stays on the list', () => {
  const tree = buildVm([
    root(),
    {
      id: 'p',
      parent: 'main',
      harness: 'codex',
      run: { state: 'ended', mode: 'headless', endedAt: ago(3600) },
      status: S.exited(ago(3600)),
      report: { status: 'completed', summary: 'Done.', at: ago(3600) },
      createdAt: ago(5000),
    },
    { id: 'k', parent: 'p', harness: 'codex', status: S.working(ago(100)), createdAt: ago(200) },
  ]);
  const rows = draw(tree.vm, 60);
  assert.equal(rows.length, 3);
  assert.doesNotMatch(rows.join('\n'), /done/);
});

test('rows deeper than 4 are drawn at depth 4 with a flat `↳`', () => {
  const rows = draw(chain(7).vm, 60);
  assert.equal(rows.length, 8);
  assert.match(rows[4], /^ {7}└ ▸ ⌬ a4/);
  for (const i of [5, 6, 7]) assert.match(rows[i], /^ {7}↳ ▸ ⌬ a\d/);
  assert.deepEqual(
    planRows(projectDelegation(chain(7).vm), { nowMs: NOW }).rows.map((r) => r.depth),
    [0, 1, 2, 3, 4, 4, 4, 4]
  );
});

test('a folded node says how many it hides: long form, short form, unknown children', () => {
  const c = situationC({ reviewPass: true });
  const folded = new Set([c.keys['impl-parser']]);
  assert.match(draw(c.vm, 80, { collapsed: folded })[2], /impl-parser \+2 \(1▸ 1✓\)/);
  // The short form when the long one will not fit: the count and the worst glyph, `+2▸`.
  assert.match(draw(c.vm, 40, { collapsed: folded })[2], /impl-par… \+2▸ /);
  assert.match(draw(c.vm, 48, { collapsed: folded })[2], /\+2▸ /);
  assert.doesNotMatch(draw(c.vm, 80, { collapsed: folded }).join('\n'), /scout/);

  const open = buildVm([
    root(),
    { id: 'x', parent: 'main', harness: 'codex', status: S.working(ago(60)), continuation: true, createdAt: ago(100) },
    {
      id: 'x1',
      parent: 'x',
      native: true,
      harness: 'codex',
      label: 'kid',
      status: S.working(ago(60)),
      createdAt: ago(90),
    },
  ]);
  assert.match(draw(open.vm, 80, { collapsed: new Set([open.keys.x]) })[1], /x ⊟ \+1\? \(1▸\)/);
});

test('the worst glyph leads the fold: a trouble below wins over the working below', () => {
  const tree = buildVm([
    root(),
    {
      id: 'p',
      parent: 'main',
      harness: 'codex',
      label: 'parent-worker',
      status: S.working(ago(60)),
      createdAt: ago(400),
    },
    { id: 'k1', parent: 'p', harness: 'codex', status: S.working(ago(60)), createdAt: ago(300) },
    { id: 'k2', parent: 'p', harness: 'pi', status: S.pending('approval', ago(5)), createdAt: ago(200) },
  ]);
  const rows = draw(tree.vm, 80, { collapsed: new Set([tree.keys.p]) });
  assert.match(rows[1], /\+2 \(1⚑ 1▸\)/);
  assert.match(draw(tree.vm, 36, { collapsed: new Set([tree.keys.p]) })[1], /parent-work… \+2⚑/);
});

test('a conflict or an intent edge is drawn with `┊`, and a conflict row keeps its `~` age', () => {
  const e = draw(situationE().vm, 80);
  assert.match(e[3], /^ ┊ ⚠ ⌬ impl-c · conflict\s+~6m$/);
  const intent = buildVm([
    root(),
    {
      id: 'i',
      parent: 'main',
      kind: 'intent',
      harness: 'codex',
      label: 'plan-intent',
      run: { state: 'starting' },
      status: { cls: 'starting', since: ago(5) },
      createdAt: ago(5),
    },
  ]);
  assert.match(draw(intent.vm, 60)[1], /^ ┊ · plan-intent ⊟ · starting\s+5s$/);
  // ASCII has its own mark for it.
  assert.match(draw(intent.vm, 60, { ascii: true })[1], /^ : \. plan-intent - - starting\s+5s$/);
});

test('a node that was not loaded is `? · not loaded` with no clock', () => {
  const tree = buildVm([
    root(),
    {
      id: 'nl',
      parent: 'main',
      harness: 'codex',
      loaded: false,
      run: { state: 'running', mode: 'headless' },
      createdAt: ago(500),
    },
  ]);
  const row = draw(tree.vm, 60)[1];
  assert.match(row, /^ └ \? ⌬ nl ⊟ · not loaded\s*$/);
});

test('the selection mark replaces the first column and nothing else moves', () => {
  const c = situationC({ reviewPass: true });
  const plainRows = draw(c.vm, 60);
  const selected = draw(c.vm, 60, { selectedKey: c.keys['review-tests'] });
  assert.equal(selected[1][0], '›');
  assert.equal(selected[1].slice(1), plainRows[1].slice(1));
  assert.deepEqual(
    selected.filter((_, i) => i !== 1),
    plainRows.filter((_, i) => i !== 1)
  );
  assert.equal(draw(c.vm, 60, { ascii: true, selectedKey: c.keys['review-tests'] })[1][0], '>');
});

test('the native child shows a badge only when its model differs from its parent', () => {
  const c = situationC();
  const scout = draw(c.vm, 80)[3];
  assert.doesNotMatch(scout, /sol|★/);
  const differs = buildVm([
    root(),
    {
      id: 'p',
      parent: 'main',
      harness: 'codex',
      status: S.working(ago(60)),
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      createdAt: ago(300),
    },
    {
      id: 'n',
      parent: 'p',
      native: true,
      harness: 'codex',
      label: 'probe',
      status: S.working(ago(30)),
      model: 'gpt-6.1-flash',
      createdAt: ago(100),
    },
  ]);
  assert.match(draw(differs.vm, 80)[2], /probe\s+.*flash/);
});

test('siblings sort by subtree bucket: trouble newest first, then actives, then finished (§3.2)', () => {
  const e = draw(situationE().vm, 80).map((r) => /[⌬π◎✳] (\S+)/.exec(r)?.[1]);
  // impl-a is alive but holds the newest trouble below it, so it leads; then by dwell: 6m, 7m, 9m, 14m.
  assert.deepEqual(e, ['main', 'impl-a', 'rev-a', 'impl-c', 'impl-d', 'ask-pro', 'impl-b']);
  const c = draw(situationC().vm, 80).map((r) => /[⌬π◎✳] (\S+)/.exec(r)?.[1]);
  assert.deepEqual(c.slice(0, 6), ['main', 'review-tests', 'impl-parser', undefined, 'ask-pro', 'docs-sync']);
});

test('`s` sorts by creation alone, with no buckets', () => {
  const names = draw(situationC({ reviewPass: true }).vm, 60, { sortByCreation: true }).map((r) =>
    r.replace(/[│├└┊ ›]/g, ' ').trim()
  );
  const order = ['docs-sync', 'impl-parser', 'review-pass', 'scout', 'review-tests', 'ask-pro'];
  let at = 0;
  for (const name of order) {
    const found = names.findIndex((n, i) => i >= at && n.includes(name));
    assert.ok(found >= at, `${name} after ${at} in ${names.join(' / ')}`);
    at = found;
  }
});

test('turn clocks: seconds under an hour, minutes after, coarse drops the seconds', () => {
  assert.equal(turnClockText(0), '0m00s');
  assert.equal(turnClockText(724_000), '12m04s');
  assert.equal(turnClockText(3_599_000), '59m59s');
  assert.equal(turnClockText(3_900_000), '1h05m');
  assert.equal(turnClockText(724_000, true), '12m');
  assert.equal(turnClockText(-5000), '0m00s');
});

test('more than 30 active rows: the turn clocks go coarse so a second no longer repaints them', () => {
  const many = buildVm([
    root(),
    ...Array.from({ length: COARSE_CLOCK_ROWS + 1 }, (_, i): NodeSpec => ({
      id: `w${i}`,
      parent: 'main',
      harness: 'codex',
      status: S.working(ago(400 + i)),
      createdAt: ago(1000 - i),
    })),
  ]);
  const rows = draw(many.vm, 48);
  assert.ok(rows.every((r) => /◷\d+m$/.test(r)));
  const few = draw(chain(2).vm, 48);
  assert.ok(few.every((r) => /◷\d+m\d\ds$/.test(r)));
});

test('CJK: a wide character that does not fit leaves a space, and a name is cut by columns', () => {
  const c = situationC();
  assert.match(draw(c.vm, 32)[3], /scout 中文 bou…/);
  const wide = buildVm([
    root(),
    {
      id: 'a',
      parent: 'main',
      harness: 'codex',
      label: '解析器重构任务甲乙丙丁',
      status: S.working(ago(60)),
      createdAt: ago(100),
    },
  ]);
  for (let width = 22; width <= 60; width++) {
    const row = draw(wide.vm, width)[1];
    assert.equal(visualLength(row), width, `${width}: |${row}|`);
  }
});

test('the plan is memoised per option set until a subtree crosses its put-away time (B10B-s2, §6 #3)', () => {
  const proj = projectDelegation(situationC().vm);
  const a = planRows(proj, { nowMs: NOW });
  assert.equal(planRows(proj, { nowMs: NOW + 400 }), a);
  // The second moving on changes nothing in the plan: the same plan (B10B-s2; segment 1 replanned every second).
  assert.equal(planRows(proj, { nowMs: NOW + 1000 }), a);
  // `docs-sync` finished 120 s before NOW: at NOW + 60 s it is put away, and the plan is a new one.
  const later = planRows(proj, { nowMs: NOW + 60_000 });
  assert.notEqual(later, a);
  assert.equal(later.putAway, a.putAway + 1);
  assert.equal(planRows(proj, { nowMs: NOW + 59_999 }).putAway, a.putAway, 'and back before the boundary');
  assert.notEqual(planRows(proj, { nowMs: NOW, showHistory: true }), planRows(proj, { nowMs: NOW }));
  const key = [...proj.nodes].find((pn) => pn.children.length > 0 && !pn.proj.isRoot)!.key;
  const folded = planRows(proj, { nowMs: NOW, collapsed: new Set([key]) });
  assert.ok(folded.rows.length < a.rows.length);
  assert.equal(planRows(proj, { nowMs: NOW, collapsed: new Set([key]) }), folded);
});

test('a row is rendered once for what it reads: same inputs give the same string object cache', () => {
  const proj = projectDelegation(situationC().vm);
  const plan = planRows(proj, { nowMs: NOW });
  const ctx = { proj, width: 60, nowMs: NOW, coarse: plan.coarse };
  const row = plan.rows[2];
  assert.equal(renderRow(row, ctx), renderRow(row, ctx));
  assert.notEqual(renderRow(row, ctx), renderRow(row, { ...ctx, width: 48 }));
  assert.notEqual(renderRow(row, ctx), renderRow(row, { ...ctx, selectedKey: row.key }));
  assert.notEqual(renderRow(row, ctx), renderRow(row, { ...ctx, ascii: true }));
  // A tick later the turn clock moved, so the cached text is not reused.
  assert.notEqual(renderRow(row, ctx), renderRow(row, { ...ctx, nowMs: NOW + 5000 }));
});

test('no root row and no nodes: no rows', () => {
  const empty = buildVm([root()]);
  assert.equal(draw(empty.vm, 40).length, 1);
});

/** The rows as drawn, colours included. */
function drawRaw(vm: DelegationViewModel, width: number, options: Partial<RowOptions> & Draw = {}): string[] {
  const { ascii, selectedKey, say, ...rest } = options;
  return renderRows(
    projectDelegation(vm),
    { nowMs: NOW, ...rest },
    { width, ascii, selectedKey, say: say ?? plainSay }
  );
}

test('a folded node keeps its counts apart: 1 flag + 11 failures is not 11 flags + 1 failure', () => {
  const tree = (flags: number, fails: number) =>
    buildVm([
      root(),
      {
        id: 'p',
        parent: 'main',
        harness: 'codex',
        label: 'parent-worker',
        status: S.working(ago(60)),
        createdAt: ago(900),
      },
      ...Array.from({ length: 12 }, (_, i): NodeSpec => {
        const spec: NodeSpec = { id: `k${i}`, parent: 'p', harness: 'codex', createdAt: ago(800 - i) };
        return {
          ...spec,
          status:
            i < flags ? S.pending('approval', ago(30)) : i < flags + fails ? S.failed(ago(40)) : S.working(ago(60)),
        };
      }),
    ]);
  const first = tree(1, 11);
  const second = tree(11, 1);
  const options = { collapsed: new Set([first.keys.p]) };
  // The same parent, cached, under two different sets of children.
  assert.match(draw(first.vm, 80, options)[1], /\+12 \(1⚑ 11!\)/);
  assert.match(draw(second.vm, 80, options)[1], /\+12 \(11⚑ 1!\)/);
  assert.match(draw(first.vm, 80, options)[1], /\+12 \(1⚑ 11!\)/);
});

test('§3.4: an age that cannot be measured is left empty, never `0s`', () => {
  const clockOf = (row: string): string => row.slice(-7).trim();
  // A time that has not happened yet: the entering time, the evidence time and the turn start.
  const future = buildVm([
    root(),
    { id: 'w', parent: 'main', status: S.working(NOW + 90_000), createdAt: ago(500) },
    { id: 'p', parent: 'main', status: S.pending('approval', NOW + 60_000), createdAt: ago(400) },
    {
      id: 'u',
      parent: 'main',
      run: { state: 'uncertain', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', since: ago(100), evidenceAt: NOW + 60_000 },
      createdAt: ago(300),
    },
  ]);
  const rows = draw(future.vm, 60);
  for (const key of ['w', 'p', 'u']) {
    const row = rows.find((r) => new RegExp(`⌬ ${key}\\b`).test(r));
    assert.ok(row, key);
    assert.equal(clockOf(row!), '', `${key}: |${row}|`);
    assert.doesNotMatch(row!, /\d+[smhd]\s*$/);
  }
  // A clock the observation calls anomalous is empty even where the time is in the past.
  const anomaly = buildVm([
    root(),
    {
      id: 'x',
      parent: 'main',
      status: { cls: 'unknown', since: ago(100), basis: 'event', evidenceAt: ago(50), clockAnomaly: true },
      createdAt: ago(500),
    },
    { id: 'y', parent: 'main', status: { cls: 'working', since: ago(100), clockAnomaly: true }, createdAt: ago(400) },
  ]);
  for (const key of ['x', 'y']) {
    const row = draw(anomaly.vm, 60).find((r) => new RegExp(`⌬ ${key}\\b`).test(r))!;
    assert.equal(clockOf(row), '', `${key}: |${row}|`);
  }
  // And the same nodes with a sane clock do draw one.
  const sane = buildVm([
    root(),
    { id: 'x', parent: 'main', status: { cls: 'working', since: ago(100) }, createdAt: ago(500) },
  ]);
  assert.match(draw(sane.vm, 60)[1], /◷1m40s$/);
});

const hex = (value: string): string => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  return `2;${r};${g};${b}`;
};

test('§5.2: a selected row is the palette band across the whole row, without faint text or the alert hue lost', () => {
  const bands: Array<[string, string, string]> = [
    // palette, band, danger (the `⚑` hue)
    ['mocha', '#45475A', '#F38BA8'],
    ['latte', '#CCD0DA', '#D20F39'],
    ['titanium', '#2E3540', '#FF4757'],
  ];
  const previous = setDisplayConfig({});
  try {
    for (const [theme, band, danger] of bands) {
      setDisplayConfig({ theme: theme as never });
      const c = situationC({ reviewPass: true });
      for (const width of [32, 48, 80]) {
        const rows = drawRaw(c.vm, width, { selectedKey: c.keys['review-tests'] });
        const selected = cells(rows[1]);
        assert.equal(selected.length, width, `${theme} ${width}: one cell per column`);
        assert.ok(
          selected.every((cell) => cell.bg === hex(band)),
          `${theme} ${width}: the band covers every cell`
        );
        assert.ok(
          selected.every((cell) => !cell.faint),
          `${theme} ${width}: no faint text on the band`
        );
        // The marker keeps its meaning on the band: `⚑` is the bold danger hue.
        const flag = cellsOf(rows[1], '⚑')[0];
        assert.equal(flag.fg, hex(danger), `${theme}: the alert hue survives`);
        assert.equal(flag.bold, true);
        // The other rows carry no band at all.
        for (const [i, row] of rows.entries())
          if (i !== 1)
            assert.ok(
              cells(row).every((cell) => cell.bg === null),
              `${theme} ${width} row ${i}`
            );
      }
      // A working row on the band keeps the info hue, and the meter and clock are legible.
      const work = drawRaw(c.vm, 80, { selectedKey: c.keys['impl-parser'] })[2];
      assert.ok(
        cells(work).every((cell) => cell.bg === hex(band) && !cell.faint),
        `${theme}: the working row`
      );
    }
  } finally {
    setDisplayConfig(previous);
  }
});

test('§5.2: a palette without a band (none, terminal) selects with › and a bold name, and no background', () => {
  const previous = setDisplayConfig({});
  try {
    // The selection is `›` and a bold name, and no cell has a background.
    // Every other cell is painted as on the unselected row, muted text included.
    for (const theme of ['none', 'terminal'] as const) {
      setDisplayConfig({ theme });
      const c = situationC({ reviewPass: true });
      const was = cells(drawRaw(c.vm, 60)[1]);
      const rows = drawRaw(c.vm, 60, { selectedKey: c.keys['review-tests'] });
      const now = cells(rows[1]);
      assert.equal(now.length, 60);
      assert.ok(
        now.every((cell) => cell.bg === null),
        `${theme}: no background on the selected row`
      );
      assert.equal(now[0].ch, '›', `${theme}: the selection mark`);
      assert.ok(
        cellsOf(rows[1], 'review-tests').every((cell) => cell.bold),
        `${theme}: the name is bold`
      );
      now.forEach((cell, i) => {
        if (i === 0) return;
        assert.equal(cell.fg, was[i].fg, `${theme}: cell ${i} keeps its colour`);
        assert.equal(cell.faint, was[i].faint, `${theme}: cell ${i} keeps its dimming`);
      });
      if (theme === 'terminal')
        assert.ok(
          now.some((cell) => cell.faint),
          'terminal: muted text stays muted: there is no band to make it illegible'
        );
    }
  } finally {
    setDisplayConfig(previous);
  }
});

test('§3.2, §5.2: a state that began in the last three seconds has its word and its clock bold, for every node', () => {
  const previous = setDisplayConfig({ theme: 'mocha' });
  try {
    type Basis = 'event' | 'observed' | 'unknown';
    const starting = (basis: Basis, since: number, extra: { clockAnomaly?: boolean } = {}): Built =>
      buildVm([
        { ...root(), status: S.working(ago(30)) },
        {
          id: 'a',
          parent: 'main',
          harness: 'codex',
          run: { state: 'starting' },
          status: { cls: 'starting', since, basis, ...extra },
          createdAt: ago(100),
        },
      ]);
    /** Is the state word bold, and the clock (the last 7 columns, there must be one) too? */
    const bold = (built: Built, nowMs: number, at = 1, word = 'starting') => {
      const row = drawRaw(built.vm, 60, { nowMs })[at];
      const clock = cells(row)
        .slice(-7)
        .filter((cell) => cell.ch !== ' ');
      return {
        word: cellsOf(row, word).every((cell) => cell.bold),
        clock: clock.length > 0 && clock.every((cell) => cell.bold),
      };
    };
    const on = { word: true, clock: true };
    const off = { word: false, clock: false };
    const since = NOW - 10_000;

    // Either side of the third second, on a state that is not an alert.
    const tree = starting('event', since);
    assert.deepEqual(bold(tree, since + 2999), on);
    assert.deepEqual(bold(tree, since + 3000), off);
    assert.deepEqual(bold(tree, since + 20_000), off);

    // An observed boundary is a persisted episode too (the commit carries it), clock `~1s` and all; its window ends the same.
    assert.deepEqual(bold(starting('observed', since), since + 1000), on);
    assert.match(plain(drawRaw(starting('observed', since).vm, 60, { nowMs: since + 1000 })[1]), /~1s$/);
    assert.deepEqual(bold(starting('observed', since), since + 2999), on);
    assert.deepEqual(bold(starting('observed', since), since + 3000), off);

    // The viewpoint root is a node like the others: its own new episode is emphasised, and ends at the same second.
    const rootStarting = (at: number) => buildVm([{ ...root(), status: S.starting(at) }]);
    assert.deepEqual(bold(rootStarting(since), since + 1000, 0), on, 'the root');
    assert.deepEqual(bold(rootStarting(since), since + 3000, 0), off);
    const rootUncertain = buildVm([{ ...root(), status: { cls: 'uncertain', since: NOW - 1000 } }]);
    assert.equal(
      cellsOf(drawRaw(rootUncertain.vm, 60)[0], 'uncertain').every((cell) => cell.bold),
      true
    );
    assert.equal(
      cellsOf(drawRaw(rootUncertain.vm, 60, { nowMs: NOW + 5000 })[0], 'uncertain').some((cell) => cell.bold),
      false
    );

    // What the published data does not stand behind is no episode: an unknown basis, a time that has not happened
    // yet, a clock the observation calls anomalous. (The controls above are the same rows with a good boundary.)
    const stale = (basis: Basis) =>
      buildVm([
        root(),
        {
          id: 's',
          parent: 'main',
          harness: 'codex',
          status: { cls: 'stale', reason: 'heartbeat', since: NOW - 1000, basis, evidenceAt: NOW - 5000 },
          createdAt: ago(100),
        },
      ]);
    assert.equal(bold(stale('observed'), NOW, 1, 'stale').word, true, 'control');
    assert.equal(bold(stale('unknown'), NOW, 1, 'stale').word, false, 'basis unknown');
    assert.deepEqual(bold(starting('event', NOW + 5000), NOW), off, 'a boundary in the future');
    assert.deepEqual(bold(starting('event', NOW - 1000), NOW), on, 'control');
    assert.deepEqual(bold(starting('event', NOW - 1000, { clockAnomaly: true }), NOW), off, 'an anomalous clock');

    // The ledger is no stand-in for an unknown published episode: a run created a second ago, whose published
    // continuity is `{stateSince: null, basis: unknown}`, is not a new episode (the clock still reads from the
    // run, which is not what the emphasis is about).
    const unknownEpisode = (state: 'starting' | 'uncertain', published: { since: number | null; basis: Basis }) =>
      buildVm([
        root(),
        {
          id: 'e',
          parent: 'main',
          harness: 'codex',
          run:
            state === 'starting'
              ? { state: 'starting', createdAt: NOW - 1000 }
              : { state: 'uncertain', reconciliation: 'scope_unknown', createdAt: NOW - 1000 },
          status: { cls: state, ...published },
          createdAt: NOW - 1000,
        },
      ]);
    for (const state of ['starting', 'uncertain'] as const) {
      assert.deepEqual(bold(unknownEpisode(state, { since: NOW - 1000, basis: 'event' }), NOW, 1, state), on, state);
      assert.deepEqual(bold(unknownEpisode(state, { since: null, basis: 'unknown' }), NOW, 1, state), off, state);
      // The published time with its basis unknown is no more an episode than none at all.
      assert.deepEqual(bold(unknownEpisode(state, { since: NOW - 1000, basis: 'unknown' }), NOW, 1, state), off, state);
    }
    assert.match(
      plain(drawRaw(unknownEpisode('starting', { since: null, basis: 'unknown' }).vm, 60)[1]),
      /1s$/,
      'the clock still shows the run'
    );

    // A conflict keeps its own (observed) timing: the node's row and the claim's row are both new for three seconds.
    const conflicts = (at: number) =>
      buildVm([
        root(),
        { id: 'n', parent: 'main', harness: 'codex', conflict: { count: 2, since: at }, createdAt: ago(900) },
        { id: 'c', parent: 'main', harness: 'codex', relationOnly: true, conflict: { count: 2, since: at } },
      ]);
    for (const [at, wanted] of [
      [NOW - 1000, true],
      [NOW - 3000, false],
    ] as const) {
      const rows = drawRaw(conflicts(at).vm, 60);
      for (const row of rows.filter((r) => r.includes('conflict')))
        assert.equal(
          cellsOf(row, 'conflict').every((cell) => cell.bold),
          wanted,
          `a conflict that began ${NOW - at} ms ago`
        );
      assert.equal(rows.filter((r) => r.includes('conflict')).length, 2);
    }

    // A new round of the same state is a new episode: the published time moved, so it is bold again. (A `⚑` word
    // is bold at any age, so the state used here is `uncertain`.)
    const uncertain = (at: number) =>
      buildVm([
        root(),
        {
          id: 'u',
          parent: 'main',
          harness: 'codex',
          run: { state: 'uncertain', reconciliation: 'scope_unknown' },
          status: { cls: 'uncertain', since: at },
          createdAt: ago(100),
        },
      ]);
    const wordBold = (built: Built, nowMs: number) =>
      cellsOf(drawRaw(built.vm, 60, { nowMs })[1], 'uncertain').every((cell) => cell.bold);
    assert.equal(wordBold(uncertain(NOW - 600_000), NOW), false, 'ten minutes in');
    assert.equal(wordBold(uncertain(NOW - 1000), NOW), true, 'the renewed episode');

    // The cached row follows the boundary.
    const cached = starting('event', NOW - 2950);
    const a = drawRaw(cached.vm, 60, { nowMs: NOW })[1];
    const b = drawRaw(cached.vm, 60, { nowMs: NOW + 100 })[1];
    assert.notEqual(a, b);
  } finally {
    setDisplayConfig(previous);
  }
});

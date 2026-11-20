/** The Project hub uses its room: whole waiting items, a Now about work in flight, unlisted worktrees counted on their page (synthetic STATE and worktrees). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubFixture, WAITING, TRY_LONG } from '../fixtures/project-hub.mjs';
import { plain, onPage, PROJECTS, NOW, TREE } from '../fixtures/project-page.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { workboardPalette } from '../../dist/render/palette.js';
import { THEMES, setDisplayConfig } from '../../dist/render/hud-config.js';
import { visualLength } from '../../dist/render/colors.js';

async function fixture(t, options) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-hub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return hubFixture(root, options);
}
/** The rows of a block: those after its header up to the next blank row. */
const press = (frame, input) => handleMonitorInput(frame.state, typeof input === 'string' ? { type: 'key', key: input } : input, { tree: TREE, frame, nowMs: NOW, standalone: true });
const block = (lines, header) => {
  const start = lines.findIndex((l) => header.test(l));
  assert.ok(start >= 0, `${header} is in the frame`);
  const end = lines.findIndex((l, i) => i > start && l === '');
  return lines.slice(start, end < 0 ? undefined : end);
};

test('a waiting item flows whole into the hub\'s spare rows, is cut to one row before Latest or the page rows give way, and stays whole under the cursor', async (t) => {
  const f = await fixture(t);
  const tall = plain(f.render(38, 'en', undefined, 46));
  // Four items and the slices still to try (one in the ledger), said in the header; each text that does not fit one row flows on under its `?`, to its last word (spec §2.2).
  assert.deepEqual(block(tall, /^Waiting for you/), [
    'Waiting for you ───────── 4 · 1 to try',
    '? Try 0.2 PANEL-TIDY: open the Project',
    '  tab; every waiting item shows its',
    '  whole text and Now lists only work',
    '  in flight; then say whether the bars',
    '  read.',
    '? Try the synthetic setup, then reopen',
    '  `/hud` in a Claude pane and check',
    '  the lines come back.',
    '? Choose the browser profile for the',
    '  synthetic flow',
    '? Decide whether the hub keeps its',
    '  Latest block on a short panel, and',
    '  say so in this file when you have.',
  ]);
  assert.ok(tall.every((l) => visualLength(l) <= 38));
  assert.equal(block(plain(f.render(38, 'zh', undefined, 46)), /^等你处理/)[0], '等你处理 ──────────────── 4 · 1 待试用');
  // Rows are given to the waiting items only once Latest and the page rows have theirs: the spare rows top down, an item as many as it needs.
  const shape = (height) => {
    const lines = plain(f.render(38, 'en', undefined, height));
    return { wrapped: block(lines, /^Waiting for you/).filter((l) => l.startsWith('  ')).length, latest: lines.filter((l) => /^  [✓◇] /.test(l)).length,
      pages: lines.filter((l) => /^(Progress|Working tree|Docs) /.test(l)).length };
  };
  assert.deepEqual(shape(23), { wrapped: 0, latest: 3, pages: 3 }, 'a short panel keeps one cut row each');
  assert.deepEqual(shape(25), { wrapped: 2, latest: 3, pages: 3 }, 'two spare rows go to the first item, the rest of its text cut');
  assert.deepEqual(shape(29), { wrapped: 6, latest: 3, pages: 3 }, 'six spare rows: the first item whole, the second too');
  assert.deepEqual(shape(21), { wrapped: 0, latest: 1, pages: 3 }, 'Latest gives way after, never before, the wrapping');
  // The item the cursor is on keeps its whole text whatever the panel has, and the others stay one row.
  const long = await fixture(t, { waiting: [WAITING[2], TRY_LONG, WAITING[3]] });
  const kept = plain(long.render(38, 'en', onPage(undefined, { projectCursor: 'project:wait:1' }), 24));
  assert.ok(kept.join(' ').replace(/\s+/g, ' ').includes('not on the first one.'), 'the cursor item is whole');
  assert.equal(block(kept, /^Waiting for you/).filter((l) => l.startsWith('? ')).length, 3);
});

test('the 40×24 Classic hub keeps the selected waiting item whole even when the hub must scroll', async (t) => {
  const waiting = [TRY_LONG, ...Array.from({ length: 22 }, (_, i) => `Choose synthetic option ${i + 1}`)];
  const f = await fixture(t, { waiting });
  const frame = f.render(40, 'en', onPage(undefined, { projectCursor: 'project:wait:0' }), 24);
  assert.ok(frame.panes[0].contentLength > frame.panes[0].height, 'even the smallest tier overflows');
  const lines = plain(frame);
  assert.match(lines.join(' ').replace(/\s+/g, ' '), /not on the first one\./);
  assert.ok(lines.includes('? Choose synthetic option 1'));
  assert.ok(frame.lines.every((line) => visualLength(line) === 40));
});

test('Now is work in flight: worktrees with no ledger row leave it, and an empty Now says so', async (t) => {
  const f = await fixture(t);
  const busy = block(plain(f.render(38, 'en', undefined, 46)), /^Now /);
  assert.deepEqual(busy, ['Now ──────────────────────────────── 2', '  ◐ NATIVE-TREE           imp asking ?', '  ◉ imp  Build the Project tab     20m']);
  assert.ok(f.data.slices.some((s) => s.drift === 'not in ledger'), 'the collector still finds them');
  assert.doesNotMatch(plain(f.render(38, 'en', 'progress', 46)).join('\n'), /EXTRA-ONE|NO-JOB/, 'nor does the Progress page list them under Now');
  const idle = await fixture(t, { idle: true });
  assert.deepEqual(block(plain(idle.render(38, 'en', undefined, 46)), /^Now /), ['Now ──────────────────────────────────', '  Nothing in progress']);
  assert.deepEqual(block(plain(idle.render(38, 'zh', undefined, 46)), /^现在 /), ['现在 ─────────────────────────────────', '  没有进行中的工作']);
});

test('the Working tree row counts the worktrees with no ledger row, and its page lists them', async (t) => {
  const f = await fixture(t);
  const rows = (lang, state) => plain(f.render(38, lang, state, 46));
  assert.ok(rows('en').some((line) => /^Working tree +3 unlisted worktrees$/.test(line)));
  assert.ok(rows('zh').includes('工作区 3 个未登记工作树'));
  assert.deepEqual(block(rows('en', 'tree'), /^Unlisted worktrees/), ['Unlisted worktrees ───────────────── 3',
    '  ! EXTRA-ONE            not in ledger', '  ! EXTRA-TWO            not in ledger', '  ! NO-JOB               not in ledger']);
  assert.ok(rows('zh', 'tree').includes('  ! NO-JOB                  未记入清单'));
});

test('the name row says what its count counts, and a bar tells to try from accepted by glyph and by ink in every theme', async (t) => {
  const f = await fixture(t);
  const name = (lang) => plain(f.render(38, lang, onPage(undefined, { projectRoot: PROJECTS[1].root }), 46, { projects: PROJECTS, projectName: PROJECTS[1].name }))[2];
  assert.equal(name('en'), 'second-project ───── 0.2 ▾ project 2/3');
  assert.equal(name('zh'), 'second-project ──────── 0.2 ▾ 项目 2/3');
  const bar = (icons) => plain(f.render(38, 'en', undefined, 46, {}, icons)).find((l) => /^[█▒░#=.]{20,}$/.test(l));
  assert.match(bar('unicode'), /^█+▒+░+█+$/, 'working, to try, todo, accepted: three densities, none of them ▓');
  assert.match(bar('text'), /^#+=+\.+#+$/, 'with no colour at all the glyphs still differ');
  // CIE76 distance between the two inks, on every coloured theme.
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lab = ([R, G, B]) => {
    const [r, g, b] = [R, G, B].map(lin), f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const ink = (paint) => lab(paint('x').match(/38;2;(\d+);(\d+);(\d+)/).slice(1).map(Number));
  for (const theme of THEMES.filter((name) => name !== 'none')) {
    const previous = setDisplayConfig({ theme, icons: 'unicode' });
    try {
      const board = workboardPalette(), a = ink(board.identifier), b = ink(board.success);
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 45, `${theme}: to try (the identifier ink) and accepted (success) are far apart`);
    } finally {
      setDisplayConfig(previous);
    }
  }
});

test('Enter or a click on a waiting item opens its whole STATE text on a page, in STATE\'s words; `o` opens STATE.md', async (t) => {
  const f = await fixture(t, { waiting: [WAITING[2], TRY_LONG, WAITING[3]] });
  // The parse keeps the continuation lines as written; the hub shows the item whole under the cursor.
  assert.equal(f.data.waiting[1].text, TRY_LONG);
  const hubAt = (lang, state) => f.render(38, lang, state ?? onPage(undefined, { projectCursor: 'project:wait:1' }), 24);
  assert.match(plain(hubAt('en'))[6], /^\? Try 0\.3 PANEL-NEXT, a synthetic try$/);
  const key = press(hubAt('en'), 'enter'), click = press(hubAt('en'), { type: 'mouse', button: 'left', x: 4, y: 6 });
  for (const opened of [key, click]) {
    assert.equal(opened.state.projectPage, 'waiting');
    assert.equal(opened.state.projectWait, 1);
    assert.equal(opened.action, undefined, 'it reads here; it does not open the editor');
  }
  assert.deepEqual(press(hubAt('en'), 'open-session').action, { type: 'open-files', files: [f.data.statePath] });
  for (const [lang, crumb, hint] of [['en', '‹ Project › Waiting', '↑↓ scroll  o open  esc back  ? help'], ['zh', '‹ 项目 › 等你处理', '↑↓ 滚动  o 打开  esc 返回  ? 帮助']]) {
    const page = f.render(38, lang, key.state, 30), lines = plain(page);
    assert.equal(lines[0], crumb);
    assert.equal(lines.at(-1).trim(), hint);
    assert.ok(page.lines.every((l) => visualLength(l.replace(/\x1b\[[0-9;]*m/g, '')) === 38), 'every row is the frame width');
    // The first sentence flows over its continuation line; each numbered check is a paragraph of its own, wrapped under its text.
    assert.deepEqual(lines.slice(2, 13), [
      '? Try 0.3 PANEL-NEXT, a synthetic try',
      '  with several checks, each of which',
      '  the owner reads to its end: open the',
      '  Project hub, then press Enter on',
      '  this item.',
      '  1. The whole text opens on a page of',
      '     its own, continuation lines and',
      '     all.',
      '  2. Scroll it with the arrow keys or',
      '     the wheel; the last check is',
      '     further down than the first rows',
    ]);
    // Every word of the bullet, in its order, is on the page.
    const all = plain(f.render(38, lang, key.state, 60)).slice(2, -1).filter(Boolean).map((l) => l.trim().replace(/^\? /, '')).join(' ');
    assert.equal(all, TRY_LONG.replace(/\s+/g, ' '));
  }
  assert.deepEqual(press(f.render(38, 'en', key.state, 30), 'open-session').action, { type: 'open-files', files: [f.data.statePath] }, '`o` in the page opens STATE.md');
});

test('the page scrolls with the movement keys and the wheel; Esc or a click on the crumb returns with the cursor on the same item', async (t) => {
  const f = await fixture(t, { waiting: [WAITING[2], TRY_LONG, WAITING[3]] });
  for (const lang of ['en', 'zh']) {
    let frame = f.render(38, lang, press(f.render(38, lang, onPage(undefined, { projectCursor: 'project:wait:1' }), 24), 'enter').state, 12);
    const top = plain(frame), rows = 12 - 2;
    assert.equal(frame.state.projectScroll, 0);
    // End moves the cursor to the last row, and the page scrolls to show it: the end of the text is what matters.
    frame = f.render(38, lang, press(frame, 'end').state, 12);
    const end = plain(frame);
    assert.ok(frame.state.projectScroll > 0);
    assert.match(end.slice(1, rows + 1).join(' '), /not on the first one\.$/);
    assert.notDeepEqual(end.slice(1, rows + 1), top.slice(1, rows + 1));
    // The wheel moves three rows at a time and stays inside the text.
    const up = f.render(38, lang, press(frame, { type: 'mouse', button: 'wheel-up', x: 4, y: 5 }).state, 12);
    assert.equal(up.state.projectScroll, frame.state.projectScroll - 3);
    const down = f.render(38, lang, press(up, { type: 'mouse', button: 'wheel-down', x: 4, y: 5 }).state, 12);
    assert.equal(down.state.projectScroll, frame.state.projectScroll);
    assert.equal(f.render(38, lang, press(down, { type: 'mouse', button: 'wheel-down', x: 4, y: 5 }).state, 12).state.projectScroll, frame.state.projectScroll, 'not past the end');
    // Esc and a click on the crumb row both land on the item's own row, which the hub keeps in view.
    for (const back of ['escape', { type: 'mouse', button: 'left', x: 6, y: 0 }]) {
      const hub = f.render(38, lang, press(frame, back).state, 24);
      assert.equal(hub.state.projectPage, undefined);
      assert.equal(hub.state.projectCursor, 'project:wait:1');
      assert.match(plain(hub)[6], /^\? Try 0\.3 PANEL-NEXT/);
      assert.equal(hub.state.projectScroll, 0);
    }
  }
});

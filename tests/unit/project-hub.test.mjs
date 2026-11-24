import { projectPageOf } from '../../dist/render/project-view.js';
/** Project overview, waiting-item navigation and unlisted worktree facts (synthetic data). */
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

test('the Working tree row counts unlinked worktrees and its page lists them', async (t) => {
  const f = await fixture(t);
  const rows = (lang, state) => plain(f.render(38, lang, state, 46));
  assert.ok(rows('en').some((line) => /^Working tree +3 unlisted worktrees$/.test(line)));
  assert.ok(rows('zh').includes('工作区 3 个未登记工作树'));
  const listed = block(rows('en', 'tree'), /^Unlisted worktrees/);
  assert.match(listed[0], /^Unlisted worktrees ─+ 3$/);
  assert.deepEqual(listed.slice(1).map(l => l.trim().replace(/ +/g, ' ')),
    ['! EXTRA-ONE no linked ticket', '! EXTRA-TWO no linked ticket', '! NO-JOB no linked ticket']);
  assert.match(rows('zh', 'tree').join('\n'), /! NO-JOB +未关联工单/);
});

test('the name row identifies the project switch; try and accepted keep distinct inks in every theme', async (t) => {
  const f = await fixture(t);
  const name = (lang) => plain(f.render(38, lang, onPage(undefined, { selectedProject: PROJECTS[1].root }), 46, { projects: PROJECTS, projectName: PROJECTS[1].name }))[2];
  assert.match(name('en'), /^second-project ─+ ▾ project 2\/3$/);
  assert.match(name('zh'), /^second-project ─+ ▾ 项目 2\/3$/);
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
  const hubAt = (lang, state) => f.render(38, lang, state ?? onPage(undefined, { project: { nav: { cursor: 'project:wait:1' } } }), 24);
  const hub = hubAt('en'), y = plain(hub).findIndex((row) => /^  \? Try 0\.3 PANEL-NEXT/.test(row));
  assert.ok(y > 0);
  const key = press(hub, 'enter'), click = press(hub, { type: 'mouse', button: 'left', x: 4, y });
  for (const opened of [key, click]) {
    assert.equal(projectPageOf(opened.state), 'waiting');
    assert.equal(opened.state.project.view.index, 1);
    assert.equal(opened.state.project.view.request, TRY_LONG, 'legacy requests use the original line text');
    assert.equal(opened.action, undefined, 'it reads here; it does not open the editor');
  }
  assert.deepEqual(press(hubAt('en'), 'open-session').action, { type: 'open-files', files: [f.data.statePath] });
  for (const [lang, crumb, hint] of [['en', '‹ Project › Waiting', 'o file  Esc back  ? help'], ['zh', '‹ 项目 › 等你处理', 'o 文件  Esc 返回  ? 帮助']]) {
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

test('an open Project inbox request keeps its ID through reordering and clears on resolution', async (t) => {
  const f = await fixture(t, { waiting: ['[r1] Choose alpha', '[r2] Choose beta'] });
  const opened = press(f.render(60, 'en', undefined, 24), 'enter');
  assert.equal(opened.state.project.view.request, 'r1');
  const draw = (waiting) => plain(f.render(60, 'en', opened.state, 24, { project: { ...f.data, waiting } })).join('\n');
  assert.match(draw([...f.data.waiting].reverse()), /Choose alpha/);
  const resolved = draw(f.data.waiting.filter(({ request }) => request !== 'r1'));
  assert.match(resolved, /none/);
  assert.doesNotMatch(resolved, /Choose (alpha|beta)/);
});

test('the page scrolls with the movement keys and the wheel; Esc or a click on the crumb returns with the cursor on the same item', async (t) => {
  const f = await fixture(t, { waiting: [WAITING[2], TRY_LONG, WAITING[3]] });
  for (const lang of ['en', 'zh']) {
    let frame = f.render(38, lang, press(f.render(38, lang, onPage(undefined, { project: { nav: { cursor: 'project:wait:1' } } }), 24), 'enter').state, 12);
    const top = plain(frame), rows = 12 - 2;
    assert.equal(frame.state.project.nav.scroll, 0);
    // End moves the cursor to the last row, and the page scrolls to show it: the end of the text is what matters.
    frame = f.render(38, lang, press(frame, 'end').state, 12);
    const end = plain(frame);
    assert.ok(frame.state.project.nav.scroll > 0);
    assert.match(end.slice(1, rows + 1).join(' '), /not on the first one\.$/);
    assert.notDeepEqual(end.slice(1, rows + 1), top.slice(1, rows + 1));
    // The wheel moves three rows at a time and stays inside the text.
    const up = f.render(38, lang, press(frame, { type: 'mouse', button: 'wheel-up', x: 4, y: 5 }).state, 12);
    assert.equal(up.state.project.nav.scroll, frame.state.project.nav.scroll - 3);
    const down = f.render(38, lang, press(up, { type: 'mouse', button: 'wheel-down', x: 4, y: 5 }).state, 12);
    assert.equal(down.state.project.nav.scroll, frame.state.project.nav.scroll);
    assert.equal(f.render(38, lang, press(down, { type: 'mouse', button: 'wheel-down', x: 4, y: 5 }).state, 12).state.project.nav.scroll, frame.state.project.nav.scroll, 'not past the end');
    // Esc and a click on the crumb row both land on the item's own row, which the hub keeps in view.
    for (const back of ['escape', { type: 'mouse', button: 'left', x: 6, y: 0 }]) {
      const hub = f.render(38, lang, press(frame, back).state, 24);
      assert.equal(projectPageOf(hub.state), undefined);
      assert.equal(hub.state.project.nav.cursor, 'project:wait:1');
      assert.match(plain(hub).join('\n'), /^  \? Try 0\.3 PANEL-NEXT/m);
      assert.equal(hub.state.project.nav.scroll, 0);
    }
  }
});

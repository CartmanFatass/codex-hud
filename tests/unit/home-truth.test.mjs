import { sliceState } from '../fixtures/state-helpers.mjs';
import { homeAnchor } from '../../dist/render/monitor-state.js';
import { projectPageOf } from '../../dist/render/project-view.js';
/** Home's waiting items, ticket counts and spare rows, from synthetic files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeFixture } from '../fixtures/home-progress.mjs';
import { NOW, TREE, plain } from '../fixtures/project-page.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'home-truth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await homeFixture(root);
  f.put(f.paths.status, fs.readFileSync(f.paths.status, 'utf8') + '\n## Comments\n- Landed abc1234\n', 30);
  const data = await f.collector.collect('home', f.board, NOW);
  const render = (width, lang, height, state, snapshot = data, extra) => f.render(width, lang, height, state, snapshot, extra);
  // No jobs, no cards: Home's own rows are only the top line.
  const idle = { ...f.board, lanes: [], workers: [], decisions: [] };
  return { ...f, data, render, quiet: (width, lang, height, state, snapshot) => render(width, lang, height, state, snapshot, { workboard: idle }) };
}
const press = (frame, input) => handleMonitorInput(frame.state, input, { tree: TREE, frame, nowMs: NOW, standalone: true });
const legend = (lines) => lines[lines.findIndex(l => /^  [█▒░]/.test(l)) + 1];

test('Home top line counts STATE waiting items with job questions, ✓ only when both are zero, and opens the Project Inbox', async (t) => {
  const f = await fixture(t);
  assert.match(plain(f.quiet(38, 'en', 46))[1], /^\? 2 waiting for you *$/);
  assert.match(plain(f.quiet(38, 'zh', 46))[1], /^\? 2 项等你处理 *$/);
  assert.match(plain(f.quiet(38, 'en', 46, undefined, { ...f.data, waiting: [] }))[1], /^✓ Nothing needs you *$/);
  // One job question and two STATE items are three things waiting; the question's row stays under the line.
  const busy = plain(f.render(38, 'en', 46));
  assert.match(busy[1], /^\? 3 waiting/);
  assert.match(busy[3], /^\S \? {2}NATIVE-TREE {2}asks/);
  // A done-today count of 0 is not shown.
  assert.doesNotMatch(plain(f.quiet(38, 'en', 46)).at(-1), /done today/);
  assert.doesNotMatch(plain(f.quiet(38, 'zh', 46)).at(-1), /今日完成/);
  // Enter and a click on the line open the Project Inbox.
  let frame = f.quiet(38, 'en', 46);
  assert.equal(homeAnchor(frame.state.home), 'home-progress:waiting', 'an idle Home rests on its first stop');
  const click = { type: 'mouse', button: 'left', x: 4, y: frame.workboard.rows.findIndex((r) => r.item === 'home-progress:waiting') + 1 };
  for (const input of [{ type: 'key', key: 'enter' }, click]) {
    const state = press(frame, input).state;
    assert.equal(state.activeTab, 'project');
    assert.equal(projectPageOf(state), undefined);
    const hub = f.quiet(38, 'en', 46, state);
    assert.equal(hub.state.project.nav.cursor, 'project:wait:0', 'the hub starts on the first waiting item');
    assert.ok(plain(hub).some((l) => /^Needs you ─+ 2$/.test(l)));
  }
});

test('Enter or a click on a waiting item on Home opens its whole text on the Project tab\'s page, and Esc returns to the item\'s row on the hub', async (t) => {
  const f = await fixture(t);
  assert.equal(f.data.waiting[1].text, 'Choose the browser profile\n  after trying the synthetic setup', 'the Home read keeps continuation lines too');
  for (const lang of ['en', 'zh']) {
    // The top line and the block's header are one stop; each waiting item is a stop of its own.
    let frame = f.quiet(38, lang, 46);
    for (const stop of ['wait:0', 'wait:1']) frame = f.quiet(38, lang, 46, press(frame, { type: 'key', key: 'down' }).state), assert.equal(homeAnchor(frame.state.home), `home-progress:${stop}`);
    const row = frame.workboard.rows.findIndex((r) => r.item === 'home-progress:wait:1') + 1;
    for (const input of [{ type: 'key', key: 'enter' }, { type: 'mouse', button: 'left', x: 4, y: row }]) {
      const state = press(input.type === 'key' ? frame : f.quiet(38, lang, 46), input).state;
      assert.equal(state.activeTab, 'project');
      assert.equal(projectPageOf(state), 'waiting');
      assert.equal(state.project.view.index, 1);
      const page = f.quiet(38, lang, 46, state), lines = plain(page);
      assert.equal(lines[0], lang === 'en' ? '‹ Project › Waiting' : '‹ 项目 › 等你处理');
      assert.deepEqual(lines.slice(2, 4), ['? Choose the browser profile after', '  trying the synthetic setup']);
      const hub = f.quiet(38, lang, 46, press(page, { type: 'key', key: 'escape' }).state);
      assert.equal(projectPageOf(hub.state), undefined);
      assert.equal(hub.state.project.nav.cursor, 'project:wait:1');
      assert.equal(plain(hub).findIndex((l) => l.trimStart().startsWith('? Choose the browser profile')) >= 0, true, 'the item is on the hub');
    }
  }
});

test('Home counts tickets and uses the milestone only as a label', async (t) => {
  const f = await fixture(t);
  for (const width of [38, 80]) {
    const home = plain(f.quiet(width, 'en', 46));
    assert.match(legend(home), /✓ 3.*◇ 1.*◐ 2.*◆ 2.*○ 6/);
    assert.doesNotMatch(legend(home), /dropped/);
    assert.match(home.find((l) => /^Progress ─/.test(l)), /Milestone M3b$/);
  }
  const lines = plain(f.quiet(80, 'zh', 46, undefined, { ...f.data, ladder: { ids: [] } }));
  assert.match(lines.find((l) => /^进度 ─/.test(l)), /全部工单$/);
  for (const word of ['◐ 2 工作中', '◆ 2 受阻', '○ 6 已规划', '✓ 3 已验收']) assert.ok(legend(lines).includes(word), word);
});

test('an idle Home at 38×46 shows waiting items and the newest landed slices above the progress block, whose summary wraps', async (t) => {
  const f = await fixture(t);
  for (const lang of ['en', 'zh']) {
    const frame = f.quiet(38, lang, 46), lines = plain(frame);
    for (const line of frame.lines) assert.equal(visualLength(line), 38, stripAnsi(line));
    const at = (re) => lines.findIndex((l) => re.test(l));
    const waiting = at(/^(Waiting for you|等你处理) ─/), latest = at(/^(Latest|最近完成) ─/), progress = at(/^(Progress|进度) ─/);
    assert.ok(2 < waiting && waiting < latest && latest < progress, `${waiting} < ${latest} < ${progress}`);
    // One row an item: the two waiting items, then only accepted work.
    assert.deepEqual(lines.slice(waiting + 1, waiting + 3).map((l) => l.slice(0, 2)), ['? ', '? ']);
    assert.match(lines[waiting + 1], /Try the Project tab/);
    assert.match(lines[latest + 1], /RETIRED-TOOLS-01/);
    assert.deepEqual(lines.slice(latest + 2, progress).filter(Boolean), [], 'no pending rows between');
    // The summary is cut after three rows, not one; the bar follows it.
    assert.match(lines[progress + 1], /^  Synthetic milestone closing/);
    assert.match(lines[progress + 2], /^  building in worktrees$/);
    assert.match(lines[progress + 3], /^  █+▒/);
    assert.equal(lines.findIndex((l) => /^  (Tickets|工单) [━─]/.test(l)), progress + 5, 'summary (2 rows), bar, legend (1 row), then the tickets');
  }
});

test('cards keep their rows, then the progress block, before Home\'s waiting and latest rows', async (t) => {
  const f = await fixture(t), base = f.render(38, 'en', 100, undefined, null).workboard.rows.length;
  // The cards, with the top line above them and nothing spare.
  const cards = f.render(38, 'en', base + 2);
  assert.equal(cards.workboard.rows.length, base);
  for (let spare = 40; spare >= 0; spare--) {
    const frame = f.render(38, 'en', base + 2 + spare), lines = plain(frame), rows = frame.workboard.rows.length - base;
    assert.ok(rows <= spare, `spare ${spare}: ${rows} rows`);
    assert.deepEqual(plain(frame).slice(1, base + 1), plain(cards).slice(1, base + 1), 'no card row cut or displaced');
    const summary = lines.some((l) => /^  Synthetic milestone/.test(l)), bar = lines.some((l) => /^  [█▒░]/.test(l));
    if (summary) assert.ok(bar, `spare ${spare}: the summary never outlives the bar`);
    if (spare === 4) assert.ok(bar && summary, 'the progress block adds a blank separator above the bar and summary');
    // Below four spare rows (blank + header + bar + summary) the progress block cannot fit. Otherwise the lists only use what it leaves.
    if (spare >= 4 && lines.some((l) => /^(Waiting for you|Latest) ─/.test(l))) assert.ok(lines.some((l) => /^  Tickets [━─]/.test(l)), `spare ${spare}`);
  }
  const roomy = plain(f.render(38, 'en', base + 2 + 40));
  assert.ok(roomy.some((l) => /^Waiting for you ─/.test(l)) && roomy.some((l) => /^Latest ─/.test(l)), 'with room, both lists come');
});

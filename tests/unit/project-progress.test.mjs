import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectFixture, plain, onPage, PROJECTS, NOW, TREE } from '../fixtures/project-page.mjs';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { ProjectVisits } from '../../dist/collectors/project-visits.js';
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...(await projectFixture(root)) };
}
const decoder = new WorkbenchInputDecoder('workboard'), key = (raw) => decoder.push(Buffer.from(raw))[0];
const send = (frame, raw) => handleMonitorInput(frame.state, key(raw), { tree: TREE, frame, nowMs: NOW, standalone: true });
const text = (frame) => plain(frame).join('\n');
const extra = { projects: PROJECTS };

test('Progress: Now, Next, To try and Done from a synthetic ledger, cell-exact at 32/40/80/120 EN/ZH and in text icons', async (t) => {
  const f = await fixture(t);
  for (const width of [32, 40, 80, 120]) for (const lang of ['en', 'zh']) {
    const frame = f.render(width, lang, 'progress', 80, f.rich);
    for (const line of frame.lines) assert.equal(visualLength(line), width, stripAnsi(line));
    const page = text(frame), word = (en, zh) => (lang === 'en' ? en : zh);
    // Chips are the ledger's milestones in ledger order (the row with no milestone has no chip); the current one is marked.
    assert.match(page, /\[M3\]  \[M3b\]  \[M4\]  \(0\.1\.3\)/);
    assert.match(page, new RegExp(`^${word('Now', '现在')} ─+ 3$`, 'm'));
    assert.match(page, new RegExp(`^${word('Next', '下一步')} ─+ 4$`, 'm'));
    assert.match(page, new RegExp(`^${word('To try', '待试用')} ─+ 5$`, 'm'));
    assert.match(page, new RegExp(`^${word('Done', '已完成')} ─+ 5$`, 'm'));
    // To try: the newest milestone open with its date and commit and the text under it (the commit is not repeated in it);
    // every other milestone folded. Done: every group folded, rows with no milestone last.
    assert.match(page, /^  0\.1\.3 +1$/m);
    assert.match(page, /^    DATA-ONE · 11-11 d0e1f2a\n +ledger history/m);
    assert.doesNotMatch(page, /\(d0e1f2a3\)/);
    assert.match(page, /^  ▸ M4 +3$\n^  ▸ M3b +1$/m);
    assert.match(page, new RegExp(`^  ▸ M4 +1$\\n^  ▸ M3b +1$\\n^  ▸ M3 +2$\\n^  ▸ ${word('other', '其他')} +1$`, 'm'));
    assert.doesNotMatch(page, /SENTENCE-CUT|NATIVE-ROWS|REVIEW-ONE|BAR-LINES|SKILL-MOVE/);
    // In flight: a slice, a blocked one, and the job no slice shows (its title under it where it would be cut).
    assert.match(page, /PAGE-ONE/);
    assert.match(page, /◆ PAGE-TWO/);
    assert.match(page, /◉ imp/);
    assert.match(page, /Tidy the synthetic docs/);
    // Next: at most two rows a bullet, the cut one ending in an ellipsis.
    const rows = (id) => frame.workboard.rows.filter((r) => r.item === `project:fold:next:${id}`);
    for (const id of [1, 3]) {
      assert.equal(rows(id).length, 2, 'a long bullet folds to two rows');
      assert.match(stripAnsi(rows(id)[1].text), /…\s*$/);
      assert.ok(rows(id).every((r) => r.files?.[0] === f.rich.statePath));
    }
    assert.equal(rows(0).length, 0, 'a bullet that fits has no fold');
  }
  const ascii = text(f.render(40, 'en', 'progress', 80, f.rich, true, 'text'));
  assert.doesNotMatch(ascii, /[▸▾→●◐◆◉░▓█─━‹›✓○]/);
  assert.match(ascii, /^  > M4 +3$/m);
  assert.match(ascii, /^  > A long bullet/m);
});
test('Progress folds through real input: To try and Done groups open and close, a long Next bullet expands, a short one opens STATE.md', async (t) => {
  const f = await fixture(t), height = 90;
  let frame = f.render(40, 'en', 'progress', height, f.rich);
  const at = (item) => { frame.state.projectCursor = item; return frame; };
  assert.doesNotMatch(text(frame), /NATIVE-ROWS|SENTENCE-CUT|REVIEW-ONE/);
  for (const [id, shown] of [['try:M4', /SENTENCE-CUT · 11-05 b8c9d0e/], ['try:M3b', /NATIVE-ROWS/], ['done:M4', /REVIEW-ONE/], ['done:M3', /BAR-LINES[\s\S]*PANEL-KEYS|PANEL-KEYS[\s\S]*BAR-LINES/], ['done:', /SKILL-MOVE/]]) {
    frame = f.render(40, 'en', send(at(`project:fold:${id}`), '\r').state, height, f.rich);
    assert.match(text(frame), shown, id);
    frame = f.render(40, 'en', send(at(`project:fold:${id}`), '\r').state, height, f.rich);
    assert.doesNotMatch(text(frame), shown, `${id} folds again`);
  }
  // The newest milestone folds too, and the other way round.
  frame = f.render(40, 'en', send(at('project:fold:try:0.1.3'), '\r').state, height, f.rich);
  assert.doesNotMatch(text(frame), /DATA-ONE/);
  // Newest first inside a group; the row with no commit date shows no date, and a commit first in the text moves beside the date.
  frame = f.render(40, 'en', send(at('project:fold:try:M4'), '\r').state, height, f.rich);
  const order = text(frame).match(/NO-HASH|WATCH-LINK|SENTENCE-CUT/g);
  assert.deepEqual(order, ['NO-HASH', 'WATCH-LINK', 'SENTENCE-CUT']);
  assert.match(text(frame), /^    NO-HASH\n +landed with no commit in its text$/m);
  assert.match(text(frame), /^    WATCH-LINK · 11-07 c9d0e1f\n +the watcher survives a link loop$/m);
  // Next: Enter on a long bullet shows all of it, again folds it; a short one has nothing to show and opens STATE.md.
  const long = frame.workboard.rows.find((r) => r.item === 'project:fold:next:1');
  frame = f.render(40, 'en', send(at(long.item), '\r').state, height, f.rich);
  assert.match(text(frame), /the end of it all\n/);
  assert.doesNotMatch(text(frame), /…\n +→ Another/);
  frame = f.render(40, 'en', send(at(long.item), '\r').state, height, f.rich);
  assert.doesNotMatch(text(frame), /the end of it all/);
  assert.deepEqual(send(at(long.item), 'o').action, { type: 'open-files', files: [f.data.statePath] }, 'o opens the file where Enter folds');
  const short = frame.workboard.rows.find((r) => /:next:0$/.test(r.item ?? ''));
  for (const raw of ['\r', 'o']) assert.deepEqual(send(at(short.item), raw).action, { type: 'open-files', files: [f.data.statePath] });
  // A group header has no file: o folds it like Enter.
  assert.equal(send(at('project:fold:try:M3b'), 'o').action, undefined);
  assert.ok(send(at('project:fold:try:M3b'), 'o').state.projectFolded.has('try:M3b'));
});
test('a project with no STATE.md says so on Progress and its other pages work; its live jobs still show', async (t) => {
  const f = await fixture(t), bare = join(f.root, 'bare');
  fs.mkdirSync(bare);
  const collector = new ProjectCollector(bare, f.hud, f.env, f.home);
  const data = await collector.collect(true, { ...f.board, workers: [] }, NOW);
  assert.equal(data.statePath, undefined);
  const withJob = { ...data, active: f.rich.active };
  for (const width of [40, 120]) for (const lang of ['en', 'zh']) {
    const progress = f.render(width, lang, 'progress', 40, withJob);
    for (const line of progress.lines) assert.equal(visualLength(line), width);
    assert.match(text(progress), lang === 'en' ? /no STATE\.md/ : /无 STATE\.md/);
    assert.match(text(progress), /◉ imp/);
    assert.doesNotMatch(text(progress), /\(0\.1\.3\)|[█▓░]|● working|Next|To try/);
    assert.match(text(f.render(width, lang, undefined, 24, data)), lang === 'en' ? /Progress +no STATE\.md/ : /进度 +无 STATE\.md/);
    for (const page of ['tickets', 'tree', 'docs', 'control']) for (const line of f.render(width, lang, page, 40, data).lines)
      assert.equal(visualLength(line), width);
  }
  assert.doesNotMatch(text(f.render(40, 'en', 'progress', 40, data)), /◉|Now/, 'no STATE and no job: only the one line');
});
test('hub: with several projects the name row is the switch; [ ] and a click step through them, wrapping; a page keeps its page', async (t) => {
  const f = await fixture(t), height = 24;
  const hub = (state) => f.render(40, 'en', state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'demo-project' });
  let frame = hub(onPage());
  assert.match(text(frame), /^demo-project ─+ ‹ 1\/3 ›$/m);
  assert.deepEqual(frame.projects, PROJECTS);
  assert.match(plain(frame).at(-1), /\[ \] project/);
  assert.equal(f.render(40, 'en').projects, undefined, 'one project: no switch, no hint');
  assert.doesNotMatch(text(f.render(40, 'en')), /‹ \d\/\d ›|\[ \]/);
  assert.equal(f.render(40, 'en').workboard.rows.find((r) => /^demo-project/.test(stripAnsi(r.text))).item, undefined);
  // Keys: next, next, wraps to the panel's own (stored as none), previous goes round the other way.
  const roots = [];
  for (const raw of [']', ']', ']', '[']) { frame = hub(send(frame, raw).state); roots.push(frame.state.projectRoot); }
  assert.deepEqual(roots, [PROJECTS[1].root, PROJECTS[2].root, undefined, PROJECTS[2].root]);
  // A click on the name row steps too (one click, as on any hub entry); the cursor can rest there and Enter steps.
  const name = frame.workboard.rows.findIndex((r) => r.item === 'project:switch');
  frame = hub(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 3, y: name + 1 }, { tree: TREE, frame, nowMs: NOW, standalone: true }).state);
  assert.equal(frame.state.projectRoot, undefined);
  frame.state.projectCursor = 'project:switch';
  assert.equal(hub(send(frame, '\r').state).state.projectRoot, PROJECTS[1].root);
  // A page: its crumb names the project, the page stays open, and the page's cursor, scroll and folds start fresh.
  const page = (state) => f.render(40, 'en', state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'second-project' });
  assert.match(plain(f.render(40, 'en', 'progress'))[0], /^‹ Project › Progress/, 'one project: the crumb says Project');
  frame = page(onPage('progress', { projectCursor: 'project:file:x:slice:1', projectScroll: 4, projectFolded: new Set(['agents', 'try:M3b']),
    projectSaved: { docs: { cursor: 'project:file:y:0', scroll: 2 } } }));
  frame = page(send(frame, ']').state);
  assert.equal(frame.state.projectPage, 'progress');
  assert.equal(frame.state.projectRoot, PROJECTS[1].root);
  assert.deepEqual([frame.state.projectScroll, frame.state.projectFolded, frame.state.projectSaved], [0, undefined, {}]);
  assert.match(plain(frame)[0], /^‹ second-project › Progress/);
  // Home is not the tab: nothing happens there, and the choice is kept for when Project is open again.
  const home = f.render(80, 'en', { ...initialMonitorState(), projectRoot: PROJECTS[1].root }, 56, f.data, true, 'unicode', 'none', { projects: PROJECTS });
  assert.equal(send(home, ']').state.projectRoot, PROJECTS[1].root);
  assert.deepEqual(plain(home), plain(f.render(80, 'en', initialMonitorState(), 56, f.data, true, 'unicode', 'none', { projects: PROJECTS })), 'Home does not depend on the choice');
  // Home's progress block is the panel's own project's: opening it from Home leaves the choice for the panel's own.
  const block = home.workboard.rows.find((r) => r.item === 'home-progress:progress');
  assert.ok(block, 'Home has its progress block');
  home.state.boardAnchor = block.item;
  const opened = send(home, '\r').state;
  assert.deepEqual([opened.mainTab, opened.projectPage, opened.projectRoot], ['project', 'progress', undefined]);
  // The choice survives the panel's own restart: the whole state goes through the reload place.
  const state = hub(send(hub(onPage()), ']').state).state;
  process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state }, (_k, v) => (v instanceof Set ? { panelSet: [...v] } : v));
  const place = readPanelPlace();
  assert.equal(place.state.projectRoot, PROJECTS[1].root);
  frame = f.render(40, 'en', place.state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'second-project' });
  assert.match(text(frame), /^second-project ─+ ‹ 2\/3 ›$/m);
  // A root that left projects.json is the panel's own again, not an empty page.
  assert.match(text(f.render(40, 'en', place.state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS.slice(2), projectName: 'x' })), /^x ─+$/m);
});
test('the panel keeps one collector per visited root: at most four, the panel own never dropped, the oldest other one first', () => {
  const made = [], visits = new ProjectVisits('/own', (root) => { made.push(root); return { root }; });
  for (const root of ['/a', '/b', '/c']) visits.visit(root);
  assert.deepEqual(visits.roots, ['/own', '/a', '/b', '/c']);
  visits.visit('/a');
  visits.visit('/d');
  assert.deepEqual(visits.roots, ['/own', '/c', '/a', '/d'], 'the oldest visit, /b, is the one dropped');
  visits.visit('/own');
  visits.visit('/e');
  assert.deepEqual(visits.roots, ['/a', '/d', '/own', '/e'], 'revisiting the own root made it newer; /c was the oldest');
  assert.equal(visits.visit('/e').collector, visits.visit('/e').collector, 'a visited root keeps its collector (and so its caches)');
  visits.visit('/e').snapshot = { summary: 'kept' };
  assert.equal(visits.snapshot('/e').summary, 'kept');
  assert.equal(visits.snapshot('/never'), undefined);
  visits.visit('/f');
  visits.visit('/g');
  visits.visit('/h');
  assert.deepEqual(visits.roots, ['/own', '/f', '/g', '/h'], 'the own root is the oldest now and is skipped: /e goes instead');
  assert.equal(made.filter((r) => r === '/e').length, 1);
});
test('the live panel collects only the project it shows; Home and the other tab stay on its own project', async (t) => {
  const f = await fixture(t), other = fs.realpathSync(fs.mkdtempSync(join(f.root, 'other-')));
  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root: other, registered_at: '2026-11-13T00:00:00.000Z' }] });
  f.put(join(f.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 100, language: 'en' });
  const runner = join(f.root, 'collect-log.mjs');
  fs.writeFileSync(runner, `
import { ProjectCollector } from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)};
import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};
ProjectCollector.prototype.collect = async function (shown) { process.stderr.write('COLLECT ' + JSON.stringify({ cwd: this.cwd, shown }) + '\\n'); };
await runLivePage();
`);
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...f.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: f.cwd } });
  let log = '', stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (b) => { stderr += b; log += b; });
  t.after(() => child.kill('SIGKILL'));
  const collects = () => log.split('\n').filter((l) => l.startsWith('COLLECT ')).map((l) => JSON.parse(l.slice(8)));
  const until = async (ok, what) => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
    assert.fail(`${what}: ${stderr}`);
  };
  const own = fs.realpathSync(f.cwd), mark = () => collects().length;
  await until(() => mark() > 0, 'the first collection');
  assert.ok(collects().every((c) => c.cwd === own && c.shown !== true), 'Home collects only the cheap read of its own project');
  child.stdin.write('2');
  await until(() => collects().some((c) => c.shown === true), 'the Project tab');
  assert.ok(collects().filter((c) => c.shown === true).every((c) => c.cwd === own));
  const before = mark();
  child.stdin.write(']');
  await until(() => collects().slice(before).some((c) => c.cwd === other && c.shown === true), 'the second project');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(collects().slice(before).every((c) => c.cwd === other && c.shown === true), 'only the shown project is collected');
  const leave = mark();
  child.stdin.write('1');
  await until(() => collects().slice(leave).some((c) => c.cwd === own && c.shown === 'home'), 'Home again');
  const home = mark();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(mark() > home);
  assert.ok(collects().slice(home).every((c) => c.cwd === own && c.shown === 'home'), 'Home reads its own project again, never the other');
});

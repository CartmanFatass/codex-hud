import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { listFixture, listFrames } from '../fixtures/project-list.mjs';
import { NOW, TREE, plain, onPage } from '../fixtures/project-page.mjs';
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { projectOrder } from '../../dist/render/project-view.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-list-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...(await listFixture(root)) };
}
const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/project-list-frames.json', import.meta.url), 'utf8'));
const decoder = new WorkbenchInputDecoder('workboard'), keyOf = (raw) => decoder.push(Buffer.from(raw))[0];
const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
const send = (frame, raw) => handleMonitorInput(frame.state, keyOf(raw), ctx(frame));
const esc = (frame) => handleMonitorInput(frame.state, { type: 'key', key: 'escape' }, ctx(frame));
const click = (frame, x, y) => handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x, y }, ctx(frame));
const text = (frame) => plain(frame).join('\n');
const names = (frame) => text(frame).match(/^[a-z]+-project/gm);
const UP = '\x1b[A', DOWN = '\x1b[B';

test('Projects list frames: two rows a project at 40/80/120 EN/ZH and in text icons, from real synthetic projects', async (t) => {
  const l = await fixture(t);
  assert.deepEqual(listFrames(l), expected);
  for (const width of [32, 40, 80, 120]) for (const lang of ['en', 'zh']) for (const icons of ['unicode', 'text'])
    for (const line of l.list(width, lang, undefined, 24, icons).lines) assert.equal(visualLength(line), width, stripAnsi(line));
});
test('Projects list: the panel project first, then waiting, running, then the most recent; each project is two rows', async (t) => {
  const l = await fixture(t), frame = l.list(40);
  assert.deepEqual(names(frame), ['demo-project', 'waiting-project', 'busy-project', 'bare-project', 'quiet-project', 'old-project']);
  const rows = plain(frame);
  const entry = (name) => rows.slice(rows.findIndex((r) => r.startsWith(name)), rows.findIndex((r) => r.startsWith(name)) + 2);
  // Name, milestone, waiting `?` and running `◉`; then what it is doing now (working slices, else the newest landed one) and the age.
  assert.match(entry('demo-project')[0], /^demo-project  M3b +\? 2  ◉ 1$/);
  assert.match(entry('demo-project')[1], /^  ◐ NATIVE-TREE, ORPHAN working +0m$/);
  assert.match(entry('waiting-project')[0], /^waiting-project  M5 +\? 2$/);
  assert.match(entry('waiting-project')[1], /^  ◇ B-TWO to try +5h$/, 'no working slice: the newest landed one, and it is still to try');
  // Two running jobs (one asking) count; the settled one and the idle_grace one in another project do not.
  assert.match(entry('busy-project')[0], /^busy-project  M2 +◉ 2$/);
  assert.match(entry('busy-project')[1], /^  ◐ C-ONE, C-TWO working +20m$/);
  assert.match(entry('quiet-project')[1], /^  ◐ A-THREE working +3d$/, 'a working slice wins over the accepted ones before it');
  assert.match(entry('old-project')[0], /^old-project  M1$/);
  assert.match(entry('old-project')[1], /^  ✓ D-ONE accepted +40d$/);
  // No STATE.md says so; the open tickets say how many and the newest ticket is its age.
  assert.match(entry('bare-project')[1], /^  no STATE\.md · 1 open +2d$/);
  // The last-activity column goes through t(): minutes, hours and days in Chinese too.
  assert.match(text(l.list(40, 'zh')), /^  无 STATE\.md · 1 未完成 +2天$/m);
  assert.match(text(l.list(40, 'zh')), /^  ◐ NATIVE-TREE, ORPHAN 工作中 +0分钟$/m);
  assert.match(text(l.list(40, 'zh')), /^  ◇ B-TWO 待试用 +5小时$/m);
  // The overview carries it: the working slices, else the newest landed one (ledger order, no dates and no Git behind the list).
  const latest = (name) => l.projects.find((p) => p.name === name).overview.latest;
  assert.deepEqual(latest('demo-project'), { state: 'working', ids: ['NATIVE-TREE', 'ORPHAN'] });
  assert.deepEqual(latest('waiting-project'), { state: 'try', ids: ['B-TWO'] });
  assert.deepEqual(latest('old-project'), { state: 'accepted', ids: ['D-ONE'] });
  assert.equal(latest('bare-project'), undefined);
  // A wide row keeps the bar before it.
  assert.match(text(l.list(80)), /^  [█▓░]{24}  ◐ NATIVE-TREE, ORPHAN working +0m$/m);
  const zh = text(l.list(40, 'zh'));
  for (const age of ['0分钟', '5小时', '20分钟', '3天', '40天']) assert.match(zh, new RegExp(`${age}$`, 'm'));
  assert.doesNotMatch(zh, /\b\d+[mhd]$/m, 'no English unit left in the Chinese list');
  assert.match(plain(l.list(40, 'zh'))[0], /^‹ 项目列表/);
  assert.match(plain(frame)[0], /^‹ Projects/);
  assert.match(plain(frame).at(-1), /esc back/);
  // Text icons: no unicode glyph at all.
  assert.doesNotMatch(text(l.list(40, 'en', undefined, 24, 'text')), /[‹›▾◉█▓░…]/);
  assert.match(text(l.list(40, 'en', undefined, 24, 'text')), /^demo-project {2}M3b +\? 2 {2}@ 1$/m);
  // The order is a function of what each project shows, not of the list's own order.
  const [own, ...rest] = l.projects;
  assert.deepEqual(projectOrder([own, ...rest.slice().reverse()]).map((p) => p.name), names(frame));
  // No overview yet (the first frame): names only, never a crash.
  assert.deepEqual(names(l.list(40, 'en', undefined, 24, 'unicode', l.projects.map(({ root, name }) => ({ root, name })))), l.projects.map((p) => p.name));
});
test('Projects list through real input: name row opens it, Enter opens a hub, Esc and the crumb come back, 2 opens the hub, reload keeps it', async (t) => {
  const l = await fixture(t), { projects } = l, byName = (name) => projects.find((p) => p.name === name).root;
  const view = (state) => l.render(40, 'en', state, 24, l.data, true, 'unicode', 'none', {
    projects, projectName: (projects.find((p) => p.root === state.projectRoot) ?? projects[0]).name });
  let frame = view(onPage());
  assert.match(text(frame), /^demo-project ─+ M3b ▾ 1\/6$/m);
  // Enter on the name row opens the list with the cursor on the shown project.
  frame.state.projectCursor = 'project:switch';
  frame = view(send(frame, '\r').state);
  assert.equal(frame.state.projectList, true);
  assert.equal(frame.state.projectCursor, `project:list:${byName('demo-project')}`);
  assert.match(plain(frame)[0], /^‹ Projects/);
  // [ ] do nothing on the list; the cursor moves through the entries (two rows, one stop) and Enter opens that hub.
  assert.equal(view(send(frame, ']').state).state.projectRoot, undefined);
  for (const raw of [DOWN, DOWN]) frame = view(send(frame, raw).state);
  frame = view(send(frame, '\r').state);
  assert.equal(frame.state.projectRoot, byName('busy-project'));
  assert.deepEqual([frame.state.projectList, frame.state.projectPage], [undefined, undefined]);
  assert.match(text(frame), /^busy-project ─+ M3b ▾ 4\/6$/m, 'the hub of that project, numbered by the switch order');
  // Stepping on with ] leaves that hub: Esc no longer goes back to the list it was opened from.
  const stepped = view(send(frame, ']').state);
  assert.equal(stepped.state.projectBack, undefined);
  assert.equal(esc(stepped).state.projectList, undefined);
  // Esc on a hub reached from the list goes back to it, with the cursor on that project; Esc on the list returns to the hub.
  frame = view(esc(frame).state);
  assert.equal(frame.state.projectList, true);
  assert.equal(frame.state.projectCursor, `project:list:${byName('busy-project')}`);
  frame = view(esc(frame).state);
  assert.deepEqual([frame.state.projectList, frame.state.projectRoot], [undefined, byName('busy-project')]);
  // That hub was not reached from the list now: Esc on it does what it always did (nothing here), so keys can be given back.
  assert.equal(esc(frame).state.projectList, undefined);
  assert.match(text(view(esc(frame).state)), /^busy-project ─+ M3b ▾ 4\/6$/m);
  // One click on an entry opens its hub; a click on the crumb row returns to the shown project's hub.
  frame = view(onPage(undefined, { projectList: true }));
  const at = frame.workboard.rows.findIndex((r) => r.item === `project:list:${byName('waiting-project')}`);
  frame = view(click(frame, 3, at + 1).state);
  assert.equal(frame.state.projectRoot, byName('waiting-project'));
  frame = view(esc(frame).state);
  assert.equal(frame.state.projectList, true);
  frame = view(click(frame, 1, 0).state);
  assert.deepEqual([frame.state.projectList, frame.state.projectRoot], [undefined, byName('waiting-project')]);
  // A page: Esc goes up to the hub, then (the hub being reached from the list) to the list.
  frame = view(send(view(onPage(undefined, { projectList: true })), '\r').state);
  frame = view(send(frame, '\r').state);
  assert.equal(frame.state.projectPage, 'progress');
  frame = view(esc(frame).state);
  assert.equal(frame.state.projectPage, undefined);
  frame = view(esc(frame).state);
  assert.equal(frame.state.projectList, true);
  // 2 opens the hub of the project shown last, not the list; so does 1 then 2.
  frame = view(send(frame, '1').state);
  assert.equal(frame.state.mainTab, 'home');
  frame = view(send(frame, '2').state);
  assert.deepEqual([frame.state.mainTab, frame.state.projectList, frame.state.projectRoot], ['project', undefined, undefined]);
  frame = view(send(view(onPage(undefined, { projectList: true, projectRoot: byName('quiet-project') })), '1').state);
  frame = view(send(frame, '2').state);
  assert.deepEqual([frame.state.projectList, frame.state.projectRoot], [undefined, byName('quiet-project')]);
  assert.match(text(frame), /^quiet-project ─+ M3b ▾ 2\/6$/m);
  // The list survives the panel's own restart: the whole state goes through the reload place.
  const listed = onPage(undefined, { projectList: true, projectRoot: byName('quiet-project') });
  process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state: listed }, (_k, v) => (v instanceof Set ? { panelSet: [...v] } : v));
  const place = readPanelPlace();
  assert.deepEqual([place.state.projectList, place.state.projectRoot], [true, byName('quiet-project')]);
  assert.match(plain(view(place.state))[0], /^‹ Projects/);
  // A root that left the list is the panel's own again; a list that shrank to one project is the plain hub.
  assert.match(text(l.render(40, 'en', place.state, 24, l.data, true, 'unicode', 'none', { projects: projects.slice(0, 1), projectName: 'demo-project' })), /^demo-project ─+ M3b$/m);
});
test('one project shows no list: no `▾ i/n`, no list, Esc and [ ] as before', async (t) => {
  const l = await fixture(t), one = l.projects.slice(0, 1);
  const view = (state, projects = one) => l.render(40, 'en', state, 24, l.data, true, 'unicode', 'none', { projects, projectName: 'demo-project' });
  const forced = view(onPage(undefined, { projectList: true, projectBack: true }));
  assert.equal(forced.projects, undefined);
  assert.doesNotMatch(text(forced), /▾|‹ Projects|\[ \]/);
  assert.match(text(forced), /^Progress /m);
  assert.equal(esc(forced).state.projectList, true, 'a stale flag is left alone, never acted on');
  assert.doesNotMatch(plain(view(esc(forced).state))[0], /Projects/);
  assert.equal(send(forced, ']').state.projectRoot, undefined);
  // Enter on the first row opens a page, exactly as with no list at all.
  assert.equal(send(forced, '\r').state.projectPage, 'progress');
  assert.deepEqual(plain(view(onPage())), plain(l.render(40, 'en', onPage(), 24, l.data, true, 'unicode', 'none', { projectName: 'demo-project' })));
});
test('the list reads no Git and re-reads only the files that changed', async (t) => {
  const l = await fixture(t), roots = l.projects.map((p) => p.root);
  const opened = [], spawned = [];
  const origOpen = fs.openSync, origExec = childProcess.execFile, origSpawn = childProcess.spawn;
  fs.openSync = (path, ...args) => { opened.push(String(path)); return origOpen(path, ...args); };
  childProcess.execFile = (...args) => { spawned.push(args[0]); return origExec(...args); };
  childProcess.spawn = (...args) => { spawned.push(args[0]); return origSpawn(...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = origOpen; childProcess.execFile = origExec; childProcess.spawn = origSpawn; syncBuiltinESMExports(); });
  const pool = l.pool(), fresh = await pool.read(roots, l.board, NOW);
  assert.deepEqual(spawned, [], 'no Git, no process of any kind');
  assert.ok(opened.length > 0 && opened.every((p) => /\/(STATE\.md|\d+-[^/]+\.md|job\.json|STATUS\.json)$/.test(p) && !/\.git\//.test(p)), opened.join('\n'));
  assert.equal(fresh.get(l.places[0][0]).running, 1);
  assert.equal(fresh.get(l.places[3][0]).running, 2);
  const cold = opened.length;
  await pool.read(roots, l.board, NOW + 1000);
  assert.equal(opened.length, cold, 'unchanged files are not opened again');
  const state = join(roots[1], 'STATE.md');
  fs.writeFileSync(state, fs.readFileSync(state, 'utf8') + '- todo · 0.2 · A-FIVE · more\n');
  fs.utimesSync(state, new Date(NOW + 5000), new Date(NOW + 5000));
  const again = await pool.read(roots, l.board, NOW + 2000);
  assert.deepEqual(opened.slice(cold), [state], 'only the changed STATE.md is read again');
  assert.equal(again.get(roots[1]).counts.todo, 2);
  assert.ok(Math.abs(again.get(roots[1]).at - (NOW + 5000)) < 2);
  assert.deepEqual(spawned, []);
  // A root that left the list drops its collector: coming back, its files are read afresh.
  await pool.read(roots.slice(0, 2), l.board, NOW + 3000);
  const dropped = opened.length;
  await pool.read(roots, l.board, NOW + 4000);
  assert.ok(opened.length > dropped, 'a project that came back is read again');
  // Control: the same spy does see Git when a project is collected in full.
  await new ProjectCollector(roots[0], l.hud, l.env, l.home).collect(true, l.board, NOW + 10000);
  assert.ok(spawned.length > 0, 'the spy sees the full collection read Git');
});
test('the live panel reads the overviews only while the list is open, and the shown project only while it is not', async (t) => {
  const l = await fixture(t), own = fs.realpathSync(l.cwd), others = l.projects.slice(1).map((p) => p.root);
  l.put(join(l.hud, 'projects.json'), { version: 1, projects: others.map((root) => ({ root, registered_at: '2026-11-13T00:00:00.000Z' })) });
  l.put(join(l.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 100, language: 'en' });
  const runner = join(l.root, 'collect-log.mjs');
  fs.writeFileSync(runner, `
import { ProjectCollector } from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)};
import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};
const real = ProjectCollector.prototype.collect;
ProjectCollector.prototype.collect = function (shown, ...rest) { process.stderr.write('COLLECT ' + JSON.stringify({ cwd: this.cwd, shown }) + '\\n'); return real.call(this, shown, ...rest); };
await runLivePage();
`);
  // The panel opens on the list, as after a reload.
  const place = JSON.stringify({ state: { ...initialMonitorState(), mainTab: 'project', projectList: true } }, (_k, v) => (v instanceof Set ? { panelSet: [...v] } : v));
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...l.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: l.cwd, HUD_PANEL_RELOAD_PLACE: place } });
  let log = '', stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (b) => { stderr += b; log += b; });
  t.after(() => child.kill('SIGKILL'));
  const collects = () => log.split('\n').filter((x) => x.startsWith('COLLECT ')).map((x) => JSON.parse(x.slice(8)));
  const until = async (ok, what) => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
    assert.fail(`${what}: ${stderr}`);
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  await until(() => others.every((root) => collects().some((c) => c.cwd === root && c.shown === 'home')), 'an overview of every other listed project');
  assert.ok(collects().some((c) => c.cwd === own && c.shown === 'home'), 'the panel own project is listed too');
  assert.ok(collects().every((c) => c.shown !== true), 'with the list open no project is fully collected (no Git)');
  // Open for a while at a 100 ms refresh, the overviews are still read once, not on every refresh.
  await pause(150);
  const overviewReads = () => collects().filter((c) => c.shown === 'home' && c.cwd === others[0]).length;
  const settled = overviewReads();
  await pause(700);
  assert.equal(overviewReads(), settled, 'no re-read inside five seconds');
  // Esc goes back to the hub: the shown project is collected in full, the overviews stop.
  const before = collects().length;
  child.stdin.write('\x1b');
  await until(() => collects().slice(before).some((c) => c.cwd === own && c.shown === true), 'the hub');
  const hub = collects().length;
  await pause(400);
  assert.ok(collects().slice(hub).every((c) => c.cwd === own && c.shown === true), 'only the shown project is collected on the hub');
  // The name row opens the list again (g goes to the first row, the name row).
  child.stdin.write('g');
  await pause(150);
  const reopen = collects().length;
  child.stdin.write('\r');
  await until(() => collects().slice(reopen).some((c) => c.cwd !== own && c.shown === 'home'), 'the list again');
  // Home: the overviews stop and Home reads only its own project.
  child.stdin.write('1');
  await until(() => collects().slice(-1)[0].cwd === own && collects().slice(-1)[0].shown === 'home', 'Home');
  const home = collects().length;
  await pause(400);
  assert.ok(collects().length > home);
  assert.ok(collects().slice(home).every((c) => c.cwd === own && c.shown === 'home'), 'Home reads its own project only');
});

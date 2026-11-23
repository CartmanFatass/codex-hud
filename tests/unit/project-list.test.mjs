import { withState, sliceState } from '../fixtures/state-helpers.mjs';
import { projectPageOf } from '../../dist/render/project-view.js';
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
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { encodePanelPlace, readPanelPlace } from '../../dist/utils/panel-reload.js';
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
const DOWN = '\x1b[B';

test('Projects list frames: grouped projects at 40/80/120 EN/ZH and in text icons, from real synthetic projects', async (t) => {
  const l = await fixture(t);
  assert.deepEqual(listFrames(l), expected);
  for (const width of [32, 40, 80, 120]) for (const lang of ['en', 'zh']) for (const icons of ['unicode', 'text'])
    for (const line of l.list(width, lang, undefined, 24, icons).lines) assert.equal(visualLength(line), width, stripAnsi(line));
});
test('Projects list keeps projects visible before their overviews load', async (t) => {
  const l = await fixture(t), choices = l.projects.map(({ root, name }) => ({ root, name }));
  assert.deepEqual(text(l.list(40, 'en', undefined, 24, 'unicode', choices)).match(/^  [a-z]+-project/gm).map((row) => row.trim()), choices.map((p) => p.name));
});
test('Projects list through real input: name row opens it, Enter opens a hub, Esc and the crumb come back, 2 opens the hub, reload keeps it', async (t) => {
  const l = await fixture(t), { projects } = l, byName = (name) => projects.find((p) => p.name === name).root;
  const view = (state) => l.render(40, 'en', state, 24, l.data, true, 'unicode', 'none', {
    projects, projectName: (projects.find((p) => p.root === state.selectedProject) ?? projects[0]).name });
  let frame = view(onPage());
  assert.match(text(frame), /^demo-project ─+ ▾ project 1\/6$/m);
  // Enter on the name row opens the list with the cursor on the shown project.
  frame.state.project.nav.cursor = 'project:switch';
  frame = view(send(frame, '\r').state);
  assert.equal((frame.state.project.view.kind === 'projects-list'), true);
  assert.equal(frame.state.project.nav.cursor, `project:list:${byName('demo-project')}`);
  assert.match(plain(frame)[0], /^‹ Projects/);
  // [ ] do nothing on the list; the cursor moves through the entries (two rows, one stop) and Enter opens that hub.
  assert.equal(view(send(frame, ']').state).state.selectedProject, undefined);
  for (const raw of [DOWN, DOWN]) frame = view(send(frame, raw).state);
  frame = view(send(frame, '\r').state);
  assert.equal(frame.state.selectedProject, byName('busy-project'));
  assert.deepEqual([(frame.state.project.view.kind === 'projects-list'), projectPageOf(frame.state)], [false, undefined]);
  assert.match(text(frame), /^busy-project ─+ ▾ project 4\/6$/m, 'the hub of that project, numbered by the switch order');
  // Stepping on with ] leaves that hub: Esc no longer goes back to the list it was opened from.
  const stepped = view(send(frame, ']').state);
  assert.equal(stepped.state.project.fromProjectsList, false);
  assert.equal((esc(stepped).state.project.view.kind === 'projects-list'), false);
  // Esc on a hub reached from the list goes back to it, with the cursor on that project; Esc on the list returns to the hub.
  frame = view(esc(frame).state);
  assert.equal((frame.state.project.view.kind === 'projects-list'), true);
  assert.equal(frame.state.project.nav.cursor, `project:list:${byName('busy-project')}`);
  frame = view(esc(frame).state);
  assert.deepEqual([(frame.state.project.view.kind === 'projects-list'), frame.state.selectedProject], [false, byName('busy-project')]);
  // That hub was not reached from the list now: Esc on it does what it always did (nothing here), so keys can be given back.
  assert.equal((esc(frame).state.project.view.kind === 'projects-list'), false);
  assert.match(text(view(esc(frame).state)), /^busy-project ─+ ▾ project 4\/6$/m);
  // One click on an entry opens its hub; a click on the crumb row returns to the shown project's hub.
  frame = view(onPage(undefined, { project: { view: { kind: 'projects-list' } } }));
  const at = frame.workboard.rows.findIndex((r) => r.item === `project:list:${byName('waiting-project')}`);
  frame = view(click(frame, 3, at + 1).state);
  assert.equal(frame.state.selectedProject, byName('waiting-project'));
  frame = view(esc(frame).state);
  assert.equal((frame.state.project.view.kind === 'projects-list'), true);
  frame = view(click(frame, 1, 0).state);
  assert.deepEqual([(frame.state.project.view.kind === 'projects-list'), frame.state.selectedProject], [false, byName('waiting-project')]);
  // A page: Esc goes up to the hub, then (the hub being reached from the list) to the list.
  frame = view(send(view(onPage(undefined, { project: { view: { kind: 'projects-list' } } })), '\r').state);
  frame.state.project.nav.cursor = 'project:page:progress';
  frame = view(send(frame, '\r').state);
  assert.equal(projectPageOf(frame.state), 'progress');
  frame = view(esc(frame).state);
  assert.equal(projectPageOf(frame.state), undefined);
  frame = view(esc(frame).state);
  assert.equal((frame.state.project.view.kind === 'projects-list'), true);
  // The right arrow opens the hub of the project shown last, not the list; so does the left arrow then the right one.
  frame = view(send(frame, '\x1b[D').state);
  assert.equal(frame.state.activeTab, 'home');
  frame = view(send(frame, '\x1b[C').state);
  assert.deepEqual([frame.state.activeTab, (frame.state.project.view.kind === 'projects-list'), frame.state.selectedProject], ['project', false, undefined]);
  frame = view(send(view(onPage(undefined, { selectedProject: byName('quiet-project'), project: { view: { kind: 'projects-list' } } })), '\x1b[D').state);
  frame = view(send(frame, '\x1b[C').state);
  assert.deepEqual([(frame.state.project.view.kind === 'projects-list'), frame.state.selectedProject], [false, byName('quiet-project')]);
  assert.match(text(frame), /^quiet-project ─+ ▾ project 2\/6$/m);
  // The list survives the panel's own restart: the whole state goes through the reload place.
  const listed = onPage(undefined, { selectedProject: byName('quiet-project'), project: { view: { kind: 'projects-list' } } });
  process.env.HUD_PANEL_RELOAD_PLACE = encodePanelPlace({ state: listed, settings: null });
  const place = readPanelPlace();
  assert.deepEqual([(place.state.project.view.kind === 'projects-list'), place.state.selectedProject], [true, byName('quiet-project')]);
  assert.match(plain(view(place.state))[0], /^‹ Projects/);
  // A root that left the list is the panel's own again; a list that shrank to one project is the plain hub.
  assert.match(text(l.render(40, 'en', place.state, 24, l.data, true, 'unicode', 'none', { projects: projects.slice(0, 1), projectName: 'demo-project' })), /^demo-project ─+$/m);
});
test('one project shows no list: no `▾ i/n`, no list, Esc and [ ] as before', async (t) => {
  const l = await fixture(t), one = l.projects.slice(0, 1);
  const view = (state, projects = one) => l.render(40, 'en', state, 24, l.data, true, 'unicode', 'none', { projects, projectName: 'demo-project' });
  const forced = view(onPage(undefined, { project: { fromProjectsList: true, view: { kind: 'projects-list' } } }));
  assert.equal(forced.projects, undefined);
  assert.doesNotMatch(text(forced), /▾|‹ Projects|\[ \]/);
  assert.match(text(forced), /^Progress /m);
  assert.equal((esc(forced).state.project.view.kind === 'projects-list'), true, 'a stale flag is left alone, never acted on');
  assert.doesNotMatch(plain(view(esc(forced).state))[0], /Projects/);
  assert.equal(send(forced, ']').state.selectedProject, undefined);
  // A stale list flag does not stop hub links from opening pages.
  forced.state.project.nav.cursor = 'project:page:progress';
  assert.equal(projectPageOf(send(forced, '\r').state), 'progress');
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
  fs.writeFileSync(state, fs.readFileSync(state, 'utf8') + '## Slices\n- todo · 0.2 · A-FIVE · more\n');
  fs.utimesSync(state, new Date(NOW + 5000), new Date(NOW + 5000));
  const again = await pool.read(roots, l.board, NOW + 2000);
  assert.deepEqual(opened.slice(cold), [state], 'only the changed STATE.md is read again');
  assert.equal(again.get(roots[1]).counts.todo, 0, 'legacy STATE rows do not affect the overview');
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
  l.put(join(l.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 100, language: 'en', acceptance: 'slice' });
  const runner = join(l.root, 'collect-log.mjs');
  fs.writeFileSync(runner, `
import { ProjectCollector } from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)};
import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};
const real = ProjectCollector.prototype.collect;
ProjectCollector.prototype.collect = function (shown, ...rest) { process.stderr.write('COLLECT ' + JSON.stringify({ cwd: this.cwd, shown }) + '\\n'); return real.call(this, shown, ...rest); };
await runLivePage();
`);
  // The panel opens on the list, as after a reload.
  const place = encodePanelPlace({ state: onPage(undefined, { project: { view: { kind: 'projects-list' } } }), settings: null });
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
  await until(() => others.every((root) => collects().some((c) => c.cwd === root && c.shown === 'overview')), 'an overview of every other listed project');
  assert.ok(collects().some((c) => c.cwd === own && c.shown === 'overview'), 'the panel own project is listed too');
  assert.ok(collects().every((c) => c.shown !== true), 'with the list open no project is fully collected (no Git)');
  // Open for a while at a 100 ms refresh, the overviews are still read once, not on every refresh.
  await pause(150);
  const overviewReads = () => collects().filter((c) => c.shown === 'overview' && c.cwd === others[0]).length;
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
  child.stdin.write('\x1b[H');
  await pause(150);
  const reopen = collects().length;
  child.stdin.write('\r');
  await until(() => collects().slice(reopen).some((c) => c.cwd !== own && c.shown === 'overview'), 'the list again');
  // Home: the overviews stop and Home reads only its own project.
  child.stdin.write('\x1b[D');
  await until(() => collects().slice(-1)[0].cwd === own && collects().slice(-1)[0].shown === 'home', 'Home');
  const home = collects().length;
  await pause(400);
  assert.ok(collects().length > home);
  assert.ok(collects().slice(home).every((c) => c.cwd === own && c.shown === 'home'), 'Home reads its own project only');
});

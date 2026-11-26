import { sliceState } from '../fixtures/state-helpers.mjs';
import { projectPageOf } from '../../dist/render/project-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { projectFixture, plain, onPage, PROJECTS, NOW, TREE } from '../fixtures/project-page.mjs';
import { ProjectVisits } from '../../dist/collectors/project-visits.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { encodePanelPlace, readPanelPlace } from '../../dist/utils/panel-reload.js';
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-progress-'));
  const cleanups = [];
  t.after(async () => {
    // Stop writers before removing their files. If rm throws, node:test skips later after hooks.
    try { for (const cleanup of cleanups) await cleanup(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return { root, ...(await projectFixture(root)), onCleanup: (cleanup) => cleanups.push(cleanup) };
}
const decoder = new WorkbenchInputDecoder('workboard'), key = (raw) => decoder.push(Buffer.from(raw))[0];
const send = (frame, raw) => handleMonitorInput(frame.state, key(raw), { tree: TREE, frame, nowMs: NOW, standalone: true });
const text = (frame) => plain(frame).join('\n');
const extra = { projects: PROJECTS };

test('Project without Objectives keeps STATE handoff notes but no job rows', async (t) => {
  const f = await fixture(t);
  for (const lang of ['en', 'zh']) for (const width of [40, 62]) {
    const hub = f.render(width, lang, undefined, 24, f.rich);
    assert.ok(hub.lines.every((line) => visualLength(line) === width));
    assert.match(text(hub), /Synthetic hub work/);
    assert.match(text(hub), /A short bullet/);
    assert.doesNotMatch(text(hub), /Tidy the synthetic docs|进度|Progress/);
    assert.ok(!hub.workboard.rows.some((r) => r.item?.startsWith('project:job:')));
  }
});
test('hub: with several projects the resident strip switches projects and +N opens the Projects list; [ ] step through them, wrapping; a page keeps its page', async (t) => {
  const f = await fixture(t), height = 24;
  const hub = (state, projects = PROJECTS) => f.render(40, 'en', state, height, f.data, true, 'unicode', 'none', { projects, projectName: 'demo-project' });
  let frame = hub(onPage());
  assert.match(plain(frame)[1], /^ demo-project  second-project  third ─+$/);
  assert.doesNotMatch(text(frame), /▾ (project|项目) \d+\/\d+/);
  assert.deepEqual(frame.projects, PROJECTS);
  assert.match(plain(hub(onPage(), PROJECTS)).at(-1), /t tickets/);
  assert.equal(f.render(40, 'en').projects, undefined, 'one project: no switch, no hint');
  assert.doesNotMatch(text(f.render(40, 'en')), /▾ (project )?\d\/\d|\[ \]/);
  assert.match(text(f.render(40, 'en')), /^demo-project ─/m);
  // Keys: next, next, wraps to the panel's own (stored as none), previous goes round the other way.
  const roots = [];
  for (const raw of [']', ']', ']', '[']) { frame = hub(send(frame, raw).state); roots.push(frame.state.selectedProject); }
  assert.deepEqual(roots, [PROJECTS[1].root, PROJECTS[2].root, undefined, PROJECTS[2].root]);
  // Click a project name on the strip to switch directly.
  const secondBtn = frame.controls.find((c) => c.kind === 'project-strip-pick' && c.item === PROJECTS[1].root);
  assert.ok(secondBtn);
  frame = hub(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: secondBtn.x, y: secondBtn.y }, { tree: TREE, frame, nowMs: NOW, standalone: true }).state);
  assert.equal(frame.state.selectedProject, PROJECTS[1].root);
  // With overflow (+N), clicking +N or moving to +N and pressing Enter opens the Projects list; Esc closes it again.
  const many = [...PROJECTS, { root: '/synthetic/fourth', name: 'fourth-project' }, { root: '/synthetic/fifth', name: 'fifth-project' }];
  frame = hub(onPage(), many);
  const moreBtn = frame.controls.find((c) => c.kind === 'project-strip-more');
  assert.ok(moreBtn, '+N overflow control present at 40 cols with 5 projects');
  frame = hub(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: moreBtn.x, y: moreBtn.y }, { tree: TREE, frame, nowMs: NOW, standalone: true }).state, many);
  assert.equal((frame.state.project.view.kind === 'projects-list'), true);
  assert.match(plain(frame)[0], /^‹ Projects/);
  frame = hub(handleMonitorInput(frame.state, { type: 'key', key: 'escape' }, { tree: TREE, frame, nowMs: NOW, standalone: true }).state, many);
  assert.equal((frame.state.project.view.kind === 'projects-list'), false);
  frame = hub(send(frame, '\x1b[H').state, many);
  assert.equal((hub(send(frame, '\r').state, many).state.project.view.kind === 'projects-list'), true);
  assert.equal(hub(send(frame, ']').state, many).state.selectedProject, many[1].root, 'the cursor on +N does not stop [ ] from stepping');
  // A page: its crumb names the project, the page stays open, and the page's cursor, scroll and folds start fresh.
  const page = (state) => f.render(40, 'en', state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'second-project' });
  assert.match(plain(f.render(40, 'en', 'tickets'))[0], /^‹ Project › Tickets/, 'one project: the crumb says Project');
  frame = page(onPage('tickets', { project: { nav: { cursor: 'project:file:x:slice:1', scroll: 4 }, savedPages: { docs: { cursor: 'project:file:y:0', scroll: 2 } }, folded: new Set(['agents', 'inbox:done']) } }));
  frame = page(send(frame, ']').state);
  assert.equal(projectPageOf(frame.state), 'tickets');
  assert.equal(frame.state.selectedProject, PROJECTS[1].root);
  assert.deepEqual([frame.state.project.nav.scroll, frame.state.project.folded, frame.state.project.savedPages], [0, new Set(), {}]);
  assert.match(plain(frame)[0], /^‹ second-project › Tickets/);
  // Home is not the tab: nothing happens there, and the choice is kept for when Project is open again.
  const home = f.render(80, 'en', { ...sliceState(), selectedProject: PROJECTS[1].root }, 56, f.data, true, 'unicode', 'none', { projects: PROJECTS });
  assert.equal(send(home, ']').state.selectedProject, PROJECTS[1].root);
  assert.deepEqual(plain(home), plain(f.render(80, 'en', sliceState(), 56, f.data, true, 'unicode', 'none', { projects: PROJECTS })), 'Home does not depend on the choice');
  // The choice survives the panel's own restart: the whole state goes through the reload place.
  const state = hub(send(hub(onPage()), ']').state).state;
  process.env.HUD_PANEL_RELOAD_PLACE = encodePanelPlace({ state, settings: null });
  const place = readPanelPlace();
  assert.equal(place.state.selectedProject, PROJECTS[1].root);
  frame = f.render(40, 'en', place.state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'second-project' });
  assert.match(plain(frame)[1], /second-project/);
  assert.doesNotMatch(text(frame), /▾ (project|项目) \d+\/\d+/);
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
test('the Project tab keeps the previous snapshot, with its own root, until a root just switched to has one', () => {
  const visits = new ProjectVisits('/own', (root) => ({ root }));
  assert.deepEqual(visits.shown('/own'), { root: '/own' }, 'nothing collected yet: nothing to show');
  visits.visit('/own').snapshot = { summary: 'own' };
  assert.deepEqual(visits.shown('/own'), { root: '/own', snapshot: { summary: 'own' } });
  visits.visit('/a');
  assert.deepEqual(visits.shown('/a'), { root: '/own', snapshot: { summary: 'own' } }, 'the first frame of a switch is the old page');
  visits.visit('/a').snapshot = { summary: 'a' };
  assert.deepEqual(visits.shown('/a'), { root: '/a', snapshot: { summary: 'a' } });
  assert.deepEqual(visits.shown('/b'), { root: '/a', snapshot: { summary: 'a' } }, 'the newest shown one, not the first');
  assert.deepEqual(visits.shown('/own'), { root: '/own', snapshot: { summary: 'own' } }, 'a visited root shows its own at once');
});
function livePanel(f, runner, env = {}) {
  // A live loop (and the held collection below) has no natural exit while stdin is open.
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 50000, killSignal: 'SIGKILL',
    env: { ...process.env, ...f.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: f.cwd, ...env } });
  const exited = once(child, 'exit');
  f.onCleanup(async () => {
    try { await stopChild(child, exited, { closeStdin: true }); }
    finally { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  });
  return child;
}

test('the live panel paints the old page, not a blank one, on the first switch to a project and then the new page', async (t) => {
  const f = await fixture(t), other = fs.realpathSync(fs.mkdtempSync(join(f.root, 'other-'))), release = join(f.root, 'release');
  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root: other, registered_at: '2026-11-13T00:00:00.000Z' }] });
  f.put(join(f.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 100, language: 'en' });
  const runner = join(f.root, 'slow-second.mjs');
  // The second project's first full collection is held until the test says so, so the frame after `]` is the only one.
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import { ProjectCollector } from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)};
import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};
const real = ProjectCollector.prototype.collect;
ProjectCollector.prototype.collect = async function (shown, ...rest) {
  if (shown === true && this.cwd === ${JSON.stringify(other)}) {
    const end = performance.now() + 20000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (performance.now() >= end) throw Error('Timed out waiting for the test to release the second project');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return real.call(this, shown, ...rest);
};
await runLivePage();
`);
  const state = sliceState();
  const place = encodePanelPlace({ state: { ...state, activeTab: 'project', project: { ...state.project, view: { kind: 'tickets' } } }, settings: null });
  const child = livePanel(f, runner, { HUD_PANEL_RELOAD_PLACE: place });
  // Keep the last row across chunks: the cursor marker or row text may be split at any byte.
  const screen = [];
  let stderr = '', pending = '', row;
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    const parts = (pending + chunk).split(/\x1b\[(\d+);1H\x1b\[0m\x1b\[K/);
    if (row !== undefined) screen[row] = stripAnsi(parts[0]).trimEnd();
    for (let i = 1; i + 1 < parts.length; i += 2) {
      row = Number(parts[i]) - 1;
      screen[row] = stripAnsi(parts[i + 1]).trimEnd();
    }
    pending = parts.at(-1);
  });
  child.stderr.on('data', (b) => { stderr += b; });
  const until = async (ok, what) => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (ok()) return;
    assert.fail(`${what}: ${stderr}\n${screen.join('\n')}`);
  };
  const rows = () => screen.filter((r) => r !== undefined);
  const hasAcceptAll = () => rows().some((r) => /^Accept all +1 to try/.test(r));
  await until(hasAcceptAll, 'the first project’s ticket diagnostics');
  child.stdin.write('G');
  await until(() => rows().some((r) => /⏎ accept all/.test(r)), 'the first project’s Accept all row is selected');
  child.stdin.write(']');
  await until(() => !rows().some((r) => /⏎ accept all/.test(r)), 'the project switch resets the cursor');
  // The held collection has not finished: the tab still shows the first project's page.
  assert.ok(hasAcceptAll(), screen.join('\n'));
  child.stdin.write('G\r');
  await until(() => rows().some((r) => /⏎ accept all/.test(r)), 'the stale Accept all row is selected');
  fs.writeFileSync(release, '');
  await until(() => !hasAcceptAll(), 'the second project’s empty ticket diagnostics');
  assert.ok(!fs.existsSync(join(f.hud, 'tries.jsonl')), 'a row painted for the previous root cannot record acceptance');
});
test('the live panel collects only the project shown on Project and switches back to portfolio reads on Home', async (t) => {
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
  const child = livePanel(f, runner);
  let log = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const collects = () => log.split('\n').slice(0, -1).filter((l) => l.startsWith('COLLECT ')).map((l) => JSON.parse(l.slice(8)));
  const until = async (ok, what) => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
    assert.fail(`${what}: ${log}`);
  };
  const own = fs.realpathSync(f.cwd), mark = () => collects().length;
  await until(() => [own, other].every((root) => collects().some((c) => c.cwd === root && c.shown === 'home')), 'the first portfolio collection');
  assert.ok(collects().every((c) => c.shown === 'home'), 'Home collects only light reads');
  child.stdin.write('\x1b[C'); // → opens the Project tab
  await until(() => collects().some((c) => c.shown === true), 'the Project tab');
  assert.ok(collects().filter((c) => c.shown === true).every((c) => c.cwd === own));
  const before = mark();
  child.stdin.write(']');
  await until(() => collects().slice(before).some((c) => c.cwd === other && c.shown === true), 'the second project');
  await until(() => collects().slice(before).length >= 3, 'multiple collection ticks on the second project');
  assert.ok(collects().slice(before).every((c) => c.cwd === other && c.shown === true), 'only the shown project is collected');
  const leave = mark();
  child.stdin.write('\x1b[D'); // ← is Home again
  await until(() => collects().slice(leave).some((c) => c.cwd === own && c.shown === 'home'), 'Home again');
  const home = mark();
  await until(() => [own, other].every((root) => collects().slice(home).some((c) => c.cwd === root && c.shown === 'home')), 'another portfolio tick');
  assert.ok(collects().slice(home).every((c) => c.shown === 'home'), 'Home does not read full projects');
});

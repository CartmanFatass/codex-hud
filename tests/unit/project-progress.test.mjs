import { withState, sliceState } from '../fixtures/state-helpers.mjs';
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
import { ProjectCollector } from '../../dist/collectors/project-board.js';
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

test('Progress folds through real input: a task shows slice details; Next shows the rest and a long bullet expands', async (t) => {
  const f = await fixture(t), height = 90;
  let frame = f.render(40, 'en', 'progress', height, f.rich);
  const at = (item) => { frame.state.project.nav.cursor = item; return frame; };
  const milestone = 'project:fold:task:milestone:0.1.3';
  frame = f.render(40, 'en', send(at(milestone), '\r').state, height, f.rich);
  assert.match(text(frame), /0\.1\.3 · d0e1f2a · 11-11/m);
  frame = f.render(40, 'en', send(at(milestone), '\r').state, height, f.rich);
  assert.doesNotMatch(text(frame), /d0e1f2a/);
  assert.deepEqual(send(at(milestone), 'o').action, { type: 'open-files', files: [f.data.statePath] }, 'o opens STATE where Enter folds');
  // Next: the row for the rest shows all four bullets and `fewer`, and Enter again folds them.
  assert.doesNotMatch(text(frame), /Another short bullet/);
  frame = f.render(40, 'en', send(at('project:fold:next'), '\r').state, height, f.rich);
  assert.match(text(frame), /→ Another short bullet/);
  assert.match(text(frame), /^ {2}▾ fewer$/m);
  frame = f.render(40, 'en', send(at('project:fold:next'), '\r').state, height, f.rich);
  assert.doesNotMatch(text(frame), /Another short bullet/);
  // Enter on a long bullet shows all of it, again folds it; a short one has nothing to show and opens STATE.md.
  const long = frame.workboard.rows.find((r) => r.item === 'project:fold:next:1');
  frame = f.render(40, 'en', send(at(long.item), '\r').state, height, f.rich);
  assert.match(text(frame), /the end of it all\n/);
  frame = f.render(40, 'en', send(at(long.item), '\r').state, height, f.rich);
  assert.doesNotMatch(text(frame), /the end of it all/);
  assert.deepEqual(send(at(long.item), 'o').action, { type: 'open-files', files: [f.data.statePath] }, 'o opens the file where Enter folds');
  const short = frame.workboard.rows.find((r) => /:next:0$/.test(r.item ?? ''));
  for (const raw of ['\r', 'o']) assert.deepEqual(send(at(short.item), raw).action, { type: 'open-files', files: [f.data.statePath] });
});
test('a project without tickets gets an empty Progress message; its live jobs still show', async (t) => {
  const f = await fixture(t), bare = join(f.root, 'bare');
  fs.mkdirSync(bare);
  const collector = new ProjectCollector(bare, f.hud, f.env, f.home);
  const data = await collector.collect(true, { ...f.board, workers: [] }, NOW);
  assert.equal(data.statePath, undefined);
  const withJob = { ...data, active: f.rich.active };
  for (const width of [40, 120]) for (const lang of ['en', 'zh']) {
    const progress = f.render(width, lang, 'progress', 40, withJob);
    for (const line of progress.lines) assert.equal(visualLength(line), width);
    assert.match(text(progress), lang === 'en' ? /No tickets/ : /无工单/);
    assert.match(text(progress), /◉ imp/);
    assert.doesNotMatch(text(progress), /\(0\.1\.3\)|[█▒░]|● working|Next|To try/);
    assert.match(text(f.render(width, lang, undefined, 24, data)), lang === 'en' ? /Progress +No tickets/ : /进度 +无工单/);
    for (const page of ['tickets', 'tree', 'docs', 'control']) for (const line of f.render(width, lang, page, 40, data).lines)
      assert.equal(visualLength(line), width);
  }
  assert.doesNotMatch(text(f.render(40, 'en', 'progress', 40, data)), /◉|Now/, 'no STATE and no job: only the one line');
});
test('a job of another pane is titled from its brief on Progress, in EN and ZH, and is a stop whose Enter and o open that brief', async (t) => {
  const f = await fixture(t), id = 'j0000000000000001';
  // Started by another main pane, as an ordinary MCP job: no title, no task, no package, and the panel's workboard lacks it.
  f.put(join(f.job, 'job.json'), { job: id, role: 'imp', cwd: f.cwd, herdr_pane: 'w4E:p9', created_at: new Date(NOW - 20 * 60000).toISOString() });
  const data = await f.collector.collect(true, { ...f.board, workers: [] }, NOW + 1);
  assert.equal(data.active.find((a) => a.jobId === id).title, 'Build the Project tab');
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) {
    const frame = f.render(width, lang, 'progress', 56, data);
    for (const line of frame.lines) assert.equal(visualLength(line), width, stripAnsi(line));
    assert.match(text(frame), /◉ imp +Build the Project tab +20(m|分)$/m);
  }
  let frame = f.render(40, 'en', 'progress', 56, data);
  const rows = frame.workboard.rows.filter((r) => r.item === `project:job:${id}`);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.files?.[0] === join(f.job, 'brief.md')));
  frame = f.render(40, 'en', withState(frame.state, { project: { nav: { cursor: `project:job:${id}` } } }), 56, data);
  for (const raw of ['\r', 'o']) assert.deepEqual(send(frame, raw).action, { type: 'open-files', files: [join(f.job, 'brief.md')] });
  // Once it reports, the row opens the report, and the cursor stays on the same row.
  f.put(join(f.job, 'report.md'), '# Report');
  const reported = await f.collector.collect(true, { ...f.board, workers: [] }, NOW + 2);
  frame = f.render(40, 'en', frame.state, 56, reported);
  assert.equal(frame.state.project.nav.cursor, `project:job:${id}`);
  assert.deepEqual(send(frame, '\r').action, { type: 'open-files', files: [join(f.job, 'report.md')] });
});
test('a Progress page of jobs alone pages by keyboard: Down, PgDn and End move the cursor and the view', async (t) => {
  const f = await fixture(t), height = 12;
  const job = (i) => ({ jobId: `j${String(i).padStart(16, '0')}`, role: 'imp', state: 'working', title: `Task ${i + 1}`, at: NOW, asking: false });
  const active = Array.from({ length: 12 }, (_, i) => ({ ...job(i), ...(i === 11 ? {} : { path: join(f.job, 'brief.md') }) }));
  // A project with no STATE.md and more jobs than rows (a panel this short cannot show them all).
  const data = { ...f.data, statePath: undefined, slices: [], next: [], ledger: [], active };
  const page = (state) => f.render(40, 'en', state, height, data);
  let frame = page('progress');
  const first = plain(frame);
  assert.doesNotMatch(first.join('\n'), /Task 12/, 'the last job is below the fold');
  assert.equal(frame.state.project.nav.cursor, active[0] && `project:job:${active[0].jobId}`, 'the first job holds the cursor');
  frame = page(send(frame, '\x1b[6~').state);
  assert.ok(frame.state.project.nav.scroll > 0 || frame.state.project.nav.cursor !== `project:job:${active[0].jobId}`, 'PgDn moves');
  frame = page(send(frame, '\x1b[B').state);
  frame = page(send(frame, 'G').state);
  assert.equal(frame.state.project.nav.cursor, `project:job:${active[11].jobId}`, 'End lands on the last job');
  assert.ok(frame.state.project.nav.scroll > 0, 'and the view followed it');
  assert.match(plain(frame).join('\n'), /Task 12/);
  // A job with neither report nor brief is still a stop, and Enter on it does nothing.
  assert.equal(send(frame, '\r').action, undefined);
  frame = page(send(frame, '\x1b[H').state);
  assert.equal(frame.state.project.nav.cursor, `project:job:${active[0].jobId}`);
  assert.match(plain(frame).join('\n'), /Task 1\b/, 'the view came back to the first job');
  assert.deepEqual(send(frame, '\r').action, { type: 'open-files', files: [join(f.job, 'brief.md')] });
});
test('hub: with several projects the name row reads `▾ i/n` and opens the Projects list; [ ] step through them, wrapping; a page keeps its page', async (t) => {
  const f = await fixture(t), height = 24;
  const hub = (state) => f.render(40, 'en', state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'demo-project' });
  let frame = hub(onPage());
  assert.match(text(frame), /^demo-project ─+ ▾ project 1\/3$/m);
  assert.deepEqual(frame.projects, PROJECTS);
  assert.match(plain(frame).at(-1), /\[ \] project/);
  assert.equal(f.render(40, 'en').projects, undefined, 'one project: no switch, no hint');
  assert.doesNotMatch(text(f.render(40, 'en')), /▾ (project )?\d\/\d|\[ \]/);
  assert.equal(f.render(40, 'en').workboard.rows.find((r) => /^demo-project/.test(stripAnsi(r.text))).item, undefined);
  // Keys: next, next, wraps to the panel's own (stored as none), previous goes round the other way.
  const roots = [];
  for (const raw of [']', ']', ']', '[']) { frame = hub(send(frame, raw).state); roots.push(frame.state.selectedProject); }
  assert.deepEqual(roots, [PROJECTS[1].root, PROJECTS[2].root, undefined, PROJECTS[2].root]);
  // A click on the name row (and Enter on it) opens the Projects list; Esc closes it again (project-list.test.mjs has the rest).
  const name = frame.workboard.rows.findIndex((r) => r.item === 'project:switch');
  frame = hub(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 3, y: name + 1 }, { tree: TREE, frame, nowMs: NOW, standalone: true }).state);
  assert.equal((frame.state.project.view.kind === 'projects-list'), true);
  assert.match(plain(frame)[0], /^‹ Projects/);
  frame = hub(handleMonitorInput(frame.state, { type: 'key', key: 'escape' }, { tree: TREE, frame, nowMs: NOW, standalone: true }).state);
  assert.equal((frame.state.project.view.kind === 'projects-list'), false);
  frame.state.project.nav.cursor = 'project:switch';
  assert.equal((hub(send(frame, '\r').state).state.project.view.kind === 'projects-list'), true);
  assert.equal(hub(send(frame, ']').state).state.selectedProject, undefined, 'the cursor on the name row does not stop [ ] from stepping');
  // A page: its crumb names the project, the page stays open, and the page's cursor, scroll and folds start fresh.
  const page = (state) => f.render(40, 'en', state, height, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'second-project' });
  assert.match(plain(f.render(40, 'en', 'progress'))[0], /^‹ Project › Progress/, 'one project: the crumb says Project');
  frame = page(onPage('progress', { project: { nav: { cursor: 'project:file:x:slice:1', scroll: 4 }, savedPages: { docs: { cursor: 'project:file:y:0', scroll: 2 } }, folded: new Set(['agents', 'inbox:done']) } }));
  frame = page(send(frame, ']').state);
  assert.equal(projectPageOf(frame.state), 'progress');
  assert.equal(frame.state.selectedProject, PROJECTS[1].root);
  assert.deepEqual([frame.state.project.nav.scroll, frame.state.project.folded, frame.state.project.savedPages], [0, new Set(), {}]);
  assert.match(plain(frame)[0], /^‹ second-project › Progress/);
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
  assert.match(text(frame), /^second-project ─+ ▾ project 2\/3$/m);
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
  await until(() => mark() > 0, 'the first collection');
  assert.ok(collects().every((c) => c.cwd === own && c.shown !== true), 'Home collects only the cheap read of its own project');
  child.stdin.write('\x1b[C'); // → opens the Project tab
  await until(() => collects().some((c) => c.shown === true), 'the Project tab');
  assert.ok(collects().filter((c) => c.shown === true).every((c) => c.cwd === own));
  const before = mark();
  child.stdin.write(']');
  await until(() => collects().slice(before).some((c) => c.cwd === other && c.shown === true), 'the second project');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(collects().slice(before).every((c) => c.cwd === other && c.shown === true), 'only the shown project is collected');
  const leave = mark();
  child.stdin.write('\x1b[D'); // ← is Home again
  await until(() => collects().slice(leave).some((c) => c.cwd === own && c.shown === 'home'), 'Home again');
  const home = mark();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(mark() > home);
  assert.ok(collects().slice(home).every((c) => c.cwd === own && c.shown === 'home'), 'Home reads its own project again, never the other');
});

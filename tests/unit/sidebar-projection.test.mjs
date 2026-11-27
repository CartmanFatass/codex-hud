import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { readExecutionRuns } from '../../dist/collectors/execution-runs.js';
import { buildSidebarProjection } from '../../dist/collectors/sidebar-projection.js';
import { createSidebarPublisher, runSidebar } from '../../dist/runtime/sidebar.js';
import { openSidebarDestination, sidebarDestination } from '../../dist/panel/sidebar-navigation.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { roleIcon } from '../../dist/render/model-glyphs.js';
import { projectList } from '../../dist/roles/projects.js';
import { stripAnsi } from '../../dist/render/colors.js';

const flow = 'q1000000000000001', job = 'j1000000000000002';
const wait = (item) => `## Waiting for the owner\n${item ? `- ${item}\n` : ''}`;
function put(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(t, { withRun = true, requests = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hud-sidebar-')), home = join(root, 'hud');
  const project = join(root, 'orchard'), other = join(root, 'canal');
  const now = Date.now(), at = new Date(now - 10 * 60_000).toISOString();
  const sock = join(root, 'h.sock');
  const env = { HOME: root, HUD_HOME: home, HERDR_SOCKET_PATH: sock, PATH: process.env.PATH,
    CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_DIR: join(root, 'pi') };
  const stops = [];
  cleanupFixture(t, { root, hudHome: home }, () => Promise.all(stops.map(stop => stop())));
  put(join(home, 'projects.json'), { version: 1, projects: [{ root: project }, { root: other }] });
  mkdirSync(project); mkdirSync(other);
  const state = join(project, 'STATE.md');
  if (requests) {
    put(state, wait('2026-11-21 [r1] Choose the orchard layout (work waits)'));
    put(join(other, 'STATE.md'), wait('2026-11-20 [r2] Try the canal lights'));
  }
  if (withRun) {
    put(join(home, 'flows', `${flow}.json`), {
      flow, root: project, project_root: project, feature: 'layout', pane: 'wS:p1', state: 'working', created_at: at,
      tickets: [{ ticket: '01', role: 'imp', job, blockers: [] }, { ticket: '02', role: 'imp', blockers: ['01'], landed: true }],
      steps: { tickets: { state: 'running' }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    });
    put(join(home, 'jobs', job, 'job.json'), { job, role: 'imp', cwd: project, project_root: project, created_at: at });
    put(join(home, 'jobs', job, 'STATUS.json'), { state: 'working', started_at: at });
    put(join(home, 'jobs', job, 'SESSION.txt'), `LEFT=wS:p2\nHERDR_SOCKET_PATH=${sock}\nLAUNCH_ID=synthetic-launch\nTERMINAL_ID=synthetic-terminal\n`);
  }
  return { root, state, project, other, home, sock, env, stops, now };
}

const hit = { target: 'execution', hud_group: 'orchard', hud_subgroup: 'layout', step: 'review' };

test('sidebar reuses Home request order and Execution steps; no new generation for the same facts', async (t) => {
  const f = fixture(t), registry = projectList(f.home, f.other);
  const read = async (now) => {
    const portfolio = await new HomePortfolioCollector(f.home).read(registry, { workers: [] }, now);
    assert.deepEqual(portfolio.requests.map(r => r.item.sentence), ['Choose the orchard layout', 'Try the canal lights']);
    const runs = readExecutionRuns(f.home, { root: f.project, pane: null }, new Map(), now);
    return buildSidebarProjection(portfolio, runs.map(run => ({ root: f.project, group: 'orchard', run })),
      new Set([f.project]), () => 'wS:p2', now);
  };
  const facts = await read(f.now);
  const p = facts.projection;
  assert.deepEqual(p.requests, { count: 2, project: 'orchard', age: p.requests.age, sentence: 'Choose the orchard layout' });
  assert.equal(p.extra_projects, 1);
  assert.deepEqual(p.launcher, { execution: 1 });
  assert.deepEqual(p.runs[0].steps.map(({ id, state, role, pane_id }) => [id, state, role, pane_id]), [
    ['01', 'running', roleIcon('imp'), 'wS:p2'], ['02', 'done', roleIcon('imp'), undefined],
    ['review', 'queued', roleIcon('reviewer'), undefined], ['accept', 'queued', roleIcon('lead'), undefined],
  ]);
  assert.ok(p.runs[0].edges.some(edge => edge.join(':') === 'review:accept'));
  const sends = [], publisher = createSidebarPublisher(async params => { sends.push(params); return true; });
  await publisher.update(facts);
  const same = await read(f.now + 121_000);
  assert.notEqual(same.projection.runs[0].age, p.runs[0].age);
  await publisher.update(same);
  assert.equal(sends.length, 1);
  await publisher.update(undefined, true);
  assert.deepEqual(sends, [sends[0], sends[0]], 'lease renewal carries identical data and generation');
  assert.equal(publisher.destination(sends[0].gen + 1, hit), undefined, 'ignore a stale or foreign click');
  for (const page of ['home', 'project', 'execution', 'control']) {
    const routed = publisher.destination(sends[0].gen, { target: page });
    assert.equal(openSidebarDestination(initialMonitorState(), routed).activeTab, page);
  }
  const atStep = openSidebarDestination(initialMonitorState(), sidebarDestination(hit, facts));
  assert.equal(atStep.selectedProject, f.project);
  assert.deepEqual(atStep.subpage, { kind: 'station-detail', flow, stationId: 'review', scroll: 0 });
  const atRun = openSidebarDestination(initialMonitorState(), sidebarDestination({ ...hit, step: undefined }, facts));
  assert.deepEqual(atRun.subpage, { kind: 'run-detail', flow, scroll: 0 });
  assert.equal(sidebarDestination({ ...hit, step: 'not-a-step' }, facts), undefined);
});

async function fakeHerdr(t, f, dock = 'closed') {
  const sockets = new Set(), listeners = new Set(), messages = new EventEmitter(), projections = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); listeners.delete(socket); });
    socket.on('error', () => {});
    createInterface({ input: socket }).once('line', raw => {
      const { id, method, params } = JSON.parse(raw);
      const reply = (result) => socket.end(JSON.stringify({ id, result }) + '\n');
      if (method === 'events.subscribe') {
        if (params.subscriptions.some(sub => sub.type === 'sidebar.hud_activate')) listeners.add(socket);
        socket.write(JSON.stringify({ id, result: { type: 'subscription_started' } }) + '\n');
      } else if (method === 'sidebar.set_hud') {
        projections.push(params);
        reply({ type: 'ok' });
        messages.emit(method, params);
      } else if (method === 'ping') reply({ type: 'pong', version: 'fixture-hud', capabilities: { dock: true, sidebar_hud: true } });
      else if (method === 'pane.list') reply({ panes: [{ pane_id: 'wS:p2', cwd: f.project, launch_id: 'synthetic-launch', terminal_id: 'synthetic-terminal' }] });
      else if (method === 'workspace.list') reply({ workspaces: [{ workspace_id: 'wS' }] });
      else if (method.startsWith('dock.')) {
        if (method === 'dock.open' || method === 'dock.show') dock = 'shown';
        reply({ type: 'dock', shown: dock === 'shown', hidden: dock === 'hidden', action: method === 'dock.open' ? 'opened' : 'shown' });
        messages.emit(method, params);
      } else reply({ type: 'ok' });
    });
  });
  server.listen(f.sock);
  await once(server, 'listening');
  t.after(() => { for (const peer of sockets) peer.destroy(); return new Promise(done => server.close(done)); });
  return { messages, projections, activate(data) {
    const gen = projections.at(-1).gen;
    for (const socket of listeners) socket.write(JSON.stringify({ event: 'sidebar_hud_activate', data: { gen, ...data } }) + '\n');
  } };
}
const nextSet = (fake, ms = 1000) => once(fake.messages, 'sidebar.set_hud', { signal: AbortSignal.timeout(ms) }).then(([v]) => v);

test('a new nested STATE.md request and its atomic replacement publish before the lease timer', async (t) => {
  const f = fixture(t, { requests: false }), fake = await fakeHerdr(t, f);
  f.stops.push(runSidebar(f.home, f.project, { activate() {} }, f.env));
  const initial = await nextSet(fake, 5000);
  assert.equal(initial.projection.requests, undefined);
  assert.equal(initial.projection.runs[0].steps[0].pane_id, 'wS:p2');
  const state = join(f.other, 'docs/handoff/STATE.md');
  const added = nextSet(fake);
  put(state, wait('[r1] Confirm the canal lamps (work waits)'));
  const open = await added;
  assert.equal(open.projection.requests.sentence, 'Confirm the canal lamps');
  const removed = nextSet(fake);
  put(`${state}.tmp`, wait(''));
  renameSync(`${state}.tmp`, state);
  assert.equal((await removed).projection.requests, undefined);
  assert.notEqual(open.gen, initial.gen);
});

test('a launcher event opens the idle watcher’s current dock with its requested page', async (t) => {
  const f = fixture(t, { withRun: false }), fake = await fakeHerdr(t, f);
  mkdirSync(join(f.home, 'jobs'));
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { cwd: f.project, env: f.env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  f.stops.push(() => stopChild(child, exited));
  await nextSet(fake, 5000);
  const opening = once(fake.messages, 'dock.open', { signal: AbortSignal.timeout(2000) });
  fake.activate({ target: 'control' });
  const [params] = await opening;
  assert.equal(params.focus, true);
  assert.deepEqual(JSON.parse(params.env.HUD_SIDEBAR_TARGET), { page: 'control' });
});

test('a live hidden panel shows the requested run station on sidebar activation', async (t) => {
  const f = fixture(t), fake = await fakeHerdr(t, f, 'hidden');
  const entry = new URL('../../dist/tree-page.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runLivePage } from ${JSON.stringify(entry)};
    process.stdout.columns = 100; process.stdout.rows = 35;
    await runLivePage();
  `], { cwd: f.other, env: { ...f.env, HUD_DOCK_CALLER_PANE: 'wS:p1', HERDR_DOCK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  f.stops.push(() => stopChild(child, exited));
  const shown = new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Panel did not show the run station: ${stripAnsi(screen)}`)), 5000);
    let screen = '';
    child.stdout.on('data', bytes => {
      screen += bytes.toString();
      if (/Run review/.test(stripAnsi(screen))) { clearTimeout(timeout); done(); }
    });
    child.stderr.on('data', bytes => { screen += bytes.toString(); });
  });
  const ready = await nextSet(fake, 5000);
  assert.equal(ready.projection.runs[0].hud_group, 'orchard');
  fake.activate(hit);
  await shown;
});

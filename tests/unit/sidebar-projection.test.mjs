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
  assert.deepEqual(p.runs[0].steps.map(({ id, label, state, role, pane_id }) => [id, label, state, role, pane_id]), [
    ['01', '01', 'running', roleIcon('imp'), 'wS:p2'], ['02', '02', 'done', undefined, undefined],
    ['review', 'review', 'queued', undefined, undefined], ['accept', 'accept', 'queued', undefined, undefined],
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

test('composed steps use the job label or kind word; even a borrowed land worker carries its glyph', (t) => {
  const f = fixture(t, { withRun: false }), graph = 'w1000000000000001';
  put(join(f.home, 'flows', `${graph}.json`), { flow: graph, project_root: f.project, state: 'working',
    steps: { inspect: { state: 'done', job }, decide: { state: 'done' }, publish: { state: 'running' } } });
  put(join(f.home, 'flows', graph, 'graph.json'), { version: 1, name: 'release', steps: {
    inspect: { kind: 'job', role: 'imp', needs: [] }, decide: { kind: 'job', role: 'lead', needs: ['inspect'] },
    publish: { kind: 'land', job: 'inspect', needs: ['decide'] },
  } });
  const workers = new Map([[job, { id: `thin-job:${job}`, role: 'imp', briefTitle: 'Inspect the release checklist' }]]);
  const [run] = readExecutionRuns(f.home, { root: f.project, pane: null }, workers, f.now);
  const { projection } = buildSidebarProjection({ projects: [], requests: [] }, [{ root: f.project, group: 'orchard', run, workers }],
    undefined, () => undefined, f.now);
  const { steps } = projection.runs[0];
  assert.equal(steps[0].title, 'Inspect the release checklist');
  assert.deepEqual(steps.map(s => [s.id, s.label, s.role]), [
    ['inspect', 'inspect', undefined], ['decide', 'lead', undefined], ['publish', 'land', roleIcon('imp')],
  ]);
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

test('C1 dock-ux fixture queue projects short labels, full titles, worker roles and parallel fan edges', async (t) => {
  const f = fixture(t, { withRun: false, requests: false });
  const now = f.now, at = new Date(now - 47 * 60_000).toISOString();
  const qFlow = 'q2000000000000001', j01 = 'j2000000000000001', j02 = 'j2000000000000002', j03 = 'j2000000000000003';
  const ticketEntry = (number, title, status) => ({
    number, title, status, role: 'imp', owner_try: false, live_try: 'none', approved_removals: [],
    blocked_by: [], what: title, acceptance: [{ id: 1, text: title, done: status === 'done' }],
    comments: [], created_at: at, updated_at: at,
  });
  put(join(f.project, '.hud', 'tickets', 'dock-ux.json'), {
    version: 1, feature: 'dock-ux',
    tickets: [
      ticketEntry(1, 'Left dock geometry', 'done'),
      ticketEntry(2, 'Push dock width', 'ready-for-agent'),
      ticketEntry(3, 'Dock mode default', 'ready-for-agent'),
    ],
  });
  put(join(f.home, 'flows', `${qFlow}.json`), {
    flow: qFlow, root: f.project, project_root: f.project, feature: 'dock-ux', pane: 'wS:p1', state: 'working', created_at: at,
    tickets: [
      { ticket: 'dock-ux/01', role: 'imp', job: j01, blockers: [], landed: true },
      // Omit item.role to verify the worker's job.json role still carries into the projection.
      { ticket: 'dock-ux/02', job: j02, blockers: [], failed: { reason: 'gate failed', at } },
      { ticket: 'dock-ux/03', role: 'imp', job: j03, blockers: [] },
    ],
    steps: { tickets: { state: 'running' }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
  });
  for (const [id, state] of [[j01, 'done'], [j02, 'failed'], [j03, 'waiting_orchestrator']]) {
    put(join(f.home, 'jobs', id, 'job.json'), { job: id, role: 'imp', cwd: f.project, project_root: f.project, created_at: at });
    put(join(f.home, 'jobs', id, 'STATUS.json'), { state, started_at: at });
  }
  const portfolio = await new HomePortfolioCollector(f.home).read(projectList(f.home, f.project), { workers: [] }, now);
  const runs = readExecutionRuns(f.home, { root: f.project, pane: null }, new Map(), now);
  const { projection } = buildSidebarProjection(
    portfolio,
    runs.map(run => ({ root: f.project, group: 'harbor-api', run })),
    new Set([f.project]),
    id => (id === j03 ? 'wS:p3' : undefined),
    now,
  );
  assert.equal(projection.runs.length, 1);
  const [run] = projection.runs;
  assert.equal(run.hud_group, 'harbor-api');
  assert.equal(run.hud_subgroup, 'dock-ux');
  assert.equal(run.name, 'dock-ux');
  assert.equal(run.age, '47m');
  // Matches C1 frame: ╭────┬────╮ / ✓01  ×02⚒ ?03⚒ / ├╌╌╌╌┴╌╌╌╌╯ / ○ review ╌ ○ accept
  assert.deepEqual(run.steps, [
    { id: 'dock-ux/01', label: '01', title: 'Left dock geometry', state: 'done' },
    { id: 'dock-ux/02', label: '02', title: 'Push dock width', state: 'blocked', role: roleIcon('imp') },
    { id: 'dock-ux/03', label: '03', title: 'Dock mode default', state: 'asked', role: roleIcon('imp'), pane_id: 'wS:p3' },
    { id: 'review', label: 'review', state: 'queued' },
    { id: 'accept', label: 'accept', state: 'queued' },
  ]);
  assert.deepEqual(run.edges, [
    ['dock-ux/01', 'review'],
    ['dock-ux/02', 'review'],
    ['dock-ux/03', 'review'],
    ['review', 'accept'],
  ]);
});

test('shared-blocker parallel tickets fan together and active review/accept/non-queue workers carry short role-free labels and roles', async (t) => {
  const f = fixture(t, { withRun: false, requests: false });
  const now = f.now, at = new Date(now - 12 * 60_000).toISOString();
  const qFlow = 'q3000000000000001', jRev = 'j3000000000000002', jLead = 'j3000000000000003', jAudit = 'j3000000000000004';
  put(join(f.home, 'flows', `${qFlow}.json`), {
    flow: qFlow, root: f.project, project_root: f.project, feature: 'fan', pane: 'wS:p1', state: 'working', created_at: at,
    tickets: [
      { ticket: 'fan/01', role: 'imp', blockers: [], landed: true },
      { ticket: 'fan/02', role: 'imp', blockers: ['fan/01'], landed: true },
      { ticket: 'fan/03', role: 'imp', blockers: ['fan/01'], landed: true },
      { ticket: 'fan/04', role: 'imp', blockers: ['fan/01'], landed: true },
    ],
    review_job: jRev,
    active_lead: { job: jLead, kind: 'accept', step: 'accept', round: 1 },
    steps: { tickets: { state: 'done' }, review: { state: 'running' }, accept: { state: 'running' } },
  });
  put(join(f.home, 'jobs', jRev, 'job.json'), { job: jRev, role: 'reviewer', cwd: f.project, project_root: f.project, created_at: at });
  put(join(f.home, 'jobs', jRev, 'STATUS.json'), { state: 'working', started_at: at });
  put(join(f.home, 'jobs', jLead, 'job.json'), { job: jLead, role: 'lead', cwd: f.project, project_root: f.project, created_at: at });
  put(join(f.home, 'jobs', jLead, 'STATUS.json'), { state: 'working', started_at: at });

  // Single-step graph run matching C1 lantern-ui's `◐◈ run audit  12m`, plus step kinds & role-free labels.
  const gAudit = 'g3000000000000001', gCustom = 'g3000000000000002';
  put(join(f.home, 'flows', `${gAudit}.json`), {
    flow: gAudit, project_root: f.project, state: 'working', created_at: at,
    steps: { audit: { state: 'running', job: jAudit } },
  });
  put(join(f.home, 'flows', gAudit, 'graph.json'), {
    version: 1, name: 'audit',
    steps: { audit: { kind: 'job', role: 'oracle', needs: [], from: [], optional: false, task: 'Audit cache keys' } },
  });
  put(join(f.home, 'jobs', jAudit, 'job.json'), { job: jAudit, role: 'oracle', cwd: f.project, project_root: f.project, created_at: at });
  put(join(f.home, 'jobs', jAudit, 'STATUS.json'), { state: 'working', started_at: at });

  put(join(f.home, 'flows', `${gCustom}.json`), {
    flow: gCustom, project_root: f.project, state: 'working', created_at: at,
    steps: {
      'oracle-cache': { state: 'done', job: jAudit },
      land: { state: 'running' },
      code_review: { state: 'waiting' },
      lead: { state: 'waiting' },
      signoff: { state: 'waiting' },
    },
  });
  put(join(f.home, 'flows', gCustom, 'graph.json'), {
    version: 1, name: 'pipeline',
    steps: {
      'oracle-cache': { kind: 'job', role: 'oracle', needs: [], from: [], optional: false, task: 'Audit' },
      land: { kind: 'land', job: 'oracle-cache', needs: ['oracle-cache'], from: [], optional: false },
      code_review: { kind: 'job', role: 'reviewer', needs: ['land'], from: [], optional: false, task: 'Review' },
      lead: { kind: 'job', role: 'lead', needs: ['code_review'], from: [], optional: false, task: 'Lead' },
      signoff: { kind: 'handback', needs: ['lead'], from: [], optional: false, ask: 'Approve?', options: ['yes'] },
    },
  });

  const portfolio = await new HomePortfolioCollector(f.home).read(projectList(f.home, f.project), { workers: [] }, now);
  const runs = readExecutionRuns(f.home, { root: f.project, pane: null }, new Map(), now);
  const { projection } = buildSidebarProjection(
    portfolio,
    runs.map(run => ({ root: f.project, group: 'lantern-ui', run })),
    new Set([f.project]),
    () => undefined,
    now,
  );
  const byName = new Map(projection.runs.map(r => [r.name, r]));

  const fan = byName.get('fan');
  assert.deepEqual(fan.steps.map(({ label, state, role }) => [label, state, role]), [
    ['01', 'done', undefined],
    ['02', 'done', undefined],
    ['03', 'done', undefined],
    ['04', 'done', undefined],
    ['review', 'running', roleIcon('reviewer')],
    ['accept', 'running', roleIcon('lead')],
  ]);
  assert.deepEqual(fan.edges, [
    ['fan/01', 'fan/02'],
    ['fan/01', 'fan/03'],
    ['fan/01', 'fan/04'],
    ['fan/02', 'review'],
    ['fan/03', 'review'],
    ['fan/04', 'review'],
    ['review', 'accept'],
  ]);

  const audit = byName.get('audit');
  assert.deepEqual(audit.steps, [{ id: 'audit', label: 'audit', state: 'running', role: roleIcon('oracle') }]);

  const pipeline = byName.get('pipeline');
  assert.deepEqual(pipeline.steps.map(({ id, label, role }) => [id, label, role]), [
    ['oracle-cache', 'cache', undefined],
    ['land', 'land', roleIcon('oracle')],
    ['code_review', 'review', undefined],
    ['lead', 'lead', undefined],
    ['signoff', 'accept', undefined],
  ]);
});

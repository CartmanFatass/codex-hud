import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { workerMetadataTokens, workerSubgroup, ticketFeatureSlug } from '../../dist/mcp/dispatch/direct-exec.js';
import { installPiPackage } from '../../dist/harness/pi/package-entry.js';
import { registeredProjectName } from '../../dist/roles/projects.js';
import { reportMainPaneGroup } from '../../dist/runtime/pane-group.js';
import { watchCommand } from '../../dist/cli/watch.js';

async function startMetadataServer(t, sockPath, { failOnce = false } = {}) {
  const reports = [];
  const sockets = new Set();
  let remainingFailures = failOnce ? 1 : 0;
  const server = createServer((conn) => {
    sockets.add(conn);
    conn.on('error', () => {});
    conn.on('close', () => sockets.delete(conn));
    const lines = createInterface({ input: conn });
    lines.on('line', (raw) => {
      const req = JSON.parse(raw);
      if (req.method === 'pane.report_metadata') {
        reports.push(req.params);
        if (remainingFailures > 0) {
          remainingFailures--;
          conn.write(JSON.stringify({ id: req.id, error: { code: 'temporary_failure' } }) + '\n');
          return;
        }
        conn.write(JSON.stringify({ id: req.id, result: { type: 'ok' } }) + '\n');
        return;
      }
      conn.write(JSON.stringify({ id: req.id, result: { type: 'ok' } }) + '\n');
    });
  });
  await new Promise((done) => server.listen(sockPath, done));
  t.after(async () => {
    for (const conn of sockets) conn.destroy();
    await new Promise((done) => server.close(done));
  });
  return { reports };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.ok(predicate(), 'condition timed out');
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const run = (...args) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  };
  run('init', '-b', 'main');
  run('config', 'user.name', 'Synthetic');
  run('config', 'user.email', 'synth@hud.invalid');
  fs.writeFileSync(join(dir, 'README.md'), 'synthetic\n');
  run('add', 'README.md');
  run('commit', '-qm', 'init');
}

test('worker metadata tokens resolve registered project groups and task subgroups across synthetic jobs', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-pane-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hudHome = join(root, 'hud');
  const myHud = join(root, 'MyHUD');
  const herdrFork = join(root, 'herdr-hud');
  const unregistered = join(root, 'unregistered-app');
  const worktree = join(root, 'MyHUD-wt', 'imp-1');
  fs.mkdirSync(hudHome, { recursive: true });
  initRepo(myHud);
  fs.mkdirSync(herdrFork, { recursive: true });
  fs.mkdirSync(unregistered, { recursive: true });
  const wtRes = spawnSync('git', ['worktree', 'add', '-b', 'wt/imp-1', worktree], { cwd: myHud, encoding: 'utf8' });
  assert.equal(wtRes.status, 0, wtRes.stderr);

  const realMyHud = fs.realpathSync(myHud);
  const realHerdr = fs.realpathSync(herdrFork);
  fs.writeFileSync(
    join(hudHome, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root: realMyHud }, { root: realHerdr }] })
  );

  // Registered project name resolves from main checkout, linked worktree, and subdirectory; unregistered yields undefined.
  const subdir = join(realHerdr, 'src', 'ui');
  fs.mkdirSync(subdir, { recursive: true });
  assert.equal(registeredProjectName(hudHome, realMyHud), 'MyHUD');
  assert.equal(registeredProjectName(hudHome, worktree), 'MyHUD');
  assert.equal(registeredProjectName(hudHome, subdir), 'herdr-hud');
  assert.equal(registeredProjectName(hudHome, unregistered), undefined);

  // Ticket feature slug parsing.
  assert.equal(ticketFeatureSlug('herdr-fork/27'), 'herdr-fork');
  assert.equal(ticketFeatureSlug('  select-send/03  '), 'select-send');
  assert.equal(ticketFeatureSlug('42'), undefined);
  assert.equal(ticketFeatureSlug('not-a-ticket'), undefined);

  const jobs = new Map();
  const findParent = (id) => jobs.get(id) ?? null;

  // 1. Ticket feature slug takes priority over package label.
  const ticketParent = {
    job: 'j1111111111111111',
    role: 'imp',
    cwd: worktree,
    project_root: realMyHud,
    ticket: 'herdr-fork/27',
    package: 'ignored-pkg',
  };
  jobs.set(ticketParent.job, ticketParent);
  assert.deepEqual(workerMetadataTokens(ticketParent, 'I', { hudHome, findParent }), {
    hud_role: 'imp',
    hud_ticket: 'herdr-fork/27',
    hud_icon: 'I',
    hud_group: 'MyHUD',
    hud_subgroup: 'herdr-fork',
  });

  // 2. Second feature in same project + second project use distinct groups/subgroups.
  const secondFeature = {
    job: 'j2222222222222222',
    role: 'reviewer',
    cwd: realMyHud,
    ticket: 'select-send/03',
  };
  const otherProject = {
    job: 'j3333333333333333',
    role: 'imp',
    cwd: subdir,
    ticket: 'sidebar-groups/26',
  };
  assert.deepEqual(workerMetadataTokens(secondFeature, 'R', { hudHome, findParent }), {
    hud_role: 'reviewer',
    hud_ticket: 'select-send/03',
    hud_icon: 'R',
    hud_group: 'MyHUD',
    hud_subgroup: 'select-send',
  });
  assert.deepEqual(workerMetadataTokens(otherProject, 'I', { hudHome, findParent }), {
    hud_role: 'imp',
    hud_ticket: 'sidebar-groups/26',
    hud_icon: 'I',
    hud_group: 'herdr-hud',
    hud_subgroup: 'sidebar-groups',
  });

  // 3. Package label used when ticket is absent or bare number.
  const pkgParent = {
    job: 'j4444444444444444',
    role: 'frontend-imp',
    cwd: realMyHud,
    package: 'design-pass',
  };
  jobs.set(pkgParent.job, pkgParent);
  assert.deepEqual(workerMetadataTokens(pkgParent, 'F', { hudHome, findParent }), {
    hud_role: 'frontend-imp',
    hud_ticket: null,
    hud_icon: 'F',
    hud_group: 'MyHUD',
    hud_subgroup: 'design-pass',
  });
  const bareTicketJob = {
    job: 'j4444444444444445',
    role: 'imp',
    cwd: realMyHud,
    ticket: '4',
    package: 'bare-pkg',
  };
  assert.equal(workerSubgroup(bareTicketJob, findParent), 'bare-pkg');

  // 4. Sonic child inherits parent's subgroup (from ticket parent or package parent).
  const sonicFromTicket = {
    job: 'j5555555555555555',
    role: 'sonic',
    cwd: worktree,
    parent_job: ticketParent.job,
  };
  assert.deepEqual(workerMetadataTokens(sonicFromTicket, '*', { hudHome, findParent }), {
    hud_role: 'sonic',
    hud_ticket: null,
    hud_icon: '*',
    hud_group: 'MyHUD',
    hud_subgroup: 'herdr-fork',
  });
  const sonicFromPkg = {
    job: 'j5555555555555556',
    role: 'sonic',
    cwd: realMyHud,
    parent_job: pkgParent.job,
  };
  assert.equal(workerSubgroup(sonicFromPkg, findParent), 'design-pass');

  // 5. Prewalk scout inherits parent's subgroup.
  const prewalkScout = {
    job: 'j6666666666666666',
    role: 'sonic',
    cwd: realMyHud,
    parent_job: ticketParent.job,
    scout_only: true,
    prewalk_kind: 'code',
  };
  assert.deepEqual(workerMetadataTokens(prewalkScout, '*', { hudHome, findParent }), {
    hud_role: 'sonic',
    hud_ticket: null,
    hud_icon: '*',
    hud_group: 'MyHUD',
    hud_subgroup: 'herdr-fork',
  });

  // 6. Subgroup omitted when job and parent have neither ticket nor package, and non-sonic/non-scout children do not inherit.
  const bareParent = {
    job: 'j7777777777777777',
    role: 'lead',
    cwd: unregistered,
  };
  jobs.set(bareParent.job, bareParent);
  const bareTokens = workerMetadataTokens(bareParent, 'L', { hudHome, findParent });
  assert.deepEqual(bareTokens, {
    hud_role: 'lead',
    hud_ticket: null,
    hud_icon: 'L',
    hud_group: 'unregistered-app',
  });
  assert.equal(Object.hasOwn(bareTokens, 'hud_subgroup'), false);

  const sonicFromBare = {
    job: 'j7777777777777778',
    role: 'sonic',
    cwd: realMyHud,
    parent_job: bareParent.job,
  };
  assert.equal(Object.hasOwn(workerMetadataTokens(sonicFromBare, '*', { hudHome, findParent }), 'hud_subgroup'), false);

  const nonSonicChild = {
    job: 'j8888888888888888',
    role: 'general',
    cwd: realMyHud,
    parent_job: ticketParent.job,
  };
  assert.equal(workerSubgroup(nonSonicChild, findParent), undefined);

  // 7. Cycle in parent_job pointers terminates safely with undefined.
  const cycleA = { job: 'j9999999999999991', role: 'sonic', parent_job: 'j9999999999999992' };
  const cycleB = { job: 'j9999999999999992', role: 'sonic', parent_job: 'j9999999999999991' };
  jobs.set(cycleA.job, cycleA);
  jobs.set(cycleB.job, cycleB);
  assert.equal(workerSubgroup(cycleA, findParent), undefined);
});

test('main session panes report hud_group for their registered project via reportMainPaneGroup, pi extension, hud watch, and hud-mcp', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-main-group-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hudHome = join(root, 'hud');
  const project = join(root, 'MyHUD');
  const unregistered = join(root, 'other-dir');
  const sockPath = join(root, 'herdr.sock');
  fs.mkdirSync(hudHome, { recursive: true });
  fs.mkdirSync(unregistered, { recursive: true });
  initRepo(project);
  const worktree = join(root, 'MyHUD-wt', 'main-wt');
  const wtRes = spawnSync('git', ['worktree', 'add', '-b', 'wt/main-wt', worktree], { cwd: project, encoding: 'utf8' });
  assert.equal(wtRes.status, 0, wtRes.stderr);

  const realProject = fs.realpathSync(project);
  fs.writeFileSync(
    join(hudHome, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root: realProject }] })
  );

  const server = await startMetadataServer(t, sockPath, { failOnce: true });
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: root,
    HUD_HOME: hudHome,
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: sockPath,
    HERDR_PANE_ID: 'w1:p1',
  };

  // 1. Direct helper: unregistered dir and worker env do not report; registered project retries after transient failure and deduplicates on success.
  await reportMainPaneGroup(unregistered, baseEnv, hudHome);
  await reportMainPaneGroup(realProject, { ...baseEnv, HUD_JOB_DIR: join(hudHome, 'jobs', 'j1') }, hudHome);
  assert.deepEqual(server.reports, []);

  // First attempt hits failOnce, so a second attempt is allowed; third attempt deduplicates.
  await reportMainPaneGroup(worktree, baseEnv, hudHome);
  await reportMainPaneGroup(worktree, baseEnv, hudHome);
  await reportMainPaneGroup(worktree, baseEnv, hudHome);
  assert.deepEqual(server.reports, [
    { pane_id: 'w1:p1', source: 'hud', tokens: { hud_group: 'MyHUD' } },
    { pane_id: 'w1:p1', source: 'hud', tokens: { hud_group: 'MyHUD' } },
  ]);

  // 2. Pi extension (session_start in main session) reports hud_group for its pane.
  const handlers = new Map();
  const piApi = {
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    sendUserMessage() {},
    registerCommand() {},
    registerTool() {},
  };
  installPiPackage(
    piApi,
    { release: root, hudHome, node: process.execPath },
    { env: { ...baseEnv, HERDR_PANE_ID: 'w1:p2' } },
    'display'
  );
  const piCtx = {
    cwd: realProject,
    hasUI: false,
    mode: 'print',
    sessionManager: {
      getSessionId: () => 'pi-sess-1',
      getSessionDir: () => join(root, 'pi-sessions'),
      getSessionFile: () => join(root, 'pi-sessions', 'pi-sess-1.jsonl'),
      getCwd: () => realProject,
      getLeafId: () => null,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: { notify() {} },
  };
  for (const fn of handlers.get('session_start') ?? []) await fn({}, piCtx);
  await waitFor(() => server.reports.some((r) => r.pane_id === 'w1:p2'));
  assert.deepEqual(
    server.reports.find((r) => r.pane_id === 'w1:p2'),
    { pane_id: 'w1:p2', source: 'hud', tokens: { hud_group: 'MyHUD' } }
  );
  for (const fn of handlers.get('session_shutdown') ?? []) await fn({}, piCtx);

  // 3. `hud watch` (used by Claude mod `--mod`, `--queue`, and Monitor) reports hud_group for callerPane.
  const origCwd = process.cwd();
  process.chdir(realProject);
  const ac = new AbortController();
  const watchDone = watchCommand(
    [],
    {
      env: { ...baseEnv, HERDR_PANE_ID: 'w1:p3' },
      stdout: async () => {},
      stderr: () => {},
    },
    { signal: ac.signal, rescanMs: 5000 }
  );
  try {
    await waitFor(() => server.reports.some((r) => r.pane_id === 'w1:p3'));
    assert.deepEqual(
      server.reports.find((r) => r.pane_id === 'w1:p3'),
      { pane_id: 'w1:p3', source: 'hud', tokens: { hud_group: 'MyHUD' } }
    );
  } finally {
    ac.abort();
    await watchDone;
    process.chdir(origCwd);
  }

  // 4. `hud-mcp` main session reports hud_group on startup for registered project.
  const mcp = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    cwd: realProject,
    env: { ...baseEnv, HERDR_PANE_ID: 'w1:p4' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mcpExited = once(mcp, 'exit');
  t.after(async () => {
    mcp.stdin.end();
    await mcpExited;
  });
  const mcpLines = createInterface({ input: mcp.stdout });
  const mcpErr = [];
  mcp.stderr.on('data', (chunk) => mcpErr.push(chunk));
  const initReply = once(mcpLines, 'line', { signal: AbortSignal.timeout(5000) });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } }) + '\n');
  await initReply;
  await waitFor(() => server.reports.some((r) => r.pane_id === 'w1:p4'));
  assert.deepEqual(
    server.reports.find((r) => r.pane_id === 'w1:p4'),
    { pane_id: 'w1:p4', source: 'hud', tokens: { hud_group: 'MyHUD' } }
  );
  mcp.stdin.end();
  const [code] = await mcpExited;
  assert.equal(code, 0, Buffer.concat(mcpErr).toString());
});

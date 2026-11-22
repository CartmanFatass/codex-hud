import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { renderWorkCard } from '../../dist/render/work-card.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { procStat, turnToken } from '../../dist/mcp/cli-judge.js';
import { writeFixtureFile } from './thin-mcp-files.mjs';

const fakeBin = fileURLToPath(new URL('./thin-mcp-fake-bin.mjs', import.meta.url));
const clock = new URL('./thin-mcp-clock.mjs', import.meta.url).href;

export const workerFor = (f, id) =>
  readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' })
    .flatMap((lane) => lane.workers)
    .find((worker) => worker.id === 'thin-job:' + id);
export const cardText = (worker) =>
  renderWorkCard(projectWorkCard(worker, Date.now()), { ...initialMonitorState(), activeTab: 'home' }, 56)
    .map(stripAnsi)
    .join('\n');

export const entry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
export const withoutHint = ({ hint, ...result }) => result;
export const withoutCallerLookups = (commands) => commands.filter(({ command, args }) =>
  !(command === 'herdr' && args[0] === 'pane' && args[1] === 'get' && args[2] === 'w4E:p1'));
export function fixture(t, inHerdr = true, probe = '', watcherTickMs, worker = false) {
  return startFixture(t, typeof inHerdr === 'object' ? inHerdr : { inHerdr, probe, watcherTickMs, worker });
}

// Routing tests keep their closed PATH and real supervisor clock, without the socket simulation.
export function rolePlacesFixture(t, { withPi = true } = {}) {
  return startFixture(t, { routingOnly: true, withPi });
}

async function startFixture(t, { inHerdr = true, probe = '', watcherTickMs, worker = false, routingOnly = false, withPi = true, failedRetentionMs = 1000, clockScale = 20 }) {
  const root = fs.mkdtempSync(join(tmpdir(), routingOnly ? 'role-places-' : 'thin-mcp-'));
  const bin = join(root, 'bin');
  fs.mkdirSync(bin);
  const log = join(root, 'commands.jsonl');
  // The fake shebang finds this Node even on the routing fixture's closed PATH.
  fs.symlinkSync(process.execPath, join(bin, 'node'));
  const commands = ['pi-role-reap', 'herdr', 'jev-ask', 'jev-aistudio', 'jev-flow', 'grok', 'agy', 'claude', 'codex'];
  if (withPi) commands.push('pi-role');
  if (!routingOnly) commands.push('pi', 'pi-dispatch');
  for (const command of commands) {
    const path = join(bin, command);
    // The roster resolves these launchers' real paths to locate the adjacent roles directory.
    if (command === 'pi-role' || command === 'pi-dispatch')
      fs.writeFileSync(path, `#!/bin/sh\nexec node "$FAKE_BIN" ${command} "$@"\n`, { mode: 0o700 });
    else fs.symlinkSync(fakeBin, path);
  }
  fs.mkdirSync(join(root, 'roles'));
  fs.writeFileSync(join(root, 'roles', 'implementer.md'), routingOnly
    ? '---\nmodel: gpt-6.1-sol\nthinking: high\n---\n'
    : '---\nmodel: synthetic/default\nthinking: low\n---\n');
  if (routingOnly) fs.writeFileSync(join(root, 'roles', 'reviewer.md'), '---\nmodel: anthropic/opus\nthinking: high\n---\n');
  const env = {
    ...process.env,
    HUD_MCP_SURFACE: 'roles',
    HUD_WATCH_FAILED_RETENTION_MS: String(failedRetentionMs),
    ...(watcherTickMs ? { HUD_WATCH_CLI_CHECK_MS: String(watcherTickMs) } : {}),
    PATH: routingOnly ? bin : `${bin}:${process.env.PATH}`,
    FAKE_BIN: fakeBin,
    FAKE_LOG: log,
    HERDR_SOCKET_PATH: join(root, 'events.sock'),
  };
  if (routingOnly) env.FAKE_ROUTING_ONLY = '1';
  else {
    delete env.FAKE_ROUTING_ONLY;
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${clock}`;
    env.HUD_TEST_CLOCK_SCALE = String(clockScale);
  }
  // The caller's own client session must not reach the resume guard.
  delete env.CLAUDE_CODE_SESSION_ID;
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'MISTRAL_API_KEY']) {
    delete env[key];
  }
  for (const name of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
    env[name] = join(root, name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  env.HUD_SETTINGS_PATH = join(env.HUD_HOME, 'hud-settings.json');
  // The fake CLI can still show a trust prompt even when these local grants exist.
  const trusted = fs.realpathSync(root);
  const grokDir = join(env.HOME, '.grok');
  const agyDir = join(env.HOME, '.gemini', 'antigravity-cli');
  if (!routingOnly) {
    fs.mkdirSync(grokDir);
    fs.writeFileSync(join(grokDir, 'trusted_folders.toml'), `[folders.${JSON.stringify(trusted)}]\ntrusted = true\n`);
  }
  fs.mkdirSync(agyDir, { recursive: true });
  fs.writeFileSync(join(agyDir, 'settings.json'), JSON.stringify({ trustedWorkspaces: [trusted] }));
  fs.writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }));
  if (inHerdr) env.HERDR_PANE_ID = 'w4E:p1';
  else delete env.HERDR_PANE_ID;
  if (worker) {
    env.HUD_JOB_DIR = join(env.HUD_HOME, 'jobs', 'j0000000000000001');
    fs.mkdirSync(env.HUD_JOB_DIR, { recursive: true });
  } else delete env.HUD_JOB_DIR;
  const preload = probe ? ['--import', 'data:text/javascript,' + encodeURIComponent(probe)] : [];
  const child = spawn(process.execPath, [...preload, entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const rpc = rpcClient(child);
  t.after(async () => {
    const panePid = join(env.HUD_HOME, 'watchers/w4E:p1.pid');
    try {
      const pid = Number(fs.readFileSync(panePid));
      if (pid > 1 && pid !== process.pid) process.kill(pid, 'SIGTERM');
    } catch {}
    const jobsDir = join(env.HUD_HOME, 'jobs');
    if (fs.existsSync(jobsDir))
      for (const id of fs.readdirSync(jobsDir)) {
        const pidFile = join(jobsDir, id, 'supervisor.pid');
        if (!fs.existsSync(pidFile)) continue;
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
        } catch {}
      }
    child.stdin.end();
    await exited;
    const watchLog = join(env.HUD_HOME, 'watch.log');
    if (fs.existsSync(watchLog))
      for (const match of fs.readFileSync(watchLog, 'utf8').matchAll(/start pid=(\d+)/g)) {
        try {
          process.kill(Number(match[1]), 'SIGTERM');
        } catch {}
      }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(stderr, '');
  });
  let cliSocket, piStatus = () => 'idle';
  const socketRequests = [];
  const subscribers = new Set();
  const has = (name) => fs.existsSync(join(env.HOME, name));
  const push = (client, state) => {
    client.state = state;
    client.socket.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w4E:p2', workspace_id: 'w4E', agent_status: state } }) + '\n');
  };
  async function startCliSocket() {
    if (cliSocket || fs.existsSync(env.HERDR_SOCKET_PATH)) return;
    cliSocket = createServer((socket) => {
      const client = { socket, id: null, state: null, reported: 0 };
      const lines = createInterface({ input: socket });
      lines.on('line', (line) => {
        const req = JSON.parse(line);
        socketRequests.push(req);
        const reply = (result) => socket.write(JSON.stringify({ id: req.id, result }) + '\n');
        if (req.method === 'events.subscribe') {
          client.supervisor = req.params.subscriptions.some((sub) => sub.type === 'pane.agent_status_changed');
          subscribers.add(client); reply({ type: 'subscribed' });
        }
        else if (req.method === 'agent.get') {
          const id = req.params.target.replace(/-primary$/, '');
          const jobFile = join(env.HUD_HOME, 'jobs', id, 'job.json');
          if (fs.existsSync(jobFile) && !JSON.parse(fs.readFileSync(jobFile)).cli) {
            const state = piStatus();
            if (state === 'agent_not_found') socket.write(JSON.stringify({ id: req.id, error: { code: state } }) + '\n');
            else reply({ agent: { agent_status: state } });
            return;
          }
          const sub = [...subscribers].reverse().find((item) => item.supervisor && !item.id) ?? [...subscribers].find((item) => item.supervisor && item.id === id);
          if (sub) sub.id = id;
          if (has('herdr-errors') || has('no-pid')) { socket.write(JSON.stringify({ id: req.id, error: { code: 'agent_not_found' } }) + '\n'); return; }
          reply({ agent: { agent_status: sub?.state ?? 'working', agent_session: has('late-session') && !has('exit-after-done') && !has('socket-got-session') ? null : { kind: 'id', value: 'synthetic-grok-session' } } });
          fs.writeFileSync(join(env.HOME, 'socket-got-session'), '');
        } else if (req.method === 'pane.read') {
          if (has('pane-read-timeout')) return;
          reply({ read: { text: has('pane-read') ? fs.readFileSync(join(env.HOME, 'pane-read'), 'utf8') : 'synthetic pane' } });
        } else if (req.method === 'pane.process_info') {
          const pidFile = ['cli-pid', 'fake-agent-pid'].map((file) => join(env.HOME, file)).find((file) => fs.existsSync(file));
          const id = [...subscribers].filter((item) => item.supervisor).at(-1)?.id;
          const supervisor = id && join(env.HUD_HOME, 'jobs', id, 'supervisor.pid');
          reply({ process_info: { shell_pid: 1, foreground_processes: has('no-pid') ? [] : [{ pid: pidFile ? Number(fs.readFileSync(pidFile)) : supervisor && fs.existsSync(supervisor) ? Number(fs.readFileSync(supervisor)) : child.pid }] } });
        }
      });
      socket.on('error', () => {});
      lines.on('error', () => {});
      socket.on('close', () => { subscribers.delete(client); lines.close(); });
    });
    await new Promise((done) => cliSocket.listen(env.HERDR_SOCKET_PATH, done));
    const simulation = setInterval(() => {
      for (const client of subscribers) {
        if (!client.id || has('manual-socket')) continue;
        const dir = join(env.HUD_HOME, 'jobs', client.id);
        if (!fs.existsSync(join(dir, 'turn.json'))) continue;
        if (has('herdr-errors')) { client.socket.destroy(); continue; }
        const turn = JSON.parse(fs.readFileSync(join(dir, 'turn.json')));
        const status = cliState(dir);
        if (status?.state === 'idle_grace') writeFixtureFile(join(env.HOME, 'seen-grace.json'), JSON.stringify(status));
        let state = has('hold-turn') && !has('release-turn') ? 'working' : 'done';
        if (has('cli-blocked') && !has('release-blocked')) state = 'blocked';
        const report = join(dir, 'report.md');
        if (has('report-while-working')) {
          if (!fs.existsSync(report)) writeFixtureFile(report, 'Synthetic mid-turn report.\n');
          writeFixtureFile(join(env.HOME, 'report-while-working-stage'), '1');
          if (!has('release-done')) state = 'working';
        } else if (state === 'done' && !has('missing-report') && client.reported !== turn.seq) {
          if (turn.seq > 1 && !has('unchanged-report')) writeFixtureFile(report, 'Synthetic grok report two.\n');
          else if (!fs.existsSync(report)) writeFixtureFile(report, 'Synthetic grok report.\n');
          client.reported = turn.seq;
        }
        if (['cli-exit', 'cli-unknown', 'cli-gone', 'exit-after-done'].some(has) || (status?.state === 'idle_grace' && has('grace-quiet-gone')) || (has('cli-blocked') && has('blocked-quiet-gone'))) {
          if (['cli-exit', 'cli-unknown', 'cli-gone', 'exit-after-done'].some(has)) { try { fs.unlinkSync(report); } catch {} }
          const pidFile = join(env.HOME, 'fake-agent-pid');
          if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL'); } catch {} }
          push(client, 'unknown'); continue;
        }
        if (has('quiet-hold')) state = fs.readFileSync(join(env.HOME, 'quiet-hold'), 'utf8').trim();
        if (status?.state === 'idle_grace' && has('grace-quiet')) state = fs.readFileSync(join(env.HOME, 'grace-quiet'), 'utf8').trim();
        if (client.state !== state) push(client, state);
      }
    }, 20);
    t.after(() => { clearInterval(simulation); for (const client of subscribers) client.socket.destroy(); cliSocket.close(); });
  }
  async function call(name, args = {}) {
    if (!routingOnly && name === 'hud_create') {
      const roleFile = join(env.HUD_HOME, 'roles', `${args.role}.json`);
      let role;
      try { role = JSON.parse(fs.readFileSync(roleFile)); } catch {}
      if (['grok', 'agy', 'claude', 'codex'].includes(args.on) || role?.harness === 'cli' || role?.run?.some((place) => place.harness === 'cli')) {
        if (args.role === 'imp' && !role) {
          fs.mkdirSync(join(env.HUD_HOME, 'roles'), { recursive: true });
          const imp = JSON.parse(fs.readFileSync(resolve('packages/hud-mcp/roles/imp.json')));
          writeFixtureFile(roleFile, JSON.stringify({ ...imp, idle_grace_s: 15 }));
        }
        await startCliSocket();
      }
    }
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result.content[0].type, 'text');
    return JSON.parse(response.result.content[0].text);
  }
  return {
    root,
    env,
    rpc,
    call,
    // Rename replaces the fixture symlink itself, never the shared executable it points to.
    overrideBin: (name, body) => writeFixtureFile(join(bin, name), body, { mode: 0o700 }),
    socketRequests,
    startCliSocket,
    piStatus: (get) => { piStatus = get; },
    push: (id, state) => { for (const client of subscribers) if (client.id === id) push(client, state); },
    // herdr's status changes but the push never arrives: only agent.get sees it.
    silent: (id, state) => { for (const client of subscribers) if (client.id === id) client.state = state; },
    drop: () => { for (const client of subscribers) client.socket.destroy(); },
    dropWorker: (id) => { for (const client of subscribers) if (client.id === id) client.socket.destroy(); },
    closeTab: () => { for (const client of subscribers) client.socket.write(JSON.stringify({ event: 'tab.closed', data: { tab_id: 'w4E:t2', workspace_id: 'w4E' } }) + '\n'); },
    commands: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

export function rpcClient(child) {
  let next = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    const callback = pending.get(response.id);
    if (callback) {
      pending.delete(response.id);
      callback(response);
    }
  });
  return (method, params = {}) => new Promise((done) => {
    const id = ++next;
    pending.set(id, done);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

export function workerClient(t, f, dir, askTimeout = '30') {
  const child = spawn(process.execPath, [entry], {
    cwd: f.root, env: { ...f.env, HUD_JOB_DIR: dir, HUD_ASK_TIMEOUT: askTimeout }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  });
  const rpc = rpcClient(child);
  const call = async (name, args = {}) => {
    const { result, error } = await rpc('tools/call', { name, arguments: args });
    assert.equal(error, undefined);
    return result;
  };
  return Object.assign(call, { rpc });
}
export const resultValue = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

export async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

export const tasksExtension = 'io.modelcontextprotocol/tasks';
export function taskRpc(rpc) {
  return async (method, params = {}) => {
    const { result, error } = await rpc(method, { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { extensions: { [tasksExtension]: {} } },
    } });
    assert.equal(error, undefined, JSON.stringify(error));
    return result;
  };
}
export const taskCall = (rpc, name, args) => rpc('tools/call', { name, arguments: args });
export const taskJob = (f, task) => {
  assert.equal(task.resultType, 'task');
  assert.equal(task.status, 'working');
  const job = task.taskId.split(':')[0];
  assert.match(job, /^j[0-9a-f]{16}$/);
  return { job, task_dir: join(f.env.HUD_HOME, 'jobs', job) };
};

export function runSonic(f, action, dir, ...args) {
  return new Promise((done) => execFile(process.execPath,
    [resolve('packages/hud-mcp/bin/hud-sonic.mjs'), action, '--dir', dir, ...args],
    { cwd: f.root, env: { ...f.env, HUD_JOB_DIR: dir, HERDR_PANE_ID: 'w4E:p9' } },
    (error, stdout, stderr) => done({ status: error?.code ?? 0, stdout, stderr })
  ));
}
export function sonicTask(f) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false, run: [{
      harness: 'pi', pi_role: 'sonic', model: 'synthetic/sonic', thinking: 'high',
    }],
  }));
  const task = join(f.root, 'sonic-task.md');
  fs.writeFileSync(task, '# Synthetic sonic sub-task\n\nSummarize the synthetic fixture.');
  return task;
}
export function publishSonic(dir, status) {
  const tmp = join(dir, 'test-status.tmp');
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, join(dir, 'STATUS.json'));
}

export function fakeCliWithChild(t, f) {
  const worker = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const children = new Map();
    let latest;
    process.on('message', ({ command, args, detached }) => {
      if (command) {
        const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], detached });
        latest = child.pid;
        children.set(latest, detached);
        child.once('exit', () => children.delete(child.pid));
        process.send(latest);
      } else process.kill(latest);
    });
    process.on('disconnect', () => {
      for (const [pid, group] of children) { try { process.kill(group ? -pid : pid); } catch {} }
    });
  `], { env: f.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(worker, 'exit');
  t.after(async () => { if (worker.connected) worker.disconnect(); await exited; });
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(worker.pid));
  return {
    pid: worker.pid,
    // Model a tool shell that stays live until stopped, without leaving an orphan child.
    async start(command = '/bin/bash', args = ['-c', 'read -r line'], detached = false) {
      const message = once(worker, 'message');
      worker.send({ command, args, detached });
      const [pid] = await message;
      assert.equal(procStat(pid)?.ppid, worker.pid);
      return pid;
    },
    stop: () => worker.send({}),
    exit: async () => { worker.disconnect(); await exited; },
  };
}

export const statusQueries = (f, job) => f.socketRequests.filter((r) =>
  r.method === 'agent.get' && r.params.target === `${job.job}-primary`).length;

export const readCloseQuit = (f, job) => f.commands().some((c) =>
  c.command === 'herdr' && c.args[1] === 'prompt' && c.args[2] === job.agent && c.args[3] === '/quit');
export const readCloseReaped = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).reaped_at;
export const reapAttempts = (f, job) => f.commands().filter((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir).length;
const progressCommand = resolve('packages/hud-mcp/bin/hud-progress.mjs');
export const cliToken = (dir) => turnToken(JSON.parse(fs.readFileSync(join(dir, 'turn.json'), 'utf8')));
export const runProgress = (f, dir, ...args) => spawnSync(process.execPath, [progressCommand, ...args], {
  env: { ...f.env, HUD_JOB_DIR: dir }, encoding: 'utf8',
});
export function declareDone(f, job, cli = true) {
  const dir = job.task_dir;
  const result = runProgress(f, dir, '--done', ...(cli ? ['--turn', cliToken(dir)] : []));
  assert.equal(result.status, 0, result.stderr);
}

export async function publishPiGrace(job, worker, writeReport = true) {
  const dir = job.task_dir;
  const report = join(dir, 'report.md');
  if (writeReport) writeFixtureFile(report, 'Synthetic settled pi report.\n');
  const now = Date.now();
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({
    version: 1, task_dir: dir, slot: 'primary', state: 'idle_grace', output_written: true,
    ...(worker ? { pid: worker.pid, pid_start_time: procStat(worker.pid).start } : {}),
    settled_at: new Date(now).toISOString(), idle_deadline_at: new Date(now + 8000).toISOString(),
  }));
  const mtime = fs.statSync(report).mtimeMs;
  await until(() => Date.now() > mtime); // hud_read records integer milliseconds.
}

export const fallbackPlaces = [
  { harness: 'cli', agent: 'grok', model: 'synthetic-first' },
  { harness: 'pi', pi_role: 'implementer', model: 'synthetic/second' },
];
export function fallbackRole(f, role, run = fallbackPlaces, presets) {
  const root = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, `${role}.json`), JSON.stringify({ role, instructions: 'implementer', can_continue: false, run, presets }));
}

export function waitFixtureJob(f, n, state = 'working', herdr_pane = 'w4E:p1', cwd = f.root) {
  const job = `j${n.toString(16).padStart(16, '0')}`;
  const dir = join(f.env.HUD_HOME, 'jobs', job);
  const receipt = { job, role: 'imp', herdr_pane, cwd, created_at: new Date(n * 1000).toISOString() };
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify(receipt));
  const status = (state) => writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state }));
  status(state);
  return { job, dir, receipt, status };
}

export const ownerOf = ({ dir }) => JSON.parse(fs.readFileSync(join(dir, 'job.json'))).herdr_pane;
export const paneList = (f, ...ids) => writeFixtureFile(join(f.env.HOME, 'pane-list.json'), JSON.stringify({
  result: { panes: ids.map((pane_id) => ({ pane_id })) },
}));

export const progressRecord = (text) => ({ at: '2026-11-18T12:00:00.000Z', text });
export const jsonLines = (rows) => rows.map((row) => JSON.stringify(row) + '\n').join('');

const cliStatusKeys = [
  'version',
  'task_dir',
  'slot',
  'harness',
  'agent',
  'role',
  'model',
  'thinking',
  'state',
  'output_path',
  'output_written',
  'pid',
  'pid_start_time',
  'agent_session_id',
  'started_at',
  'settled_at',
  'idle_deadline_at',
  'ended_at',
  'exit_reason',
  'error',
  'updated_at',
];
export function assertCliStatus(status, dir) {
  for (const key of cliStatusKeys) assert.equal(Object.hasOwn(status, key), true, key);
  assert.equal(Object.hasOwn(status, 'session_id'), false);
  assert.equal(status.version, 1);
  assert.equal(status.slot, 'primary');
  assert.equal(status.harness, 'cli');
  assert.equal(status.agent, 'grok');
  assert.equal(status.task_dir, fs.realpathSync(dir));
}

export function writeCliRole(f, role, idle_grace_s = 1, can_continue = true, agent = 'grok') {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', `${role}.json`),
    JSON.stringify({ role, harness: 'cli', agent, ...(agent === 'grok' ? { model: 'grok-4.7' } : {}), thinking: 'high', can_continue, idle_grace_s: idle_grace_s * Number(f.env.HUD_TEST_CLOCK_SCALE ?? 20) })
  );
}

export function cliState(dir) {
  const file = join(dir, 'STATUS.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function graceArmed(env, dir) {
  const seen = join(env.HOME, 'seen-grace.json');
  return (
    cliState(dir)?.state === 'idle_grace' &&
    fs.existsSync(seen) &&
    fs.readFileSync(seen, 'utf8').includes(dir.split('/').at(-1))
  );
}

export async function fakeDecisionServer(t, handler) {
  const requests = [];
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const reply = await handler(body, requests.length, req);
      if (reply?.status && reply.status !== 200) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? { error: 'synthetic error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

export function decisionAnswer(choice, probability, rest = 0.02) {
  const choices = ['still-working', 'finished-no-report', 'failed', 'needs-human'];
  const remainder = Math.max(0, 1 - probability);
  const perOther = remainder / (choices.length - 1);
  return {
    answers: [
      {
        name: 'quiet_job',
        type: 'choice',
        choice,
        probabilities: choices.map((value) => ({ value, probability: value === choice ? probability : perOther })),
        confidence: Math.max(0, probability - rest),
      },
    ],
  };
}

export function configureFakeDecision(f, baseUrl, cap = 0) {
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'credentials.env'),
    `OPENAI_API_KEY=synthetic-openai-key\nOPENAI_BASE_URL=${baseUrl}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'config.json'),
    JSON.stringify({ decisions: { primary: 'openai', openai: { baseUrl } } }),
    { mode: 0o600 }
  );
  if (cap > 0) {
    fs.writeFileSync(
      join(f.env.HUD_HOME, 'hud-settings.json'),
      JSON.stringify({ decisionCallsPerHour: cap }),
      { mode: 0o600 }
    );
  }
}

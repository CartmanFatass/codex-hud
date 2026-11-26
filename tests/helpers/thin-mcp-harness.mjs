import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { procStat, turnToken } from '../../dist/mcp/cli-judge.js';
import { writeFixtureFile } from './thin-mcp-files.mjs';
import { cleanupFixture, stopChild } from './process-cleanup.mjs';
import { reapStubOptions } from './reap-stub.mjs';
import { until } from './until.mjs';

const fakeBin = fileURLToPath(new URL('./thin-mcp-fake-bin.mjs', import.meta.url));
const clock = new URL('./thin-mcp-clock.mjs', import.meta.url).href;

export const workerFor = (f, id) =>
  readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' })
    .flatMap((lane) => lane.workers)
    .find((worker) => worker.id === 'thin-job:' + id);
export const cardText = (worker) =>
  workInspectorRows(worker, 80, Date.now())
    .map((row) => stripAnsi(row.text))
    .join('\n');

export const entry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
export const withoutHint = ({ hint, ...result }) => result;
export function enableOptionalRoles(f, ...names) {
  fs.writeFileSync(join(f.env.HUD_HOME, 'role-switches.json'), JSON.stringify(Object.fromEntries(names.map((name) => [name, true]))));
}
export const withoutCallerLookups = (commands) => commands.filter(({ command, args }) =>
  !(command === 'herdr' && args[0] === 'pane' && args[1] === 'get' && args[2] === 'w4E:p1'));
export function fixture(t, inHerdr = true, probe = '', watcherTickMs, worker = false) {
  return startFixture(t, typeof inHerdr === 'object' ? inHerdr : { inHerdr, probe, watcherTickMs, worker });
}

// These fixtures exercise the lifecycle of receipts published before close-at-report arrived.
const legacyReceiptProbe = `
{
  const stringify = JSON.stringify;
  JSON.stringify = (value, ...args) => {
    if (value && typeof value === 'object' && /^j[0-9a-f]{16}$/.test(value.job) &&
        'dispatch_exit_code' in value && 'resume_s' in value) {
      const { resume_s, ...oldReceipt } = value;
      return stringify(oldReceipt, ...args);
    }
    return stringify(value, ...args);
  };
}
`;
export function legacyFixture(t, inHerdr = true, probe = '', watcherTickMs, worker = false) {
  const opts = typeof inHerdr === 'object' ? inHerdr : { inHerdr, probe, watcherTickMs, worker };
  return startFixture(t, { ...opts, probe: [opts.probe, legacyReceiptProbe].filter(Boolean).join('\n') });
}

// Routing tests keep their closed PATH and real supervisor clock.
export function rolePlacesFixture(t, { withPi = true } = {}) {
  return startFixture(t, { routingOnly: true, withPi });
}

async function startFixture(t, { inHerdr = true, probe = '', watcherTickMs, worker = false, routingOnly = false, withPi = true, path = process.env.PATH, failedRetentionMs = 1000, clockScale = 20, mcpEntry = entry, mcpJson = true, autoPrewalk = false, herdrVersion = '0.9.5-hud.76b187b0', herdrCapabilities = { agy_background_work: true }, customHerdrSocket = false, expectedStderr = '' }) {
  const root = fs.mkdtempSync(join(tmpdir(), routingOnly ? 'role-places-' : 'thin-mcp-'));
  const cleanups = [];
  cleanupFixture(t, { root, hudHome: join(root, 'hud_home') }, async () => {
    let firstError;
    for (const cleanup of [...cleanups].reverse()) {
      try { await cleanup(); } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  });
  const bin = join(root, 'bin');
  fs.mkdirSync(bin);
  const log = join(root, 'commands.jsonl');
  // The fake shebang finds this Node even on the routing fixture's closed PATH.
  fs.symlinkSync(process.execPath, join(bin, 'node'));
  const commands = ['hud-reap', 'herdr', 'jev-ask', 'jev-aistudio', 'jev-flow', 'grok', 'agy', 'claude', 'codex'];
  if (withPi) commands.push('pi');
  for (const command of commands) fs.symlinkSync(fakeBin, join(bin, command));
  const env = {
    ...process.env,
    HUD_MCP_SURFACE: 'roles',
    HUD_MCP_JSON: '1',
    HUD_WATCH_FAILED_RETENTION_MS: String(failedRetentionMs),
    ...(watcherTickMs ? { HUD_WATCH_CLI_CHECK_MS: String(watcherTickMs) } : {}),
    PATH: routingOnly ? bin : `${bin}:${path}`,
    FAKE_BIN: fakeBin,
    FAKE_LOG: log,
    // Node fetch must reach the fixture's loopback Decision server, not the caller's HTTP proxy.
    no_proxy: '127.0.0.1,localhost',
    NO_PROXY: '127.0.0.1,localhost',
    HERDR_SOCKET_PATH: join(root, 'events.sock'),
  };
  if (!mcpJson) delete env.HUD_MCP_JSON;
  // Set by the Claude mod in the session that runs the suite; it would turn MCP tasks off. Tests that want it set it.
  delete env.HUD_CLAUDE_MOD;
  if (routingOnly) env.FAKE_ROUTING_ONLY = '1';
  else {
    delete env.FAKE_ROUTING_ONLY;
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${clock}`;
    env.HUD_TEST_CLOCK_SCALE = String(clockScale);
  }
  env.NODE_OPTIONS = reapStubOptions(bin, env.NODE_OPTIONS);
  // Never pass the outer test runner's session into the synthetic MCP caller.
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'HUD_MCP_PI_SESSION_ID']) delete env[key];
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'MISTRAL_API_KEY']) {
    delete env[key];
  }
  for (const name of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
    env[name] = join(root, name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  env.HUD_SETTINGS_PATH = join(env.HUD_HOME, 'hud-settings.json');
  if (!autoPrewalk) writeFixtureFile(env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false }));
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
  const child = spawn(process.execPath, [...preload, mcpEntry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  let stopping;
  const stopMcp = () => stopping ??= stopChild(child, exited, {
    closeStdin: true,
    graceMs: t.signal?.aborted ? 200 : 2000,
    killMs: 400,
  });
  cleanups.push(async () => {
    try {
      const stopped = await stopMcp();
      if (!stopped.forced && !t.signal?.aborted) assert.equal(stderr, expectedStderr);
    } finally {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
  const rpc = rpcClient(child);
  let cliSocket, listening, piStatus = () => 'idle';
  const socketRequests = [], launches = new Map(), agents = new Set();
  const subscribers = new Set(), sockets = new Set(), vanishedTabs = new Set();
  const emitTabClosed = (tab_id) => {
    for (const client of subscribers) client.socket.write(JSON.stringify({ event: 'tab.closed', data: { tab_id, workspace_id: 'w4E' } }) + '\n');
  };
  const has = (name) => fs.existsSync(join(env.HOME, name));
  const push = (client, state) => {
    client.state = state;
    client.socket.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: client.pane, workspace_id: 'w4E', agent_status: state } }) + '\n');
  };
  function startCliSocket() {
    if (listening || fs.existsSync(env.HERDR_SOCKET_PATH)) return listening;
    cliSocket = createServer((socket) => {
      sockets.add(socket);
      const client = { socket, id: null, state: null, reported: 0 };
      const lines = createInterface({ input: socket });
      lines.on('line', (line) => {
        const req = JSON.parse(line);
        socketRequests.push(req);
        const reply = (result) => socket.write(JSON.stringify({ id: req.id, result }) + '\n');
        const error = (code, message) => socket.write(JSON.stringify({ id: req.id, error: { code, message } }) + '\n');
        if (req.method === 'ping') {
          reply({ type: 'pong', version: herdrVersion, protocol: 22, capabilities: herdrCapabilities });
          return;
        }
        if (req.method === 'agent.start') {
          const { name, kind, argv, cwd, label, workspace_id, focus, timeout_ms, env: workerEnv } = req.params;
          const seq = join(env.HOME, 'tab-seq'), n = has('tab-seq') ? (Number(fs.readFileSync(seq)) || 1) + 1 : 2;
          if (has('tab-seq')) writeFixtureFile(seq, String(n));
          const tab_id = `w4E:t${n}`, pane_id = `w4E:p${n}`, launch_id = randomUUID(), terminal_id = randomUUID();
          const args = ['agent', 'start', name, '--kind', kind, '--pane', pane_id,
            ...(timeout_ms ? ['--timeout', String(timeout_ms)] : []), '--', ...argv];
          // Project direct-start metadata into the fixture's operation log for existing argv/label assertions.
          // Protocol assertions use socketRequests (or filter out these projected rows via rpc).
          const entries = [
            ['tab', 'create', ...(workspace_id ? ['--workspace', workspace_id] : []), '--cwd', cwd, '--label', label,
              ...['HUD_JOB_DIR', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].filter(key => workerEnv[key] !== undefined)
                .flatMap(key => ['--env', `${key}=${workerEnv[key]}`]), ...(!focus ? ['--no-focus'] : [])],
            args,
          ];
          for (const row of entries) fs.appendFileSync(log, JSON.stringify({ command: 'herdr', args: row, rpc: req.method }) + '\n');
          const externalPid = has('cli-pid') ? Number(fs.readFileSync(join(env.HOME, 'cli-pid'))) : null;
          const external = externalPid && procStat(externalPid);
          const worker = external && external.state !== 'Z' ? null : spawn('/bin/sleep', ['600'], {
            env: { ...workerEnv, HERDR_PANE_ID: pane_id, HERDR_TAB_ID: tab_id, HERDR_WORKSPACE_ID: 'w4E' }, stdio: 'ignore',
          });
          if (worker) { agents.add(worker); worker.once('exit', () => agents.delete(worker)); }
          const pid = worker?.pid ?? externalPid;
          const start = procStat(pid)?.start;
          if (!start) { worker?.kill(); error('invalid_request', 'fixture worker PID missing'); return; }
          const init = { ...env, FAKE_DIRECT_PID: String(pid) };
          const prepare = execFile(process.execPath, [fakeBin, 'direct-start', ...args], { env: init }, (err, stdout, stderr) => {
            if (socket.destroyed) { worker?.kill(); return; }
            if (err) {
              worker?.kill();
              let failure;
              try { failure = JSON.parse(stderr).error; } catch {}
              error(failure?.code ?? 'invalid_request', failure?.message ?? (stderr.trim() || stdout.trim()));
              return;
            }
            if (worker && ['cli-exit', 'cli-unknown', 'cli-gone', 'grace-quiet-gone', 'blocked-quiet-gone', 'exit-after-done'].some(has))
              writeFixtureFile(join(env.HOME, 'fake-agent-pid'), String(pid));
            const resuming = argv.includes('--resume') || argv.includes('--conversation') || argv[0] === 'resume';
            const target = { name, kind, tab_id, pane_id, launch_id, terminal_id, worker, resuming };
            launches.set(name, target);
            reply({ type: 'agent_started', tab: { tab_id, launch_id }, root_pane: { pane_id, launch_id, terminal_id },
              launch_id, pid, pid_start_time: start });
          });
          agents.add(prepare); prepare.on('exit', () => agents.delete(prepare));
          return;
        }
        if (req.method === 'pane.report_metadata') {
          reply({ type: 'ok' });
          return;
        }
        if (req.method === 'events.subscribe') {
          client.pane = req.params.subscriptions.find((sub) => sub.type === 'pane.agent_status_changed')?.pane_id;
          client.supervisor = !!client.pane;
          subscribers.add(client); reply({ type: 'subscribed' });
        }
        else if (req.method === 'agent.get') {
          const target = launches.get(req.params.target) ?? [...launches.values()].reverse().find(a => a.pane_id === req.params.target);
          if (!target) { error('agent_not_found'); return; }
          const { kind, name, pane_id, tab_id, launch_id, terminal_id } = target;
          const id = name.replace(/-primary$/, '');
          const sub = [...subscribers].reverse().find(item => item.id === id || (!item.id && item.pane === pane_id));
          if (sub) sub.id = id;
          const state = sub?.state ?? (kind === 'pi' && target.ready ? piStatus() : 'idle');
          if (state === 'agent_not_found' || (sub && has('herdr-errors'))) { error('agent_not_found'); return; }
          const agent_session = has('late-session') && !has('exit-after-done') && !has('socket-got-session') ? null : {
            kind: 'id', value: target.resuming && has('wrong-native-session') ? 'unexpected-session' : 'synthetic-grok-session',
          };
          const blocked = !target.ready && has('start-not-ready');
          reply({ agent: { name, pane_id, tab_id, launch_id, terminal_id, agent: kind,
            agent_status: blocked ? 'blocked' : state, interactive_ready: !blocked, agent_session } });
          target.ready = true;
          if (sub) fs.writeFileSync(join(env.HOME, 'socket-got-session'), '');
        } else if (req.method === 'pane.get' || req.method === 'tab.get') {
          const id = req.params.tab_id ?? req.params.pane_id.replace(/:p/, ':t');
          if (vanishedTabs.has(id)) socket.write(JSON.stringify({ id: req.id, error: { code: req.method === 'pane.get' ? 'pane_not_found' : 'tab_not_found' } }) + '\n');
          else {
            const target = [...launches.values()].reverse().find(a => a.tab_id === id);
            reply(req.method === 'pane.get' ? { pane: { pane_id: req.params.pane_id } } : { tab: { tab_id: id, launch_id: target?.launch_id } });
          }
        } else if (req.method === 'pane.read') {
          if (has('pane-read-timeout')) return;
          reply({ read: { text: has('pane-read') ? fs.readFileSync(join(env.HOME, 'pane-read'), 'utf8') : 'synthetic pane' } });
        } else if (req.method === 'pane.process_info') {
          const pidFile = ['cli-pid', 'fake-agent-pid'].map((file) => join(env.HOME, file)).find((file) => fs.existsSync(file));
          const id = [...subscribers].filter((item) => item.supervisor).at(-1)?.id;
          const supervisor = id && join(env.HUD_HOME, 'jobs', id, 'supervisor.pid');
          const pid = pidFile ? Number(fs.readFileSync(pidFile)) : supervisor && fs.existsSync(supervisor) ? Number(fs.readFileSync(supervisor)) : child.pid;
          const job = id && join(env.HUD_HOME, 'jobs', id, 'job.json');
          const name = job && fs.existsSync(job) ? JSON.parse(fs.readFileSync(job)).cli?.agent : undefined;
          reply({ process_info: { pane_id: req.params.pane_id, shell_pid: 1, foreground_process_group_id: pid, foreground_processes: has('no-pid') ? [] : [{ pid, name }] } });
        }
      });
      socket.on('error', () => {});
      lines.on('error', () => {});
      socket.on('close', () => { subscribers.delete(client); sockets.delete(socket); lines.close(); });
    });
    listening = new Promise((done) => cliSocket.listen(env.HERDR_SOCKET_PATH, done));
    const simulation = routingOnly ? null : setInterval(() => {
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
          if (!status?.pid_start_time && fs.existsSync(pidFile)) continue; // Model exit after the worker identity is discovered.
          if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL'); } catch {} }
          push(client, 'unknown'); continue;
        }
        if (has('quiet-hold')) state = fs.readFileSync(join(env.HOME, 'quiet-hold'), 'utf8').trim();
        if (status?.state === 'idle_grace' && has('grace-quiet')) state = fs.readFileSync(join(env.HOME, 'grace-quiet'), 'utf8').trim();
        if (client.state !== state) push(client, state);
      }
    }, 20);
    cleanups.push(async () => {
      clearInterval(simulation);
      for (const proc of agents) proc.kill('SIGKILL');
      for (const socket of sockets) socket.destroy();
      await new Promise(done => cliSocket.close(done));
    });
    return listening;
  }
  async function call(name, args = {}) {
    if (!routingOnly && name === 'hud_create') {
      const roleFile = join(env.HUD_HOME, 'roles', `${args.role}.json`);
      let role;
      try { role = JSON.parse(fs.readFileSync(roleFile)); } catch {}
      if (['grok', 'agy', 'claude', 'codex'].includes(args.on) || role?.harness === 'cli' || role?.run?.some((place) => place.harness === 'cli')) {
        if (['imp', 'general'].includes(args.role) && !role) {
          fs.mkdirSync(join(env.HUD_HOME, 'roles'), { recursive: true });
          const defaults = JSON.parse(fs.readFileSync(resolve('packages/hud-mcp/roles', `${args.role}.json`)));
          writeFixtureFile(roleFile, JSON.stringify({ ...defaults, idle_grace_s: 15 }));
        }
      }
    }
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result.content[0].type, 'text');
    return JSON.parse(response.result.content[0].text);
  }
  // Detached workflow runners and direct dispatch helpers also call agent.start.
  if (!customHerdrSocket) await startCliSocket();
  return {
    root,
    env,
    rpc,
    notifications: rpc.notifications,
    call,
    onCleanup: (fn) => cleanups.push(fn),
    stopMcp,
    // Rename replaces the fixture symlink itself, never the shared executable it points to.
    overrideBin: (name, body) => writeFixtureFile(join(bin, name), body, { mode: 0o700 }),
    socketRequests,
    startCliSocket,
    piStatus: (get) => { piStatus = get; },
    push: (id, state) => { for (const client of subscribers) if (client.id === id) push(client, state); },
    // herdr's status changes but the push never arrives: only agent.get sees it.
    silent: (id, state) => { for (const client of subscribers) if (client.id === id) client.state = state; },
    drop: () => { for (const client of subscribers) client.socket.destroy(); },
    dropWorker: (id) => {
      const clients = [...subscribers].filter(client => client.id === id && !client.socket.destroyed);
      for (const client of clients) client.socket.destroy();
      return clients.length > 0;
    },
    emitTabClosed,
    exitAgent: (id, exit_code) => {
      const { pane_id, tab_id, launch_id, terminal_id } = launches.get(`${id}-primary`);
      for (const client of subscribers) client.socket.write(JSON.stringify({ event: 'pane.exited',
        data: { pane_id, tab_id, launch_id, terminal_id, exit_code } }) + '\n');
    },
    closeTab: (tab_id = 'w4E:t2') => { vanishedTabs.add(tab_id); emitTabClosed(tab_id); },
    commands: () => {
      if (!fs.existsSync(log)) return [];
      const text = fs.readFileSync(log, 'utf8');
      const end = text.lastIndexOf('\n');
      // A fake command may have created the log or started appending its next row.
      return end < 0 ? [] : text.slice(0, end).split('\n').map((line) => JSON.parse(line));
    },
  };
}

export function rpcClient(child) {
  let next = 0;
  const pending = new Map();
  const notifications = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    if (response.id === undefined) {
      notifications.push(response);
      return;
    }
    const callback = pending.get(response.id);
    if (callback) {
      pending.delete(response.id);
      callback(response);
    }
  });
  return Object.assign((method, params = {}) => new Promise((done) => {
    const id = ++next;
    pending.set(id, done);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }), { notifications });
}

export function workerClient(t, f, dir, askTimeout = '30') {
  const child = spawn(process.execPath, [entry], {
    cwd: f.root, env: { ...f.env, HUD_JOB_DIR: dir, HUD_ASK_TIMEOUT: askTimeout }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  const cleanup = async () => {
    const { forced, result } = await stopChild(child, exited, {
      closeStdin: true,
      graceMs: t.signal?.aborted ? 200 : 1500,
      killMs: 400,
    });
    if (!forced && !t.signal?.aborted) assert.deepEqual(result, [0, null]);
  };
  if (f.onCleanup) f.onCleanup(cleanup);
  else t.after(cleanup);
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

export { until };

// A parent can drive an input only once the MCP has subscribed to the job directory.
export const watchStatsProbe = `{
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const watch = fs.watch, statsFile = process.env.HOME + '/watch-stats.json';
  let opened = 0, closed = 0;
  const record = () => {
    const tmp = statsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ opened, closed, active: opened - closed }));
    fs.renameSync(tmp, statsFile);
  };
  fs.watch = function(...args) {
    const w = watch.apply(this, args);
    opened++;
    record();
    const close = w.close.bind(w);
    let done = false;
    w.close = function() {
      if (!done) { done = true; closed++; record(); }
      return close();
    };
    return w;
  };
  syncBuiltinESMExports();
}`;
export function watchStats(f) {
  const file = join(f.env.HOME, 'watch-stats.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { opened: 0, closed: 0, active: 0 };
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
  fs.writeFileSync(join(f.env.HOME, 'hold-sonic'), '');
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
    process.on('message', ({ command, args, detached }) => {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], detached });
      children.set(child.pid, detached);
      child.once('exit', () => children.delete(child.pid));
      process.send(child.pid);
    });
    process.on('disconnect', () => {
      for (const [pid, group] of children) { try { process.kill(group ? -pid : pid); } catch {} }
    });
  `], { env: f.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(worker, 'exit');
  const cleanup = async () => {
    if (worker.connected) {
      try { worker.disconnect(); } catch {}
    }
    await stopChild(worker, exited, { graceMs: 400, killMs: 200 });
  };
  if (f.onCleanup) f.onCleanup(cleanup);
  else t.after(cleanup);
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
    exit: async () => { worker.disconnect(); await exited; },
  };
}

export const statusQueries = (f, job) => f.socketRequests.filter((r) =>
  r.method === 'agent.get' && r.params.target === `${job.job}-primary`).length;

export const readCloseQuit = (f, job) => f.commands().some((c) =>
  c.command === 'herdr' && c.args[1] === 'prompt' && c.args[2] === job.agent && c.args[3] === '/quit');
export const readCloseReaped = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).reaped_at;
export const reapAttempts = (f, job) => f.commands().filter((c) => c.command === 'hud-reap' && c.args[0] === job.task_dir).length;
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

export async function publishPiGrace(t, job, worker, writeReport = true, session = {}) {
  const dir = job.task_dir;
  const report = join(dir, 'report.md');
  if (writeReport) writeFixtureFile(report, 'Synthetic settled pi report.\n');
  const now = Date.now();
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({
    version: 1, task_dir: dir, slot: 'primary', ...session, state: 'idle_grace', output_written: true,
    ...(worker ? { pid: worker.pid, pid_start_time: procStat(worker.pid).start } : {}),
    settled_at: new Date(now).toISOString(), idle_deadline_at: new Date(now + 30000).toISOString(),
  }));
  const mtime = fs.statSync(report).mtimeMs;
  await until(() => Date.now() > mtime, t.signal); // hud_read records integer milliseconds.
}

export async function publishLegacyPiGrace(t, job, worker, writeReport) {
  const file = join(job.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete receipt.resume_s;
  writeFixtureFile(file, JSON.stringify(receipt));
  return publishPiGrace(t, job, worker, writeReport);
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
export function assertCliStatus(status, dir, agent = 'grok') {
  for (const key of cliStatusKeys) assert.equal(Object.hasOwn(status, key), true, key);
  assert.equal(Object.hasOwn(status, 'session_id'), false);
  assert.equal(status.version, 1);
  assert.equal(status.slot, 'primary');
  assert.equal(status.harness, 'cli');
  assert.equal(status.agent, agent);
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
  try {
    return JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
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
  t.after(() => { server.closeAllConnections?.(); return new Promise((done) => server.close(done)); });
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

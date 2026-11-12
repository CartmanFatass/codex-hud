#!/usr/bin/env node
/** CLI/socket front end over the shared inventory; safe to import in unit tests. */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHerdr, herdrState, jsonReply, refused } from './herdr-model.mjs';
export { createHerdr, herdrState } from './herdr-model.mjs';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function load(file) {
  if (!file || !fs.existsSync(file)) return herdrState();
  return herdrState(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function persist(file, state) {
  if (!file) return;
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
/** Serialize fixture-owned read/transition/write, including delayed admitted effects.
 * A killed holder stays unresolved; only the owning fixture's cleanup removes its lock.
 */
async function lockState(file) {
  if (!file) return () => {};
  fs.mkdirSync(dirname(file), { recursive: true });
  const lock = file + '.lock',
    token = randomUUID(),
    until = performance.now() + 10000;
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(lock, 'utf8'));
    } catch {
      return null;
    }
  };
  while (performance.now() < until) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return () => {
        if (read()?.token === token) fs.unlinkSync(lock);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await pause(5);
    }
  }
  throw Error('state_lock_timeout');
}
function receiptReady(home) {
  try {
    return fs
      .readdirSync(join(home, 'jobs'))
      .some((n) => /^j[a-f0-9]{16}$/.test(n) && fs.existsSync(join(home, 'jobs', n, 'receipt.json')));
  } catch {
    return false;
  }
}
export async function roleCall(argv, env = process.env) {
  const command = argv.slice(0, 2).join(' '),
    mode = env.HERDR_FAKE_MODE ?? 'ok';
  if (env.HERDR_FAKE_LOG)
    fs.appendFileSync(
      env.HERDR_FAKE_LOG,
      JSON.stringify({
        argv,
        ...(command === 'tab create'
          ? { receipt_before: env.HERDR_FAKE_ASSERT_HOME ? receiptReady(env.HERDR_FAKE_ASSERT_HOME) : null }
          : {}),
      }) + '\n'
    );
  if (mode === 'hang') {
    await pause(20000);
    return { stdout: '', exit: 0 };
  }
  if (env.HERDR_FAKE_SCRIPTS && !env.HERDR_FAKE_STATE) return refused('scripts_require_state');
  const unlock = await lockState(env.HERDR_FAKE_STATE);
  let model;
  try {
    const state = load(env.HERDR_FAKE_STATE);
    const source = env.HERDR_FAKE_SCRIPTS;
    const scenario = source
      ? state.scenario?.source === source
        ? state.scenario
        : { source, remaining: JSON.parse(source) }
      : null;
    const supplied = new Set(scenario?.remaining ?? []);
    const scripts = [...supplied];
    // Legacy environment switches translate to per-call scripts, never a second state machine.
    if (command === 'tab create')
      scripts.push({
        command,
        delayMs: Number(env.HERDR_FAKE_DELAY_MS ?? 0),
        ...(mode === 'lose-create'
          ? { before: 'lost_reply' }
          : mode === 'lose-create-keep'
            ? { after: 'lost_reply' }
            : {}),
      });
    if (
      ['tab list', 'tab get', 'pane list', 'tab close'].includes(command) &&
      ['list-fail', 'close-unreadable'].includes(mode)
    )
      scripts.push({ command, before: 'tab_list_failed' });
    if (mode === 'close-missing' && ['tab get', 'tab close'].includes(command))
      scripts.push({ command, before: 'tab_not_found' });
    if (mode === 'fail-start' && command === 'agent start') scripts.push({ command, before: 'agent_start_failed' });
    if (
      mode === 'fail-prompt' &&
      command === 'agent prompt' &&
      !(argv[3] ?? '').startsWith('Read ') &&
      argv[3] !== '/quit'
    )
      scripts.push({ command, before: 'agent_blocked' });
    if (command === 'agent wait' && env.HERDR_FAKE_WAIT_SLEEP === 'timeout') {
      if (env.HERDR_FAKE_QA) {
        fs.mkdirSync(env.HERDR_FAKE_QA, { recursive: true });
        const file = join(env.HERDR_FAKE_QA, 'q1.md');
        if (!fs.existsSync(file)) fs.writeFileSync(file, 'Which file?\n');
      }
      const at = argv.indexOf('--timeout');
      await pause(at < 0 ? 0 : Number(argv[at + 1]) || 0);
    }
    model = createHerdr({ profile: 'role', state, scripts, save: (s) => persist(env.HERDR_FAKE_STATE, s) });
    const invocation = model.invoke(argv);
    if (scenario) {
      state.scenario = { source, remaining: model.remainingScripts.filter((s) => supplied.has(s)) };
      // Before-effect failures consume their script even though they change no inventory.
      persist(env.HERDR_FAKE_STATE, state);
    }
    const out = await invocation;
    if (command === 'tab create' && ['lose-create', 'lose-create-keep'].includes(mode)) return { stdout: '', exit: 0 };
    if (out.exit || !out.stdout) return out;
    const envelope = JSON.parse(out.stdout),
      result = envelope.result;
    if (command === 'tab list') {
      result.tabs =
        mode === 'close-missing'
          ? []
          : result.tabs.map((t) => ({
              ...t,
              agent_status: 'idle',
              focused: false,
              pane_count: mode === 'two-panes' ? 2 : 1,
            }));
      if (mode === 'dup-label') result.tabs = result.tabs.flatMap((t) => [t, { ...t, tab_id: t.tab_id + '-b' }]);
    }
    if (command === 'pane list') {
      if (mode === 'close-missing') result.panes = [];
      if (mode === 'two-panes') result.panes = result.panes.flatMap((p) => [p, { ...p, pane_id: p.pane_id + '-b' }]);
    }
    if (command === 'agent list')
      result.agents =
        mode === 'lose-create'
          ? []
          : [
              ...result.agents,
              { agent_status: 'working', pane_id: 'w0:p0', tab_id: 'w0:t0', workspace_id: 'w0', cwd: '/tmp/synthetic' },
            ];
    if (result.agent && env.HERDR_FAKE_STATUS) result.agent.agent_status = env.HERDR_FAKE_STATUS;
    return jsonReply(result, envelope.id);
  } finally {
    // Keep serialization until a deadline-lost operation has actually settled.
    if (model) void model.idle().then(unlock);
    else unlock();
  }
}
async function panelCall(argv, env) {
  if (env.PANEL_FAKE_LOG) {
    fs.appendFileSync(env.PANEL_FAKE_LOG, JSON.stringify(argv) + '\n');
    if (argv[0] === '--version') return { stdout: 'herdr 0.9.5\n', exit: 0 };
    if (argv[0] === 'api') return { stdout: fs.readFileSync(env.PANEL_FAKE_SCHEMA_FILE, 'utf8'), exit: 0 };
    if (argv[0] === 'pane' && argv[1] === 'run' && argv[2] === '--help')
      return { stdout: 'Run a command in a pane\nUsage: herdr pane run <PANE_ID> <COMMAND>...\n', exit: 0 };
    const state = load(env.PANEL_FAKE_LOG + '.state');
    if (!state.panes.length) {
      state.tabs.push({ tab_id: 'w4E:t1' });
      state.panes.push({ pane_id: 'w4E:p1', tab_id: 'w4E:t1', workspace_id: 'w4E' });
    }
    return createHerdr({ profile: 'panel', state, save: (s) => persist(env.PANEL_FAKE_LOG + '.state', s) }).invoke(
      argv
    );
  }
  const [log, operation, ...args] = argv;
  fs.appendFileSync(log, JSON.stringify({ operation, args }) + '\n');
  if (operation === 'leak') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    fs.writeFileSync(log + '.pid', String(child.pid));
    return { stdout: '', exit: 0 };
  }
  if (!['preflight', 'split', 'start', 'close'].includes(operation)) return refused('unknown_command');
  const state = load(log + '.state');
  if (!state.tabs.length) {
    state.tabs.push({ tab_id: 'w4E:t1' });
    state.panes.push({ pane_id: 'w4E:p1', tab_id: 'w4E:t1', workspace_id: 'w4E' });
  }
  const model = createHerdr({ profile: 'panel', state, save: (s) => persist(log + '.state', s) });
  if (operation === 'preflight') return { stdout: '{}', exit: 0 };
  if (operation === 'split') {
    const receipt = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    if (receipt.phase !== 'opening') return refused('intent_missing');
    state.receipts.push(receipt);
    const out = await model.invoke(['pane', 'split', 'w4E:p1', '--env', args[1] ?? '{}']);
    return out.exit ? out : { stdout: JSON.stringify({ pane: JSON.parse(out.stdout).result.pane.pane_id }), exit: 0 };
  }
  return model.invoke(['pane', operation === 'start' ? 'run' : 'close', ...args]);
}
function socketCall(argv, env) {
  return new Promise((resolve) => {
    const socket = net.createConnection(env.HERDR_SOCKET_PATH);
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify({ argv, cliPid: process.pid }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        resolve(JSON.parse(buffer.split('\n')[0]));
        socket.destroy();
      }
    });
    socket.on('error', () => {
      resolve(refused('socket_error'));
      socket.destroy();
    });
    socket.on('end', () => {
      if (!buffer.includes('\n')) resolve(refused('missing_reply'));
    });
  });
}
export async function runHerdr(profile = 'role', argv = process.argv.slice(2), env = process.env) {
  if (profile === 'owned' && argv[0] === '--server') {
    const { serveOwned } = await import('./herdr-owned.mjs');
    return serveOwned(argv.slice(1));
  }
  const reply =
    profile === 'owned'
      ? await socketCall(argv, env)
      : profile === 'panel'
        ? await panelCall(argv, env)
        : await roleCall(argv, env);
  process.stdout.write(reply.stdout ?? '');
  process.stderr.write(reply.stderr ?? '');
  process.exitCode = reply.exit ?? 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runHerdr();

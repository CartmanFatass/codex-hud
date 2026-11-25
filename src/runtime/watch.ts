/** The ready PID and handoff state live across scan-engine rebuilds via execve. */
import { watcherReady } from '../mcp/watch-pid.js';
import { writePrivateFile } from '../utils/atomic-fs.js';
import { binScript } from '../mcp/paths.js';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers';
import { buildStamp, publishGeneration } from '../../scripts/dist-lock.mjs';

type Runtime = ReturnType<typeof import('./watch-runtime.js').openRuntime>;
type Handoff = NonNullable<Awaited<ReturnType<Runtime['pause']>>>;
const RELOAD_ENV = 'HUD_WATCH_RELOAD';
const HANDOFF_FILE = 'watch-handoff.json';

const serializeHandoff = (state: Handoff) => JSON.stringify({
  version: 1,
  reapRetries: [...state.reapRetries].map(([id, r]) => [id, { ...r, at: Number.isFinite(r.at) ? r.at : null }]),
  preflightHold: [...state.preflightHold],
  worktreeRetries: [...state.worktreeRetries],
  summaryGeneration: state.summaryGeneration ?? 0,
});

function unlinkIfPresent(file: string): void {
  try { fs.unlinkSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function readHandoff(file: string): Handoff | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.version !== 1 || !Array.isArray(raw.reapRetries) || !Array.isArray(raw.preflightHold) || !Array.isArray(raw.worktreeRetries)) return null;
    const summaryGeneration = typeof raw.summaryGeneration === 'number' && Number.isSafeInteger(raw.summaryGeneration) && raw.summaryGeneration >= 0
      ? raw.summaryGeneration : 0;
    return {
      version: 1,
      reapRetries: new Map(raw.reapRetries.map(([id, r]: [string, Record<string, unknown>]) => [id, { ...r, at: r.at === null ? Infinity : Number(r.at) }])) as Handoff['reapRetries'],
      preflightHold: new Map(raw.preflightHold) as Handoff['preflightHold'],
      worktreeRetries: new Map(raw.worktreeRetries) as Handoff['worktreeRetries'],
      summaryGeneration,
    };
  } catch { return null; }
  finally { unlinkIfPresent(file); }
}

/** Open the watcher runtime and publish readiness under the wrapper's dist lock. */
export async function openWatcher() {
  const reloaded = process.env[RELOAD_ENV] === '1';
  delete process.env[RELOAD_ENV];
  const initialEnv = { ...process.env };
  const argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  const home = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
  const pidFile = join(home, 'watch.pid'), logFile = join(home, 'watch.log'), handoffFile = join(home, HANDOFF_FILE);
  const ownsPid = () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid);
  let stamp: string | null, buildWatch: fs.FSWatcher | undefined, switching: Promise<void> | undefined, probeAbort: AbortController | undefined;
  let stopping = false, reloading = false, socket: ReturnType<typeof createConnection> | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined, reconnectMs = 5000, warned = false;
  let runtime: Runtime;
  function log(message: string) {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); }
    catch (error) { console.error(`watch log: ${(error as Error).message}; ${message}`); }
  }
  function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const peer = socket;
    socket = undefined;
    peer?.destroy();
  }
  function subscribe() {
    if (socket || reconnectTimer || stopping || reloading) return;
    const path = process.env.HERDR_SOCKET_PATH;
    if (!path) { log('herdr events unavailable: HERDR_SOCKET_PATH unset; using file events only'); return; }
    const peer = socket = createConnection(path);
    const unavailable = (message: string) => {
      if (socket !== peer) return;
      disconnect();
      if (!warned) log(`herdr events unavailable: ${message}; using file events only until reconnect`);
      warned = true;
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; subscribe(); }, reconnectMs).unref();
      reconnectMs = Math.min(30000, reconnectMs * 2);
    };
    peer.on('connect', () => peer.write(JSON.stringify({ id: 'hud-watch', method: 'events.subscribe',
      params: { subscriptions: [{ type: 'tab.closed' }] } }) + '\n'));
    const lines = createInterface({ input: peer });
    lines.on('line', (line) => {
      if (socket !== peer) return;
      let event;
      try { event = JSON.parse(line); } catch { return unavailable('invalid JSON'); }
      if (event.error) return unavailable(event.error.message);
      if (event.id === 'hud-watch') { reconnectMs = 5000; warned = false; runtime.reconcileTabs(); }
      if (String(event.event ?? '').replace(/\./g, '_') === 'tab_closed' && typeof event.data?.tab_id === 'string')
        runtime.tab(event.data.tab_id);
    });
    lines.on('error', (error) => unavailable(error.message));
    peer.on('error', (error) => unavailable(error.message));
    peer.on('close', () => { lines.close(); unavailable('socket closed'); });
  }
  async function finish(reason: string) {
    if (stopping) return;
    stopping = true;
    probeAbort?.abort();
    buildWatch?.close();
    disconnect();
    await runtime.shutdown();
    await switching;
    if (ownsPid()) fs.unlinkSync(pidFile);
    log(`exit pid=${process.pid}: ${reason}`);
    if (reason.startsWith('signal=')) process.exit(0);
  }
  function event(type: string) {
    if (type === 'subscribe') subscribe();
    if (type === 'idle') void finish('no open jobs or failed deadlines');
  }
  function watchBuild(onChange: () => void) {
    // Successful builds replace or touch index.js. Watch its directory, not the replaced inode.
    try {
      buildWatch = fs.watch(new URL('../', import.meta.url), { persistent: false }, (_event, name) => {
        if (!name || name === 'index.js') onChange();
      }).on('error', error => log(`build watch unavailable: ${error.message}`));
    } catch (error) { log(`build watch unavailable: ${(error as Error).message}`); }
  }
  async function reload(seen: string | null, onChange: () => void) {
    const script = process.argv[1] || binScript('hud-watch');
    probeAbort = new AbortController();
    const probeErr = await new Promise<string | null>((done) => execFile(
      process.execPath, [script, '--probe'], { env: initialEnv, timeout: 20000, signal: probeAbort!.signal },
      (error, _stdout, stderr) => done(error ? (stderr.trim().split('\n').at(-1) || error.message) : null),
    ));
    probeAbort = undefined;
    if (stopping) return;
    if (probeErr) { log(`keeping previous build: ${probeErr}`); stamp = seen; return; }
    const state = await runtime.pause();
    if (!state || stopping) return;
    const execve = (process as typeof process & { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
    const env: NodeJS.ProcessEnv = { ...initialEnv, [RELOAD_ENV]: '1' };
    reloading = true;
    try {
      writePrivateFile(handoffFile, serializeHandoff(state), { mkdir: false });
      buildWatch?.close();
      disconnect();
      if (execve) execve(process.execPath, argv, env);
      // Fallback without process.execve: release watch.pid and hand off to a detached replacement.
      if (ownsPid()) fs.unlinkSync(pidFile);
      spawn(process.execPath, argv.slice(1), { detached: true, stdio: 'ignore', env }).unref();
      process.exit(0);
    } catch (error) {
      reloading = false;
      unlinkIfPresent(handoffFile);
      log(`keeping previous build: ${(error as Error).message}`);
      stamp = seen;
      if (!stopping) { watchBuild(onChange); runtime.start(state); subscribe(); }
    }
  }
  if (watcherReady(pidFile, binScript('hud-watch'))) process.exit(0);
  const { openRuntime } = await import('./watch-runtime.js');
  const state = reloaded ? readHandoff(handoffFile) : (unlinkIfPresent(handoffFile), null);
  runtime = openRuntime(event);
  stamp = buildStamp();
  if (!reloaded) {
    const oldLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    fs.writeFileSync(logFile, oldLog.split('\n').filter(Boolean).slice(-200).join('\n') + (oldLog ? '\n' : ''), { mode: 0o600 });
  }
  process.on('SIGTERM', () => void finish('signal=SIGTERM'));
  process.on('SIGINT', () => void finish('signal=SIGINT'));
  if (!reloaded || !ownsPid()) writePrivateFile(pidFile, `${process.pid}\n`, { mkdir: false });
  publishGeneration('watcher', stamp);
  if (process.connected) process.send?.('ready', () => {});
  log(`${reloaded ? 'reloaded' : 'start'} pid=${process.pid}`);
  return async () => {
    function checkBuild() {
      if (switching || stopping) return;
      const seen = buildStamp();
      if (seen && seen !== stamp) switching = reload(seen, checkBuild).finally(() => {
        switching = undefined;
        if (!stopping && buildStamp() !== seen) checkBuild(); // A second publish during reload.
      });
    }
    if (stopping) return;
    watchBuild(checkBuild);
    runtime.start(state);
    checkBuild();
  };
}

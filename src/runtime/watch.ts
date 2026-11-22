/** The ready PID and tab-closed subscription live through scan-engine rebuilds. */
import { watcherReady } from '../mcp/watch-pid.js';
import { writePrivateFile } from '../utils/atomic-fs.js';
import { binScript } from '../mcp/paths.js';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { buildStamp, withDistLock } from '../../scripts/dist-lock.mjs';
import { openGeneration, type Generation } from '../../packages/hud-mcp/bin/generation.mjs';

type Runtime = ReturnType<typeof import('./watch-runtime.js').openRuntime>;
const CLOSED_TABS_LIMIT = 512;
function rememberClosedTab(tabs: Set<string>, id: string): void {
  if (!id) return;
  tabs.delete(id);
  tabs.add(id);
  while (tabs.size > CLOSED_TABS_LIMIT) {
    const oldest = tabs.values().next().value;
    if (oldest === undefined) break;
    tabs.delete(oldest);
  }
}

/** Open the initial generation and publish readiness under the wrapper's dist lock. */
export async function openWatcher() {
  const home = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
  const pidFile = join(home, 'watch.pid'), logFile = join(home, 'watch.log');
  const runtime = new URL('./watch-runtime.js', import.meta.url);
  const closedTabs = new Set<string>();
  let current: Generation<Runtime>, stamp: string | null, buildWatch: fs.FSWatcher | undefined, switching: Promise<void> | undefined;
  let stopping = false, subscribed = false, socket: ReturnType<typeof createConnection>;
  function log(message: string) {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); }
    catch (error) { console.error(`watch log: ${(error as Error).message}; ${message}`); }
  }
  function subscribe() {
    if (subscribed || stopping) return;
    subscribed = true;
    let warned = false;
    const unavailable = (message: string) => {
      if (!warned && !stopping) log(`herdr events unavailable: ${message}; using file events only`);
      warned = true;
      socket?.destroy();
    };
    if (!process.env.HERDR_SOCKET_PATH) return unavailable('HERDR_SOCKET_PATH unset');
    socket = createConnection(process.env.HERDR_SOCKET_PATH);
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'hud-watch', method: 'events.subscribe',
      params: { subscriptions: [{ type: 'tab.closed' }] } }) + '\n'));
    const lines = createInterface({ input: socket });
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return unavailable('invalid JSON'); }
      if (event.error) return unavailable(event.error.message);
      if (String(event.event ?? '').replace(/\./g, '_') === 'tab_closed') {
        rememberClosedTab(closedTabs, event.data.tab_id);
        void current.call('tab', event.data.tab_id);
      }
    });
    lines.on('error', (error) => unavailable(error.message));
    socket.on('error', (error) => unavailable(error.message));
    socket.on('close', () => { lines.close(); unavailable('socket closed'); });
  }
  async function finish(reason: string) {
    if (stopping) return;
    stopping = true;
    buildWatch?.close();
    socket?.destroy();
    const active = current;
    await active.call('shutdown'); // A signal must still abort a reap while reload is draining it.
    await switching;
    if (current !== active) await current.call('shutdown');
    current.retire();
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
    log(`exit pid=${process.pid}: ${reason}`);
    if (reason.startsWith('signal=')) process.exit(0);
  }
  function event(type: string) {
    if (type === 'subscribe') subscribe();
    if (type === 'idle') void finish('no open jobs or failed deadlines');
  }
  async function reload(seen: string | null) {
    const old = current, state = await old.call('pause');
    if (!state || stopping) return;
    let next: Generation<Runtime> | undefined;
    try {
      next = await withDistLock(async () => {
        seen = buildStamp();
        return openGeneration<Runtime>(runtime, event);
      });
      if (stopping) { next.retire(); return; }
      current = next;
      await next.call('start', state, closedTabs);
      old.retire();
      log(`reloaded pid=${process.pid}`);
    } catch (error) {
      next?.retire();
      current = old;
      log(`keeping previous build: ${(error as Error).message}`);
      if (!stopping) await old.call('start', state, closedTabs);
    }
    stamp = seen;
  }
  if (watcherReady(pidFile, binScript('hud-watch'))) process.exit(0);
  current = await openGeneration<Runtime>(runtime, event, true);
  stamp = buildStamp();
  const oldLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  fs.writeFileSync(logFile, oldLog.split('\n').filter(Boolean).slice(-200).join('\n') + (oldLog ? '\n' : ''), { mode: 0o600 });
  process.on('SIGTERM', () => void finish('signal=SIGTERM'));
  process.on('SIGINT', () => void finish('signal=SIGINT'));
  writePrivateFile(pidFile, `${process.pid}\n`, { mkdir: false });
  if (process.connected) process.send?.('ready', () => {});
  log(`start pid=${process.pid}`);
  return async () => {
    function checkBuild() {
      if (switching || stopping) return;
      const seen = buildStamp();
      if (seen && seen !== stamp) switching = reload(seen).finally(() => {
        switching = undefined;
        if (!stopping && buildStamp() !== seen) checkBuild(); // A second publish during reload.
      });
    }
    if (stopping) return;
    // Successful builds replace or touch index.js. Watch its directory, not the replaced inode.
    try {
      buildWatch = fs.watch(new URL('../', import.meta.url), { persistent: false }, (_event, name) => {
        if (!name || name === 'index.js') checkBuild();
      }).on('error', error => log(`build watch unavailable: ${error.message}`));
    } catch (error) { log(`build watch unavailable: ${(error as Error).message}`); }
    await current.call('start', null, closedTabs);
    checkBuild();
  };
}

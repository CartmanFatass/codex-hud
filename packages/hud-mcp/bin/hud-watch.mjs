#!/usr/bin/env node
/** The ready PID and tab-closed subscription live through scan-engine rebuilds. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildStamp, withDistLock } from '../../../scripts/dist-lock.mjs';
import { openGeneration } from './generation.mjs';

const home = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
const pidFile = join(home, 'watch.pid'), logFile = join(home, 'watch.log');
const runtime = new URL('watch-runtime.mjs', import.meta.url);
const closedTabs = new Set();
let current, stamp, timer, switching, stopping, subscribed, socket;
function log(message) {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); }
  catch (error) { console.error(`watch log: ${error.message}; ${message}`); }
}
function subscribe() {
  if (subscribed || stopping) return;
  subscribed = true;
  let warned = false;
  const unavailable = (message) => {
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
      closedTabs.add(event.data.tab_id);
      void current.call('tab', event.data.tab_id);
    }
  });
  lines.on('error', (error) => unavailable(error.message));
  socket.on('error', (error) => unavailable(error.message));
  socket.on('close', () => { lines.close(); unavailable('socket closed'); });
}
async function finish(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
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
function event(type) {
  if (type === 'subscribe') subscribe();
  if (type === 'idle') void finish('no open jobs or failed deadlines');
}
async function reload(seen) {
  const old = current, state = await old.call('pause');
  if (!state || stopping) return;
  let next;
  try {
    await withDistLock(async () => {
      seen = buildStamp();
      next = await openGeneration(runtime, event);
    });
    if (stopping) { next.retire(); return; }
    current = next;
    await next.call('start', state, closedTabs);
    old.retire();
    log(`reloaded pid=${process.pid}`);
  } catch (error) {
    next?.retire();
    current = old;
    log(`keeping previous build: ${error.message}`);
    if (!stopping) await old.call('start', state, closedTabs);
  }
  stamp = seen;
}
await withDistLock(async () => {
  const [{ watcherReady }, { writePrivateFile }] = await Promise.all([
    import('../../../dist/mcp/watch-pid.js'), import('../../../dist/utils/atomic-fs.js'),
  ]);
  if (watcherReady(pidFile, fileURLToPath(import.meta.url))) process.exit(0);
  current = await openGeneration(runtime, event, true);
  stamp = buildStamp();
  const oldLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  fs.writeFileSync(logFile, oldLog.split('\n').filter(Boolean).slice(-200).join('\n') + (oldLog ? '\n' : ''), { mode: 0o600 });
  process.on('SIGTERM', () => void finish('signal=SIGTERM'));
  process.on('SIGINT', () => void finish('signal=SIGINT'));
  writePrivateFile(pidFile, `${process.pid}\n`, { mkdir: false });
  log(`start pid=${process.pid}`);
});
timer = setInterval(() => {
  if (switching || stopping) return;
  const seen = buildStamp();
  if (seen && seen !== stamp) switching = reload(seen).finally(() => { switching = undefined; });
}, 30000).unref();
if (!stopping) await current.call('start', null, closedTabs);

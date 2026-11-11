#!/usr/bin/env node
/** On-demand file-event reaper. Pi owns grace; pi-role-reap owns tab safety. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

const home = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
const jobs = join(home, 'jobs'),
  pidFile = join(home, 'watch.pid'),
  logFile = join(home, 'watch.log');
const retention = Number(process.env.HUD_WATCH_FAILED_RETENTION_MS ?? 7200000);
fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function json(file) {
  try {
    return JSON.parse(read(file) ?? 'null');
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
const oldLog = read(logFile) ?? '';
fs.writeFileSync(logFile, oldLog.split('\n').filter(Boolean).slice(-200).join('\n') + (oldLog ? '\n' : ''), {
  mode: 0o600,
});
const log = (message) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
log(`start pid=${process.pid}`);
let timer,
  socket,
  subscribed = false,
  queued = false,
  stopped = false;
const closedTabs = new Set();
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  let warned = false;
  const unavailable = (message) => {
    if (!warned && !stopped) log(`herdr events unavailable: ${message}; using file events only`);
    warned = true;
    socket?.destroy();
  };
  if (!process.env.HERDR_SOCKET_PATH) return unavailable('HERDR_SOCKET_PATH unset');
  socket = createConnection(process.env.HERDR_SOCKET_PATH);
  socket.on('connect', () => {
    socket.write(
      JSON.stringify({
        id: 'hud-watch',
        method: 'events.subscribe',
        params: { subscriptions: [{ type: 'tab.closed' }] },
      }) + '\n'
    );
  });
  const lines = createInterface({ input: socket });
  lines.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return unavailable('invalid JSON');
    }
    if (event.error) return unavailable(event.error.message);
    if (event.event === 'tab_closed') {
      closedTabs.add(event.data.tab_id);
      schedule();
    }
  });
  lines.on('error', (error) => unavailable(error.message));
  socket.on('error', (error) => unavailable(error.message));
  socket.on('close', () => {
    lines.close();
    unavailable('socket closed');
  });
}
function stop() {
  stopped = true;
  watcher.close();
  socket?.destroy();
  clearTimeout(timer);
  if (read(pidFile)?.trim() === String(process.pid)) fs.unlinkSync(pidFile);
  log(`exit pid=${process.pid}: no open jobs or failed deadlines`);
}
function scan() {
  if (stopped) return;
  queued = false;
  clearTimeout(timer);
  let open = false,
    nearest = Infinity;
  for (const id of fs.readdirSync(jobs)) {
    const dir = join(jobs, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const jobFile = join(dir, 'job.json'),
      job = json(jobFile);
    if (job?.reaped_at) continue;
    const statusFile = join(dir, 'STATUS.json');
    let status = json(statusFile);
    const session = read(join(dir, 'SESSION.txt'));
    const tab = session?.match(/^TAB=(.+)$/m)?.[1]?.trim();
    if (tab && closedTabs.has(tab) && !['closed', 'failed'].includes(status?.state)) {
      status = { ...status, state: 'failed', exit_reason: 'tab closed', ended_at: new Date().toISOString() };
      fs.writeFileSync(`${statusFile}.tmp`, JSON.stringify(status) + '\n', { mode: 0o600 });
      fs.renameSync(`${statusFile}.tmp`, statusFile);
    }
    // A persisted launch without STATUS is still open until dispatch returns.
    if (!status) {
      if (job && (job.dispatch_exit_code === null || job.dispatch_exit_code === 0)) open = true;
      continue;
    }
    if (status.state === 'idle_grace') {
      open = true;
      continue;
    }
    if (status.state === 'working' || status.state?.startsWith('waiting')) {
      open = true;
      continue;
    }
    if (!['closed', 'failed'].includes(status.state)) continue;
    if (!tab) continue;
    if (status.state === 'failed') {
      const ended = Date.parse(status.ended_at);
      const deadline = (Number.isFinite(ended) ? ended : fs.statSync(statusFile).mtimeMs) + retention;
      if (deadline > Date.now()) {
        nearest = Math.min(nearest, deadline);
        continue;
      }
    }
    const result = spawnSync('pi-role-reap', [dir], { encoding: 'utf8', timeout: 135000 });
    log(`reap ${id} state=${status.state} exit=${result.status ?? result.error?.message}`);
    if (result.status === 0 && job) {
      // Read again: hud_read/send/create may have updated the receipt during reap.
      const latest = json(jobFile);
      if (latest) {
        const temp = `${jobFile}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ ...latest, reaped_at: new Date().toISOString() }, null, 2) + '\n', {
          mode: 0o600,
        });
        fs.renameSync(temp, jobFile);
      }
    }
  }
  if (open) subscribe();
  if (nearest !== Infinity) timer = setTimeout(scan, Math.max(1, Math.ceil(nearest - Date.now())));
  else if (!open) stop();
}
function schedule() {
  if (!queued && !stopped) {
    queued = true;
    setImmediate(scan);
  }
}
// Watch before catch-up, so a STATUS rename during the initial scan is not missed.
const watcher = fs.watch(jobs, { recursive: true }, (_event, filename) => {
  const path = filename?.toString();
  if (!path || !path.includes('/') || /^[^/]+\/(STATUS\.json|SESSION\.txt|job\.json)$/.test(path)) schedule();
});
watcher.on('error', (error) => {
  log(`watch error: ${error.message}`);
  process.exitCode = 1;
  watcher.close();
  socket?.destroy();
  clearTimeout(timer);
});
scan();

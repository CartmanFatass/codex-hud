#!/usr/bin/env node
/** On-demand file-event reaper. Pi owns grace; pi-role-reap owns tab safety. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isQuotaFailure, recordFailureExhaustion } from '../dist/src/roles/roster.js';
import { workerAlive, readTurn, reportSignature } from '../dist/packages/hud-mcp/src/cli-judge.js';

const bundled = fileURLToPath(new URL('..', import.meta.url));

const home = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
const jobs = join(home, 'jobs'),
  pidFile = join(home, 'watch.pid'),
  logFile = join(home, 'watch.log');
const retention = Number(process.env.HUD_WATCH_FAILED_RETENTION_MS ?? 7200000);
const cliCheck = Number(process.env.HUD_WATCH_CLI_CHECK_MS ?? 30000);
fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
const cache = new Map();
const seen = new Set();
function read(file, parse = (text) => text) {
  try {
    const st = fs.statSync(file);
    seen.add(file);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.value;
    const value = parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { stamp, value });
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function json(file) {
  return read(file, (text) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  });
}
const oldLog = read(logFile) ?? '';
fs.writeFileSync(logFile, oldLog.split('\n').filter(Boolean).slice(-200).join('\n') + (oldLog ? '\n' : ''), {
  mode: 0o600,
});
const log = (message) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
const warnings = new Map();
function warn(kind, message) {
  const now = Date.now();
  if (now - (warnings.get(kind) ?? -Infinity) < 60000) return;
  warnings.set(kind, now);
  log(message);
}
fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
log(`start pid=${process.pid}`);
let watcher, timer,
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
  watcher?.close();
  socket?.destroy();
  clearTimeout(timer);
  if (read(pidFile)?.trim() === String(process.pid)) fs.unlinkSync(pidFile);
  log(`exit pid=${process.pid}: no open jobs or failed deadlines`);
}
function sessionFolders(dir) {
  const dispatch = join(dir, '.dispatch');
  return [join(dir, 'sessions'), ...(fs.existsSync(dispatch)
    ? fs.readdirSync(dispatch, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => join(dispatch, entry.name, 'sessions')) : [])]
    .filter((folder) => fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory());
}
function preserveSessions(dir) {
  try {
    for (const folder of sessionFolders(dir)) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const source = join(folder, entry.name);
        const fd = fs.openSync(source, 'r'), buffer = Buffer.alloc(1024 * 1024);
        let cwd;
        try { cwd = JSON.parse(buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n', 1)[0]).cwd; }
        finally { fs.closeSync(fd); }
        if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw Error('session cwd missing or invalid');
        const store = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
          'sessions', `--${cwd.slice(1).replace(/[/\\:]/g, '-')}--`);
        fs.mkdirSync(store, { recursive: true, mode: 0o700 });
        const target = join(store, entry.name);
        if (fs.lstatSync(target, { throwIfNoEntry: false })) throw Error('session target exists');
        fs.renameSync(source, target);
      }
    }
    return true;
  } catch (error) {
    warn(`keep ${dir} session preservation`, `keep ${dir.split('/').at(-1)} session preservation: ${error.message}`);
    return false;
  }
}
function supervisorPid(dir, status) {
  const fromFile = Number(read(join(dir, 'supervisor.pid'))?.trim());
  if (Number.isInteger(fromFile) && fromFile > 1) return fromFile;
  return Number.isInteger(status?.supervisor_pid) && status.supervisor_pid > 1 ? status.supervisor_pid : null;
}
function supervisorAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
function scan(retryWatch = false) {
  if (stopped) return;
  queued = false;
  clearTimeout(timer);
  if (retryWatch && !watcher) startWatch(); // Install before catch-up, only on the timer path.
  seen.clear();
  let open = false,
    cliPoll = false,
    nearest = Infinity;
  for (const id of fs.readdirSync(jobs)) {
    if (!/^j[a-f0-9]{16}$/.test(id)) continue;
    const dir = join(jobs, id);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      try {
        const loops = sessionFolders(dir).flatMap((folder) => fs.readdirSync(folder, { withFileTypes: true })
          .filter((entry) => entry.isSymbolicLink() && entry.name.endsWith('.jsonl'))
          .map((entry) => join(folder, entry.name)))
          .filter((link) => {
            try { fs.statSync(link); } catch (error) { return error.code === 'ELOOP'; }
            return false;
          });
        for (const link of loops) { fs.unlinkSync(link); log(`unlink loop ${link}`); }
      } catch (error) { warn(`keep ${id} scan`, `keep ${id} scan: ${error.message}`); }
      const jobFile = join(dir, 'job.json'), statusFile = join(dir, 'STATUS.json');
      let job, status, session;
      try { job = json(jobFile); status = json(statusFile); session = read(join(dir, 'SESSION.txt')); }
      // Unreadable lifecycle or tab evidence may still belong to an open job.
      catch (error) { if (error.code !== 'ENOENT') open = true; throw error; }
      const tab = session?.match(/^TAB=([^\r\n]+)$/m)?.[1];
      if (tab && closedTabs.has(tab) && !['closed', 'failed', 'stopped'].includes(status?.state)) {
        status = { ...status, state: 'failed', exit_reason: 'tab closed', ended_at: new Date().toISOString() };
        fs.writeFileSync(`${statusFile}.${process.pid}.tmp`, JSON.stringify(status) + '\n', { mode: 0o600 });
        fs.renameSync(`${statusFile}.${process.pid}.tmp`, statusFile);
      }
      if (job?.cli && status && !['closed', 'failed', 'stopped'].includes(status.state)) {
        cliPoll = true;
        const pid = supervisorPid(dir, status);
        if (pid && !supervisorAlive(pid)) {
          const alive = workerAlive(status.pid, status.pid_start_time);
          const reason = alive === false ? 'worker exited' : alive === true ? 'supervisor exited; worker still running' : 'supervisor exited; worker liveness unknown';
          const sig = reportSignature(dir), turn = readTurn(dir);
          const report = sig !== null && sig !== turn?.report_sig;
          const state = alive === false ? (report ? 'closed' : 'failed') : 'waiting_orchestrator';
          if (status.state !== state || status.reason !== (alive === false ? null : reason)) {
            status = {
              ...status, state, blocked: false, reason: alive === false ? null : reason,
              exit_reason: alive === false ? (report ? 'settled' : reason) : null,
              error: state === 'failed' ? reason : null,
              output_written: alive === false ? report : status.output_written,
              ended_at: alive === false ? new Date().toISOString() : null,
            };
            fs.writeFileSync(`${statusFile}.${process.pid}.tmp`, JSON.stringify(status) + '\n', { mode: 0o600 });
            fs.renameSync(`${statusFile}.${process.pid}.tmp`, statusFile);
          }
        }
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
      if (!['closed', 'failed', 'stopped'].includes(status.state)) continue;
      if (status.state === 'failed' && job && !job.exhaustion_marked) {
        const text = String(status.exit_reason ?? status.error ?? '');
        if (isQuotaFailure(text)) {
          const res = recordFailureExhaustion(home, bundled, dir, job, text);
          if (res.marked && res.reason !== text) {
            status = { ...status, exit_reason: res.reason, error: res.reason };
            fs.writeFileSync(`${statusFile}.${process.pid}.tmp`, JSON.stringify(status) + '\n', { mode: 0o600 });
            fs.renameSync(`${statusFile}.${process.pid}.tmp`, statusFile);
          }
        }
      }
      const ended = Date.parse(job?.reaped_at ?? status.settled_at ?? status.ended_at);
      const expires = (Number.isFinite(ended) ? ended : fs.statSync(statusFile).mtimeMs) + 86400000;
      if (expires < Date.now() && (!tab || job?.reaped_at)) {
        // Pi sessions live in the job dir. CLI and browser keep theirs in their own default place.
        if (!(job?.cli || job?.bro || job?.jev) && !preserveSessions(dir)) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        log(`delete ${id} state=${status.state}`);
        continue;
      }
      if (job?.reaped_at || !tab) continue;
      if (status.state === 'failed') {
        const ended = Date.parse(status.ended_at);
        const deadline = (Number.isFinite(ended) ? ended : fs.statSync(statusFile).mtimeMs) + retention;
        if (deadline > Date.now()) {
          nearest = Math.min(nearest, deadline);
          continue;
        }
      }
      const result = spawnSync('pi-role-reap', [dir], { encoding: 'utf8', timeout: 135000 });
      const message = `reap ${id} state=${status.state} exit=${result.status ?? result.error?.message}`;
      if (result.status === 0) log(message);
      else warn(`reap ${id}`, message);
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
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`keep ${id} scan`, `keep ${id} scan: ${error.message}`);
    }
  }
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
  if (open) subscribe();
  // A dead supervisor is rare; a slow check keeps the watcher light while CLI jobs are open.
  if (cliPoll) nearest = Math.min(nearest, Date.now() + cliCheck);
  if ((open || nearest !== Infinity) && !watcher) nearest = Math.min(nearest, Date.now() + 1000);
  if (nearest !== Infinity) timer = setTimeout(() => scan(true), Math.max(1, Math.ceil(nearest - Date.now())));
  else if (!open) stop();
}
function schedule() {
  if (!queued && !stopped) {
    queued = true;
    setImmediate(scan);
  }
}
// Watch before catch-up, so a STATUS rename during the initial scan is not missed.
function startWatch() {
  try {
    watcher = fs.watch(jobs, { recursive: true }, (_event, filename) => {
      const path = filename?.toString();
      if (!path || !path.includes('/') || /^[^/]+\/(STATUS\.json|SESSION\.txt|job\.json)$/.test(path)) schedule();
    }).on('error', (error) => {
      warn('watch error', `watch error: ${error.message}`);
      watcher?.close(); watcher = undefined;
      clearTimeout(timer);
      timer = setTimeout(() => scan(true), 1000);
    });
  } catch (error) { warn('watch error', `watch error: ${error.message}`); }
}
startWatch();
scan();

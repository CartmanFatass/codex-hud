#!/usr/bin/env node
/** One CLI job. Blocking `herdr agent wait` calls drive STATUS.json. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isQuotaFailure, recordFailureExhaustion } from '../dist/src/roles/roster.js';

const dir = fs.realpathSync(process.argv[2]);
const bundled = fileURLToPath(new URL('..', import.meta.url));
const hudHome = dirname(dirname(dir));
const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
const session = Object.fromEntries(
  fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').split('\n').flatMap((line) => {
    const at = line.indexOf('=');
    return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
  })
);
const name = session.PRIMARY;
const pane = session.LEFT;
const cli = job.cli;
const output = join(dir, 'report.md');
const graceMs = (cli.idle_grace_s ?? 600) * 1000;
const started = new Date().toISOString();
fs.writeFileSync(join(dir, 'supervisor.pid'), `${process.pid}\n`, { mode: 0o600 });

function herdr(args, killAfter = 20000) {
  const ran = spawnSync('herdr', args, { encoding: 'utf8', timeout: killAfter });
  let body = null;
  try {
    body = JSON.parse(ran.stdout);
  } catch {
    /* A timeout has no result body. */
  }
  return { code: ran.status ?? 1, body, timedOut: ran.error?.code === 'ETIMEDOUT' };
}
/** `agent wait` resolves as wait_matched; the status is on the pane event. */
function statusOf(ran) {
  return ran.body?.result?.event?.data?.agent_status ?? ran.body?.result?.agent?.agent_status ?? null;
}
function startTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(start ?? '') ? start : null;
  } catch {
    return null;
  }
}
function identity() {
  const info = herdr(['pane', 'process-info', '--pane', pane]).body?.result?.process_info;
  const proc = info?.foreground_processes?.find((item) => item.pid && item.pid !== info.shell_pid);
  const pid = proc?.pid ?? null;
  return { pid, pid_start_time: pid ? startTime(pid) : null };
}
function sessionId() {
  const ref = herdr(['agent', 'get', name]).body?.result?.agent?.agent_session;
  return ref?.kind === 'id' && typeof ref.value === 'string' ? ref.value : null;
}
/** agy and codex publish the id only after the first prompt; a later get must not wipe a known id. */
function refreshSession() {
  const id = sessionId();
  if (id) current = { ...current, agent_session_id: id };
}
function report() {
  try {
    return fs.readFileSync(output, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
let current = {
  version: 1,
  task_dir: dir,
  slot: 'primary',
  harness: 'cli',
  agent: cli.agent,
  role: job.role,
  model: job.model ?? null,
  thinking: job.thinking ?? null,
  state: 'working',
  output_path: output,
  output_written: false,
  pid: null,
  pid_start_time: null,
  agent_session_id: null,
  started_at: started,
  settled_at: null,
  idle_deadline_at: null,
  ended_at: null,
  exit_reason: null,
  error: null,
  updated_at: started,
  supervisor_pid: process.pid,
};
const stopFile = join(dir, 'STATUS.json.stop-requested');
const closeFile = join(dir, 'STATUS.json.close-requested');
const stopped = () => fs.existsSync(stopFile);
const closing = () => fs.existsSync(closeFile);
/** Exit emits idle, then the agent is released. A slice kills a wait that never returns.
 * idle/unknown alone is not an exit: agy's idle is herdr's fallback, and a transcript viewer is unknown. */
const sliceMs = 15000;
const quiet = (status) => status === 'idle' || status === 'unknown';
function agentMissing() {
  const got = herdr(['agent', 'get', name]);
  return got.code !== 0 || JSON.stringify(got.body ?? '').includes('agent_not_found');
}
function watcherSettled() {
  try {
    const existing = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8'));
    if (existing.exit_reason === 'tab closed' || existing.exit_reason === 'supervisor exited') return existing;
  } catch {
    /* First write, or the dir is already gone. */
  }
  return null;
}
function write(patch) {
  const settled = watcherSettled();
  if (settled) {
    current = settled;
    return false;
  }
  current = { ...current, ...patch, updated_at: new Date().toISOString() };
  const file = join(dir, 'STATUS.json');
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(current) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  return true;
}
function quit() {
  if (agentMissing()) return;
  herdr(['agent', 'prompt', name, '/quit']);
  herdr(['agent', 'wait', name, '--until', 'idle', '--until', 'unknown', '--timeout', '15000'], 20000);
}
function finish(state, reason, outputWritten = current.output_written) {
  refreshSession();
  const now = new Date().toISOString();
  write({
    state,
    exit_reason: reason,
    error: state === 'failed' ? reason : null,
    ended_at: now,
    settled_at: current.settled_at ?? now,
    output_written: outputWritten,
  });
}
function enrichFailure(reason) {
  let detail = reason;
  if (!isQuotaFailure(detail)) {
    const text = herdr(['pane', 'read', pane, '--source', 'recent']).body?.result?.read?.text;
    const hit = typeof text === 'string'
      ? text.split(/\r?\n/).reverse().find((line) => isQuotaFailure(line))
      : null;
    if (hit) detail = `${detail}: ${hit.trim()}`;
  }
  return recordFailureExhaustion(hudHome, bundled, dir, job, detail).reason;
}
function fail(reason) {
  refreshSession();
  quit();
  finish('failed', enrichFailure(reason), false);
  process.exitCode = 1;
}
function closeSettled() {
  refreshSession();
  quit();
  finish('closed', 'settled', true);
}
let blockedEpisode = false;
function rememberUnblocked() {
  blockedEpisode = false;
  current = { ...current, blocked: false };
}
function notifyBlocked() {
  const orch = session.ORCH;
  if (!orch || /[\u0000-\u001f\u007f-\u009f]/.test(orch)) return;
  const tag = `${job.role}@${basename(String(job.cwd || dir))}`;
  herdr(['agent', 'prompt', orch, `[${tag}] BLOCKED: ${cli.agent} is waiting for interactive input in pane ${pane}`]);
}
function leave() {
  if (watcherSettled()) return;
  if (blockedEpisode) rememberUnblocked();
  if (stopped()) finish('stopped', 'stop requested');
  else if (closing()) closeSettled();
  else {
    finish('failed', enrichFailure('agent exited'), false);
    process.exitCode = 1;
  }
}

try {
  let baseline = report();
  refreshSession();
  write({ ...identity(), state: 'working' });
  let skipQuiet = false;
  for (;;) {
    if (watcherSettled() || stopped()) {
      if (stopped()) leave();
      break;
    }
    const until = ['--until', 'done', '--until', 'blocked'];
    if (!skipQuiet) until.push('--until', 'idle', '--until', 'unknown');
    skipQuiet = false;
    const waited = herdr(['agent', 'wait', name, ...until, '--timeout', String(sliceMs)], sliceMs + 5000);
    if (watcherSettled()) break;
    if (waited.code !== 0) {
      if (agentMissing() || stopped() || closing()) {
        leave();
        break;
      }
      continue;
    }
    const state = statusOf(waited);
    if (quiet(state)) {
      if (agentMissing()) {
        leave();
        break;
      }
      skipQuiet = true;
      continue;
    }
    let turn = state;
    if (state === 'blocked') {
      if (!blockedEpisode) {
        if (!write({ state: 'waiting_orchestrator', blocked: true })) break;
        notifyBlocked();
        blockedEpisode = true;
      }
      let skipResumeQuiet = false;
      let next = null;
      for (;;) {
        const resumeUntil = ['--until', 'working', '--until', 'done'];
        if (!skipResumeQuiet) resumeUntil.push('--until', 'idle', '--until', 'unknown');
        skipResumeQuiet = false;
        const resumed = herdr(['agent', 'wait', name, ...resumeUntil, '--timeout', String(sliceMs)], sliceMs + 5000);
        if (watcherSettled()) break;
        if (resumed.code !== 0) {
          if (agentMissing() || stopped() || closing()) {
            leave();
            next = 'left';
            break;
          }
          continue;
        }
        next = statusOf(resumed);
        if (quiet(next)) {
          if (agentMissing()) {
            rememberUnblocked();
            leave();
            next = 'left';
            break;
          }
          skipResumeQuiet = true;
          continue;
        }
        break;
      }
      if (next === 'left' || watcherSettled()) break;
      if (next === 'working') {
        rememberUnblocked();
        refreshSession();
        if (!write({ state: 'working', blocked: false })) break;
        continue;
      }
      if (next !== 'done') continue;
      rememberUnblocked();
      turn = 'done';
    }
    if (turn !== 'done') {
      leave();
      break;
    }
    const text = report();
    if (typeof text !== 'string' || !text.trim() || text === baseline) {
      fail('output missing, empty or unchanged');
      break;
    }
    if (!cli.can_continue) {
      closeSettled();
      break;
    }
    const deadline = Date.now() + graceMs;
    const now = new Date().toISOString();
    refreshSession();
    if (!write({
      state: 'idle_grace',
      output_written: true,
      settled_at: now,
      idle_deadline_at: new Date(deadline).toISOString(),
      ended_at: null,
      exit_reason: null,
      error: null,
    })) break;
    let grace = 'wait';
    let skipGraceQuiet = false;
    let gracePass = 0;
    while (grace === 'wait' && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = gracePass === 0 ? graceMs : remaining;
      gracePass += 1;
      const graceUntil = ['--until', 'working'];
      if (!skipGraceQuiet) graceUntil.push('--until', 'idle', '--until', 'unknown');
      skipGraceQuiet = false;
      const continued = herdr(['agent', 'wait', name, ...graceUntil, '--timeout', String(timeout)], timeout + 5000);
      if (watcherSettled()) break;
      if (continued.code === 0 && statusOf(continued) === 'working') {
        grace = 'resume';
        break;
      }
      if (continued.code === 0 && quiet(statusOf(continued)) && !agentMissing()) {
        skipGraceQuiet = true;
        continue;
      }
      if (continued.code === 0 || agentMissing() || stopped() || closing()) {
        leave();
        grace = 'left';
        break;
      }
      closeSettled();
      grace = 'closed';
      break;
    }
    if (grace === 'resume') {
      baseline = report();
      refreshSession();
      if (!write({ state: 'working', output_written: false, settled_at: null, idle_deadline_at: null, ended_at: null, exit_reason: null, error: null })) break;
      continue;
    }
    if (grace === 'wait' && !watcherSettled()) closeSettled();
    break;
  }
} catch (error) {
  try {
    finish('failed', String(error.message ?? error).replace(/[\r\n]+/g, ' '), false);
  } catch {
    /* The job dir may already be gone. */
  }
  process.exitCode = 1;
}

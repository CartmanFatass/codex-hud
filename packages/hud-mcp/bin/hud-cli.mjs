#!/usr/bin/env node
/** One CLI job. Blocking `herdr agent wait` calls drive STATUS.json. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isQuotaFailure, recordFailureExhaustion } from '../dist/src/roles/roster.js';
import { decideQuietJob, extractFailureScreenLine } from '../dist/packages/hud-mcp/src/quiet-decision.js';

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
function procStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const start = fields[19];
    return /^\d+$/.test(start ?? '') ? { state: fields[0], ppid: Number(fields[1]), start } : null;
  } catch {
    return null;
  }
}
function startTime(pid) {
  return procStat(pid)?.start ?? null;
}
function descendants(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return new Map();
  if (current.pid_start_time && startTime(rootPid) !== current.pid_start_time) return new Map();
  const children = new Map(), starts = new Map();
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry), info = procStat(pid);
      if (!info || info.state === 'Z' || !Number.isInteger(info.ppid)) continue;
      starts.set(pid, info.start);
      const list = children.get(info.ppid) ?? [];
      list.push(pid);
      children.set(info.ppid, list);
    }
  } catch {
    return new Map();
  }
  const found = new Map(), queue = [...(children.get(rootPid) ?? [])];
  while (queue.length) {
    const pid = queue.shift();
    if (found.has(pid)) continue;
    found.set(pid, starts.get(pid));
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return found;
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
let baseline = null;
const hasReport = () => {
  const text = report();
  return typeof text === 'string' && text.trim().length > 0 && text !== baseline;
};
let herdrMisses = 0;
function pidAlive() {
  if (!Number.isInteger(current.pid) || current.pid <= 0) return null;
  const info = procStat(current.pid);
  return info !== null && info.state !== 'Z' && info.start === current.pid_start_time;
}
function herdrMissing() {
  const got = herdr(['agent', 'get', name]);
  return got.code !== 0 || JSON.stringify(got.body ?? '').includes('agent_not_found');
}
function agentExited() {
  const alive = pidAlive();
  if (alive === true) {
    herdrMisses = 0;
    return false;
  }
  if (alive === false) return true;
  herdrMisses = herdrMissing() ? herdrMisses + 1 : 0;
  return herdrMisses >= 3;
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
  if (pidAlive() === false || (current.pid === null && herdrMissing())) return;
  herdr(['agent', 'prompt', name, '/quit']);
  herdr(['agent', 'wait', name, '--until', 'idle', '--until', 'unknown', '--timeout', '15000'], 20000);
}
function finish(state, reason, outputWritten = current.output_written) {
  refreshSession();
  const now = new Date().toISOString();
  write({
    state,
    blocked: false,
    reason: null,
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
function notify(text) {
  const orch = session.ORCH;
  if (!orch || /[\u0000-\u001f\u007f-\u009f]/.test(orch)) return;
  const tag = `${job.role}@${basename(String(job.cwd || dir))}`;
  herdr(['agent', 'prompt', orch, `[${tag}] ${text}`]);
}
function leave() {
  if (watcherSettled()) return;
  if (blockedEpisode) rememberUnblocked();
  if (stopped()) finish('stopped', 'stop requested');
  else if (closing()) closeSettled();
  else if (hasReport()) finish('closed', 'settled', true);
  else {
    finish('failed', enrichFailure('agent exited'), false);
    process.exitCode = 1;
  }
}

try {
  baseline = report();
  const hasNewDescendant = (since) => {
    for (const [pid, start] of descendants(current.pid)) if (since.get(pid) !== start) return true;
    return false;
  };
  const canSettle = () => hasReport() && turnEnded && !hasNewDescendant(turnDescendants);
  refreshSession();
  write({ ...identity(), state: 'working', reason: null });
  let turnDescendants = descendants(current.pid);
  let turnEnded = false;
  let quietSince = null;
  let quietNoticed = false;
  let skipQuiet = false;
  let quietQuestions = 0;
  let reportPromptSent = false;
  const escalateQuiet = (quietDecision) => {
    if (!write({ state: 'waiting_orchestrator', blocked: false, reason: 'quiet without a report; hud_send to continue or hud_close to stop', quiet_decision: quietDecision })) return false;
    notify('quiet without a report; hud_send to continue or hud_close to stop');
    quietNoticed = true;
    return true;
  };
  const pollMs = graceMs < 5000 ? Math.max(50, Math.min(200, graceMs || 50)) : 5000;
  for (;;) {
    if (watcherSettled() || stopped() || closing()) {
      if (stopped() || closing()) leave();
      break;
    }
    if (!canSettle()) {
      let timeout = graceMs < 5000 ? Math.min(sliceMs, 500) : sliceMs;
      const reportWritten = hasReport();
      if (turnEnded) {
        const busy = hasNewDescendant(turnDescendants);
        if (busy) quietSince = null;
        else if (!reportWritten) quietSince ??= Date.now();
        else quietSince = null;
        const remaining = reportWritten || busy ? Infinity : quietSince + graceMs - Date.now();
        if (!reportWritten && remaining <= 0) {
          if (!quietNoticed) {
            const paneRead = herdr(['pane', 'read', pane, '--source', 'recent']).body?.result?.read?.text;
            const paneText = typeof paneRead === 'string' ? paneRead : '';
            const minutesQuiet = Math.max(0, Math.round((Date.now() - quietSince) / 60000));
            const decision =
              quietQuestions >= 3
                ? { choice: null, probability: null, action: 'needs-human', reason: 'max-questions', asked: false }
                : await decideQuietJob({
                    hudHome,
                    jobId: job.job,
                    role: job.role,
                    agent: cli.agent,
                    jobState: current.state,
                    backgroundChildAlive: hasNewDescendant(turnDescendants),
                    minutesQuiet,
                    paneText,
                    reportPromptSent,
                    questionIndex: quietQuestions + 1,
                  });
            if (decision.asked) quietQuestions += 1;
            if (watcherSettled() || stopped() || closing()) {
              if (stopped() || closing()) leave();
              break;
            }
            if (hasReport()) continue;
            const quietDecision = {
              choice: decision.choice,
              probability: decision.probability,
              action: decision.action,
              ...(decision.reason ? { reason: decision.reason } : {}),
              at: new Date().toISOString(),
            };
            if (decision.action === 'wait') {
              quietSince = Date.now();
              if (!write({ state: 'working', blocked: false, reason: 'turn ended, no report yet', quiet_decision: quietDecision })) break;
              timeout = Math.min(graceMs || 1, graceMs < 5000 ? pollMs : 5000);
            } else if (decision.action === 'prompt-report') {
              reportPromptSent = true;
              const prompt = `Write your report to ${output} now; if work remains, finish it first.`;
              const sent = herdr(['agent', 'prompt', name, prompt]);
              if (sent.code !== 0) {
                if (agentExited()) {
                  leave();
                  break;
                }
                if (!escalateQuiet({ ...quietDecision, action: 'needs-human', reason: 'prompt-failed' })) break;
              } else {
                turnDescendants = descendants(current.pid);
                turnEnded = false;
                quietSince = null;
                quietNoticed = false;
                skipQuiet = false;
                if (!write({ state: 'working', blocked: false, reason: null, quiet_decision: quietDecision })) break;
                continue;
              }
            } else if (decision.action === 'fail') {
              const reason = recordFailureExhaustion(
                hudHome,
                bundled,
                dir,
                job,
                decision.failReason || extractFailureScreenLine(paneText)
              ).reason;
              if (!write({ quiet_decision: quietDecision })) break;
              finish('failed', reason, false);
              process.exitCode = 1;
              break;
            } else {
              if (!escalateQuiet(quietDecision)) break;
            }
          }
          if (quietNoticed) timeout = graceMs < 5000 ? pollMs : sliceMs;
        } else {
          const expectedReason = reportWritten ? null : 'turn ended, no report yet';
          if (current.state !== 'working' || current.blocked || current.reason !== expectedReason) {
            if (!write({ state: 'working', blocked: false, reason: expectedReason })) break;
          }
          timeout = Math.min(remaining, graceMs < 5000 ? pollMs : busy ? 2000 : 5000);
        }
      }
      const until = ['--until', turnEnded ? 'working' : 'done', '--until', 'blocked'];
      if (!skipQuiet) until.push('--until', 'idle', '--until', 'unknown');
      skipQuiet = false;
      const waited = herdr(['agent', 'wait', name, ...until, '--timeout', String(timeout)], timeout + 5000);
      if (watcherSettled()) break;
      if (waited.code !== 0) {
        if (agentExited() || stopped() || closing()) {
          leave();
          break;
        }
        continue;
      }
      const state = statusOf(waited);
      if (quiet(state)) {
        if (stopped() || closing() || agentExited()) {
          leave();
          break;
        }
        skipQuiet = true;
        continue;
      }
      if (state === 'working') {
        turnEnded = false;
        quietSince = null;
        quietNoticed = false;
        refreshSession();
        if (!write({ state: 'working', blocked: false, reason: null })) break;
        continue;
      }
      let turn = state;
      if (state === 'blocked') {
        if (!blockedEpisode) {
          if (!write({ state: 'waiting_orchestrator', blocked: true, reason: null })) break;
          notify(`BLOCKED: ${cli.agent} is waiting for interactive input in pane ${pane}`);
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
            if (agentExited() || stopped() || closing()) {
              leave();
              next = 'left';
              break;
            }
            continue;
          }
          next = statusOf(resumed);
          if (quiet(next)) {
            if (stopped() || closing() || agentExited()) {
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
          turnEnded = false;
          quietSince = null;
          quietNoticed = false;
          refreshSession();
          if (!write({ state: 'working', blocked: false, reason: null })) break;
          continue;
        }
        if (next !== 'done') continue;
        rememberUnblocked();
        turn = 'done';
      }
      if (turn === 'done') {
        refreshSession();
        turnEnded = true;
      }
      continue;
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
      blocked: false,
      reason: null,
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
    const graceBusyPoll = graceMs < 5000 ? pollMs : 2000;
    while (grace === 'wait' && (Date.now() < deadline || hasNewDescendant(turnDescendants))) {
      const busy = hasNewDescendant(turnDescendants);
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = busy
        ? Date.now() < deadline
          ? Math.min(remaining, graceBusyPoll)
          : graceBusyPoll
        : gracePass === 0
          ? graceMs
          : remaining;
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
      if (continued.code === 0 && quiet(statusOf(continued)) && !stopped() && !closing() && !agentExited()) {
        skipGraceQuiet = true;
        continue;
      }
      if (continued.code === 0 || agentExited() || stopped() || closing()) {
        leave();
        grace = 'left';
        break;
      }
      if (hasNewDescendant(turnDescendants) || (busy && Date.now() < deadline)) continue;
      closeSettled();
      grace = 'closed';
      break;
    }
    if (grace === 'resume') {
      baseline = report();
      refreshSession();
      if (!write({ state: 'working', blocked: false, reason: null, output_written: false, settled_at: null, idle_deadline_at: null, ended_at: null, exit_reason: null, error: null })) break;
      turnDescendants = descendants(current.pid);
      turnEnded = false;
      quietSince = null;
      quietNoticed = false;
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

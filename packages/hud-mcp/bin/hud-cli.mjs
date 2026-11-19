#!/usr/bin/env node
/** One CLI job: pushed facts -> pure judge -> effects. No subprocesses or STATUS writes at rest. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { recordFailureExhaustion } from '../dist/src/roles/roster.js';
import { decideQuietJob } from '../dist/packages/hud-mcp/src/quiet-decision.js';
import { firstInput, judge, procStat, terminalFact, workerAlive, workerHasChild, readTurn, reportMarker, reportSignature, writeTurn } from '../dist/packages/hud-mcp/src/cli-judge.js';
import { rememberWorkerTree } from '../dist/src/roles/worker-tree.js';
import { reportWasRead } from '../dist/src/collectors/thin-jobs.js';
import { request } from './herdr-request.mjs';
import { sonicChildren, sonicCollectPrompt } from './sonic-jobs.mjs';

const dir = fs.realpathSync(process.argv[2]);
const bundled = fileURLToPath(new URL('..', import.meta.url)), hudHome = dirname(dirname(dir));
const jobFile = join(dir, 'job.json'), job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
let readAt = job.read_at;
const session = Object.fromEntries(fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').split('\n').flatMap((line) => {
  const at = line.indexOf('=');
  return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
}));
const name = session.PRIMARY, pane = session.LEFT, cli = job.cli;
const output = join(dir, 'report.md'), graceMs = (cli.idle_grace_s ?? 600) * 1000;
fs.writeFileSync(join(dir, 'supervisor.pid'), `${process.pid}\n`, { mode: 0o600 });
function effect(args) {
  const ran = spawnSync('herdr', args, { encoding: 'utf8', timeout: 20000 });
  let body = null;
  try { body = JSON.parse(ran.stdout); } catch { /* Effects can fail without proving worker death. */ }
  return { ok: ran.status === 0, body };
}
let initialStatus = null;
try { initialStatus = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8')); } catch { /* Fresh job has no STATUS yet. */ }
let current = {
  version: 1, task_dir: dir, slot: 'primary', harness: 'cli', agent: cli.agent,
  role: job.role, model: job.model ?? null, thinking: job.thinking ?? null,
  state: 'working', output_path: output, output_written: false,
  pid: Number.isInteger(initialStatus?.pid) ? initialStatus.pid : null,
  pid_start_time: typeof initialStatus?.pid_start_time === 'string' ? initialStatus.pid_start_time : null,
  agent_session_id: typeof initialStatus?.agent_session_id === 'string' ? initialStatus.agent_session_id : null,
  started_at: typeof initialStatus?.started_at === 'string' ? initialStatus.started_at : new Date().toISOString(),
  settled_at: null, idle_deadline_at: null,
  ended_at: null, exit_reason: null, error: null, supervisor_pid: process.pid,
};
let prev = null, status = null, agentMissing = false, workingAt = null, idleAt = null, tabClosed = false;
let turn = readTurn(dir) ?? writeTurn(dir), signature = null, stamp;
let stop = false, close = false, openQuestions = false, diskDirty = true, sendInFlight = false;
let socket, lines, reconnectTimer, debounce, deadline, tickTimer, dirWatch, qaWatch;
let stopped = false, busy = false, pending = false, tickPending = false, reconnectMs = 5000, generation = 0;
let quietQuestions = 0, reportPromptSent = Boolean(turn.report_prompt_sent), rowStamp;
function shutdown() {
  stopped = true;
  for (const timer of [reconnectTimer, debounce, deadline, tickTimer]) clearTimeout(timer);
  dirWatch?.close(); qaWatch?.close(); lines?.close(); socket?.destroy();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
function wake(tick = false) {
  if (stopped) return;
  tickPending ||= tick;
  pending = true;
  clearTimeout(debounce);
  debounce = setTimeout(run, 250);
}
function watchQa() {
  if (qaWatch || !fs.existsSync(join(dir, 'qa'))) return;
  try {
    qaWatch = fs.watch(join(dir, 'qa'), () => { diskDirty = true; wake(); });
    qaWatch.on('error', () => { qaWatch?.close(); qaWatch = undefined; });
  } catch { /* The safety tick retries a missing watch. */ }
}
function watchDir() {
  if (dirWatch) return;
  try {
    dirWatch = fs.watch(dir, (_event, filename) => {
      const file = filename?.toString();
      if (file && (file === 'STATUS.json' || file === 'supervisor.pid' || file.endsWith('.tmp'))) return;
      if (!file || ['report.md', 'job.json', 'turn.json', 'qa', '.sonic', 'STATUS.json.stop-requested', 'STATUS.json.close-requested'].includes(file)) {
        diskDirty = true; watchQa(); wake();
      }
    });
    dirWatch.on('error', () => { dirWatch?.close(); dirWatch = undefined; });
  } catch { /* A lost watch is recovered by the tick. */ }
  watchQa();
}
function tick() {
  if (stopped) return;
  diskDirty = true;
  watchDir(); watchQa(); wake(true);
  tickTimer = setTimeout(tick, 30000);
}
function observeStatus(next) {
  if (next === 'working' && (status !== 'working' || (workingAt ?? -Infinity) < Date.parse(turn.sent_at))) workingAt = Date.now();
  if (next === 'done' || next === 'idle') idleAt = Date.now();
  status = next;
}
async function seed() {
  const epoch = generation;
  const got = await request('agent.get', { target: name });
  if (stopped || epoch !== generation) return;
  agentMissing = got?.error?.code === 'agent_not_found';
  const agent = got?.result?.agent;
  observeStatus(agent?.agent_status ?? null);
  if (agent?.agent_session?.kind === 'id') current.agent_session_id = agent.agent_session.value;
}
function connect() {
  if (stopped || !process.env.HERDR_SOCKET_PATH) return;
  socket = createConnection(process.env.HERDR_SOCKET_PATH ?? '');
  lines = createInterface({ input: socket });
  let lost = false;
  const unavailable = () => {
    if (lost || stopped) return;
    lost = true; generation += 1; status = null; agentMissing = false;
    lines.close(); socket.destroy(); wake();
    reconnectTimer = setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(30000, reconnectMs * 2);
  };
  socket.on('connect', () => socket.write(JSON.stringify({ id: 'hud-cli-events', method: 'events.subscribe', params: {
    subscriptions: [{ type: 'pane.agent_status_changed', pane_id: pane },
      ...['pane.exited', 'pane.closed', 'tab.closed', 'pane.agent_detected'].map((type) => ({ type }))],
  } }) + '\n'));
  lines.on('line', async (line) => {
    let event;
    try { event = JSON.parse(line); } catch { unavailable(); return; }
    if (event.error) { unavailable(); return; }
    if (event.id === 'hud-cli-events') {
      reconnectMs = 5000;
      await seed(); wake(); return;
    }
    // herdr names pushed events like their subscriptions (`pane.agent_status_changed`); the schema's kinds use `_`.
    const kind = String(event.event ?? '').replace(/\./g, '_'), data = event.data;
    if (!data || (data.pane_id !== pane && !(kind === 'tab_closed' && data.tab_id === session.TAB))) return;
    generation += 1;
    if (kind === 'pane_agent_status_changed') {
      observeStatus(data.agent_status); agentMissing = false;
    } else if (kind === 'pane_closed' || kind === 'tab_closed') {
      tabClosed = true; diskDirty = true; // Read stop intent even if the file event has not arrived.
    } else if (kind === 'pane_agent_detected') { await seed(); }
    if (!current.agent_session_id && kind === 'pane_agent_status_changed') await seed();
    wake();
  });
  lines.on('error', unavailable); socket.on('error', unavailable); socket.on('close', unavailable);
}
const sampleChild = () => workerHasChild(current.pid, current.pid_start_time, turn.sent_at, firstInput(turn));
function collect(isTick, checkChild = isTick && status !== 'working') {
  if (diskDirty || isTick) {
    turn = readTurn(dir) ?? turn;
    const receipt = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    readAt = receipt.read_at;
    // Keep the prior settlement while the sender can still cancel this baseline. If it dies, assume delivery is possible.
    sendInFlight = turn.send && receipt.send_outcomes?.some((attempt) => attempt.key === turn.send.key && attempt.exit_code === null)
      && workerAlive(turn.send.pid, turn.send.start) === true;
    stop = fs.existsSync(join(dir, 'STATUS.json.stop-requested'));
    close = fs.existsSync(join(dir, 'STATUS.json.close-requested'));
    const qa = join(dir, 'qa');
    openQuestions = fs.existsSync(qa) && fs.readdirSync(qa).some((file) => /^q\d+\.md$/.test(file) && !fs.existsSync(join(qa, file.replace('.md', '.answer.md'))));
    diskDirty = false;
  }
  const st = fs.statSync(output, { throwIfNoEntry: false });
  const nextStamp = st ? `${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.size}` : null;
  if (nextStamp !== stamp) { signature = reportSignature(dir); stamp = nextStamp; }
  return { turn, reportSig: signature, reportRead: reportWasRead(readAt, st?.isFile() ? st.mtimeMs : null),
    alive: workerAlive(current.pid, current.pid_start_time), status,
    liveChild: checkChild ? sampleChild() : null,
    sonic: sonicChildren(dir),
    stop, close, openQuestions, canContinue: cli.can_continue, graceMs, stateTrust: cli.state_trust,
    tick: isTick, agentMissing, workingAt, idleAt, reportMtime: st && Math.floor(st.mtimeMs), tabClosed };
}
function write(result) {
  const terminal = ['closed', 'failed', 'stopped'].includes(result.state);
  const iso = (time) => time === null ? null : new Date(time).toISOString();
  const row = { ...current, state: result.state, blocked: result.blocked, reason: result.reason,
    output_written: result.outputWritten, settled_at: iso(result.settledAt), idle_deadline_at: iso(result.deadline),
    ended_at: terminal ? current.ended_at ?? iso(Date.now()) : null, exit_reason: result.exitReason,
    error: result.state === 'failed' ? result.exitReason : null };
  const changed = JSON.stringify(row);
  if (changed === rowStamp) return;
  current = row; rowStamp = changed;
  const file = join(dir, 'STATUS.json');
  // A watcher may have reached a terminal verdict while this socket was down.
  try {
    if (['closed', 'failed', 'stopped'].includes(JSON.parse(fs.readFileSync(file, 'utf8')).state)) { shutdown(); return; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ ...row, updated_at: iso(Date.now()) }) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}
async function run() {
  if (stopped || !pending || busy) return;
  busy = true; pending = false;
  const isTick = tickPending; tickPending = false;
  try {
    // The safety tick re-reads status once (one socket request per 30 s), so a missed push cannot hold a job.
    if (isTick) await seed();
    if (!current.pid_start_time) {
      const info = (await request('pane.process_info', { pane_id: pane }))?.result?.process_info;
      const pid = info?.foreground_processes?.find((item) => item.pid && item.pid !== info.shell_pid)?.pid;
      if (pid) { current.pid = pid; current.pid_start_time = procStat(pid)?.start ?? null; }
    }
    let observed = collect(isTick);
    if (sendInFlight && !observed.close && !terminalFact(observed)) { clearTimeout(deadline); return; }
    if (observed.reportSig && observed.reportSig !== observed.turn.report_sig && !observed.close && !terminalFact(observed)) {
      const sample = observed;
      const text = (await request('pane.read', { pane_id: pane, source: 'recent_unwrapped', lines: 40 }))?.result?.read?.text;
      observed = collect(isTick);
      if (sendInFlight && !observed.close && !terminalFact(observed)) { clearTimeout(deadline); return; }
      if (typeof text === 'string' && sample.turn.seq === observed.turn.seq && sample.reportSig === observed.reportSig) {
        observed.paneSig = createHash('sha256').update(text.trimEnd()).digest('hex');
        observed.reportMarker = reportMarker(text, output);
      }
    }
    let next = judge(prev, observed, Date.now());
    if (next.action === 'sample') {
      observed = { ...observed, liveChild: sampleChild() };
      next = judge(prev, observed, Date.now());
    }
    if (next.action === 'collect-sonic') {
      const { open, uncollected } = sonicChildren(dir);
      if (open || !uncollected.length) { wake(); return; }
      const prompt = sonicCollectPrompt(dir, output, uncollected);
      writeTurn(dir, false, undefined, observed.reportMarker);
      if (!effect(['agent', 'prompt', name, prompt]).ok) throw new Error('sonic collect prompt failed');
      diskDirty = true; wake(); return;
    }
    if (next.action === 'decide') {
      const text = effect(['pane', 'read', pane, '--source', 'recent']).body?.result?.read?.text ?? '';
      // The pane read can block; don't ask using the earlier child sample.
      const liveChild = sampleChild(), sonic = sonicChildren(dir);
      if (liveChild !== false || sonic.open || sonic.uncollected.length) { wake(); return; }
      const decision = quietQuestions >= 3
        ? { choice: null, probability: null, action: 'needs-human', reason: 'max-questions', asked: false }
        : await decideQuietJob({ hudHome, jobId: job.job, role: job.role, agent: cli.agent,
            jobState: current.state, backgroundChildAlive: liveChild,
            minutesQuiet: Math.max(0, Math.round((Date.now() - next.quietSince) / 60000)),
            paneText: text, reportPromptSent, questionIndex: quietQuestions + 1 });
      if (decision.asked) quietQuestions += 1;
      diskDirty = true;
      const latest = collect(false, true);
      if (sendInFlight || latest.turn.seq !== observed.turn.seq || latest.reportSig !== observed.reportSig || latest.stop || latest.close || latest.alive === false || latest.status !== observed.status || latest.workingAt !== observed.workingAt || latest.openQuestions || latest.liveChild !== false || latest.sonic.open || latest.sonic.uncollected.length) { wake(); return; }
      current.quiet_decision = { choice: decision.choice, probability: decision.probability, action: decision.action,
        ...(decision.reason ? { reason: decision.reason } : {}), at: new Date().toISOString() };
      if (decision.action === 'prompt-report') {
        reportPromptSent = true;
        const sent = writeTurn(dir, true, undefined, reportMarker(text, output));
        if (!effect(['agent', 'prompt', name, `Write your report to ${output} now; if work remains, finish it first.`]).ok) {
          decision.action = 'needs-human'; decision.reason = 'prompt-failed';
          current.quiet_decision = { ...current.quiet_decision, action: 'needs-human', reason: 'prompt-failed' };
          turn = sent;
          observed = { ...observed, turn: sent };
          prev = prev ? { ...prev, seq: sent.seq } : prev;
        } else { diskDirty = true; wake(); return; }
      }
      if (decision.action === 'fail') decision.failReason = recordFailureExhaustion(hudHome, bundled, dir, job, decision.failReason).reason;
      next = judge(prev, { ...observed, decision }, Date.now());
    }
    // Settlement is independent of /quit delivery; the global watcher owns cleanup and retries.
    if (next.action === 'quit' && observed.alive !== false) {
      rememberWorkerTree(dir, current);
      effect(['agent', 'prompt', name, '/quit']);
    }
    write(next);
    if (stopped) return;
    prev = next;
    clearTimeout(deadline);
    if (next.wakeAt !== null) deadline = setTimeout(() => wake(), Math.max(0, next.wakeAt - Date.now()));
    if (['closed', 'failed', 'stopped'].includes(next.state)) {
      if (next.state === 'failed') process.exitCode = 1;
      shutdown();
    }
  } catch (error) {
    try { write(judge(prev, { ...collect(false), supervisorError: `supervisor error: ${String(error.message ?? error).replace(/[\r\n]+/g, ' ')}` }, Date.now())); } catch { /* Watcher observes death if the directory vanished. */ }
    process.exitCode = 1; shutdown();
  } finally { busy = false; if (pending && !stopped) wake(); }
}
watchDir(); connect(); tickTimer = setTimeout(tick, 30000); wake();

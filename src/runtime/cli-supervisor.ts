/** One CLI job: pushed facts -> pure judge -> effects. No subprocesses or STATUS writes at rest. */
import { recordFailureExhaustion } from '../roles/roster.js';
import { decideQuietJob } from '../mcp/quiet-decision.js';
import { loadSettings } from '../settings.js';
import { beginPrompt, cliWorkerTools, endPrompt, firstInput, judge, terminalFact, workerAlive, workerHasChild, readTurn, readDone, DONE_FILE, REPORT_SETTLED_EXIT, reportSignature, withDonePrompt, writeTurn, type Judgment, type PaneExit } from '../mcp/cli-judge.js';
import { invocationWitness } from './cli-invocation.js';
import { tabProcessStart } from './tab-owner.js';
import { rememberWorkerTree } from '../roles/worker-tree.js';
import { fileStampOf, getJobIndexCache, statsMtimeMs } from '../roles/job-index-cache.js';
import { reportWasRead } from '../collectors/thin-jobs.js';
import { runHerdr } from '../roles/herdr-run.js';
import { recordStopOrigin } from '../roles/job-archive.js';
import { readJsonFile, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';
import { isValidPid } from '../utils/proc.js';
import type { Job, JobStatus, DoneReceipt } from '../mcp/job-contracts.js';
import { jobFiles, BUNDLED_ROOT } from '../mcp/paths.js';
import * as fs from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as scheduleTabProbe } from 'node:timers';
import { hasLocalHerdrTarget, probeHerdrTarget, request, TAB_PROBE_INTERVAL_MS, tabProbeBackoff } from './herdr-socket.js';
import { sonicChildren, sonicCollectPrompt } from '../worker/sonic-jobs.js';

import { publishRunnerLifetime } from '../utils/runner-lifetime.js';

export async function main() {
  const dir = fs.realpathSync(process.argv[2]);
  await publishRunnerLifetime(dir);
  const bundled = BUNDLED_ROOT, hudHome = dirname(dirname(dir));
  const jobFile = join(dir, jobFiles.job), job = readJsonFile(jobFile) as Job;
  let receipt = job;
  const jobCache = getJobIndexCache(hudHome);
  const binding = jobCache.readSession(job.job, { throwOnError: true });
  if (!binding?.fields.left || !binding.fields.primary || !binding.fields.tab) throw Error('CLI tab receipt missing or incomplete');
  const session = binding.fields;
  const name = session.primary!, pane = session.left!, tab = session.tab!, cli = job.cli!;
  const directExec = session.directExec === '1' && Boolean(session.launchId);
  const launchId = session.launchId;
  const terminalId = session.terminalId;
  let directPid: number | null = null;
  let directStart: string | null = null;
  if (directExec) {
    const parsedPid = Number(session.pid);
    if (!terminalId || !isValidPid(parsedPid) || !session.pidStart || !/^\d+$/.test(session.pidStart))
      throw Error('CLI direct-exec receipt missing terminal_id or pid/start');
    directPid = parsedPid;
    directStart = session.pidStart;
  }
  const sameSession = () => jobCache.readSession(job.job, { throwOnError: true })?.stamp === binding.stamp;
  const tools = cliWorkerTools(cli.agent);
  const output = join(dir, jobFiles.report), graceMs = (cli.idle_grace_s ?? 600) * 1000;
  const statusFile = join(dir, jobFiles.status), stopFile = join(dir, jobFiles.stopRequested), closeFile = join(dir, jobFiles.closeRequested);
  const quitFile = `${statusFile}.quit-${process.pid}`;
  writePrivateFile(join(dir, jobFiles.supervisorPid), `${process.pid}\n`, { mkdir: false });
  function effect(kind: string, args: string[]) {
    // Leave headroom for terminal status writes even if the helper ignores SIGTERM.
    return withEffect(kind, async (signal) => {
      const ran = await runHerdr(args, process.env, { budgetMs: 20_000, killGraceMs: 100, signal });
      let body = null;
      try { body = JSON.parse(ran.stdout); } catch { /* Effects can fail without proving worker death. */ }
      return { ok: ran.ok, body };
    });
  }
  let initialStatus: JobStatus | null = null;
  try { initialStatus = readJsonFile(statusFile) as JobStatus; } catch { /* Fresh job has no STATUS yet. */ }
  const witness = directExec ? null : invocationWitness(dir, session.launch);
  const restore = directExec
    ? initialStatus?.pid === directPid && initialStatus.pid_start_time === directStart
    : witness && initialStatus?.pid === witness.pid && initialStatus.pid_start_time === witness.start;
  let current: JobStatus = {
    version: 1, task_dir: dir, slot: 'primary', harness: 'cli', agent: cli.agent,
    role: job.role, model: job.model ?? null, thinking: job.thinking ?? null,
    state: 'working', output_path: output, output_written: false,
    pid: directExec ? directPid : restore ? witness!.pid : null,
    pid_start_time: directExec ? directStart : restore ? witness!.start : null,
    agent_session_id: restore ? initialStatus?.agent_session_id ?? null : null,
    started_at: typeof initialStatus?.started_at === 'string' ? initialStatus.started_at : new Date().toISOString(),
    settled_at: null, idle_deadline_at: null,
    ended_at: null, exit_reason: null, error: null, supervisor_pid: process.pid,
  };
  let prev: Judgment | null = null, status: string | null = null, statusAt: number | null = null;
  let agentMissing = false, workingAt: number | null = null, tabClosed = false;
  let paneExit: PaneExit | null = null;
  let deadObservedAt: number | null = null;
  let tabCheckPending = false, checkingTab = false, nextTabProbe = 0, tabProbeFailures = 0;
  let tabProbeTimer: NodeJS.Timeout | undefined;
  let turn = readTurn(dir) ?? writeTurn(dir), done: DoneReceipt | null = null, signature: string | null = null, stamp: string | null | undefined;
  let stop = false, close = false, openQuestions = false, diskDirty = true, sendInFlight = false;
  let socket: ReturnType<typeof createConnection>, lines: ReturnType<typeof createInterface>;
  let reconnectTimer: NodeJS.Timeout, debounce: NodeJS.Timeout, deadline: NodeJS.Timeout, tickTimer: NodeJS.Timeout;
  let dirWatch: fs.FSWatcher | undefined, qaWatch: fs.FSWatcher | undefined;
  let stopped = false, busy = false, pending = false, tickPending = false, seedPending = false, reconnectMs = 5000, generation = 0;
  let quietQuestions = 0, reportPromptSent = Boolean(turn.report_prompt_sent), rowStamp: string | undefined;
  const lifecycle = new AbortController();
  let activeEffect: { kind: string; controller: AbortController } | undefined, immediate: NodeJS.Immediate | undefined;
  let urgentWake = false;
  async function withEffect<T>(kind: string, call: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    activeEffect = { kind, controller };
    const signal = AbortSignal.any([lifecycle.signal, controller.signal]);
    try { return { result: await call(signal), aborted: signal.aborted }; }
    finally { activeEffect = undefined; }
  }
  function cancelQuiet() {
    if (activeEffect?.kind === 'read' || activeEffect?.kind === 'decide') activeEffect.controller.abort();
  }
  function shutdown() {
    if (stopped) return;
    stopped = true;
    lifecycle.abort();
    for (const timer of [reconnectTimer, debounce, deadline, tickTimer, tabProbeTimer]) clearTimeout(timer);
    clearImmediate(immediate);
    dirWatch?.close(); qaWatch?.close(); lines?.close(); socket?.destroy();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  function wake(tick = false, urgent = false) {
    if (stopped) return;
    tickPending ||= tick;
    urgentWake ||= urgent;
    pending = true;
    if (busy) return;
    clearTimeout(debounce);
    if (urgentWake) immediate ??= setImmediate(run);
    else debounce = setTimeout(run, 250);
  }
  function terminalWake() {
    diskDirty = true;
    activeEffect?.controller.abort();
    wake(false, true);
  }
  function checkTab() {
    // On the fork, absence of the old pane address is never terminal while exact PID+start is alive.
    if (stopped || tabClosed || directExec || !hasLocalHerdrTarget(session)) return;
    tabCheckPending = true;
    if (checkingTab || tabProbeTimer) return;
    const now = performance.now();
    if (nextTabProbe > now) {
      tabProbeTimer = scheduleTabProbe(() => { tabProbeTimer = undefined; checkTab(); }, Math.ceil(nextTabProbe - now));
      return;
    }
    checkingTab = true;
    tabCheckPending = false;
    nextTabProbe = now + TAB_PROBE_INTERVAL_MS;
    void probeHerdrTarget(session, lifecycle.signal, 'hud-cli-probe').then(result => {
      if (stopped) return;
      if (!sameSession()) { shutdown(); return; }
      if (result === 'unknown') {
        tabProbeFailures = Math.min(tabProbeFailures + 1, 8);
        nextTabProbe = performance.now() + tabProbeBackoff(tabProbeFailures);
        tabCheckPending = true;
        return;
      }
      tabProbeFailures = 0;
      if (result === 'absent') {
        tabClosed = true;
        terminalWake(); // Abort a held effect only on confirmed disappearance, not on the push.
      }
    }).catch((error) => console.error(`CLI tab probe: ${(error as Error).message}`))
      .finally(() => { checkingTab = false; if (tabCheckPending) checkTab(); });
  }
  function watchQa() {
    if (qaWatch || !fs.existsSync(join(dir, jobFiles.qa))) return;
    try {
      qaWatch = fs.watch(join(dir, jobFiles.qa), () => { diskDirty = true; cancelQuiet(); wake(); });
      qaWatch.on('error', () => { qaWatch?.close(); qaWatch = undefined; });
    } catch { /* The safety tick retries a missing watch. */ }
  }
  const refreshQuiet: string[] = [jobFiles.report, jobFiles.turn, DONE_FILE, jobFiles.qa, jobFiles.closeRequested];
  const refreshDisk = [...refreshQuiet, jobFiles.job, jobFiles.sonic, jobFiles.stopRequested];
  function watchDir() {
    if (dirWatch) return;
    try {
      dirWatch = fs.watch(dir, (_event, filename) => {
        const file = filename?.toString();
        if (file && (file === jobFiles.status || file === jobFiles.supervisorPid || file.endsWith('.tmp'))) return;
        if ((!file || file === jobFiles.stopRequested) && fs.existsSync(stopFile)) { terminalWake(); return; }
        if (!file || refreshQuiet.includes(file)) cancelQuiet();
        if (!file || refreshDisk.includes(file)) {
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
    watchDir(); watchQa();
    if (fs.existsSync(stopFile)) terminalWake();
    else wake(true);
    tickTimer = setTimeout(tick, 30000);
  }
  function observeStatus(next: string | null) {
    statusAt = Date.now();
    if (next === 'working' && (status !== 'working' || (workingAt ?? -Infinity) < Date.parse(turn.sent_at))) workingAt = statusAt;
    status = next;
  }
  async function seed(signal: AbortSignal) {
    const epoch = generation;
    const got = await request('agent.get', { target: name }, { signal });
    if (signal.aborted || epoch !== generation) return;
    agentMissing = got?.error?.code === 'agent_not_found';
    const agent = got?.result?.agent;
    const bound = agent && agent.name === name && agent.pane_id === pane && agent.tab_id === tab &&
      (!directExec || (agent.launch_id === launchId && agent.terminal_id === terminalId)) &&
      (!current.agent_session_id || current.agent_session_id === agent.agent_session?.value);
    observeStatus(bound ? agent.agent_status ?? null : null);
    return bound ? agent : undefined;
  }
  let refusedInvocation = !directExec && !witness;
  if (!directExec && !witness) console.error('CLI invocation witness missing or invalid; identity not adopted');
  async function foreground(signal: AbortSignal) {
    const epoch = generation;
    const info = (await request('pane.process_info', { pane_id: pane }, { signal }))?.result?.process_info;
    // The job's agent, not the first foreground tool subprocess or a replacement shell.
    const pid = info?.foreground_process_group_id;
    if (signal.aborted || epoch !== generation || info?.pane_id !== pane || !pid || !Number.isSafeInteger(pid) || pid < 1) return;
    // A concrete different group (or the shell itself) already contradicts the
    // witness, even if its leader row is absent. Missing facts alone can retry.
    if (pid === witness?.pid && pid !== info.shell_pid) {
      const leader = info.foreground_processes?.find(p => p.pid === pid);
      if (!leader?.name) return;
      if (leader.name === cli.agent) {
        if (!info.shell_pid) return;
        if (tabProcessStart(dir, pane, tab, pid, session.launch) === witness.start) {
          refusedInvocation = false; return witness;
        }
      }
    }
    if (!refusedInvocation) console.error('CLI invocation witness missing or does not match the foreground worker; identity not adopted');
    refusedInvocation = true;
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
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { unavailable(); return; }
      if (event.error) { unavailable(); return; }
      if (event.id === 'hud-cli-events') {
        reconnectMs = 5000;
        checkTab(); seedPending = true; wake(); return;
      }
      // herdr names pushed events like their subscriptions (`pane.agent_status_changed`); the schema's kinds use `_`.
      const kind = String(event.event ?? '').replace(/\./g, '_'), data = event.data;
      if (!data) return;
      if (directExec && (kind === 'pane_exited' || kind === 'pane_closed' || kind === 'tab_closed')) {
        if (data.launch_id !== launchId) return;
        if (kind === 'pane_exited') {
          // launch_id is per tab; match pane.exited on both launch_id AND root terminal_id so sibling exits never retire the worker.
          if (data.terminal_id !== terminalId) return;
          paneExit = {
            exitCode: typeof data.exit_code === 'number' ? data.exit_code : null,
            signal: typeof data.signal === 'string' ? data.signal : null,
          };
          terminalWake();
          return;
        }
        // tab.closed and pane.closed alone are never terminal on the fork while exact PID+start is alive; recheck liveness.
        wake();
        return;
      }
      if (data.pane_id !== pane && !(kind === 'tab_closed' && data.tab_id === tab)) return;
      if (kind === 'pane_closed' || kind === 'tab_closed') { checkTab(); return; }
      generation += 1;
      if (kind === 'pane_agent_status_changed') {
        observeStatus(data.agent_status); agentMissing = false;
        if (status === 'working') cancelQuiet();
        if (!current.agent_session_id) seedPending = true;
      } else if (kind === 'pane_agent_detected') seedPending = true;
      wake();
    });
    lines.on('error', unavailable); socket.on('error', unavailable); socket.on('close', unavailable);
  }
  const sampleChild = () => workerHasChild(current.pid ?? null, current.pid_start_time ?? null, turn.sent_at, firstInput(turn));
  function collect(isTick: boolean, checkChild = isTick && status !== 'working') {
    if (diskDirty || isTick) {
      turn = readTurn(dir) ?? turn;
      done = readDone(dir);
      receipt = readJsonFile(jobFile) as Job;
      // Keep the prior settlement while the sender can still cancel this baseline. If it dies, assume delivery is possible.
      sendInFlight = !!turn.send && !!receipt.send_outcomes?.some((attempt) => attempt.key === turn.send?.key && attempt.exit_code === null)
        && workerAlive(turn.send.pid, turn.send.start) === true;
      stop = fs.existsSync(stopFile);
      close = fs.existsSync(closeFile);
      const qa = join(dir, jobFiles.qa);
      openQuestions = fs.existsSync(qa) && fs.readdirSync(qa).some((file) => /^q\d+\.md$/.test(file) && !fs.existsSync(join(qa, file.replace('.md', '.answer.md'))));
      diskDirty = false;
    }
    const st = fs.statSync(output, { bigint: true, throwIfNoEntry: false });
    const nextStamp = st?.isFile() ? fileStampOf(st) : null;
    if (nextStamp !== stamp) { signature = reportSignature(dir); stamp = nextStamp; }
    return { turn, reportSig: signature, reportRead: reportWasRead(receipt, st?.isFile() ? statsMtimeMs(st.mtimeNs) : null, nextStamp),
      closeAtReport: job.resume_s !== undefined,
      alive: workerAlive(current.pid ?? null, current.pid_start_time ?? null), paneExit, directExec, status, statusAt,
      liveChild: checkChild ? sampleChild() : null,
      sonic: sonicChildren(dir),
      stop, close, openQuestions, canContinue: cli.can_continue, graceMs, stateTrust: cli.state_trust,
      tick: isTick, agentMissing, workingAt, done, tabClosed };
  }
  function stillQuiet(before: ReturnType<typeof collect>, latest: ReturnType<typeof collect>) {
    return !sendInFlight && !latest.stop && !latest.close && !latest.tabClosed && !latest.paneExit && latest.alive !== false &&
      latest.turn.seq === before.turn.seq && latest.turn.sent_at === before.turn.sent_at &&
      latest.reportSig === before.reportSig && latest.done?.at === before.done?.at &&
      latest.status === before.status && latest.workingAt === before.workingAt && !latest.openQuestions &&
      latest.liveChild === false && !latest.sonic.open && !latest.sonic.uncollected.length;
  }
  function write(result: Judgment) {
    const terminal = ['closed', 'failed', 'stopped'].includes(result.state);
    const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();
    const row: JobStatus = { ...current, state: result.state, blocked: result.blocked, reason: result.reason ?? (refusedInvocation ? 'CLI invocation identity unverified' : null),
      output_written: result.outputWritten, settled_at: iso(result.settledAt), idle_deadline_at: iso(result.deadline),
      ...(job.checks?.length ? { declared_report_sig: result.declared ? result.reportSig : null } : {}),
      ...(terminal && paneExit ? { runner_exit_code: paneExit.exitCode, runner_exit_signal: paneExit.signal as NodeJS.Signals | null } : {}),
      ended_at: terminal ? current.ended_at ?? iso(Date.now()) : null, exit_reason: result.exitReason,
      error: result.state === 'failed' ? result.exitReason : null };
    const changed = JSON.stringify(row);
    if (changed === rowStamp) return;
    // A watcher may have reached a terminal verdict while this socket was down, or resume may have replaced SESSION.
    try {
      if (['closed', 'failed', 'stopped'].includes((readJsonFile(statusFile) as JobStatus).state)) { shutdown(); return; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!sameSession()) { shutdown(); return; }
    if (terminal && tabClosed && !stop && !result.outputWritten && !paneExit)
      recordStopOrigin(dir, 'pane_vanished', current.state, row.ended_at ?? new Date().toISOString());
    if (!sameSession()) { shutdown(); return; }
    writeJsonPrivate(statusFile, { ...row, updated_at: iso(Date.now()) }, { mkdir: false });
    current = row; rowStamp = changed;
  }
  async function run() {
    if (stopped || !pending || busy) return;
    busy = true; pending = urgentWake = false; immediate = undefined;
    const isTick = tickPending, refreshAgent = isTick || seedPending;
    tickPending = seedPending = false;
    let quitting = false;
    try {
      if (!sameSession()) { shutdown(); return; }
      // Terminal facts never wait on a socket query. The safety tick refreshes missed status pushes.
      const stopping = fs.existsSync(stopFile);
      if (stopping) diskDirty = true;
      if (!tabClosed && !paneExit && ((!stopping && refreshAgent) || !current.pid_start_time)) {
        const { aborted } = await withEffect('query', async (signal) => {
          const agent = await seed(signal);
          const nativeId = agent?.agent_session?.kind === 'id' ? agent.agent_session.value : undefined;
          if (directExec) {
            if (agent && nativeId) current.agent_session_id ??= nativeId;
          } else if (agent && (!current.pid_start_time || (!current.agent_session_id && nativeId)) && !signal.aborted) {
            const owner = await foreground(signal);
            if (owner && (!current.pid_start_time || (current.pid === owner.pid && current.pid_start_time === owner.start))) {
              current.pid = owner.pid; current.pid_start_time = owner.start;
              if (nativeId) current.agent_session_id ??= nativeId;
            }
          }
        });
        if (stopped || aborted) return;
      }
      let observed = collect(isTick);
      if (directExec && observed.alive === false && !observed.paneExit && !observed.tabClosed && !observed.stop) {
        // Allow a brief window for an in-flight pane.exited before settling as missed/exit-unknown.
        const now = Date.now();
        deadObservedAt ??= now;
        const remaining = 200 - (now - deadObservedAt);
        if (remaining > 0) {
          clearTimeout(deadline);
          deadline = setTimeout(() => wake(), remaining);
          return;
        }
      } else {
        deadObservedAt = null;
      }
      if (sendInFlight && !observed.close && !terminalFact(observed)) { clearTimeout(deadline); return; }
      let next = judge(prev, observed, Date.now());
      if ((observed.stop || observed.close) && !current.pid_start_time && !tabClosed && !receipt.reaped_at) {
        // Stop intent is durable. Wait for verified PID discovery or the same
        // endpoint-bound probe used by close hints before retiring this writer.
        checkTab();
        write({ ...next, state: 'waiting_orchestrator', reason: 'stop pending verified worker identity', exitReason: null });
        return;
      }
      if (next.action === 'sample') {
        observed = { ...observed, liveChild: sampleChild() };
        next = judge(prev, observed, Date.now());
      }
      if (next.action === 'collect-sonic') {
        if (!sameSession()) { shutdown(); return; }
        const { open, uncollected } = sonicChildren(dir);
        if (open || !uncollected.length) { wake(); return; }
        const submission = await beginPrompt(dir, { by: 'hud' });
        if (!sameSession()) { await endPrompt(dir, submission, true); shutdown(); return; }
        const prompt = withDonePrompt(sonicCollectPrompt(dir, output, uncollected, tools), bundled, dir, submission.turn, cli.agent);
        const { result, aborted } = await effect('sonic', ['agent', 'prompt', name, prompt]).finally(() => endPrompt(dir, submission));
        if (stopped || aborted) return;
        if (!sameSession()) { shutdown(); return; }
        diskDirty = true;
        if (!result.ok) {
          const after = collect(false);
          if (!after.close && !terminalFact(after)) throw new Error('sonic collect prompt failed');
        }
        wake(); return;
      }
      if (next.action === 'decide') {
        if (!sameSession()) { shutdown(); return; }
        let enabled = true;
        try { enabled = loadSettings({ ...process.env, HUD_HOME: hudHome }).quietJobDecision; }
        catch { /* The decision path already hands off on a settings read error. */ }
        const skip = !enabled ? 'off' : quietQuestions >= 3 ? 'max-questions' : undefined;
        const read = skip ? undefined : await effect('read', ['pane', 'read', pane, '--source', 'recent']);
        if (stopped || read?.aborted) return;
        if (!sameSession()) { shutdown(); return; }
        diskDirty = true;
        const mid = collect(false, true);
        if (!stillQuiet(observed, mid)) { wake(); return; }
        const { result: decision, aborted } = skip
          ? { aborted: false, result: { choice: null, probability: null, action: 'needs-human' as const, reason: skip, asked: false } }
          : await withEffect('decide', (signal) => decideQuietJob({ hudHome, jobId: job.job, role: job.role, agent: cli.agent,
              jobState: current.state, backgroundChildAlive: mid.liveChild as false,
              minutesQuiet: Math.max(0, Math.round((Date.now() - next.quietSince!) / 60000)),
              beforeRequest: () => { if (fs.existsSync(stopFile)) terminalWake(); },
              paneText: read?.result.body?.result?.read?.text ?? '', reportPromptSent, questionIndex: quietQuestions + 1, signal }));
        if (decision.asked) quietQuestions += 1;
        if (stopped || aborted) return;
        if (!sameSession()) { shutdown(); return; }
        diskDirty = true;
        const latest = collect(false, true);
        if (!stillQuiet(observed, latest)) { wake(); return; }
        observed = latest;
        let prompted = false;
        if (decision.action === 'prompt-report') {
          if (!sameSession()) { shutdown(); return; }
          reportPromptSent = true;
          const submission = await beginPrompt(dir, { by: 'hud', reportPromptSent: true });
          if (!sameSession()) { await endPrompt(dir, submission, true); shutdown(); return; }
          const sent = submission.turn;
          const prompt = withDonePrompt(tools ? 'If work remains, finish it first.' :
            `Write your report to ${output} now; if work remains, finish it first.`, bundled, dir, sent, cli.agent);
          const reply = await effect('prompt', ['agent', 'prompt', name, prompt]).finally(() => endPrompt(dir, submission));
          if (stopped || reply.aborted) return;
          if (!sameSession()) { shutdown(); return; }
          diskDirty = true;
          const after = collect(false, !reply.result.ok);
          if (sendInFlight || after.close || terminalFact(after) || after.turn.seq !== sent.seq || after.turn.sent_at !== sent.sent_at) { wake(); return; }
          if (reply.result.ok) prompted = true;
          else {
            if (!stillQuiet({ ...observed, turn: sent, reportSig: sent.report_sig }, after)) { wake(); return; }
            decision.action = 'needs-human'; decision.reason = 'prompt-failed';
            observed = after;
            prev = prev ? { ...prev, seq: sent.seq } : prev;
          }
        }
        current.quiet_decision = { choice: decision.choice, probability: decision.probability, action: decision.action,
          ...(decision.reason ? { reason: decision.reason } : {}), at: new Date().toISOString() };
        if (prompted) { wake(); return; }
        if (decision.action === 'fail') decision.failReason = recordFailureExhaustion(hudHome, bundled, dir, job, decision.failReason!).reason;
        next = judge(prev, { ...observed, decision }, Date.now());
      }
      // For report closure the watcher owns the tab; capture ancestry before publishing the terminal state.
      if (next.exitReason === REPORT_SETTLED_EXIT) {
        diskDirty = true;
        const fresh = collect(false);
        if (sendInFlight || fresh.turn.seq !== observed.turn.seq || fresh.turn.sent_at !== observed.turn.sent_at ||
            fresh.reportSig !== observed.reportSig || fresh.done?.at !== observed.done?.at || fresh.openQuestions ||
            fresh.sonic.open || fresh.sonic.uncollected.length || fresh.stop || fresh.close || fresh.tabClosed) { wake(); return; }
        rememberWorkerTree(dir, current);
      }
      // Settlement is independent of /quit delivery; the global watcher owns cleanup and retries.
      let deferredQuit = false;
      // For a declared turn with checks, publish settlement and let the watcher reap after the helper exits.
      if (next.action === 'quit' && observed.alive !== false && !(job.checks?.length && next.declared && !observed.close)) {
        const { issue } = rememberWorkerTree(dir, current);
        // On capture failure let the reaper try again with the root still in place.
        let okToQuit = false;
        if (directExec) {
          const { result: agent } = await withEffect('query', async signal => await seed(signal));
          okToQuit = Boolean(agent) && workerAlive(current.pid ?? null, current.pid_start_time ?? null) === true;
        } else {
          const { result: owner } = await withEffect('query', async signal => await seed(signal) ? foreground(signal) : undefined);
          okToQuit = Boolean(owner && owner.pid === current.pid && owner.start === current.pid_start_time);
        }
        if (issue || !okToQuit) {
          deferredQuit = true;
          if (issue) console.error(`pre-quit snapshot: ${issue}; deferring quit to watcher`);
        } else {
          if (!sameSession()) { shutdown(); return; }
          // Reserve the terminal write until delivery/cancellation; the watcher must not race it with tab failure.
          fs.writeFileSync(quitFile, '', { flag: 'wx', mode: 0o600 });
          quitting = true;
          await effect('quit', ['agent', 'prompt', name, '/quit']);
          if (stopped) return;
          if (fs.existsSync(stopFile)) {
            diskDirty = true;
            next = judge(prev, collect(false), Date.now());
          }
          // A tab close can be confirmation of `/quit`; keep the prior closed judgment.
        }
      }
      try { write(next); }
      catch (error) {
        // A full disk can block STATUS as well. Don't exit before the watcher can see the terminal state.
        if (!deferredQuit) throw error;
        clearTimeout(deadline);
        deadline = setTimeout(() => { diskDirty = true; wake(); }, 30000);
        return;
      }
      if (stopped) return;
      prev = next;
      clearTimeout(deadline);
      if (next.wakeAt !== null) deadline = setTimeout(() => wake(), Math.max(0, next.wakeAt - Date.now()));
      if (['closed', 'failed', 'stopped'].includes(next.state)) {
        if (next.state === 'failed') process.exitCode = 1;
        shutdown();
      }
    } catch (error) {
      if (stopped) return;
      try {
        diskDirty = true;
        write(judge(prev, { ...collect(false), supervisorError: `supervisor error: ${String((error as Error).message ?? error).replace(/[\r\n]+/g, ' ')}` }, Date.now()));
      } catch { /* Watcher observes death if the directory vanished. */ }
      process.exitCode = 1; shutdown();
    } finally {
      if (quitting) {
        try { fs.rmSync(quitFile, { force: true }); } catch { /* A stale marker is ignored when the supervisor exits. */ }
      }
      busy = false;
      if (pending) wake();
    }
  }
  watchDir(); connect(); tickTimer = setTimeout(tick, 30000); wake(false, fs.existsSync(stopFile));
}

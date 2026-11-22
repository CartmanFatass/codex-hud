/** One CLI job: pushed facts -> pure judge -> effects. No subprocesses or STATUS writes at rest. */
import { recordFailureExhaustion } from '../roles/roster.js';
import { decideQuietJob } from '../mcp/quiet-decision.js';
import { cliWorkerTools, firstInput, judge, terminalFact, workerAlive, workerHasChild, readTurn, readDone, DONE_FILE, REPORT_SETTLED_EXIT, reportSignature, withDonePrompt, writeTurn, type Judgment } from '../mcp/cli-judge.js';
import { procStat } from '../utils/proc.js';
import { rememberWorkerTree } from '../roles/worker-tree.js';
import { reportWasRead } from '../collectors/thin-jobs.js';
import { runHerdr } from '../roles/herdr-run.js';
import { readJsonFile, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';
import type { Job, JobStatus, DoneReceipt } from '../mcp/job-contracts.js';
import { jobFiles, BUNDLED_ROOT } from '../mcp/paths.js';
import * as fs from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { request } from './herdr-socket.js';
import { sonicChildren, sonicCollectPrompt } from '../worker/sonic-jobs.js';

export function main() {
  const dir = fs.realpathSync(process.argv[2]);
  const bundled = BUNDLED_ROOT, hudHome = dirname(dirname(dir));
  const jobFile = join(dir, jobFiles.job), job = readJsonFile(jobFile) as Job;
  let readAt = job.read_at;
  const session = Object.fromEntries(fs.readFileSync(join(dir, jobFiles.session), 'utf8').split('\n').flatMap((line) => {
    const at = line.indexOf('=');
    return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
  }));
  const name = session.PRIMARY, pane = session.LEFT, cli = job.cli!;
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
  let current: JobStatus = {
    version: 1, task_dir: dir, slot: 'primary', harness: 'cli', agent: cli.agent,
    role: job.role, model: job.model ?? null, thinking: job.thinking ?? null,
    state: 'working', output_path: output, output_written: false,
    pid: Number.isInteger(initialStatus?.pid) ? initialStatus!.pid : null,
    pid_start_time: typeof initialStatus?.pid_start_time === 'string' ? initialStatus.pid_start_time : null,
    agent_session_id: typeof initialStatus?.agent_session_id === 'string' ? initialStatus.agent_session_id : null,
    started_at: typeof initialStatus?.started_at === 'string' ? initialStatus.started_at : new Date().toISOString(),
    settled_at: null, idle_deadline_at: null,
    ended_at: null, exit_reason: null, error: null, supervisor_pid: process.pid,
  };
  let prev: Judgment | null = null, status: string | null = null, statusAt: number | null = null;
  let agentMissing = false, workingAt: number | null = null, tabClosed = false;
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
    for (const timer of [reconnectTimer, debounce, deadline, tickTimer]) clearTimeout(timer);
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
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { unavailable(); return; }
      if (event.error) { unavailable(); return; }
      if (event.id === 'hud-cli-events') {
        reconnectMs = 5000;
        seedPending = true; wake(); return;
      }
      // herdr names pushed events like their subscriptions (`pane.agent_status_changed`); the schema's kinds use `_`.
      const kind = String(event.event ?? '').replace(/\./g, '_'), data = event.data;
      if (!data || (data.pane_id !== pane && !(kind === 'tab_closed' && data.tab_id === session.TAB))) return;
      generation += 1;
      if (kind === 'pane_agent_status_changed') {
        observeStatus(data.agent_status); agentMissing = false;
        if (status === 'working') cancelQuiet();
        if (!current.agent_session_id) seedPending = true;
      } else if (kind === 'pane_closed' || kind === 'tab_closed') {
        tabClosed = true; terminalWake(); return;
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
      const receipt = readJsonFile(jobFile) as Job;
      readAt = receipt.read_at;
      // Keep the prior settlement while the sender can still cancel this baseline. If it dies, assume delivery is possible.
      sendInFlight = !!turn.send && !!receipt.send_outcomes?.some((attempt) => attempt.key === turn.send?.key && attempt.exit_code === null)
        && workerAlive(turn.send.pid, turn.send.start) === true;
      stop = fs.existsSync(stopFile);
      close = fs.existsSync(closeFile);
      const qa = join(dir, jobFiles.qa);
      openQuestions = fs.existsSync(qa) && fs.readdirSync(qa).some((file) => /^q\d+\.md$/.test(file) && !fs.existsSync(join(qa, file.replace('.md', '.answer.md'))));
      diskDirty = false;
    }
    const st = fs.statSync(output, { throwIfNoEntry: false });
    const nextStamp = st ? `${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.size}` : null;
    if (nextStamp !== stamp) { signature = reportSignature(dir); stamp = nextStamp; }
    return { turn, reportSig: signature, reportRead: reportWasRead(readAt, st?.isFile() ? st.mtimeMs : null),
      closeAtReport: job.resume_s !== undefined,
      alive: workerAlive(current.pid ?? null, current.pid_start_time ?? null), status, statusAt,
      liveChild: checkChild ? sampleChild() : null,
      sonic: sonicChildren(dir),
      stop, close, openQuestions, canContinue: cli.can_continue, graceMs, stateTrust: cli.state_trust,
      tick: isTick, agentMissing, workingAt, done, tabClosed };
  }
  function stillQuiet(before: ReturnType<typeof collect>, latest: ReturnType<typeof collect>) {
    return !sendInFlight && !latest.stop && !latest.close && !latest.tabClosed && latest.alive !== false &&
      latest.turn.seq === before.turn.seq && latest.turn.sent_at === before.turn.sent_at &&
      latest.reportSig === before.reportSig && latest.done?.at === before.done?.at &&
      latest.status === before.status && latest.workingAt === before.workingAt && !latest.openQuestions &&
      latest.liveChild === false && !latest.sonic.open && !latest.sonic.uncollected.length;
  }
  function write(result: Judgment) {
    const terminal = ['closed', 'failed', 'stopped'].includes(result.state);
    const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();
    const row: JobStatus = { ...current, state: result.state, blocked: result.blocked, reason: result.reason,
      output_written: result.outputWritten, settled_at: iso(result.settledAt), idle_deadline_at: iso(result.deadline),
      ...(job.checks?.length ? { declared_report_sig: result.declared ? result.reportSig : null } : {}),
      ended_at: terminal ? current.ended_at ?? iso(Date.now()) : null, exit_reason: result.exitReason,
      error: result.state === 'failed' ? result.exitReason : null };
    const changed = JSON.stringify(row);
    if (changed === rowStamp) return;
    // A watcher may have reached a terminal verdict while this socket was down.
    try {
      if (['closed', 'failed', 'stopped'].includes((readJsonFile(statusFile) as JobStatus).state)) { shutdown(); return; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
      // Terminal facts never wait on a socket query. The safety tick refreshes missed status pushes.
      const stopping = fs.existsSync(stopFile);
      if (stopping) diskDirty = true;
      if (!tabClosed && !stopping && (refreshAgent || !current.pid_start_time)) {
        const { aborted } = await withEffect('query', async (signal) => {
          if (refreshAgent) await seed(signal);
          if (!current.pid_start_time && !signal.aborted) {
            const info = (await request('pane.process_info', { pane_id: pane }, { signal }))?.result?.process_info;
            const pid = info?.foreground_processes?.find((item) => item.pid && item.pid !== info.shell_pid)?.pid;
            if (!signal.aborted && pid) { current.pid = pid; current.pid_start_time = procStat(pid)?.start ?? null; }
          }
        });
        if (stopped || aborted) return;
      }
      let observed = collect(isTick);
      if (sendInFlight && !observed.close && !terminalFact(observed)) { clearTimeout(deadline); return; }
      let next = judge(prev, observed, Date.now());
      if (next.action === 'sample') {
        observed = { ...observed, liveChild: sampleChild() };
        next = judge(prev, observed, Date.now());
      }
      if (next.action === 'collect-sonic') {
        const { open, uncollected } = sonicChildren(dir);
        if (open || !uncollected.length) { wake(); return; }
        const prompt = withDonePrompt(sonicCollectPrompt(dir, output, uncollected, tools), bundled, dir, writeTurn(dir, { by: 'hud' }), cli.agent);
        const { result, aborted } = await effect('sonic', ['agent', 'prompt', name, prompt]);
        if (stopped || aborted) return;
        diskDirty = true;
        if (!result.ok) {
          const after = collect(false);
          if (!after.close && !terminalFact(after)) throw new Error('sonic collect prompt failed');
        }
        wake(); return;
      }
      if (next.action === 'decide') {
        const read = await effect('read', ['pane', 'read', pane, '--source', 'recent']);
        if (stopped || read.aborted) return;
        diskDirty = true;
        const mid = collect(false, true);
        if (!stillQuiet(observed, mid)) { wake(); return; }
        const { result: decision, aborted } = quietQuestions >= 3
          ? { aborted: false, result: { choice: null, probability: null, action: 'needs-human' as const, reason: 'max-questions', asked: false } }
          : await withEffect('decide', (signal) => decideQuietJob({ hudHome, jobId: job.job, role: job.role, agent: cli.agent,
              jobState: current.state, backgroundChildAlive: mid.liveChild as false,
              minutesQuiet: Math.max(0, Math.round((Date.now() - next.quietSince!) / 60000)),
              beforeRequest: () => { if (fs.existsSync(stopFile)) terminalWake(); },
              paneText: read.result.body?.result?.read?.text ?? '', reportPromptSent, questionIndex: quietQuestions + 1, signal }));
        if (decision.asked) quietQuestions += 1;
        if (stopped || aborted) return;
        diskDirty = true;
        const latest = collect(false, true);
        if (!stillQuiet(observed, latest)) { wake(); return; }
        observed = latest;
        let prompted = false;
        if (decision.action === 'prompt-report') {
          reportPromptSent = true;
          const sent = writeTurn(dir, { by: 'hud', reportPromptSent: true });
          const prompt = withDonePrompt(tools ? 'If work remains, finish it first.' :
            `Write your report to ${output} now; if work remains, finish it first.`, bundled, dir, sent, cli.agent);
          const reply = await effect('prompt', ['agent', 'prompt', name, prompt]);
          if (stopped || reply.aborted) return;
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
        if (issue) {
          deferredQuit = true;
          console.error(`pre-quit snapshot: ${issue}; deferring quit to watcher`);
        } else {
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

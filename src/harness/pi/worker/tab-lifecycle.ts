/** Tab Pi worker lifecycle: STATUS writer, session link, sync/async ask steering, Sonic collection, idle grace, stop, and clean exit. */
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { JobStatus } from '../../../mcp/job-contracts.js';
import { jobFiles } from '../../../mcp/paths.js';
import { recordQuestionTimeout } from '../../../roles/job-archive.js';
import { getJobIndexCache } from '../../../roles/job-index-cache.js';
import { formatSelectionMessage } from '../../../roles/select-send.js';
import { markSelectionNotesDelivered, pendingSelectionNotes } from '../../../roles/selection-excerpts.js';
import { writeJsonPrivate } from '../../../utils/atomic-fs.js';
import { procStat } from '../../../utils/proc.js';
import { readQuestionAnswer, watchQaDir, type PublishedQuestion } from '../../../worker/qa.js';
import { sonicChildren, sonicCollectPrompt } from '../../../worker/sonic-jobs.js';
import type { WorkerAgentQueue, WorkerContext, WorkerPi } from './host.js';
import { DEFAULT_WARM_CAP_USD, exitDecision, idleGraceMs, lifecycle, warming } from './tab-policy.js';

export const ASYNC_ANSWER_TYPE = 'hud-orchestrator-answer';
const SELECTION_NOTE_TYPE = 'hud-selection-note';
const ASYNC_DELIVERY_TIMEOUT_MS = 20_000;
const ASYNC_FALLBACK_POLL_MS = 2_000;
const SONIC_RETRY_MS = 2_000;

type QueuedMessage = Parameters<WorkerAgentQueue['followUp']>[0];
const observedQueues = new WeakSet<WorkerAgentQueue>();
const queuedUserFollowUps = new WeakSet<QueuedMessage>();

function observeUserFollowUps(queue: WorkerAgentQueue): void {
  if (observedQueues.has(queue)) return;
  const followUp = queue.followUp;
  // Pi's message events don't distinguish steers from follow-ups. Remember the exact object
  // handed to the native follow-up queue, without changing the queue, its text or its drain order.
  queue.followUp = function (message) {
    followUp.call(this, message);
    if (message.role === 'user') queuedUserFollowUps.add(message);
  };
  observedQueues.add(queue);
}

export interface TabTiming {
  now: () => number;
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface TabLifecycleOptions {
  taskDir: string;
  role: string;
  profile: string;
  effortSource?: string;
  warmCapUsd?: number;
  timing?: TabTiming;
  watchQa?: boolean;
  agentQueue?: WorkerAgentQueue;
  fatal?: (reason: string) => never;
}

export interface TabLifecycleController {
  canAskAsync(ctx: WorkerContext, qaDir: string): boolean;
  trackQuestion(ctx: WorkerContext, question: PublishedQuestion, timeoutMs: number): string;
  reportPublished(ctx: WorkerContext): void;
  isSettled(): boolean;
  disable(ctx: WorkerContext): void;
}

type AsyncQuestion = {
  question: PublishedQuestion;
  deadline: number;
  timeoutMs: number;
  sentAt?: number;
  deliveryOverdue?: boolean;
};

function signature(file?: string): string | null {
  if (!file) return null;
  try {
    const s = statSync(file, { bigint: true });
    return s.isFile() && s.size > 0 ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
  } catch {
    return null;
  }
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return join(canonical(dirname(file)), basename(file));
  }
}

function defaultFail(reason: string): never {
  console.error(`[hud-worker] ${reason}`);
  process.exit(2);
}

export function installTabLifecycle(pi: WorkerPi, options: TabLifecycleOptions): TabLifecycleController {
  if (options.agentQueue) observeUserFollowUps(options.agentQueue);
  const timing: TabTiming = options.timing ?? {
    now: () => performance.now(),
    schedule: setTimeout,
    cancel: clearTimeout,
  };
  const policy = lifecycle(options.profile);
  const fatal = options.fatal ?? defaultFail;
  const watchQa = options.watchQa ?? options.timing === undefined;
  const warmCapUsd = options.warmCapUsd ?? DEFAULT_WARM_CAP_USD;
  const pidStartTime = procStat(process.pid)?.start ?? null;

  let taskDir = options.taskDir;
  let outputPath = join(taskDir, jobFiles.report);
  let statusFile = join(taskDir, jobFiles.status);
  let qaRoot = join(taskDir, jobFiles.qa);

  let enabled = false;
  let disabled = false;
  let settled = false;
  let turnStarted = false;
  let closing = false;
  let failed = false;
  let outputWritten = false;
  let baseline: string | null = null;
  let declaredReport: string | null = null;
  let waitingToSettle = false;
  let runError: string | null = null;
  let generation = 0;
  let deadline: number | undefined;
  let deadlineAt: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const questions = new Set<string>();
  const asyncQuestions = new Map<string, AsyncQuestion>();
  let questionTimer: ReturnType<typeof setTimeout> | undefined;
  let stopQaWatch: (() => void) | undefined;

  let admitted = 0;
  let admittedCount = 0;
  let lastDecision: string | null = null;
  let state: JobStatus['state'] = 'working';
  let error: string | null = null;
  let exitReason: string | null = null;
  let started = '';
  let ended: string | null = null;
  let settledAt: string | null = null;
  let lastSnapshot = '';
  let linkedSession: string | undefined;
  let stagedNotes: string[] = [];
  const stagedFollowUpNotes = new WeakMap<QueuedMessage, { ids: string[]; block: { type: 'text'; text: string } }>();
  const deliveredNotes = new Set<string>(); // If receipt I/O fails, don't inject the same notes again in this worker.

  const active = () => enabled && !disabled;
  const stopRequested = () => existsSync(`${statusFile}.stop-requested`);

  function projected(): JobStatus['state'] {
    if (closing) return stopRequested() ? 'stopped' : failed ? 'failed' : 'closed';
    if (questions.size || asyncQuestions.size) return 'waiting_orchestrator';
    return state;
  }

  function linkSession(sessionFile: string | undefined): void {
    if (!sessionFile || sessionFile === linkedSession) return;
    const target = resolve(sessionFile);
    const directory = join(taskDir, 'sessions');
    const link = join(directory, basename(target));
    if (link !== target) {
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        try {
          symlinkSync(target, link);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || readlinkSync(link) !== target) throw err;
        }
      } catch (err) {
        console.error(`[hud-worker] session link failed (ignored): ${err}`);
      }
    }
    linkedSession = sessionFile;
  }

  function publish(ctx: WorkerContext): void {
    if (!active()) return;
    if (!ownsPendingQuestions(ctx)) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    linkSession(sessionFile);
    const snapshot: Omit<JobStatus, 'updated_at'> & {
      effort_source: string;
      warm: { admitted_count: number; admitted_usd: number; cap_usd: number; last_decision: string | null };
    } = {
      version: 1,
      task_dir: taskDir,
      slot: 'primary',
      harness: 'pi',
      role: options.role,
      session_id: ctx.sessionManager.getSessionId(),
      session_file: sessionFile ?? null,
      pid: process.pid,
      pid_start_time: pidStartTime,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      thinking: pi.getThinkingLevel(),
      state: projected(),
      output_path: outputPath,
      output_written: outputWritten,
      effort_source: options.effortSource ?? 'role-default',
      settled_at: settledAt,
      warm: { admitted_count: admittedCount, admitted_usd: admitted, cap_usd: warmCapUsd, last_decision: lastDecision },
      started_at: started,
      idle_deadline_at: deadlineAt,
      ended_at: ended,
      exit_reason: closing && stopRequested() ? 'stop requested' : exitReason,
      error: closing && stopRequested() ? null : error,
    };
    const undelivered = [...asyncQuestions].filter(([, q]) => q.deliveryOverdue).map(([id]) => id);
    if (undelivered.length) snapshot.reason = `Undelivered HUD decision (${undelivered.join(', ')}): Pi has not acknowledged delivery; still waiting`;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSnapshot) return;
    try {
      writeJsonPrivate(statusFile, { ...snapshot, updated_at: new Date().toISOString() }, { mkdir: false });
      lastSnapshot = serialized;
    } catch (err) {
      error = `STATUS persistence failed: ${err}`;
      failed = true;
      console.error(`[hud-worker] ${error}`);
    }
  }

  function cancelTimer(): void {
    if (timer !== undefined) timing.cancel(timer);
    timer = undefined;
  }

  function cancelQuestionTimer(): void {
    if (questionTimer !== undefined) timing.cancel(questionTimer);
    questionTimer = undefined;
  }

  function closeQaWatch(): void {
    stopQaWatch?.();
    stopQaWatch = undefined;
  }

  function clearAsyncQuestions(): void {
    cancelQuestionTimer();
    closeQaWatch();
    asyncQuestions.clear();
  }

  function ownsStatus(ctx: WorkerContext): boolean {
    try {
      const current = JSON.parse(readFileSync(statusFile, 'utf8')) as Partial<JobStatus>;
      return (
        current.pid === process.pid &&
        current.pid_start_time === pidStartTime &&
        current.session_id === ctx.sessionManager.getSessionId() &&
        !['stopped', 'closed', 'failed'].includes(current.state ?? '')
      );
    } catch {
      return false;
    }
  }

  function ownsPendingQuestions(ctx: WorkerContext): boolean {
    if (!asyncQuestions.size || ownsStatus(ctx)) return true;
    // A replacement or terminal owner, not this runtime, now controls the job.
    clearAsyncQuestions();
    cancelTimer();
    disabled = true;
    return false;
  }

  function canAskAsync(ctx: WorkerContext, dir: string): boolean {
    return (
      ctx.mode === 'tui' &&
      active() &&
      !closing &&
      !failed &&
      !stopRequested() &&
      canonical(dir) === qaRoot &&
      ownsStatus(ctx)
    );
  }

  function scheduleQuestions(ctx: WorkerContext, useDeadlines = true): void {
    if (!asyncQuestions.size) {
      cancelQuestionTimer();
      closeQaWatch();
      return;
    }
    if (watchQa && !stopQaWatch) {
      stopQaWatch = watchQaDir(qaRoot, () => {
        cancelQuestionTimer();
        pollQuestions(ctx);
      });
    }
    if (questionTimer !== undefined) return;
    let ms = ASYNC_FALLBACK_POLL_MS;
    if (useDeadlines) {
      const now = timing.now();
      const idle = ctx.isIdle?.() ?? true;
      for (const q of asyncQuestions.values()) {
        if (q.sentAt === undefined) ms = Math.min(ms, q.deadline - now);
        else if (idle && !q.deliveryOverdue) ms = Math.min(ms, q.sentAt + ASYNC_DELIVERY_TIMEOUT_MS - now);
      }
    }
    questionTimer = timing.schedule(() => pollQuestions(ctx), Math.max(1, Math.ceil(ms)));
  }

  function trackQuestion(ctx: WorkerContext, question: PublishedQuestion, timeoutMs: number): string {
    const requestId = `q${question.n}`;
    asyncQuestions.set(requestId, { question, timeoutMs, deadline: timing.now() + timeoutMs });
    publish(ctx);
    scheduleQuestions(ctx);
    return requestId;
  }

  function reportPublished(ctx: WorkerContext): void {
    if (!active() || closing || !asyncQuestions.size) return;
    // An answer already written can still be waiting on the fs.watch debounce. Steer it as usual.
    cancelQuestionTimer();
    pollQuestions(ctx);
    declaredReport = signature(outputPath);
  }

  function pollQuestions(ctx: WorkerContext): void {
    questionTimer = undefined;
    if (!active() || closing) {
      clearAsyncQuestions();
      return;
    }
    if (!ownsPendingQuestions(ctx)) return;
    const idle = ctx.isIdle?.() ?? true;
    if (stopRequested()) {
      if (idle) settleTurn(ctx, false);
      else {
        ctx.abort();
        scheduleQuestions(ctx, false);
      }
      return;
    }
    if (ctx.signal?.aborted) {
      scheduleQuestions(ctx, false);
      return;
    }
    const now = timing.now();
    const reportStands = declaredReport !== null && declaredReport !== baseline && declaredReport === signature(outputPath);
    for (const [requestId, pending] of asyncQuestions) {
      if (pending.sentAt !== undefined) {
        // Publish the undelivered decision through the normal main-session escalation, but keep the steer queued.
        if (idle && !pending.deliveryOverdue && now - pending.sentAt >= ASYNC_DELIVERY_TIMEOUT_MS) {
          pending.deliveryOverdue = true;
          publish(ctx);
        }
        continue;
      }
      const { question, timeoutMs, deadline: qDeadline } = pending;
      let answer: string | undefined;
      try {
        if (timeoutMs > 0) answer = readQuestionAnswer(question, question.questionMtimeMs + timeoutMs);
      } catch {
        /* An unreadable answer is not a decision. Retry until timeout. */
      }
      if (!answer && now < qDeadline) continue;
      if (!answer && (reportStands || timeoutMs > 0)) {
        const recorded = recordQuestionTimeout(taskDir, requestId, undefined, reportStands);
        if (reportStands && !recorded) {
          // Don't publish a clean settlement that still looks like it has an open question.
          failed = true;
          error ??= `could not record timeout for ${requestId}`;
        }
      }
      if (reportStands) {
        // The worker already declared its report. Retain the reply in Pi history, but don't
        // start a new turn (or apply a timeout default) for a decision the report didn't need.
        asyncQuestions.delete(requestId);
        if (!answer) continue;
      } else {
        pending.sentAt = now; // Never send twice, including while queued for a busy Pi.
      }
      const content = answer
        ? `ANSWER from the orchestrator (${requestId}${reportStands ? ', moot: report already published' : ''}):\n\n${answer}`
        : `No answer to ${requestId} within ${timeoutMs / 1000}s. Proposed default: ${question.default.trim()}. Proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report.`;
      pi.sendMessage(
        {
          customType: ASYNC_ANSWER_TYPE,
          content: `${content}\n\nQuestion (${requestId}): ${question.question.trim()}`,
          display: true,
          details: { requestId, answered: !!answer, ...(reportStands && { moot: true }) },
        },
        { triggerTurn: !reportStands, deliverAs: 'steer' }
      );
    }
    scheduleQuestions(ctx);
    if (reportStands && !asyncQuestions.size) {
      if (waitingToSettle) settleTurn(ctx, false);
      else publish(ctx);
    }
  }

  function disable(ctx: WorkerContext): void {
    ownsPendingQuestions(ctx);
    cancelTimer();
    clearAsyncQuestions();
    generation++;
    if (active()) {
      failed = true;
      closing = true;
      error = 'dispatch disabled after role/session replacement';
      ended = new Date().toISOString();
      publish(ctx);
    }
    disabled = true;
  }

  function checkExit(ctx: WorkerContext, expected: number): void {
    if (!active() || closing || !policy) return;
    const decision = exitDecision({
      lifecycle: policy,
      settled,
      outputWritten,
      failed,
      idle: ctx.isIdle?.() ?? true,
      pendingMessages: ctx.hasPendingMessages?.() ?? false,
      pendingQuestions: questions.size + asyncQuestions.size,
      generation,
      expectedGeneration: expected,
      now: timing.now(),
      deadline,
    });
    if (decision === 'wait') return;
    cancelTimer();
    closing = true;
    failed = decision === 'failed';
    ended = new Date().toISOString();
    exitReason = failed ? (error ?? 'output missing, empty or unchanged') : 'settled';
    publish(ctx);
    // Under herdr-hud direct-exec (`on_exit: close_on_zero`), exiting 0 closes the tab cleanly.
    // Keep failed tabs open for the failure-retention window (reaped by HUD's `reapDirect`);
    // clean settlements and explicit stops shut Pi down natively (exit 0).
    if (decision === 'closed' || stopRequested()) ctx.shutdown?.();
  }

  function deferredExit(ctx: WorkerContext): void {
    const expected = generation;
    setImmediate(() => checkExit(ctx, expected));
  }

  function arm(ctx: WorkerContext): void {
    cancelTimer();
    if (deadline === undefined) return;
    const expected = generation;
    timer = timing.schedule(() => {
      timer = undefined;
      if (!active() || closing || generation !== expected) return;
      // Node can deliver a timeout fractionally early even with a rounded delay. Re-arm the same
      // fixed deadline, not a polling interval or a new grace period, while retaining only one timer.
      if (deadline !== undefined && timing.now() < deadline) {
        arm(ctx);
        return;
      }
      checkExit(ctx, expected);
    }, Math.max(0, Math.ceil(deadline - timing.now())));
  }

  function settleTurn(ctx: WorkerContext, aborted: boolean): void {
    if (!active() || closing || !ownsPendingQuestions(ctx)) return;
    const cancelledQuestions = asyncQuestions.size > 0;
    if (cancelledQuestions) {
      if (!aborted && !runError && !failed && !stopRequested()) {
        waitingToSettle = true;
        return;
      }
      failed = true;
      error ??= `${aborted ? 'agent aborted' : runError ?? 'stop requested'}; unresolved HUD decisions: ${[...asyncQuestions.keys()].join(', ')}`;
      clearAsyncQuestions();
    }
    waitingToSettle = false;
    if (!cancelledQuestions && !stopRequested()) {
      const retry = () => {
        // Keep STATUS working, without a grace deadline, until the children settle.
        cancelTimer();
        timer = timing.schedule(() => {
          timer = undefined;
          settleTurn(ctx, aborted);
        }, SONIC_RETRY_MS);
      };
      try {
        const { open, uncollected, remind } = sonicChildren(taskDir);
        if (open) return retry();
        if (uncollected.length && !aborted && !runError && !failed) {
          cancelTimer();
          baseline = signature(outputPath); // A report written before collection cannot settle this turn.
          if (remind.length) {
            // Keep HUD's wake out of both user note-delivery paths, whether queued or starting a run.
            pi.sendMessage(
              { customType: 'hud-sonic-collect', content: sonicCollectPrompt(taskDir, outputPath, remind), display: true },
              { triggerTurn: true, deliverAs: 'followUp' }
            );
          }
          return;
        }
      } catch {
        return retry(); // Missing lifecycle evidence does not authorize settlement.
      }
    }
    settled = true;
    turnStarted = false;
    settledAt = new Date().toISOString();
    const current = signature(outputPath);
    outputWritten = !cancelledQuestions && current !== null && current !== baseline;
    failed ||= aborted || runError !== null || !outputWritten;
    if (failed) error ??= aborted ? 'agent aborted' : runError ?? 'output missing, empty or unchanged';
    const grace = policy === 'implementer' && !failed;
    const ttl = grace ? idleGraceMs(ctx.model, process.env.PI_CACHE_RETENTION) : 0;
    deadline = grace ? timing.now() + ttl : undefined;
    deadlineAt = grace ? new Date(Date.now() + ttl).toISOString() : null;
    state = grace ? 'idle_grace' : 'working';
    publish(ctx);
    if (grace) arm(ctx);
    deferredExit(ctx);
  }

  // Registered after roleRuntime's session_start so model/thinking/tools are verified first.
  pi.on('session_start', (event, ctx) => {
    if (event?.reason && event.reason !== 'startup') {
      disabled = true;
      return;
    }
    try {
      if (!policy) throw Error(`unsupported tab profile: ${options.profile}`);
      taskDir = realpathSync(options.taskDir);
      if (!statSync(taskDir).isDirectory()) throw Error('task-dir is not a directory');
      outputPath = canonical(join(taskDir, jobFiles.report));
      statusFile = join(taskDir, jobFiles.status);
      qaRoot = canonical(join(taskDir, jobFiles.qa));
      enabled = true;
      started = new Date().toISOString();
      publish(ctx);
    } catch (err) {
      fatal(String(err));
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (!active() || closing) return;
    cancelTimer();
    generation++;
    settled = false;
    deadline = undefined;
    deadlineAt = null;
    runError = null;
    // Keep the turn's original report baseline across internal follow-ups (e.g., hud-sonic-ready)
    // until this turn actually settles; async ask and uncollected-Sonic reminders advance it explicitly.
    if (!turnStarted) {
      baseline = signature(outputPath);
      turnStarted = true;
    }
    declaredReport = null;
    waitingToSettle = false;
    outputWritten = false;
    settledAt = null;
    state = 'working';
    publish(ctx);
    stagedNotes = [];
    if (event?.messageType !== 'user') return;
    const notes = loadNotes();
    if (!notes) return;
    stagedNotes = notes.ids;
    return { message: { customType: SELECTION_NOTE_TYPE, content: notes.content, display: true } };
  });

  function loadNotes() {
    if (!active() || closing || stopRequested() || existsSync(join(taskDir, jobFiles.closeRequested))) return;
    const home = dirname(dirname(taskDir)), target = basename(taskDir);
    const fields = getJobIndexCache(home).readSession(target)?.fields;
    if (!fields?.launchId || fields.pid !== String(process.pid) || fields.pidStart !== pidStartTime) return;
    try {
      const pending = pendingSelectionNotes(home, target, fields.launchId);
      // Receipt failures shouldn't accumulate IDs after their records are no longer pending.
      for (const id of deliveredNotes) if (!pending.some(note => note.id === id)) deliveredNotes.delete(id);
      const notes = pending.filter(row => !deliveredNotes.has(row.id));
      if (!notes.length) return;
      return { ids: notes.map(row => row.id), content: notes.map(row => formatSelectionMessage(row)).join('\n\n') };
    } catch { /* An unavailable note store must not prevent a worker prompt. */ }
  }

  pi.on('message_start', ({ message }, ctx) => {
    if (message.role === 'user' && queuedUserFollowUps.delete(message)) {
      const notes = loadNotes();
      if (!notes) return;
      const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      if (!Array.isArray(content)) return;
      // At this point pi has drained the follow-up and normalized its attachments. It uses this
      // same message for message_end, session persistence and the next assistant request.
      const block = { type: 'text' as const, text: `\n\n${notes.content}` };
      message.content = [...content, block];
      stagedFollowUpNotes.set(message, { ids: notes.ids, block });
      return;
    }
    if (message.role !== 'custom' || message.customType !== ASYNC_ANSWER_TYPE) return;
    const id = (message.details as { requestId?: string } | undefined)?.requestId;
    if (!id || asyncQuestions.get(id)?.sentAt === undefined || stopRequested() || !ownsPendingQuestions(ctx)) return;
    asyncQuestions.delete(id);
    declaredReport = null;
    if (!asyncQuestions.size) {
      cancelQuestionTimer();
      closeQaWatch();
      // Require fresh output after the final decision, not an interim report written while waiting.
      baseline = signature(outputPath);
    }
    publish(ctx);
  });

  async function acknowledgeNotes(ids: string[]): Promise<void> {
    for (const id of ids) deliveredNotes.add(id);
    try {
      await markSelectionNotesDelivered(dirname(dirname(taskDir)), deliveredNotes);
      deliveredNotes.clear();
    } catch { /* Keep the in-process fence even if the receipt cannot be written. */ }
  }

  pi.on('message_end', async ({ message }) => {
    if (message.role === 'user') {
      const notes = stagedFollowUpNotes.get(message);
      stagedFollowUpNotes.delete(message);
      if (notes && Array.isArray(message.content) && message.content.includes(notes.block)) await acknowledgeNotes(notes.ids);
      return;
    }
    if (message.role === 'custom' && message.customType === SELECTION_NOTE_TYPE && stagedNotes.length) {
      const ids = stagedNotes;
      stagedNotes = [];
      await acknowledgeNotes(ids);
      return;
    }
    if (message.role !== 'assistant') return;
    if (message.stopReason === 'error') runError = message.errorMessage?.trim() || 'error';
    else if (message.stopReason === 'aborted') runError = 'aborted';
    else runError = null;
  });

  pi.on('tool_execution_start', (event, ctx) => {
    if (active() && !closing && event?.toolName === 'hud_ask' && event.toolCallId) {
      questions.add(event.toolCallId);
      publish(ctx);
    }
  });

  pi.on('tool_execution_end', (event, ctx) => {
    if (event?.toolCallId && questions.delete(event.toolCallId)) {
      publish(ctx);
      deferredExit(ctx);
    }
  });

  pi.on('agent_settled', (event, ctx) => settleTurn(ctx, Boolean(event?.aborted)));

  pi.on('cache_warming_decision', (event, ctx) => {
    const decision = warming({
      cap: warmCapUsd,
      admitted,
      warmCost: event.warmCost,
      action: event.action,
      closing: closing || failed || disabled,
      settled: settled || (asyncQuestions.size > 0 && (ctx.isIdle?.() ?? true)),
    });
    if (decision.action === 'warm') {
      admitted = decision.admitted;
      admittedCount++;
    }
    lastDecision = decision.action;
    publish(ctx);
    return { action: failed ? ('stop' as const) : decision.action };
  });

  pi.on('model_select', (event, ctx) => {
    if (active() && settled && deadline !== undefined) {
      deadline = Math.min(deadline, timing.now() + idleGraceMs(event?.model ?? ctx.model, process.env.PI_CACHE_RETENTION));
      deadlineAt = new Date(Date.now() + Math.max(0, deadline - timing.now())).toISOString();
      arm(ctx);
    }
    publish(ctx);
  });

  pi.on('thinking_level_select', (_event, ctx) => publish(ctx));

  pi.on('session_tree', (_event, ctx) => {
    if (active()) disable(ctx);
  });

  pi.on('session_shutdown', (event, ctx) => {
    ownsPendingQuestions(ctx);
    if (asyncQuestions.size) {
      error ??= `external shutdown: ${event?.reason ?? 'unknown'}; unresolved HUD decisions: ${[...asyncQuestions.keys()].join(', ')}`;
    }
    cancelTimer();
    clearAsyncQuestions();
    generation++;
    if (!active()) return;
    if (!closing) {
      if (state === 'idle_grace' && settled && outputWritten && !failed) exitReason = 'shutdown during idle grace';
      else {
        failed = true;
        error ??= `external shutdown: ${event?.reason ?? 'unknown'}`;
        exitReason = error;
      }
    }
    closing = true;
    ended ??= new Date().toISOString();
    publish(ctx);
    enabled = false;
  });

  return { canAskAsync, trackQuestion, reportPublished, isSettled: () => settled || closing, disable };
}

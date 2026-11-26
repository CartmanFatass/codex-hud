/** Orchestrator tool operations and session change delivery. */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AnswerResult } from '../../collectors/panel-actions.js';
import { readJobProgress, jobRowReportMeta, jobChanges, failedAttempt, type JobRow } from '../../collectors/thin-jobs.js';
import type { ReportMetaFields } from '../../roles/report-meta.js';
import { removeQueuedJob } from '../../roles/concurrency.js';
import { HarnessSwitchError } from '../../roles/harness-switches.js';
import { herdrId, runHerdr, runCommand } from '../../roles/herdr-run.js';
import { isShellLaunchedWorker, SHELL_WORKER_UNSUPPORTED } from '../../runtime/herdr-socket.js';
import { CHECKS_FILE, jobChecks } from '../../roles/job-checks.js';
import { recordQuestionAnswer, recordStopOrigin } from '../../roles/job-archive.js';
import { JOB_ID_RE } from '../../roles/job-index-cache.js';
import { packageJobFilter, projectJobFilter } from '../../roles/job-project.js';
import { takeLease } from '../../roles/lease.js';
import { ensureQueueWatcher, paneInfo, watching, notify } from '../../roles/notify.js';
import { piSwitches } from '../../roles/roster.js';
import { ROLE_TOOLS as tools } from '../../roles/tool-definitions.js';
import { reapWorkerTree, tabTreeGrant } from '../../roles/worker-tree.js';
import { readFileBounded, writePrivateFile } from '../../utils/atomic-fs.js';
import { waitUntilFs, type WatchTarget } from '../../utils/fs-wait.js';
import { reportReadHint } from '../../utils/report-summary.js';
import { required, jobCwd, type Args } from '../dispatch/context.js';
import { prepareCouncil, synthesisTemplate } from '../dispatch/council.js';
import { requestPrewalkStop } from '../prewalk-flow.js';
import { sendJob, dispatchJob, resumeJob } from '../dispatch/orchestrator.js';
import { registry, harnessSwitchFailure, compactAssignment } from '../dispatch/places.js';
import { paneText, ensureWatcher } from '../dispatch/proc.js';
import { jobCallerPane } from '../../roles/job-pane.js';
import type { AnswerActor, Job } from '../job-contracts.js';
import { wakeWorkflow } from '../../workflows/wake.js';
import { batchView, controlBatch, startBatch } from '../batch.js';
import { runVisible } from '../../workflows/scope.js';
import { headerScanner } from '../../workflows/header-scan.js';
import { batchEvents, isBatchId, type Batch } from '../batch-state.js';
import { landView, isFlowId, recoverLand } from '../land-state.js';
import { workflowEvents } from '../../workflows/events.js';
import { startLand, landTask } from '../land.js';
import { readyTickets, editTickets } from '../local-tickets.js';
import { editObjectives, type RequestCaller } from '../local-objectives.js';
import { callSchedule } from '../local-schedule.js';
import { answerTicketQueueHandback, resumeQueueAfterAnswer, startTicketQueue, ticketQueueTask } from '../ticket-queue.js';
import { isTicketQueueId, readTicketQueue, ticketQueueView } from '../ticket-queue-state.js';
import { gitSummary } from '../managed-worktree.js';
import { panelDelivery } from '../panel-delivery.js';
import { binScript, jobFiles } from '../paths.js';
import { settleStoppedPi } from '../pi-stop-settlement.js';
import { stopSonic } from '../sonic-process.js';
import {
  directory, readRow, jobCache, isWorker, findJob, settled, jobsRoot, slice, digestLine, fallbackResultLine,
  openQuestions, hudHome, bundled, writeScan, publishWorkSummary, findJobMutable, save, readCachedStatus,
  type JobScan,
} from '../store/job-store.js';
import { keyLock } from '../store/key-lock.js';
import { rememberLandTask } from '../task-bounds.js';
import { ensureJobWatcher } from '../watch-pid.js';
import {
  ownsJob, sessionJobs, adoptSessionJobs, callerPane, session, rememberCallerHarness, deliveryHint,
  sessionRows, tries, answers, refreshModWatch,
} from './session-state.js';
import {
  landTasks, landActive, saveTaskReceipt, TASK_TTL, isTaskReply, activeTasks, taskFence, sampleTask,
  beginTask, needsAttention, extendTask, registerBatchTask, finishTask, releaseTask, batchTasks, taskLabel,
  updateTask, ensureBatchTimer, stopBatchDelivery, drainBatchChanges,
} from './tasks.js';

function compactRow(row: JobRow) {
  const reason = row.blocked || row.state === 'waiting_orchestrator' || row.display_state === 'failed' ? row.reason : null;
  return {
    job: row.job,
    role: row.role,
    ...(row.overflow_from ? { overflow_from: row.overflow_from } : {}),
    state: row.state ?? row.display_state,
    ...(row.queue_position !== undefined ? { queue_position: row.queue_position } : {}),
    ...(row.report_unread ? { report_unread: true } : {}),
    ...(row.blocked ? { blocked: true } : {}),
    ...(row.question_ids.length ? { question_ids: row.question_ids } : {}),
    ...(reason ? { reason } : {}),
  };
}

async function peekJob(job: Job, { lines, detail }: Args, scan: JobScan) {
  const dir = directory(job.job);
  const { row } = readRow(job, false, scan);
  const summary = {
    status: compactRow(row),
    ...readJobProgress(dir),
    ...(detail === true ? { diagnostics: { ...jobDiagnostics(job), display_state: row.display_state } } : {}),
  };
  if (lines === undefined) return summary;
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 120)
    throw new Error('invalid_arguments: lines');
  const pane = jobCache.readSession(job.job)?.fields.left;
  if (!herdrId(pane) || pane.startsWith('-')) return { ...summary, pane_lines: null, pane_reason: 'no pane' };
  const result = await runHerdr(['pane', 'read', pane, '--source', 'recent'], process.env, { budgetMs: 1000 });
  if (!result.ok) return { ...summary, pane_lines: null, pane_reason: result.reason };
  const output = paneText(result.stdout).replace(/\r?\n$/, '');
  return { ...summary, pane_lines: output ? output.split(/\r?\n/).slice(-lines) : [] };
}

function listReportSummary(row: JobRow) {
  const summary = jobRowReportMeta(row, directory(row.job))?.summary;
  return summary ? { summary: [...summary].slice(0, 120).join('') } : {};
}

function listJobs(recent: boolean, scan: JobScan) {
  const newest = scan.all().filter(projectJobFilter(process.cwd())).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const children = new Map<string, number>();
  for (const { parent_job } of newest) {
    if (parent_job) children.set(parent_job, (children.get(parent_job) ?? 0) + 1);
  }
  const childCount = (id: string) => children.has(id) ? { child_count: children.get(id) } : {};
  const recentLimit = 20;
  if (recent) {
    const rows = newest.slice(0, recentLimit).map((job) => {
      const { row } = readRow(job, !isWorker, scan);
      return {
        job: row.job,
        ...(row.parent_job ? { parent_job: row.parent_job } : {}),
        ...childCount(row.job),
        role: row.role,
        ...(row.overflow_from ? { overflow_from: row.overflow_from } : {}),
        ...(job.instructions_from && { instructions_from: job.instructions_from }),
        state: row.state,
        display_state: row.display_state,
        ...(row.queue_position !== undefined ? { queue_position: row.queue_position } : {}),
        reason: row.reason,
        blocked: row.blocked,
        open_questions: row.open_questions,
        report_present: row.report_present,
        report_unread: row.report_unread,
        created_at: job.created_at,
        ...listReportSummary(row),
      };
    });
    return { jobs: rows };
  }
  const candidates = newest.flatMap((job, index) => {
    if (job.parent_job) return [];
    // Scanning beyond recent history must not widen the list's quota side effects.
    const { row } = readRow(job, !isWorker && index < recentLimit, scan);
    const active = row.display_state === 'working' || row.display_state === 'queued';
    if (!active && !(ownsJob(job) && row.report_unread)) return [];
    return [{ row, active, compact: { ...compactRow(row), ...childCount(row.job),
      ...(job.instructions_from && { instructions_from: job.instructions_from }) } }];
  });
  // Keep active work visible. Spend the remaining space on the newest unread reports,
  // reserving room for the single count of those that didn't fit.
  let budget = 2048 - Buffer.byteLength(JSON.stringify({
    jobs: candidates.filter(({ active }) => active).map(({ compact }) => compact),
    older_unread_reports: candidates.length,
  }));
  let older_unread_reports = 0;
  const rows = candidates.flatMap(({ row, active, compact }) => {
    if (active) return [compact];
    if (!older_unread_reports) {
      const preview = { ...compact, ...listReportSummary(row) };
      budget -= 1 + Buffer.byteLength(JSON.stringify(preview));
      if (budget >= 0) return [preview];
    }
    older_unread_reports++;
    return [];
  });
  return { jobs: rows, ...(older_unread_reports ? { older_unread_reports } : {}) };
}

const JOB_WATCH_FILES = new Set<string>([jobFiles.status, jobFiles.job, jobFiles.report, jobFiles.qa, CHECKS_FILE]);
const WAIT_JOB_DIRECT_WATCH_LIMIT = 16;

function jobWatchTargets(dir: string): WatchTarget[] {
  const qaDir = join(dir, jobFiles.qa);
  const list: WatchTarget[] = [
    {
      dir,
      filter: (name) => name === null || JOB_WATCH_FILES.has(name),
    },
  ];
  if (fs.existsSync(qaDir)) {
    list.push({
      dir: qaDir,
      filter: (name) => name === null || /^q\d+(?:\.answer)?\.md$/.test(name),
    });
  }
  return list;
}

async function waitJobs({ jobs: ids, mode = 'any', wait_ms = 60000 }: Args, scan: JobScan) {
  if (mode !== 'any' && mode !== 'all') throw new Error('invalid_arguments: mode');
  if (typeof wait_ms !== 'number' || !Number.isInteger(wait_ms) || wait_ms < 0 || wait_ms > 120000)
    throw new Error('invalid_arguments: wait_ms');
  const deadline = performance.now() + wait_ms;
  const readJob = (id: string) => findJob(id);
  let initial: JobRow[];
  if (ids === undefined) {
    // Existing session jobs may settle while herdr is listing panes; keep the call-start targets.
    const atStart = new Map(sessionJobs(scan).map((job) => [job.job, readRow(job, false, null).row]));
    if (await adoptSessionJobs(scan)) {
      for (const job of sessionJobs(scan)) if (!atStart.has(job.job)) atStart.set(job.job, readRow(job, false, null).row);
    }
    initial = [...atStart.values()].filter((row) => !settled(row.state));
  } else {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !JOB_ID_RE.test(id)))
      throw new Error('invalid_arguments: jobs');
    await adoptSessionJobs(scan);
    initial = [...new Set<string>(ids)].map((id) => {
      const job = readJob(id);
      if (!job) throw new Error(`invalid_arguments: unknown job ${id}`);
      return readRow(job, false, null).row;
    });
  }
  const targets = new Set(initial.map((row) => row.job));
  function result(rows: JobRow[], timedOut = false) {
    const allSettled = mode === 'all' && rows.length === targets.size && rows.every((row) => settled(row.state));
    const triggered = rows.filter((row) => allSettled || (mode === 'any' && settled(row.state)) ||
      row.blocked || row.state === 'waiting_orchestrator' || row.display_state === 'failed' || row.open_questions > 0
    ).map((row) => row.job);
    const ready = targets.size === 0 || triggered.length > 0;
    const timed_out = !ready && (timedOut || performance.now() >= deadline);
    const jobs = ready || timed_out ? rows.map(row => compactRow(row.state === 'queued'
      ? { ...row, queue_position: scan.position(row.job) } : row)) : [];
    return { ready, timed_out, triggered, jobs };
  }
  const sample = () => [...targets].flatMap((id) => {
    const job = readJob(id);
    return job ? [readRow(job, false, null).row] : [];
  });
  let first = true;
  const watchTargets = (): WatchTarget[] =>
    targets.size <= WAIT_JOB_DIRECT_WATCH_LIMIT
      ? [...targets].flatMap((id) => jobWatchTargets(directory(id)))
      : [{
          dir: jobsRoot,
          recursive: true,
          filter: (name) => {
            if (name === null) return true;
            const [id, file] = name.split('/');
            return !id || (targets.has(id) && (!file || JOB_WATCH_FILES.has(file)));
          },
        }];

  return waitUntilFs({
    targets: watchTargets,
    timeoutMs: Math.max(0, deadline - performance.now()),
    isTransientError: (error) => error instanceof SyntaxError,
    check: ({ timedOut }) => {
      const rows = first && ids !== undefined ? initial : sample();
      first = false;
      const next = result(rows, timedOut);
      return next.ready || next.timed_out ? { done: true, value: next } : { done: false };
    },
  });
}

function jobDiagnostics(job: Job) {
  return {
    cwd: job.cwd,
    ...(job.attempts ? { attempts: job.attempts, used_place: job.used_place ?? null } : {}),
    place: job.place,
    ...(job.preset !== undefined ? { preset: job.preset } : {}),
    model: job.model,
    thinking: job.thinking,
    model_source: job.model_source,
    ...(job.cli ? { idle_grace_s: job.cli.idle_grace_s } : {}),
    ...(job.resume_s !== undefined ? { resume_s: job.resume_s } : {}),
    ...(job.cli?.mcp_scope_warning ? { mcp_scope_warning: job.cli.mcp_scope_warning } : {}),
    ...Object.fromEntries([...piSwitches, 'pi_args' as const].map((key) => [key, job[key]])),
    ...(job.role_skills !== undefined
      ? {
          role_skills: job.role_skills,
          skipped_skills: job.skipped_skills ?? [],
          worker_prompt: job.worker_prompt ?? null,
        }
      : {}),
    dispatch_exit_code: job.dispatch_exit_code,
    stderr_tail: job.stderr_tail,
    ...(job.prewalk && { prewalk: job.prewalk }),
    ...(job.resume_failures?.length && { resume_failures: job.resume_failures }),
    ...(job.launch_agent_args && { launch_agent_args: job.launch_agent_args }),
  };
}
type GitSummary = Awaited<ReturnType<typeof gitSummary>>;
function readGit(summary: GitSummary | undefined, full: boolean) {
  if (!summary) return {};
  const { paths, ...git_summary } = summary;
  if (full) return { git_summary };
  const more = (summary.changed_files ?? 0) - (paths?.length ?? 0);
  return {
    changed_files: paths && (more ? [...paths, `+${more} more`] : paths),
    ...(summary.overlaps?.length ? { overlaps: summary.overlaps.map(({ job }) => job) } : {}),
    ...('overlaps_incomplete' in summary && summary.overlaps_incomplete ? { overlaps_incomplete: true } : {}),
  };
}

function reportDigest(report: NonNullable<ReturnType<typeof slice>>, job: string, state: string | null,
  meta: ReportMetaFields | undefined, git: GitSummary | undefined) {
  const verdict = report.text.match(/^[\t ]*(?:[-*] )?(?:\*\*)?verdict(?:\*\*)?:(?:\*\*)?[\t ]*([^\r\n]+)/im)?.[1].trim();
  const blockers = report.text.match(/^[\t ]*(?:[-*] )?(?:\*\*)?blockers?(?:\*\*)?:(?:\*\*)?[\t ]*([^\r\n]+)/im)?.[1].trim();
  const facts = { state, read_hint: reportReadHint(job), report_bytes: report.bytes,
    ...(git ? { changed_files: git.changed_files } : {}),
    ...(verdict ? { verdict: digestLine(verdict, 100) } : {}),
    ...(blockers ? { blockers: digestLine(blockers, 160) } : {}),
    ...(meta?.skip_checks_reason ? { skip_checks_reason: digestLine(meta.skip_checks_reason, 160) } : {}),
    ...(meta?.preview?.path && { preview_path: meta.preview.path }),
    ...(meta?.preview?.error && { preview_error: meta.preview.error }) };
  const budget = 1000 - Buffer.byteLength(JSON.stringify({ ...facts, result: '…' }));
  return { ...facts, result: digestLine(meta?.summary ?? fallbackResultLine(report.text), budget) };
}
const REPORT_PAGE_BYTES = 24 * 1024;

function fullRead({ mode, full }: Args) {
  return mode === 'full' || (mode === undefined && full === true);
}

function readReportPage(path: string, offset: number) {
  try {
    // One lookahead byte tells us if the page edge splits a UTF-8 character or reaches EOF.
    const { bytes, stat } = readFileBounded(path, REPORT_PAGE_BYTES + 1, { followSymlinks: true, offset });
    const boundary = (end: number) => {
      const min = Math.max(0, end - 3);
      while (end > min && (bytes[end] & 0xc0) === 0x80) end--;
      return end;
    };
    let high = Math.min(bytes.length, REPORT_PAGE_BYTES);
    let end = boundary(high);
    let text = bytes.toString('utf8', 0, end);
    // Newlines, quotes and other escapes must also fit in the client's JSON tool result.
    const fits = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2 <= REPORT_PAGE_BYTES;
    if (!fits(text)) {
      let low = 0;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(bytes.toString('utf8', 0, boundary(mid)))) low = mid;
        else high = mid - 1;
      }
      end = boundary(low);
      text = bytes.toString('utf8', 0, end);
    }
    const truncated = end < bytes.length;
    return { text, bytes: stat.size, truncated, next_offset: truncated ? offset + end : undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function observation(
  job: Job,
  full: boolean,
  detail: boolean,
  git: GitSummary | undefined,
  offset: number,
  preRead?: ReturnType<typeof readRow>
) {
  const dir = directory(job.job);
  const { row, status, job: currentJob } = preRead ?? readRow(job, !isWorker);
  const reportPath = join(dir, jobFiles.report);
  const page = full ? readReportPage(reportPath, offset) : null;
  const report = full ? page : row.report_unread ? slice(reportPath, 65536) : null;
  const reportMeta = jobRowReportMeta(row, dir);
  const questions = (preRead ? row.question_ids.map((id) => `${id}.md`) : openQuestions(dir)).map((name) => ({
    id: name.slice(0, -3),
    text: slice(join(dir, jobFiles.qa, name), 2048)?.text ?? '',
  }));
  const progress = readJobProgress(dir);
  const checks = jobChecks(dir, { ...currentJob });
  const exit_reason = typeof status?.exit_reason === 'string' ? status.exit_reason : null;
  return {
    row,
    value: {
      job: currentJob.job,
      role: currentJob.role,
      ...(currentJob.overflow_from ? { overflow_from: currentJob.overflow_from } : {}),
      ...(currentJob.council && { council: currentJob.council }),
      ...(currentJob.council_members && { members: currentJob.council_members, synthesizer: currentJob.synthesizer,
        ...(currentJob.synthesis_job && { synthesis_job: currentJob.synthesis_job }),
        ...(currentJob.synthesizer === 'main' && row.display_state === 'done' && { synthesis_template: synthesisTemplate }) }),
      ...(currentJob.instructions_from && { instructions_from: currentJob.instructions_from }),
      ...(currentJob.route && { route: currentJob.route }),
      state: detail ? row.state : row.state ?? row.display_state,
      ...(row.queue_position !== undefined ? { queue_position: row.queue_position } : {}),
      ...(detail || (row.state !== null && row.state !== row.display_state) ? { display_state: row.display_state } : {}),
      ...(detail || row.reason ? { reason: row.reason } : {}),
      ...(detail || row.blocked ? { blocked: row.blocked } : {}),
      ...(detail || exit_reason ? { exit_reason } : {}),
      ...(full && status?.quiet_decision && typeof status.quiet_decision === 'object' ? { quiet_decision: status.quiet_decision } : {}),
      ...(detail ? jobDiagnostics(currentJob) : {}),
      ...readGit(git, full),
      ...(full && currentJob.worktree ? { worktree: currentJob.worktree } : {}),
      ...(full && currentJob.worktree_removed_at ? { worktree_removed_at: currentJob.worktree_removed_at } : {}),
      ...(full && currentJob.worktree_kept_reason ? { worktree_kept_reason: currentJob.worktree_kept_reason } : {}),
      report_exists: row.report_present,
      ...(full && reportMeta ? { report_meta: reportMeta } : {}),
      ...(detail || (full && row.report_unread) ? { report_unread: row.report_unread } : {}),
      ...(full && (detail || progress.latest_progress) ? progress : { latest_progress: progress.latest_progress ?? undefined }),
      ...(checks ? { checks: full ? checks : { state: checks.state, stale: checks.stale,
        results: checks.results.map(({ command, passed }) => `${passed ? 'pass' : 'fail'}: ${digestLine(command.replace(/\s+/g, ' '), 120)}`) } } : {}),
      ...(row.report_present && !report ? { report_unchanged: true } : report && !full ? {
        digest: reportDigest(report, currentJob.job, row.state ?? row.display_state, reportMeta, git),
      } : {
        ...(page ? {
          report_path: reportPath,
          ...(page.truncated || offset > 0 ? { report_bytes: page.bytes } : {}),
          ...(page.truncated ? { next_offset: page.next_offset } : {}),
        } : {}),
        ...(detail || report ? { report: report?.text ?? null } : {}),
        ...(detail || report?.truncated ? { report_truncated: report?.truncated ?? false } : {}),
      }),
      ...(detail || questions.length ? { questions } : {}),
    },
  };
}

function ticketGuide(args: Args): boolean {
  return args.op === undefined || args.op === 'guide';
}

function itemError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: message.startsWith('invalid_arguments') ? 'invalid_arguments' : 'tool_error', error: message };
}

async function sendJobs(args: Args, dispatcher: Job['dispatcher']) {
  if (args.messages !== undefined) {
    if (args.job !== undefined || args.jobs !== undefined || args.text !== undefined || args.message_key !== undefined ||
        !Array.isArray(args.messages) || !args.messages.length) throw new Error('invalid_arguments: messages');
    const messages = await Promise.all(args.messages.map(async (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: messages' };
      const item = raw as Args;
      const jobId = typeof item.job === 'string' ? item.job : undefined;
      try {
        const id = required(item, 'job');
        const message = required(item, 'text');
        const key = item.message_key === undefined ? undefined : required(item, 'message_key');
        return { job: id, ...await keyLock(`job:${id}`, () => sendJob(id, message, key, false, { batch: true, dispatcher })) };
      } catch (error) {
        return { ...(jobId ? { job: jobId } : {}), ...itemError(error) };
      }
    }));
    return { messages };
  }
  const text = required(args, 'text');
  const key = args.message_key === undefined ? undefined : required(args, 'message_key');
  const send = (id: string, workingOnly: boolean) => keyLock(`job:${id}`, () => sendJob(id, text, key, workingOnly, { dispatcher }));
  if (args.jobs === undefined) return send(required(args, 'job'), false);
  if (args.job !== undefined || !Array.isArray(args.jobs) || !args.jobs.length ||
      args.jobs.some((id) => typeof id !== 'string' || !id)) throw new Error('invalid_arguments: jobs');
  const results = await Promise.all([...new Set<string>(args.jobs)].map(async (job) => ({ job, result: await send(job, true) })));
  const sent: string[] = [], queued: string[] = [], skipped: { job: string; reason: string }[] = [];
  for (const { job, result } of results) {
    if ('sent' in result && result.sent) {
      sent.push(job);
      // Tab sends have already handed off to herdr; headless sends are still on disk.
      if ('queued' in result && result.queued && !('exit_code' in result)) queued.push(job);
    } else skipped.push({ job, reason: ('code' in result && result.code) || 'already_sent' });
  }
  return { sent, skipped, ...(queued.length && { queued }) };
}

export async function call(name: string, args: Args, scan: JobScan, by?: RequestCaller, dispatcher?: Job['dispatcher']): Promise<unknown> {
  if (name === 'hud_land') {
    const id = required(args, 'job'), job = findJob(id);
    const task = session.taskClient;
    const flow = await startLand(hudHome, id, job, job ? readRow(job).row.state : null, callerPane, task, undefined, undefined, undefined, !isWorker);
    ensureWatcher();
    if (task) {
      rememberLandTask(landTasks, flow.flow, landActive);
      saveTaskReceipt({ id: flow.flow, expiresAt: Date.parse(flow.created_at) + TASK_TTL });
      return { resultType: 'task', ...landTask(hudHome, flow) };
    }
    if (callerPane) void ensureQueueWatcher(callerPane, hudHome);
    return landView(flow);
  }
  if (name === 'hud_lease') return takeLease(args, { home: hudHome, cwd: process.cwd(), holder: callerPane });
  if (name === 'hud_objective') return editObjectives(jobCwd(args), hudHome, args, by);
  if (name === 'hud_schedule') return callSchedule(hudHome, args);
  if (name === 'hud_tickets') {
    if (ticketGuide(args)) return fs.readFileSync(join(bundled, '../../integrations/tickets/method.md'), 'utf8');
    const cwd = jobCwd(args);
    if (args.op === 'run') {
      const q = await startTicketQueue(hudHome, cwd, callerPane, session.taskClient, args, dispatcher);
      if (!q) return { ok: false, code: 'queue_not_running' };
      ensureWatcher();
      if (q.task && session.taskCapable && args.cancel !== true) {
        rememberLandTask(landTasks, q.flow, landActive);
        saveTaskReceipt({ id: q.flow, expiresAt: Date.parse(q.created_at) + TASK_TTL });
        return { resultType: 'task', ...ticketQueueTask(hudHome, q) };
      }
      if (!q.task && callerPane) void ensureQueueWatcher(callerPane, hudHome);
      return { ...ticketQueueView(q), ...(args.cancel === true && { cancel_requested: true }) };
    }
    return args.op === 'ready' ? readyTickets(cwd, jobCache, hudHome) : editTickets(cwd, args, hudHome);
  }
  if (args.detail !== undefined && typeof args.detail !== 'boolean') throw new Error('invalid_arguments: detail');
  const detail = args.detail === true;
  if (name === 'hud_roster') {
    if (args.convention_version !== undefined && typeof args.convention_version !== 'string')
      throw new Error('invalid_arguments: convention_version');
    const found = registry(jobCwd(args));
    const { root, registered } = found.project();
    const project = { root, registered };
    const ignored = found.projectConfigIgnored();
    const invalid = found.invalid();
    const convention = found.convention();
    // Include the project and source. For a capped file, invalidate on changes beyond the returned prefix too.
    const stat = convention.truncated ? fs.statSync(convention.path, { bigint: true, throwIfNoEntry: false }) : undefined;
    const beyondCap = stat && `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const convention_version = createHash('sha256').update(JSON.stringify([project, convention, beyondCap])).digest('hex');
    const now = Date.now();
    let routing;
    try { routing = found.routing(now); }
    catch (error) {
      if (error instanceof HarnessSwitchError) return harnessSwitchFailure(error);
      throw error;
    }
    const configured = found.roles(true);
    const roles = [...configured.values()].filter(role => role.optionalEnabled !== false).map((role) => {
      const assignment = found.assignment(role, now, undefined, routing);
      if (role.members) {
        const defaults = prepareCouncil({}, role, found, configured, routing);
        return { ...(detail ? assignment : { role: role.role, presets: role.presets?.map(p => p.name) }),
          members: role.members, synthesizer: role.synthesizer, instructions: role.instructions, available: !('code' in defaults),
          ...('code' in defaults && { reason: defaults.reason }) };
      }
      if (!detail) return compactAssignment(assignment);
      return role.role === 'imp' && assignment.routing ? {
        ...assignment,
        routing_hint: 'Auto-route chooses these presets; do not pass them to hud_create.',
      } : assignment;
    });
    if (!session.taskClient && !session.callerHarness && callerPane) rememberCallerHarness((await paneInfo(callerPane))?.agent);
    const watcherAlive = !session.taskClient && !!callerPane && watching(callerPane, hudHome);
    const unchanged = (args.convention_version ?? session.sentConventionVersion) === convention_version;
    if (!unchanged) session.sentConventionVersion = convention_version;
    return {
      roles,
      ...(detail || invalid.length ? { invalid } : {}),
      convention_version,
      ...(unchanged ? { convention_unchanged: true } : { convention }),
      project,
      ...(callerPane && !session.taskClient ? { watcher_alive: watcherAlive } : {}),
      hint: deliveryHint(watcherAlive),
      ...(ignored ? { project_config_ignored: ignored } : {}),
    };
  }
  if (name === 'hud_create') {
    if (args.items !== undefined || args.batch !== undefined || args.action !== undefined) {
      const b = args.items === undefined ? await controlBatch(hudHome, callerPane, args) : await startBatch(hudHome, callerPane, args, dispatcher);
      wakeWorkflow(hudHome, b); ensureWatcher();
      if (callerPane && !session.taskClient) void ensureQueueWatcher(callerPane, hudHome);
      return { flow: b.flow, state: b.state, totals: b.totals, scale: b.scale };
    }
    if (args.jobs !== undefined) {
      if (session.taskClient) throw new Error('In a task session, send one hud_create per job as parallel calls; each gets its own MCP task.');
      if (!Array.isArray(args.jobs) || !args.jobs.length ||
          Object.keys(args).some((key) => key !== 'jobs' && args[key] !== undefined)) {
        throw new Error('invalid_arguments: jobs');
      }
      let gate = Promise.resolve();
      const results = await Promise.all(args.jobs.map(async (raw) => {
        const wait = gate;
        let release!: () => void;
        gate = new Promise<void>((resolve) => { release = resolve; });
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ('jobs' in raw && (raw as Args).jobs !== undefined)) {
          release();
          return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: jobs' };
        }
        try {
          return await dispatchJob(raw as Args, process.env.HERDR_PANE_ID, { batch: true, slotGate: { wait, release }, dispatcher });
        } catch (error) {
          return itemError(error);
        } finally {
          release();
        }
      }));
      if (session.sentCreateHint) return { jobs: results };
      session.sentCreateHint = true;
      const watcherAlive = !session.taskClient && !!callerPane && watching(callerPane, hudHome);
      return { jobs: results, hint: deliveryHint(watcherAlive) };
    }
    const result = await dispatchJob(args, process.env.HERDR_PANE_ID, { dispatcher });
    if (session.sentCreateHint) return result;
    session.sentCreateHint = true;
    if (isTaskReply(result)) return { ...result, statusMessage: `${result.statusMessage} — ${deliveryHint(false)}` };
    const watcherAlive = !session.taskClient && ('watcher_alive' in result ? result.watcher_alive === true : !!callerPane && watching(callerPane, hudHome));
    // Tab placement or roster discovery may already know the harness; do not probe on the dispatch reply path.
    return { ...result, hint: deliveryHint(watcherAlive) };
  }
  if (name === 'hud_send') {
    ensureWatcher();
    return sendJobs(args, dispatcher);
  }
  if (name === 'hud_respond' && args.answers !== undefined) {
    if (args.job !== undefined || args.request_id !== undefined || args.answer !== undefined || args.by !== undefined ||
        !Array.isArray(args.answers) || !args.answers.length) throw new Error('invalid_arguments: answers');
    let changed = false;
    const items = args.answers;
    // Coalesce ordinary answer writes and any status changes from a headless resume.
    const answers = await writeScan.run({ ...scan, deferSummary: () => { changed = true; } }, () => Promise.all(items.map(async (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: answers' };
      const item = raw as Args;
      const jobId = typeof item.job === 'string' ? item.job : undefined;
      const reqId = typeof item.request_id === 'string' ? item.request_id : undefined;
      try {
        const id = required(item, 'job');
        const res = await keyLock(`job:${id}`, async () => isTicketQueueId(id) ? respondTicketQueue(item, true) : respondJob(item, true));
        return { job: id, ...(reqId ? { request_id: reqId } : {}), ...res };
      } catch (error) {
        return { ...(jobId ? { job: jobId } : {}), ...(reqId ? { request_id: reqId } : {}), ...itemError(error) };
      }
    })));
    if (changed) publishWorkSummary(scan.summaryJobs());
    // As for a single answer: the answer to the question that stopped a ticket queue resumes it.
    const queues_resumed: string[] = [];
    for (const a of answers as { ok?: boolean; job?: string; request_id?: string }[]) {
      if (a.ok === false || !a.job || !a.request_id || isTicketQueueId(a.job)) continue;
      const flow = await resumeQueueAfterAnswer(hudHome, a.job, a.request_id, callerPane);
      if (flow) queues_resumed.push(flow);
    }
    if (queues_resumed.length && callerPane) void ensureQueueWatcher(callerPane, hudHome);
    return { answers, ...(queues_resumed.length && { queues_resumed }) };
  }
  if (name === 'hud_close' && (args.jobs !== undefined || args.package !== undefined || args.state !== undefined || args.preset !== undefined))
    return cancelBatch(args, scan);
  if (name === 'hud_wait') return waitJobs(args, scan);
  if (name === 'hud_read') {
    const { view } = args;
    if (view !== undefined) {
      if (view !== 'compact' && view !== 'recent') throw new Error('invalid_arguments: view');
      if (args.job !== undefined || args.jobs !== undefined) throw new Error('invalid_arguments: view is list-only');
    }
    if (args.mode !== undefined && args.mode !== 'digest' && args.mode !== 'full') throw new Error('invalid_arguments: mode');
    if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('invalid_arguments: full');
    if (args.offset !== undefined && (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0 ||
        !fullRead(args) || typeof args.job !== 'string' || args.jobs !== undefined || isFlowId(args.job) || isTicketQueueId(args.job) || isBatchId(args.job)))
      throw new Error('invalid_arguments: offset requires a nonnegative integer and one full job read');
    if (args.wait_ms !== undefined && (typeof args.wait_ms !== 'number' || !Number.isFinite(args.wait_ms)))
      throw new Error('invalid_arguments: wait_ms');
    ensureJobWatcher(hudHome, () => scan.watcherNeeded(Number(args.wait_ms) > 0));
    if (args.jobs !== undefined) {
      if (args.job !== undefined || !Array.isArray(args.jobs) || !args.jobs.length) throw new Error('invalid_arguments: jobs');
      return { jobs: await Promise.all(args.jobs.map(async (job) => {
        try { return { job, ...await callJob(name, { ...args, job }, detail, scan) }; }
        catch (error) { return { job, ok: false, code: 'tool_error', error: String(error) }; }
      })) };
    }
    if (args.job === undefined) {
      if (args.mode !== undefined) throw new Error('invalid_arguments: mode requires job or jobs');
      if (args.detail !== undefined) throw new Error('invalid_arguments: detail requires job');
      return listJobs(view === 'recent', scan);
    }
  }
  if (!tools.some((tool) => tool.name === name)) throw new Error('unknown_tool');
  return callJob(name, args, detail, scan);
}

async function callJob(name: string, args: Args, detail: boolean, scan: JobScan) {
  const id = required(args, 'job');
  if (name === 'hud_read' && isBatchId(id)) return batchView(hudHome, id, callerPane);
  if (name === 'hud_read' && isFlowId(id)) {
    const flow = await recoverLand(hudHome, id);
    return flow ? landView(flow) : { ok: false, code: 'flow_not_found' };
  }
  if (name === 'hud_read' && isTicketQueueId(id)) {
    const flow = readTicketQueue(hudHome, id);
    if (!flow || !runVisible(flow, callerPane)) return { ok: false, code: 'flow_not_found' };
    if (flow.state === 'working') { wakeWorkflow(hudHome, flow); ensureWatcher(); }
    return ticketQueueView(flow);
  }
  if (name === 'hud_respond' && isTicketQueueId(id)) {
    return respondTicketQueue(args, false);
  }
  const job = findJob(id);
  if (!job) return { ok: false, code: 'job_not_found' };
  if (name === 'hud_peek') return job.job === id ? peekJob(job, args, scan) : { ok: false, code: 'job_not_found' };
  const dir = directory(job.job);
  if (name === 'hud_read') {
    const full = fullRead(args);
    const offset = (args.offset as number | undefined) ?? 0;
    const waitMs = Math.max(0, Math.min(120000, (args.wait_ms as number | undefined) ?? 0));
    let initial: JobRow | undefined;
    const isReady = (row: JobRow) =>
      settled(row.state) ||
      row.state === 'waiting_orchestrator' ||
      row.blocked ||
      row.open_questions > 0 ||
      (initial !== undefined && jobChanges([initial], [row]).length > 0);
    let summary: GitSummary | undefined;
    let firstCheck = true;
    return waitUntilFs({
      targets: () => jobWatchTargets(dir),
      timeoutMs: waitMs,
      isTransientError: (error) => error instanceof SyntaxError,
      check: async ({ timedOut }) => {
        const polledJob = firstCheck ? job : (findJob(job.job) ?? job);
        firstCheck = false;
        let polled = readRow(polledJob, !isWorker, null);
        initial ??= polled.row;
        if (!timedOut && !isReady(polled.row)) return { done: false };
        const obsJob = polled.job;
        const wt = obsJob.worktree;
        // Only probe once per read, even if a concurrent answer or continuation resumes the wait.
        if (wt && summary === undefined) {
          summary = await gitSummary(wt, () => scan.all()
            .flatMap((other) => other.job !== obsJob.job && other.worktree?.main_root === wt.main_root &&
              other.worktree.root !== wt.root && !other.worktree_removed_at
              ? [{ job: other.job, worktree: other.worktree, created_at: other.created_at }] : [])
            .sort((a, b) => b.created_at.localeCompare(a.created_at)));
          // Async gitSummary yielded; re-read job and status fresh before observing.
          polled = readRow(findJob(job.job) ?? obsJob, !isWorker, null);
          // The fresh read disagrees with the quick one (answered or continued meanwhile): wait, never spin.
          if (!timedOut && !isReady(polled.row)) return { done: false, minDelayMs: 50 };
        }
        if (polled.row.state === 'queued') polled.row.queue_position = scan.position(job.job);
        const { value: result, row: currentRow } = observation(polled.job, full, detail, summary, offset, polled);
        const collected = ('report' in result || 'digest' in result) && result.report_exists;
        const observed = result.blocked || failedAttempt(currentRow);
        if (!isWorker && (collected || observed)) {
          const latest = findJobMutable(job.job)!;
          if (observed) latest.observed_at = new Date().toISOString();
          // Use the pre-read stat: a racing replacement must never be acknowledged sight unseen.
          save(latest, false, collected ? polled.reportStamp : null);
        }
        return { done: true, value: result };
      },
    });
  }
  if (name === 'hud_respond') {
    const result = await respondJob(args, false, scan.summaryJobs());
    const answered = fs.existsSync(join(directory(job.job), jobFiles.qa, `${args.request_id}.answer.md`));
    const resumed = answered ? await resumeQueueAfterAnswer(hudHome, job.job, String(args.request_id), callerPane) : undefined;
    if (!resumed) return result;
    if (callerPane) void ensureQueueWatcher(callerPane, hudHome);
    return 'resultType' in result ? result : { ...result, queue_resumed: resumed };
  }
  return closeJob(job);
}

export async function resumePanelAnswer(home: string, job: string, request_id: string, answer: string): Promise<AnswerResult> {
  if (resolve(home) !== hudHome) return { ok: false, reason: 'job belongs to another HUD home' };
  const result = await keyLock(`job:${job}`, () => respondJob({ job, request_id, answer }, false, undefined, 'owner'));
  return 'code' in result && result.code ? { ok: false, reason: result.code } :
    { ok: true, written: 'written' in result ? result.written === true : true };
}
export async function answerWorkerQuestion(job: string, request_id: string, answer: string): Promise<AnswerResult> {
  const result = await keyLock(`job:${job}`, () => respondJob({ job, request_id, answer }, false, undefined, 'orchestrator'));
  return 'code' in result && result.code ? { ok: false, reason: result.code } :
    { ok: true, written: 'written' in result ? result.written === true : true };
}

async function respondTicketQueue(args: Args, batch: boolean) {
  const id = required(args, 'job');
  const answer = required(args, 'answer');
  if (args.by !== undefined && args.by !== 'owner') throw new Error('invalid_arguments: by');
  let requestId: string | undefined;
  if (args.request_id !== undefined) {
    if (typeof args.request_id !== 'string' || !args.request_id.trim()) throw new Error('invalid_arguments: request_id');
    requestId = args.request_id.trim();
  }
  const res = await answerTicketQueueHandback(hudHome, id, answer, { pane: callerPane, requestId });
  if (!res.ok) return res;
  if (res.resumed) {
    ensureWatcher();
    if (!batch && res.queue.task && session.taskCapable) {
      rememberLandTask(landTasks, res.queue.flow, landActive);
      saveTaskReceipt({ id: res.queue.flow, expiresAt: Date.parse(res.queue.created_at) + TASK_TTL });
      return { resultType: 'task', ...ticketQueueTask(hudHome, res.queue) };
    }
    if (!res.queue.task && callerPane) void ensureQueueWatcher(callerPane, hudHome);
  }
  return { ok: true, ...ticketQueueView(res.queue) };
}

async function respondJob(args: Args, batch: boolean, loadedJobs?: readonly Job[], answeredBy: AnswerActor = 'orchestrator') {
  const id = required(args, 'job');
  const job = findJob(id);
  if (!job) return { ok: false, code: 'job_not_found' };
  const dir = directory(job.job);
  const request = required(args, 'request_id');
  if (!/^q\d+$/.test(request)) throw new Error('invalid_arguments: request_id');
  const answer = required(args, 'answer');
  if (args.by !== undefined && args.by !== 'owner') throw new Error('invalid_arguments: by');
  const actor: AnswerActor = args.by === 'owner' ? 'owner' : answeredBy;
  ensureWatcher();
  fs.mkdirSync(join(dir, jobFiles.qa), { recursive: true, mode: 0o700 });
  if (job.headless && job.role !== 'sonic') {
    if (fs.existsSync(join(dir, jobFiles.qa, `${request}.answer.md`))) return { ok: true, written: false };
    if (!jobCache.readQa(dir).openIds.includes(request)) return { ok: false, code: 'question_not_open' };
    // The question can be visible before the harness has flushed its session and the watcher has reaped this turn.
    const status = await waitUntilFs({ targets: [{ dir }], timeoutMs: 30_000, check: ({ timedOut }) => {
      const fresh = readCachedStatus(id).status;
      return fresh?.state !== 'working' || timedOut ? { done: true, value: fresh } : { done: false };
    } });
    if (status?.state !== 'waiting_orchestrator') return { ok: false, code: 'worker_not_waiting' };
    const key = `answer:${request}`;
    return await resumeJob(job, status, readRow(job, false).row, answer, key, key, false, batch, request, false, actor) ??
      { ok: false, code: 'resume_failed' };
  }
  const oldTask = activeTasks.get(id);
  const polled = session.taskClient && !job.batch_flow ? readRow(job, false) : undefined;
  const row = polled?.row;
  const state = row?.state ?? row?.display_state;
  const canCarry = !!oldTask && oldTask.view.status === 'working' &&
    jobCallerPane(job) === oldTask.pane && taskFence(job) === oldTask.fence &&
    state !== 'failed' && state !== 'stopped' && !fs.existsSync(join(dir, jobFiles.stopRequested));
  if (oldTask && !canCarry) sampleTask(oldTask);
  const task = !canCarry && row?.question_ids.includes(request)
    ? beginTask(job, oldTask?.reportBefore, request, row, polled?.statusAt) : undefined;
  try {
    writePrivateFile(join(dir, jobFiles.qa, `${request}.answer.md`), answer, { exclusive: true, mkdir: false });
    jobCache.invalidateQa(job.job);
    recordQuestionAnswer(dir, request, actor, jobCache);
    publishWorkSummary(loadedJobs);
    if (canCarry) {
      oldTask.seenQuestions.add(`${request}.md`);
      if (row && needsAttention(row)) oldTask.attentionBefore = polled?.statusAt ?? undefined;
      extendTask(oldTask, job);
      return { ok: true, written: true };
    }
    if (batch) {
      registerBatchTask(task, job, true);
      return { ok: true, written: true };
    }
    return finishTask(task, job, true) ?? { ok: true, written: true };
  } catch (error) {
    if (task) releaseTask(task);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    jobCache.invalidateQa(job.job);
    return { ok: true, written: false };
  }
}

const cancelledLine = 'Cancelled queued work: never started (no worker).';

function cancelQueued(id: string, state: unknown) {
  const outcome = removeQueuedJob(directory(id), state);
  if (outcome === 'cancelled' || outcome === 'missing') {
    jobCache.evictJob(id);
    session.cursor.delete(id);
    const active = activeTasks.get(id);
    if (active) {
      batchTasks.delete(id);
      const msg = `${taskLabel(active, 'stopped')} — ${cancelledLine}`;
      updateTask(active, 'cancelled', msg, msg);
    }
  }
  return outcome;
}

async function cancelBatch(args: Args, scan: JobScan) {
  let ids: string[], selected: ((job: Job) => boolean) | undefined;
  if (args.job !== undefined) throw new Error('invalid_arguments: use job or a queued batch, not both');
  if (args.jobs !== undefined) {
    if (args.package !== undefined || args.preset !== undefined || args.state !== undefined || !Array.isArray(args.jobs) ||
        !args.jobs.length || args.jobs.some(id => typeof id !== 'string' || !id)) throw new Error('invalid_arguments: jobs');
    ids = args.jobs;
  } else {
    const label = required(args, 'package');
    if (args.state !== 'queued') throw new Error('invalid_arguments: package requires state:queued');
    const preset = args.preset === undefined ? undefined : required(args, 'preset');
    const matches = packageJobFilter(process.cwd(), label, preset);
    selected = job => ownsJob(job) && matches(job);
    ids = scan.all().filter(selected).map(job => job.job);
  }
  const jobs = await Promise.all(ids.map(async job => {
    try {
      return await keyLock(`job:${job}`, async () => {
        const receipt = findJob(job);
        if (!receipt || receipt.job !== job) return { job, result: 'error', code: 'job_not_found' };
        if (selected && !selected(receipt)) return { job, result: 'skipped', reason: 'no longer matches selector' };
        const state = readCachedStatus(job).status?.state ?? null;
        const outcome = cancelQueued(job, state);
        if (outcome === 'cancelled') return { job, result: 'cancelled' };
        if (outcome === 'missing') return { job, result: 'error', code: 'job_not_found' };
        return { job, result: 'skipped', state, reason: outcome === 'claimed' ? 'queue already claimed' : 'not an unstarted queued job' };
      });
    } catch (error) { return { job, result: 'error', ...itemError(error) }; }
  }));
  const counts = { cancelled: 0, skipped: 0, errors: 0 };
  for (const { result } of jobs) {
    if (result === 'cancelled' || result === 'skipped') counts[result]++;
    else counts.errors++;
  }
  if (counts.cancelled) scan.clear(); // Do not deliver changes from the pre-cancellation receipt scan.
  return { jobs, counts, message: 'Cancelled items never started and had no worker. No running worker was closed.' };
}

export async function closeJob(job: Job, stop = false) {
  const dir = directory(job.job);
  if (!job.headless && findJob(job.job)?.reaped_at) return { exit_code: 0, last_line: 'already reaped' };
  if (job.scout_state === 'scouting' && await requestPrewalkStop(job.job)) {
    recordStopOrigin(dir, 'mcp', readCachedStatus(job.job).status?.state, undefined, jobCache);
    return { exit_code: 0, last_line: 'stopping scouted dispatch' };
  }
  let { row, status } = readRow(job);
  if (job.role === 'council' && row.state === 'working' && fs.existsSync(join(hudHome, 'flows', `${job.job}.json`))) {
    recordStopOrigin(dir, 'mcp', status?.state, undefined, jobCache);
    writePrivateFile(join(dir, jobFiles.stopRequested), '');
    ensureWatcher();
    return { exit_code: 0, last_line: 'stopping council' };
  }
  const outcome = cancelQueued(job.job, row.state);
  if (outcome === 'cancelled' || outcome === 'missing') return { exit_code: 0, last_line: cancelledLine, removed: true };
  if (outcome === 'claimed') {
    // Watcher just claimed it to start; wait briefly for launch state before reaping.
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      jobCache.invalidateJob(job.job);
      const refreshed = findJob(job.job);
      if (!refreshed) return { exit_code: 0, last_line: cancelledLine, removed: true };
      job = refreshed;
      ({ row, status } = readRow(job));
      if (row.state !== 'queued' || fs.existsSync(join(dir, jobFiles.session))) break;
    }
  }
  const initialSession = jobCache.readSession(job.job, { throwOnError: true });
  if (!job.headless && isShellLaunchedWorker(initialSession?.fields) && !job.reaped_at)
    return { exit_code: 1, last_line: SHELL_WORKER_UNSUPPORTED };
  recordStopOrigin(dir, 'mcp', status?.state, undefined, jobCache);
  if (job.headless) {
    const closed = await stopSonic(dir);
    publishWorkSummary();
    if (closed && !isWorker && readRow(job).row.display_state === 'failed')
      save({ ...(findJob(job.job) ?? job), observed_at: new Date().toISOString() });
    return { exit_code: closed ? 0 : 1, last_line: `${job.role} ${closed ? 'closed' : 'cleanup pending'}` };
  }
  const launchStamp = initialSession
    ? (initialSession.fields.launchId || initialSession.fields.launch || `stamp:${initialSession.stamp}`)
    : undefined;
  const { result, complete, issue } = await reapWorkerTree(dir, status, () => {
    const currentSession = jobCache.readSession(job.job);
    const sameLaunch = !initialSession || currentSession?.stamp === initialSession.stamp;
    // Idle grace already finished: reap quits and the supervisor closes. A working job is stopped.
    if (sameLaunch && row.state === 'idle_grace' && (stop || job.cli)) {
      try {
        fs.writeFileSync(join(dir, stop ? jobFiles.stopRequested : jobFiles.closeRequested), '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const reapArgs = [binScript('hud-reap'), dir, ...(launchStamp ? ['--launch', launchStamp] : [])];
    return runCommand(process.execPath, reapArgs, process.env, { budgetMs: 135_000, killProcessGroup: true });
  }, (run) => run.ok, { treeGrant: tabTreeGrant });
  const statusFile = join(dir, jobFiles.status);
  const stoppingPi = !job.cli && !job.bro && !job.jev && fs.existsSync(join(dir, jobFiles.stopRequested));
  // Reaping can succeed even when Pi exited before its shutdown hook wrote STATUS.
  if (stoppingPi) {
    settleStoppedPi(statusFile, readCachedStatus(job.job).status);
    jobCache.invalidateFile(statusFile);
  }
  publishWorkSummary();
  if (issue || stoppingPi) ensureWatcher();
  if (!isWorker && complete && row.display_state === 'failed') {
    const latest = findJob(job.job) ?? job;
    save({ ...latest, observed_at: new Date().toISOString() });
  }
  return {
    exit_code: complete ? 0 : result.exitCode || 1,
    last_line: issue ?? (result.reason === 'timeout' ? 'hud-reap timed out' :
      ((!result.ok && result.stderr.trim()) || result.stdout.trim() || result.stderr.trim()).split('\n').at(-1) ?? ''),
  };
}

export let ownerDelivery: ReturnType<typeof panelDelivery> | undefined;
export async function syncPanelDelivery() {
  if (session.taskClient && !session.resumeRefusal) {
    if (!ownerDelivery) {
      const cwd = process.cwd(), matches = projectJobFilter(cwd);
      ownerDelivery = panelDelivery(hudHome, callerPane, cwd, id => {
        const job = findJob(id);
        return !!job && ownsJob(job) && matches(job);
      }, async message => {
        const sent = await notify(callerPane, message, hudHome);
        return sent.status === 0 || sent.uncertain === true;
      });
    }
    ensureBatchTimer();
  } else {
    const old = ownerDelivery;
    ownerDelivery = undefined;
    await old?.stop();
    await stopBatchDelivery(true);
  }
}
// Once a mod takes over, new jobs do not have tasks. A dead watch falls back to changes /
// hud_wait; task IDs issued before takeover remain valid until their receipts expire.
export async function checkModTakeover() {
  const live = refreshModWatch();
  if (live && session.taskClient) {
    session.taskClient = false;
    await syncPanelDelivery();
  }
  return live;
}
const scanTaskRuns = headerScanner();
export async function withChanges(value: unknown, markExhaustion: boolean, scan: JobScan): Promise<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || await checkModTakeover()) return value;
  if (session.taskClient) {
    const { files, header } = scanTaskRuns(hudHome);
    const changes = [...(await ownerDelivery?.changes() ?? []), ...(await drainBatchChanges()), ...files.flatMap(file => {
      if (!file.endsWith('.json') || !isBatchId(file.slice(0, -5))) return [];
      const b = header<Batch>(file);
      return b && runVisible(b, callerPane) ? batchEvents(hudHome, b).map(e => e.line) : [];
    })];
    return changes.length ? { ...value, changes } : value;
  }
  const rows = sessionRows(markExhaustion, scan);
  const changes = [...jobChanges(session.cursor, rows), ...tries.changes(process.cwd()), ...answers.changes(new Set(rows.map((row) => row.job)), process.cwd()), ...workflowEvents(hudHome, callerPane).lines];
  session.cursor = new Map(rows.map((row) => [row.job, row]));
  return changes.length ? { ...(value as Record<string, unknown>), changes } : value;
}

export function mutationKey(name: string, args: Args): string | null {
  if (name === 'hud_tickets' && !ticketGuide(args) && args.op !== 'ready')
    return isWorker ? 'tickets' : `tickets:${fs.realpathSync(jobCwd(args))}`;
  if ((name === 'hud_respond' && args.answers !== undefined) || (name === 'hud_close' && args.job === undefined)) return null;
  if (name !== 'hud_respond' && name !== 'hud_close') return null;
  const id = args.job;
  // Leave validation to the tool, without making invalid calls wait for one another.
  if (typeof id !== 'string' || !id) return `invalid:${randomBytes(8).toString('hex')}`;
  return `job:${id}`;
}

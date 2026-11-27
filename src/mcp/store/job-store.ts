/** HUD home, job receipts, and per-call scans shared by dispatch and MCP. */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobRow } from '../../collectors/thin-jobs.js';
import { createWorkSummaryPublisher } from '../../collectors/work-summary-snapshot.js';
import { computeQueuePositions, queuedTimestamp } from '../../roles/concurrency.js';
import { filterTimedOutQuestions, JobIndexCache, JOB_ID_RE, type CachedJsonResult } from '../../roles/job-index-cache.js';
import { jobCallerPane } from '../../roles/job-pane.js';
import { recordFailureExhaustion } from '../../roles/roster.js';
import { readJsonFile, readFileBounded } from '../../utils/atomic-fs.js';
import { firstReportProse } from '../../utils/report-summary.js';
import type { Job, JobStatus } from '../job-contracts.js';
import { jobFiles } from '../paths.js';

const jobDir = process.env.HUD_JOB_DIR;
export const isWorker = jobDir !== undefined;
export const hudHome = jobDir !== undefined ? dirname(dirname(fs.realpathSync(jobDir))) : resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
if (isWorker) process.env.HUD_HOME = hudHome; // The watcher and other subprocesses inherit the worker's HUD home.
export const jobsRoot = join(hudHome, 'jobs');
export const jobCache = new JobIndexCache(hudHome);
const workSummary = createWorkSummaryPublisher(hudHome, 'hud-mcp', jobCache);
export const publishWorkSummary = (loadedJobs?: readonly Job[]) => {
  const defer = writeScan.getStore()?.deferSummary;
  if (defer) return defer();
  try {
    workSummary.publish(loadedJobs ? { jobs: loadedJobs as readonly (Job & Record<string, unknown>)[], jobsExist: true } : undefined);
  } catch { /* Best-effort display snapshot. */ }
};

export const bundled = fileURLToPath(new URL('../../../packages/hud-mcp/', import.meta.url));

export function json<T>(file: string): T | null {
  try {
    return readJsonFile(file) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function slice(file: string, limit: number): { text: string; truncated: boolean; bytes: number } | null {
  try {
    const { bytes, stat, truncated } = readFileBounded(file, limit, { followSymlinks: true });
    return { text: bytes.toString('utf8'), truncated, bytes: truncated ? stat.size : bytes.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function unwrapCachedJson<T>(res: CachedJsonResult<T>, fallbackFile: string): T | null {
  if (res.status === 'ok') return res.value;
  if (res.status === 'missing') return null;
  if (res.status === 'truncated') return json<T>(fallbackFile);
  throw res.error;
}
export function readCachedStatus(id: string): { status: JobStatus | null; at: number | null } {
  const file = join(directory(id), jobFiles.status);
  const res = jobCache.readStatus<JobStatus>(id);
  if (res.status === 'ok') return { status: res.value, at: res.at };
  if (res.status === 'missing') return { status: null, at: null };
  if (res.status === 'truncated') {
    const status = json<JobStatus>(file);
    const at = status ? (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null) : null;
    return { status, at };
  }
  throw res.error;
}
export function directory(job: string): string {
  return join(jobsRoot, job);
}
export function save(job: Job, newAttempt = false, collectedStamp?: string | null): void {
  const file = join(directory(job.job), jobFiles.job);
  // A waiting read can stamp the report while dispatch/send is awaiting a CLI.
  const receipt = findJob(job.job);
  // A session watch can adopt the receipt while this process awaits a launch or send.
  const owner = (receipt && jobCallerPane(receipt)) || jobCallerPane(job);
  if (job.headless) {
    if (owner) job.caller_pane = owner;
    delete job.herdr_pane;
  } else {
    if (owner) job.herdr_pane = owner;
    delete job.caller_pane;
  }
  // The watcher may learn a native identity while launch, send or repair awaits the harness.
  if (receipt?.sessions) job.sessions = receipt.sessions;
  const existing = newAttempt ? null : receipt;
  if (collectedStamp) {
    job.read_at = new Date().toISOString();
    job.read_report_stamp = collectedStamp;
  } else if (existing?.read_at && (!job.read_at || existing.read_at >= job.read_at)) {
    job.read_report_stamp = existing.read_report_stamp;
  }
  for (const key of ['read_at', 'observed_at', 'pi_sent_at'] as const) {
    const at = existing?.[key];
    if (at && (!job[key] || at > job[key])) job[key] = at;
  }
  if (existing?.reaped_at) job.reaped_at = existing.reaped_at;
  if (existing?.stop_origin && !job.stop_origin) job.stop_origin = existing.stop_origin;
  if (existing?.answered_by) job.answered_by = { ...existing.answered_by, ...job.answered_by };
  for (const key of ['timed_out_questions', 'moot_timed_out_questions'] as const) {
    const ids = existing?.[key];
    if (ids?.length) job[key] = [...new Set([...ids, ...(job[key] ?? [])])];
  }
  if (existing) {
    // Watcher-owned: a later integration can clear a previously recorded keep decision.
    for (const key of ['worktree_removed_at', 'worktree_kept_reason', 'worktree_checked_head'] as const)
      job[key] = existing[key];
  }
  if (existing?.exhaustion_marked) job.exhaustion_marked = true;
  if (existing?.citations) job.citations = existing.citations;
  if (existing?.reads !== undefined) job.reads = existing.reads;
  if (existing?.brief_bytes !== undefined) job.brief_bytes = existing.brief_bytes;
  if (existing?.report_bytes !== undefined) job.report_bytes = existing.report_bytes;
  if (existing?.findings) job.findings = existing.findings;
  if (existing?.reviewed) job.reviewed = existing.reviewed;
  if (existing?.resume_failures && !job.resume_failures) job.resume_failures = existing.resume_failures;
  jobCache.writeJsonAtomic(file, job as unknown as Record<string, unknown>, { indent: 2, mkdir: false });
  writeScan.getStore()?.record(job);
}
export function jobs(onMissing?: () => void): Job[] {
  const out: Job[] = [];
  for (const id of jobCache.listJobIds({ onError: (error) => { throw error; } })) {
    const job = findJob(id);
    if (job) out.push(job);
    else onMissing?.();
  }
  return out;
}
export function findJob(id: string): Job | null {
  if (!JOB_ID_RE.test(id)) return null;
  return unwrapCachedJson(jobCache.readJob<Job>(id), join(directory(id), jobFiles.job));
}
export function findJobMutable(id: string): Job | null {
  if (!JOB_ID_RE.test(id)) return null;
  return unwrapCachedJson(jobCache.readJobMutable<Job>(id), join(directory(id), jobFiles.job));
}
export function primary(id: string): string | null {
  return jobCache.readSession(id)?.fields.primary ?? null;
}

export function queuePositionsForJobs(allJobs = jobs(), statusFor = readCachedStatus): Map<string, number> {
  return computeQueuePositions(
    allJobs.map((item) => ({
      id: item.job,
      role: item.role,
      state: statusFor(item.job).status?.state ?? null,
      queuedAt: queuedTimestamp(item),
    }))
  );
}
export function scanForCall() {
  let receipts: Job[] | undefined, missingReceipt = false, summaryStale = false;
  let positions: Map<string, number> | undefined;
  const statuses = new Map<string, ReturnType<typeof readCachedStatus>>();
  const all = () => receipts ??= jobs(() => { missingReceipt = true; });
  const status = (id: string) => statuses.get(id) ?? statuses.set(id, readCachedStatus(id)).get(id)!;
  return {
    all, status,
    position: (id: string) => (positions ??= queuePositionsForJobs(all(), status)).get(id),
    summaryJobs: (): readonly Job[] | undefined => (!summaryStale && !missingReceipt ? receipts : undefined),
    invalidateSummary() { summaryStale = true; },
    watcherNeeded(waiting: boolean) {
      try {
        return all().some(job => {
          const state = (waiting ? readCachedStatus : status)(job.job).status?.state;
          if (state !== 'done' && state !== 'closed' && state !== 'failed' && state !== 'stopped') return true;
          // A terminal state does not prove the watcher has finished reaping or cleaning the checkout.
          return !!(job.worktree && !job.worktree_removed_at && !job.worktree_kept_reason) ||
            (!job.reaped_at && !!fs.lstatSync(join(directory(job.job), jobFiles.session), { throwIfNoEntry: false }));
        }) || missingReceipt;
      } catch {
        return true; // An unreadable store is not evidence that nothing needs watching.
      }
    },
    record(job: Job) {
      statuses.delete(job.job);
      if (!receipts) return;
      const index = receipts.findIndex(item => item.job === job.job);
      if (index === -1) receipts.push({ ...job });
      else receipts[index] = { ...job };
    },
    clear() { receipts = positions = undefined; statuses.clear(); },
  };
}
export type JobScan = ReturnType<typeof scanForCall>;
// Track receipt writes made by a tool without using its display snapshot for dispatch admission.
export const writeScan = new AsyncLocalStorage<JobScan & { deferSummary?: () => void }>();

// Pass null for wait samples, which need fresh status but no FIFO lookup yet.
export function readRow(job: Job, markExhaustion = true, lookup?: number | JobScan | null, qa: 'required' | 'best-effort' = 'required') {
  const dir = directory(job.job);
  const file = join(dir, jobFiles.status);
  const scan = typeof lookup === 'object' ? lookup : undefined;
  let { status, at: statusAt } = (scan?.status ?? readCachedStatus)(job.job);
  const pos = status?.state === 'queued' && lookup !== null
    ? (typeof lookup === 'number' ? lookup : scan ? scan.position(job.job) : queuePositionsForJobs().get(job.job))
    : undefined;
  const report = jobCache.readReportStat(dir);
  // Execution callers must still fail closed when QA cannot be read; observational and notice rows carry unknown evidence.
  const questionIds = qa === 'required'
    ? filterTimedOutQuestions(jobCache.readQa(dir).openIds, job.timed_out_questions)
    : undefined;
  const facts = { dir, cache: jobCache, questionIds, reportPresent: report.present, reportAt: report.mtimeMs, reportStamp: report.stamp };
  let row = jobRow(job, status, { ...facts, queuePosition: pos });
  let currentJob = job;
  if (markExhaustion && row.display_state === 'failed' && !job.exhaustion_marked && status && row.reason) {
    const outcome = recordFailureExhaustion(hudHome, bundled, dir, job, row.reason);
    if (outcome.marked) {
      jobCache.invalidateFile(join(dir, jobFiles.job));
      currentJob = { ...job, exhaustion_marked: true };
      status = {
        ...status,
        exit_reason: outcome.reason,
        ...(status.error ? { error: outcome.reason } : {}),
      };
      try {
        const published = jobCache.writeJsonAtomic(file, status as unknown as Record<string, unknown>, { mkdir: false });
        statusAt = published.mtimeMs;
      } catch {
        /* Ignore transient STATUS.json write error. */
      }
      (scan ?? writeScan.getStore())?.record(currentJob);
      row = jobRow(currentJob, status, { ...facts, questionIds: row.question_ids, openQuestions: row.open_questions });
    }
  }
  return { row, status, statusAt, job: currentJob, reportStamp: report.stamp };
}

export const settled = (state: string | null) => ['idle_grace', 'closed', 'done', 'failed', 'stopped'].includes(state ?? '');

// Count JSON escapes and UTF-8, not UTF-16 units; never split a code point.
export function digestLine(text: string, budget: number) {
  let line = '';
  for (const ch of text.trim()) {
    budget -= Buffer.byteLength(JSON.stringify(ch)) - 2;
    if (budget < 0) return line + '…';
    line += ch;
  }
  return line;
}
export const RESULT_HEAD_BYTES = 2048;
export function fallbackResultLine(text: string) {
  // The notice reads only this prefix; use the same evidence when the digest has a larger body.
  const head = Buffer.from(text.slice(0, RESULT_HEAD_BYTES)).subarray(0, RESULT_HEAD_BYTES).toString('utf8');
  return (firstReportProse(head) ?? 'Report ready').slice(0, 240);
}

export function writeCreateStatus(dir: string, status: JobStatus) {
  jobCache.writeJsonAtomic(join(dir, jobFiles.status), status as unknown as Record<string, unknown>, { mkdir: false });
  publishWorkSummary();
}

/** The Execution tab's facts: workflows, workers and their children, and recent outcomes. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import type { Job, PrewalkScoutKind } from '../mcp/job-contracts.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { readSelectionExcerpts, type SelectionExcerpt } from '../roles/selection-excerpts.js';
import { ENDED_MS, readExecutionRuns, type ExecutionRun } from './execution-runs.js';
import { readHeadlessOutput, type HeadlessOutput } from './headless-output.js';
import { executionJobDirs, jobRow, worksWithin } from './thin-jobs.js';
import type { OwnerWorker, WorkboardSnapshot } from './workboard-types.js';

export type { ExecutionRun, ExecutionRunStep, ExecutionRunTicket, RunStepKey, RunStepState, TicketRunStage } from './execution-runs.js';

export type ExecutionPhase = 'waiting' | 'running' | 'queued' | 'settled';
export interface ExecutionJob {
  readonly jobId: string;
  readonly worker: OwnerWorker;
  readonly dir: string;
  readonly phase: ExecutionPhase;
  readonly preset?: string;
  /** A prewalk scout's kind; its parent is the job it scouted for. */
  readonly scout?: PrewalkScoutKind;
  readonly parentId?: string;
  readonly parentRole?: string;
  readonly children?: readonly ExecutionJob[];
  /** The main session that dispatched it, from the receipt; unknown stays absent. */
  readonly session?: { readonly harness?: string; readonly id?: string; readonly pane?: string };
  /** A live headless job that has reported no progress: the newest lines of its output log. */
  readonly output?: HeadlessOutput;
}
export interface EndedExecutionJob {
  readonly jobId: string;
  readonly worker: OwnerWorker;
  readonly dir: string;
  readonly endedAt: number;
  readonly result?: 'failed' | 'stopped' | 'landed' | 'not landed' | 'done';
}
export type TicketActivity = { readonly ticket: string; readonly at?: number } & (
  { readonly kind: 'live'; readonly jobId: string } | { readonly kind: 'gate'; readonly flow: string } |
  { readonly kind: 'ended'; readonly at: number; readonly result?: EndedExecutionJob['result'] }
);
export interface ExecutionSnapshot {
  readonly root: string;
  /** Open workflows of this project, plus queues, batches and councils ended within the last 24 hours. */
  readonly runs?: readonly ExecutionRun[];
  /** Ended jobs not represented by a run, newest settlements first. */
  readonly endedJobs?: readonly EndedExecutionJob[];
  /** The same bounded observations, by ticket, before Execution deduplicates jobs shown in workflow rows. */
  readonly ticketActivity?: readonly TicketActivity[];
  /** Running and waiting jobs: those asking first, then running, then queued; the oldest first within each. */
  readonly jobs: readonly ExecutionJob[];
  readonly excerpts?: readonly SelectionExcerpt[];
  readonly complete: boolean;
}
export type ExecutionView = ExecutionSnapshot;

const PHASE_ORDER: Record<ExecutionPhase, number> = { waiting: 0, running: 1, queued: 2, settled: 3 };
const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const jobIdOf = (id: string | undefined) => id?.replace(/^thin-job:/, '');
const byStart = (a: ExecutionJob, b: ExecutionJob) =>
  (a.worker.startedAt ?? 0) - (b.worker.startedAt ?? 0) || a.jobId.localeCompare(b.jobId);

/** Count live (running, waiting, queued) jobs belonging to `projectRoot`, using the same membership and settlement rules as Execution. */
export function countProjectLiveJobs(home: string, projectRoot: string): number {
  const cache = getJobIndexCache(home);
  const canonicals = new Map<string, string>();
  const canonical = (p: string) => {
    let known = canonicals.get(p);
    if (known === undefined) {
      try { known = fs.realpathSync(p); } catch { known = resolve(p); }
      canonicals.set(p, known);
    }
    return known;
  };
  const root = canonical(projectRoot);
  const { dirs } = cache.listJobDirsByMtime();
  let count = 0;
  for (const { id } of executionJobDirs(cache, dirs, Date.now())) {
    const jobRes = cache.readJob<Job & Record<string, unknown>>(id);
    if (jobRes.status !== 'ok') continue;
    const job = jobRes.value;
    if (job.job !== id || typeof job.role !== 'string' || job.reaped_at) continue;
    if (!worksWithin(root, job, canonical)) continue;
    const statusRes = cache.readStatus<Parameters<typeof jobRow>[1]>(id);
    const state = jobRow(job, statusRes.status === 'ok' ? statusRes.value : null).display_state;
    if (state === 'working' || state === 'queued') count++;
  }
  return count;
}

function endedJobResult(worker: OwnerWorker, job: Partial<Job>): EndedExecutionJob['result'] {
  if (worker.state === 'failed' || worker.state === 'stopped') return worker.state;
  if (worker.landingUnknown || !job.job) return undefined;
  if (worker.flow?.kind === 'land' && worker.flow.landedSha) return 'landed';
  return job.worktree ? 'not landed' : 'done';
}

/** Uses the bounded, project-scoped job snapshot; reuses its workers for Inspector identity and land facts. */
export function executionSnapshot(home: string, board: WorkboardSnapshot, scope: { root: string; pane: string | null; complete: boolean; activityOnly?: boolean }, now = Date.now()):
  ExecutionSnapshot {
  const cache = getJobIndexCache(home);
  const workers = new Map(board.workers.map((worker) => [jobIdOf(worker.id)!, worker]));
  let complete = scope.complete, runs: ExecutionRun[] = [];
  try { runs = readExecutionRuns(home, { root: scope.root, pane: scope.pane }, workers, now); }
  catch { complete = false; } // An unreadable flows directory does not hide the jobs we could read.
  if (runs.some((run) => run.tickets.some((ticket) => ticket.landingUnknown))) complete = false;
  const receipts = new Map<string, Partial<Job>>();
  const receipt = (id: string) => {
    let job = receipts.get(id);
    if (!job) {
      const read = cache.readJob<Job & Record<string, unknown>>(id);
      receipts.set(id, job = read.status === 'ok' ? read.value : {});
    }
    return job;
  };
  // A reaped job's worker is gone, whatever its last STATUS claims.
  const live = [...workers].filter(([id, w]) => w.settledAt === null && !receipt(id).reaped_at).map(([id]) => id);
  const ticketOf = (id: string) => {
    const job = receipt(id), ticket = text(job.ticket) ?? (typeof job.ticket === 'number' ? String(job.ticket) : text(job.slice));
    return ticket && /^\d+$/.test(ticket) && text(job.package) ? `${job.package}/${ticket}` : ticket;
  };
  const ticketActivity: TicketActivity[] = [];
  const recent = (at: number) => at >= now - ENDED_MS && at <= now;
  for (const id of live) {
    const ticket = ticketOf(id), worker = workers.get(id)!;
    const progressAt = Date.parse(worker.latest_progress?.at ?? '');
    if (ticket) ticketActivity.push({ ticket, kind: 'live', jobId: id, at: Number.isFinite(progressAt) ? progressAt : worker.startedAt ?? undefined });
  }
  for (const [id, worker] of workers) {
    const ticket = ticketOf(id);
    if (!ticket) continue;
    const land = worker.flow?.kind === 'land' ? worker.flow : undefined;
    const at = land?.landedSha ? land.updatedAt ?? worker.settledAt : worker.settledAt;
    if (at !== null && recent(at)) ticketActivity.push({ ticket, kind: 'ended', at, result: endedJobResult(worker, receipt(id)) });
  }
  for (const run of runs) {
    if (run.kind === 'land') {
      const ticket = run.jobIds?.[0] && ticketOf(run.jobIds[0]);
      if (ticket) ticketActivity.push({ ticket, kind: 'gate', flow: run.flow, at: run.updatedAt ?? run.createdAt ?? undefined });
    }
    for (const item of run.tickets) {
      const ticket = run.feature && /^\d+$/.test(item.ticket) ? `${run.feature}/${item.ticket}` : item.ticket;
      if (run.endedAt === undefined && item.stage === 'land-gate' && !item.landingUnknown)
        ticketActivity.push({ ticket, kind: 'gate', flow: item.landFlow ?? `${run.flow}:${ticket}`, at: item.since });
      if (run.endedAt !== undefined && recent(run.endedAt) && (item.jobId || item.stage === 'landed' || item.stage === 'failed')) {
        const worker = item.jobId && workers.get(item.jobId);
        const result = item.stage === 'landed' || item.stage === 'failed' ? item.stage
          : item.stage === 'settled' && !item.landingUnknown && worker ? endedJobResult(worker, receipt(item.jobId!)) : undefined;
        ticketActivity.push({ ticket, kind: 'ended', at: run.endedAt, result });
      }
    }
    if (run.kind !== 'queue' && run.endedAt !== undefined && recent(run.endedAt)) {
      for (const id of new Set(run.jobIds ?? [])) {
        const ticket = ticketOf(id), worker = workers.get(id);
        if (ticket) ticketActivity.push({ ticket, kind: 'ended', at: run.endedAt,
          result: worker?.settledAt != null ? endedJobResult(worker, receipt(id)) : undefined });
      }
    }
  }
  const snapshot = { root: scope.root, ...(runs.length ? { runs } : {}), ticketActivity, complete };
  if (scope.activityOnly) return { ...snapshot, jobs: [] };
  const children = new Map<string, string[]>();
  for (const [id, worker] of workers) {
    const parent = jobIdOf(worker.parentJobId);
    if (parent && parent !== id && workers.has(parent)) {
      let siblings = children.get(parent);
      if (!siblings) children.set(parent, siblings = []);
      siblings.push(id);
    }
  }
  const shown = new Set(live.flatMap((id) => [id, ...(children.get(id) ?? [])]));
  const liveSet = new Set(live);
  const jobs = new Map([...shown].map((jobId): [string, ExecutionJob] => {
    const worker = workers.get(jobId)!, job = receipt(jobId), dir = join(home, 'jobs', jobId);
    const status = cache.readStatus<{ state?: unknown }>(jobId);
    const state = status.status === 'ok' ? status.value.state : undefined;
    const phase: ExecutionPhase = !liveSet.has(jobId) ? 'settled' : worker.state === 'queued' ? 'queued'
      : worker.homeNeedsHuman || state === 'waiting_orchestrator' || state === 'blocked' ? 'waiting' : 'running';
    const dispatcher = job.dispatcher, pane = jobCallerPane(job) || undefined;
    const harness = text(dispatcher?.harness), id = text(dispatcher?.id);
    const preset = text(job.preset) ?? text(job.imp_preset) ?? text(job.route?.preset);
    const output = phase !== 'settled' && worker.headless && !worker.latest_progress ? readHeadlessOutput(dir) : undefined;
    const parentId = jobIdOf(worker.parentJobId);
    return [jobId, {
      jobId, worker, dir, phase,
      ...(preset ? { preset } : {}),
      ...(job.prewalk_kind ? { scout: job.prewalk_kind } : {}),
      ...(parentId ? { parentId, parentRole: workers.get(parentId)?.role ?? undefined } : {}),
      ...(harness || id || pane ? { session: { harness, id, pane } } : {}),
      ...(output ? { output } : {}),
    }];
  }));
  const runIds = new Set(runs.map((run) => run.flow));
  const runJobs = new Set(runs.flatMap((run) => [
    ...run.jobIds ?? [], ...run.tickets.map((ticket) => ticket.jobId), ...run.reviews.map((review) => review.job), ...run.decisions.map((decision) => decision.job),
  ]));
  const ended = [...workers].flatMap(([jobId, worker]) => {
    const endedAt = worker.settledAt;
    return endedAt !== null && recent(endedAt) && !runJobs.has(jobId) ? [{ jobId, worker, endedAt }] : [];
  }).sort((a, b) => b.endedAt - a.endedAt || a.jobId.localeCompare(b.jobId));
  const endedJobs: EndedExecutionJob[] = [];
  for (const entry of ended) {
    const { jobId, worker } = entry, job = receipt(jobId);
    if ([job.ticket_queue, job.workflow, job.batch_flow, job.council?.id, job.land_turn].some((id) => id && runIds.has(id))) continue;
    endedJobs.push({ ...entry, dir: join(home, 'jobs', jobId), result: endedJobResult(worker, job) });
  }
  const ordered = live.map((id) => ({ ...jobs.get(id)!, children: children.get(id)?.map((child) => jobs.get(child)!).sort(byStart) }))
    .sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || byStart(a, b));
  const excerpts = readSelectionExcerpts(home, cache, { project: scope.root });
  return { ...snapshot, endedJobs, jobs: ordered, ...(excerpts.length && { excerpts }) };
}

/** The Execution tab's facts: workflows, workers and their children, and recent outcomes. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import type { Job, PrewalkScoutKind } from '../mcp/job-contracts.js';
import { filterTimedOutQuestions, getJobIndexCache } from '../roles/job-index-cache.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { readSelectionExcerpts, type SelectionExcerpt } from '../roles/selection-excerpts.js';
import { isTicketQueueId } from '../mcp/ticket-queue-state.js';
import { isComposedId, type ComposedRun } from '../workflows/composed-state.js';
import { headerScanner } from '../workflows/header-scan.js';
import { runVisible } from '../workflows/scope.js';
import { stopRequested } from '../workflows/store.js';
import {
  ENDED_MS,
  isPublishingLandStep,
  jobTargetFor,
  readExecutionRuns,
  type ExecutionRun,
  type ExecutionRunJobTarget,
  type ExecutionRunMember,
  type LandProgress,
  type RunStepState,
} from './execution-runs.js';
import { readHeadlessOutput, type HeadlessOutput } from './headless-output.js';
import type { ProjectSnapshot } from './project-board.js';
import { targetKey } from './ticket-evidence.js';
import { displayTicketQueues } from './ticket-queue-display.js';
import { executionJobDirs, jobRow, worksWithin } from './thin-jobs.js';
import { workState } from './work-job.js';
import type { OwnerWorker, WorkboardSnapshot } from './workboard-types.js';

export type {
  ExecutionRun,
  ExecutionRunDecision,
  ExecutionRunJobTarget,
  ExecutionRunMember,
  ExecutionRunRepair,
  ExecutionRunReview,
  ExecutionRunStep,
  ExecutionRunTicket,
  LandProgress,
  MetroEdge,
  MetroFlow,
  MetroGate,
  MetroJunction,
  MetroLaneEdge,
  MetroLaneStation,
  MetroPoolCounts,
  MetroRepair,
  MetroStation,
  MetroStationKind,
  MetroStationState,
  ReducedMetroMap,
  RunStepKey,
  RunStepState,
  TicketRunStage,
  WorkflowNode,
} from './execution-runs.js';
export { lastChangedStationId, reduceMetroLanes } from './execution-runs.js';

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
  /** Settled child jobs folded into this parent row (newest first). */
  readonly children?: readonly EndedExecutionJob[];
}
export type LiveTicketJobState = 'working' | 'asking' | 'waiting' | 'queued' | 'stalled';
export type TicketActivity = {
  readonly ticket: string;
  readonly at?: number;
  readonly jobId?: string;
  readonly execJob?: ExecutionRunJobTarget;
} & (
  | { readonly kind: 'live'; readonly jobId: string; readonly startedAt?: number; readonly state?: LiveTicketJobState }
  | { readonly kind: 'gate'; readonly flow: string; readonly progress?: LandProgress }
  | { readonly kind: 'ended'; readonly at: number; readonly result?: EndedExecutionJob['result'] }
);
export interface ExecutionSnapshot {
  readonly root: string;
  /** Open workflows of this project, plus queues, batches and councils ended within the last 24 hours. */
  readonly runs?: readonly ExecutionRun[];
  /** Ended jobs not represented by a run, newest settlements first. */
  readonly endedJobs?: readonly EndedExecutionJob[];
  /** The same bounded observations, by ticket, before Execution deduplicates jobs shown in workflow rows. */
  readonly ticketActivity?: readonly TicketActivity[];
  /** Landing dates in the bounded inputs, even outside the activity window, for ordering done tickets. */
  readonly ticketLandings?: ReadonlyMap<string, number>;
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

const scanWaitingRuns = headerScanner();

/** Count open workflow runs waiting on main (paused or live blocker hand-back) for `projectRoot`. */
export function countProjectWaitingRuns(home: string, projectRoot: string): number {
  let root: string;
  try { root = fs.realpathSync(projectRoot); } catch { root = resolve(projectRoot); }
  let count = 0;
  try {
    const pass = scanWaitingRuns(home);
    const queues = displayTicketQueues(pass);
    for (const file of pass.files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      try {
        if (isTicketQueueId(id)) {
          const q = queues.get(file);
          const scopeRoot = q?.project_root ?? q?.root;
          if (q && scopeRoot && !stopRequested(home, id) &&
              (q.state === 'paused' || (q.state === 'working' && q.handback?.kind === 'blocker')) &&
              runVisible({ ...q, project_root: scopeRoot }, null, root)) {
            count++;
          }
        } else if (isComposedId(id)) {
          const run = pass.header<ComposedRun>(file);
          const scopeRoot = run?.project_root ?? run?.cwd;
          if (run?.template === 'composed' && scopeRoot && run.state === 'paused' &&
              runVisible({ ...run, project_root: scopeRoot }, null, root)) {
            count++;
          }
        }
      } catch { /* An unreadable flow header does not hide other runs. */ }
    }
  } catch { /* Missing flows directory means zero waiting runs. */ }
  return count;
}

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
export function executionSnapshot(home: string, board: WorkboardSnapshot, scope: {
  root: string; pane: string | null; complete: boolean; activityOnly?: boolean; project?: ProjectSnapshot;
}, now = Date.now()): ExecutionSnapshot {
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
  // The project scan already resolved hints and task/filename references. Join by job ID, not by re-parsing them.
  const linkedTickets = new Map<string, Set<string>>();
  const project = scope.project;
  for (const { slug, tickets } of [...(project?.tickets ?? []), ...(project?.objectiveTickets ?? []), ...(project?.unlinked ?? [])]) {
    for (const { number, job } of tickets) {
      if (!job?.id) continue;
      let keys = linkedTickets.get(job.id);
      if (!keys) linkedTickets.set(job.id, keys = new Set());
      keys.add(`${slug}/${number}`);
    }
  }
  const ticketsOf = (id: string) => {
    const job = receipt(id), ticket = text(job.ticket) ?? (typeof job.ticket === 'number' ? String(job.ticket) : text(job.slice));
    if (!ticket) return linkedTickets.get(id) ?? [];
    return [/^\d+$/.test(ticket) && text(job.package) ? `${job.package}/${ticket}` : ticket];
  };
  const ticketActivity: TicketActivity[] = [];
  const ticketLandings = new Map<string, number>();
  const recordLanding = (ticket: string, at: number) => {
    const key = targetKey(ticket);
    if (at <= now && at > (ticketLandings.get(key) ?? -Infinity)) ticketLandings.set(key, at);
  };
  const recent = (at: number) => at >= now - ENDED_MS && at <= now;
  for (const id of live) {
    const tickets = [...ticketsOf(id)];
    if (!tickets.length) continue;
    const worker = workers.get(id)!;
    const progressAt = Date.parse(worker.latest_progress?.at ?? '');
    const statusRes = cache.readStatus<{ state?: unknown }>(id);
    const rawState = statusRes.status === 'ok' ? statusRes.value.state : undefined;
    const state: LiveTicketJobState = worker.state === 'queued' ? 'queued'
      : worker.homeNeedsHuman ? 'asking'
      : rawState === 'waiting_orchestrator' || rawState === 'blocked' ? 'waiting'
      : workState(worker, now) === 'stalled' ? 'stalled'
      : 'working';
    const execJob = jobTargetFor(home, worker, id);
    for (const ticket of tickets) ticketActivity.push({
      ticket, kind: 'live', jobId: id,
      at: Number.isFinite(progressAt) ? progressAt : worker.startedAt ?? undefined,
      ...(worker.startedAt != null ? { startedAt: worker.startedAt } : {}),
      state,
      ...(execJob ? { execJob } : {}),
    });
  }
  const queueLandings = new Set<string>();
  for (const run of runs) {
    if (run.kind === 'land' && run.landActivity) {
      const sourceId = run.jobIds?.[0];
      const { progress, jobId, execJob } = run.landActivity;
      for (const ticket of sourceId ? ticketsOf(sourceId) : []) ticketActivity.push({
        ticket, kind: 'gate', flow: run.flow, jobId, at: run.updatedAt ?? run.createdAt ?? undefined,
        ...(progress ? { progress } : {}),
        ...(execJob ? { execJob } : {}),
      });
    }
    for (const item of run.tickets) {
      const ticket = run.feature && /^\d+$/.test(item.ticket) ? `${run.feature}/${item.ticket}` : item.ticket;
      if (run.endedAt === undefined && item.stage === 'land-gate' && !item.landingUnknown && !isPublishingLandStep(item.landStep)) {
        // Activity opens the current repair; the metro's host station keeps the source job.
        const repair = item.landProgress?.kind === 'repair' && item.landRepair?.jobId ? item.landRepair : undefined;
        const jobId = repair?.jobId ?? item.jobId;
        const execJob = repair ? repair.execJob : item.execJob;
        ticketActivity.push({
          ticket, kind: 'gate', flow: item.landFlow ?? `${run.flow}:${ticket}`, at: item.since,
          ...(jobId ? { jobId } : {}),
          ...(item.landProgress ? { progress: item.landProgress } : {}),
          ...(execJob ? { execJob } : {}),
        });
      }
      const at = item.changedAt;
      // A dated landing wins over the worker's settlement, even if the landing is outside the window.
      if (item.stage === 'landed' && at !== undefined) {
        recordLanding(ticket, at);
        if (item.jobId) queueLandings.add(`${item.jobId}:${targetKey(ticket)}`);
      }
      if (at !== undefined && recent(at) && (item.stage === 'landed' || item.stage === 'failed'
        || (run.endedAt !== undefined && (item.stage === 'settled' || (item.stage === 'held' && item.jobId))))) {
        const worker = item.jobId ? workers.get(item.jobId) : undefined;
        const result = item.stage === 'landed' || item.stage === 'failed' ? item.stage
          : item.stage === 'settled' && !item.landingUnknown && worker ? endedJobResult(worker, receipt(item.jobId!)) : undefined;
        const execJob = item.execJob ?? jobTargetFor(home, worker, item.jobId);
        ticketActivity.push({
          ticket, kind: 'ended', at, result,
          ...(item.jobId ? { jobId: item.jobId } : {}),
          ...(execJob ? { execJob } : {}),
        });
      }
    }
  }
  for (const [id, worker] of workers) {
    const land = worker.flow?.kind === 'land' ? worker.flow : undefined;
    const at = land?.landedSha ? land.landedAt ?? land.updatedAt ?? worker.settledAt : worker.settledAt;
    if (at === null || (!land?.landedSha && !recent(at))) continue;
    const execJob = jobTargetFor(home, worker, id);
    for (const ticket of ticketsOf(id)) {
      if (queueLandings.has(`${id}:${targetKey(ticket)}`)) continue;
      if (land?.landedSha) recordLanding(ticket, at);
      if (recent(at)) ticketActivity.push({
        ticket, kind: 'ended', at, result: endedJobResult(worker, receipt(id)), jobId: id,
        ...(execJob ? { execJob } : {}),
      });
    }
  }
  const snapshot = { root: scope.root, ...(runs.length ? { runs } : {}), ticketActivity, ticketLandings, complete };
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
  const runJobToFlow = new Map<string, string>();
  for (const run of runs) {
    const ids = [
      ...(run.jobIds ?? []),
      ...run.tickets.flatMap((ticket) => [ticket.jobId, ...(ticket.landRepairs?.map((repair) => repair.jobId) ?? [])]),
      ...run.reviews.map((review) => review.job),
      run.reviewer?.jobId,
      ...run.decisions.map((decision) => decision.job),
      run.lead?.jobId,
      ...(run.nodes ?? []).flat().map((node) => node.jobId),
    ];
    for (const id of ids) if (id && !runJobToFlow.has(id)) runJobToFlow.set(id, run.flow);
  }
  const runForJob = (jobId: string): string | undefined => {
    const direct = runJobToFlow.get(jobId);
    if (direct) return direct;
    const job = receipt(jobId);
    return [job.ticket_queue, job.workflow, job.batch_flow, job.council?.id, job.land_turn]
      .find((id): id is string => Boolean(id && runIds.has(id)));
  };
  /** `unknown` when `qa/` cannot be read. A question with a recorded timeout is closed. */
  const questionState = (jobId: string, worker: OwnerWorker): 'open' | 'closed' | 'unknown' => {
    if (worker.homeNeedsHuman) return 'open';
    try {
      return filterTimedOutQuestions(cache.readQa(jobId).openIds, receipt(jobId).timed_out_questions).length ? 'open' : 'closed';
    } catch { return 'unknown'; }
  };
  const childNeedsOwnRow = (jobId: string, worker: OwnerWorker): boolean =>
    worker.state === 'failed' || worker.state === 'error' || Boolean(worker.work?.failed) || questionState(jobId, worker) !== 'closed';
  const standaloneEnded: EndedExecutionJob[] = [...workers]
    .flatMap(([jobId, worker]) => {
      const endedAt = worker.settledAt;
      if (endedAt === null || !recent(endedAt) || runForJob(jobId)) return [];
      return [{ jobId, worker, dir: join(home, 'jobs', jobId), endedAt, result: endedJobResult(worker, receipt(jobId)) }];
    })
    .sort((a, b) => b.endedAt - a.endedAt || a.jobId.localeCompare(b.jobId));
  const standaloneById = new Map(standaloneEnded.map((entry) => [entry.jobId, entry]));
  // A run receipt does not prove that its member is retained or settled within the window.
  const reachable = (jobId: string) => {
    if (liveSet.has(jobId) || standaloneById.has(jobId)) return true;
    const worker = workers.get(jobId);
    return Boolean(worker && worker.settledAt !== null && recent(worker.settledAt) && runForJob(jobId));
  };
  const parentOf = ({ jobId, worker }: EndedExecutionJob) => {
    const parent = jobIdOf(worker.parentJobId);
    return parent === jobId ? undefined : parent;
  };
  /** The ancestor whose row counts this child instead of its own Recent row: a live card, a Recent row or a Run Detail step row. */
  const foldTarget = (entry: EndedExecutionJob): string | undefined => {
    let parentId = parentOf(entry);
    if (!parentId || !reachable(parentId) || childNeedsOwnRow(entry.jobId, entry.worker)) return undefined;
    const seen = new Set([entry.jobId]);
    while (!seen.has(parentId)) {
      seen.add(parentId);
      const parent = standaloneById.get(parentId);
      if (!parent) return parentId;
      const next = parentOf(parent);
      if (!next || !reachable(next) || childNeedsOwnRow(parentId, parent.worker)) return parentId;
      parentId = next;
    }
    return undefined;
  };
  const foldedChildren = new Map<string, EndedExecutionJob[]>();
  const foldedIds = new Set<string>();
  for (const entry of standaloneEnded) {
    const target = foldTarget(entry);
    if (!target) continue;
    foldedIds.add(entry.jobId);
    let list = foldedChildren.get(target);
    if (!list) foldedChildren.set(target, list = []);
    list.push(entry);
  }
  const endedJobs: EndedExecutionJob[] = standaloneEnded
    .filter((entry) => !foldedIds.has(entry.jobId))
    .map((entry) => {
      const folded = foldedChildren.get(entry.jobId);
      return folded?.length ? { ...entry, children: folded } : entry;
    });
  const ordered = live.map((id) => ({ ...jobs.get(id)!, children: children.get(id)?.map((child) => jobs.get(child)!).sort(byStart) }))
    .sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || byStart(a, b));
  const counted = runs.map((run) => {
    const claimed = new Set<string>();
    const claim = (jobId: string | undefined, execJob: ExecutionRunJobTarget | undefined) => {
      if (!jobId || !execJob) return undefined;
      const folded = foldedChildren.get(jobId);
      if (!folded?.length) return undefined;
      claimed.add(jobId);
      return folded;
    };
    const tickets = run.tickets.map((ticket) => {
      const folded = claim(ticket.jobId, ticket.execJob);
      let repairChanged = false;
      const landRepairs = ticket.landRepairs?.map((repair, idx, all) => {
        const isLastForJob = repair.jobId ? !all.slice(idx + 1).some((later) => later.jobId === repair.jobId) : false;
        if (!repair.jobId || repair.jobId === ticket.jobId || !isLastForJob) return repair;
        const repFolded = claim(repair.jobId, repair.execJob);
        if (!repFolded) return repair;
        repairChanged = true;
        return { ...repair, children: repFolded };
      });
      if (!folded && !repairChanged) return ticket;
      return { ...ticket, ...(folded ? { children: folded } : {}), ...(repairChanged && landRepairs ? { landRepairs } : {}) };
    });
    const reviewJobs = new Set(run.reviews.map((review) => review.job));
    const reviews = run.reviews.map((review, idx, all) => {
      const isLastForJob = !all.slice(idx + 1).some((later) => later.job === review.job);
      const folded = isLastForJob ? claim(review.job, review.execJob) : undefined;
      return folded ? { ...review, children: folded } : review;
    });
    const reviewerFolded = run.reviewer && !reviewJobs.has(run.reviewer.jobId ?? '')
      ? claim(run.reviewer.jobId, run.reviewer.execJob) : undefined;
    const reviewer = run.reviewer && reviewerFolded ? { ...run.reviewer, children: reviewerFolded } : run.reviewer;
    const decisionJobs = new Set(run.decisions.map((decision) => decision.job));
    const decisions = run.decisions.map((decision, idx, all) => {
      const isLastForJob = !all.slice(idx + 1).some((later) => later.job === decision.job);
      const folded = isLastForJob ? claim(decision.job, decision.execJob) : undefined;
      return folded ? { ...decision, children: folded } : decision;
    });
    const leadFolded = run.lead && !decisionJobs.has(run.lead.jobId ?? '')
      ? claim(run.lead.jobId, run.lead.execJob) : undefined;
    const lead = run.lead && leadFolded ? { ...run.lead, children: leadFolded } : run.lead;
    const flatNodes = (run.nodes ?? []).flat();
    const targetNodeIndexForJob = new Map<string, number>();
    flatNodes.forEach((node, idx) => {
      if (!node.jobId || !node.execJob) return;
      const prev = targetNodeIndexForJob.get(node.jobId);
      if (prev === undefined || !node.borrowedJob || flatNodes[prev].borrowedJob) {
        targetNodeIndexForJob.set(node.jobId, idx);
      }
    });
    let flatIdx = 0;
    const nodes = run.nodes?.map((wave) => wave.map((node) => {
      const idx = flatIdx++;
      const folded = node.jobId && targetNodeIndexForJob.get(node.jobId) === idx
        ? claim(node.jobId, node.execJob) : undefined;
      return folded ? { ...node, children: folded } : node;
    }));
    const otherSteps: ExecutionRunMember[] = [];
    for (const [jobId, folded] of foldedChildren) {
      if (claimed.has(jobId) || !folded.length || runForJob(jobId) !== run.flow) continue;
      const worker = workers.get(jobId);
      const execJob = jobTargetFor(home, worker, jobId);
      const isLive = liveSet.has(jobId);
      if (!worker || !execJob || (!isLive && (worker.settledAt === null || !recent(worker.settledAt)))) continue;
      const phase = isLive ? jobs.get(jobId)?.phase : undefined;
      const state: RunStepState = isLive
        ? (phase === 'queued' ? 'waiting' : phase === 'waiting' ? 'asking' : 'running')
        : worker.state === 'failed' || worker.state === 'error' || worker.work?.failed ? 'failed'
          : worker.state === 'stopped' ? 'cancelled' : 'done';
      const label = worker.ticketTitle ?? worker.briefTitle ?? worker.displayId ?? undefined;
      otherSteps.push({
        jobId,
        ...(worker.role ? { role: worker.role } : {}),
        ...(label ? { label } : {}),
        state,
        execJob,
        children: folded,
      });
    }
    otherSteps.sort((a, b) => (workers.get(a.jobId)?.startedAt ?? 0) - (workers.get(b.jobId)?.startedAt ?? 0) || a.jobId.localeCompare(b.jobId));
    return {
      ...run,
      tickets,
      reviews,
      ...(reviewer ? { reviewer } : {}),
      decisions,
      ...(lead ? { lead } : {}),
      ...(nodes ? { nodes } : {}),
      ...(otherSteps.length ? { otherSteps } : {}),
    };
  });
  const excerpts = readSelectionExcerpts(home, cache, { project: scope.root });
  return { ...snapshot, ...(counted.length && { runs: counted }), endedJobs, jobs: ordered, ...(excerpts.length && { excerpts }) };
}

/** Project workflows shown on Execution, collected from flow headers and job state off the paint path. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { batchActive, isBatchId, type Batch, type ItemResult } from '../mcp/batch-state.js';
import type { Job } from '../mcp/job-contracts.js';
import { activeLand, isFlowId, isLandWait, type LandFlow } from '../mcp/land-state.js';
import type { PrewalkInputs, ScoutOutcome } from '../mcp/prewalk-flow.js';
import {
  isTicketQueueId,
  type ReviewRecord,
  type RunDecision,
  type RunTodoItem,
  type TicketHandback,
  type TicketItemHold,
  type TicketQueue,
  type TicketQueueItem,
} from '../mcp/ticket-queue-state.js';
import { getJobIndexCache, JOB_ID_RE, type JobIndexCache } from '../roles/job-index-cache.js';
import { isOpenTicketRun } from '../unattended/state.js';
import type { ComposedCursor } from '../workflows/composed-state.js';
import { SEALED_REPAIR_LIMIT, type Cursor, type Run } from '../workflows/engine.js';
import type { Graph } from '../workflows/graph.js';
import { headerScanner, type HeaderPass } from '../workflows/header-scan.js';
import { runVisible, type RunScope } from '../workflows/scope.js';
import {
  lastChangedStationId,
  reduceMetroLanes,
  type MetroEdge,
  type MetroFlow,
  type MetroGate,
  type MetroJunction,
  type MetroLaneEdge,
  type MetroLaneStation,
  type MetroPoolCounts,
  type MetroRepair,
  type MetroStation,
  type MetroStationKind,
  type MetroStationState,
  type ReducedMetroMap,
} from './execution-metro.js';
import { targetKey } from './ticket-evidence.js';
import { scanTicketStore } from './ticket-store.js';
import { workState } from './work-job.js';
import type { OwnerWorker, WorkBatch, WorkTarget } from './workboard-types.js';

export {
  lastChangedStationId,
  reduceMetroLanes,
  type MetroEdge,
  type MetroFlow,
  type MetroGate,
  type MetroJunction,
  type MetroLaneEdge,
  type MetroLaneStation,
  type MetroPoolCounts,
  type MetroRepair,
  type MetroStation,
  type MetroStationKind,
  type MetroStationState,
  type ReducedMetroMap,
};

/** The retention window for Execution's Recently ended section (jobs and runs). */
export const ENDED_MS = 24 * 60 * 60_000;
const STEP_KEYS = ['tickets', 'review', 'accept'] as const;
const STEP_STATES = new Set<RunStepState>(['waiting', 'running', 'asking', 'done', 'failed', 'skipped', 'cancelled']);
const CLEAN_STATUS_STATES = new Set(['idle_grace', 'done', 'closed']);
const scan = headerScanner();

export type RunStepKey = (typeof STEP_KEYS)[number];
export type RunStepState = 'waiting' | 'running' | 'asking' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type TicketRunStage = 'queued' | 'blocked' | 'worker' | 'settled' | 'land-gate' | 'landed' | 'held' | 'failed';
export type ExecutionRunJobTarget = {
  readonly target: Extract<WorkTarget, { kind: 'worker' }>;
  readonly dir: string;
  readonly tab: boolean;
};

export interface ExecutionRunStep {
  readonly key: RunStepKey;
  readonly state: RunStepState;
  readonly verdict?: string;
  readonly changedAt?: number;
}

export interface ExecutionRunTicket {
  readonly ticket: string;
  readonly role?: 'imp' | 'frontend-imp';
  readonly stage: TicketRunStage;
  readonly jobId?: string;
  readonly landFlow?: string;
  readonly landStep?: string;
  readonly landProgress?: LandProgress;
  readonly landGate?: MetroGate;
  readonly landRepair?: MetroRepair;
  readonly landRepairs?: readonly MetroRepair[];
  readonly title?: string;
  readonly since?: number;
  /** Last station transition time (landed, failed, held, asking, answered, gate step change, worker start). */
  readonly changedAt?: number;
  readonly stalled?: true;
  readonly statusUnknown?: true;
  readonly blockers?: readonly string[];
  /** Declared dependencies from the run receipt, or the ticket store when not recorded there. */
  readonly deps?: readonly string[];
  readonly asking?: boolean;
  readonly holdTag?: string;
  readonly reason?: string;
  readonly landingUnknown?: true;
  readonly execJob?: ExecutionRunJobTarget;
}

export interface LandProgress {
  readonly kind: 'gate' | 'repair' | 'lease';
  readonly index?: number;
  readonly total?: number;
  readonly passed?: number;
  readonly since?: number;
}
export interface WorkflowNode {
  readonly key: string;
  readonly label?: string;
  readonly word?: string;
  readonly role?: string;
  readonly state: RunStepState;
  readonly blockers?: readonly string[];
  readonly progress?: LandProgress;
  readonly gate?: MetroGate;
  readonly repair?: MetroRepair;
  readonly repairs?: readonly MetroRepair[];
  readonly since?: number;
  readonly changedAt?: number;
  readonly reason?: string;
  readonly jobId?: string;
  readonly execJob?: ExecutionRunJobTarget;
}
export interface ExecutionRun {
  readonly flow: string;
  readonly kind: 'queue' | 'batch' | 'council' | 'prewalk' | 'land' | 'graph';
  readonly label: string;
  /** Authoritative queue feature for legacy bare ticket numbers, not the display label. */
  readonly feature?: string;
  readonly unattended: boolean;
  readonly state: TicketQueue['state'];
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly endedAt?: number;
  readonly result?: 'failed' | 'landed' | 'not landed' | 'done' | 'stopped';
  readonly jobIds?: readonly string[];
  readonly nodes?: readonly (readonly WorkflowNode[])[];
  readonly queueWaves?: {
    readonly prefix: readonly ExecutionRunTicket[];
    readonly current: readonly ExecutionRunTicket[];
    readonly blocked: readonly (readonly ExecutionRunTicket[])[];
  };
  /** Metro-map stations (id, kind, state, change time) and edges for open flows. */
  readonly metro?: MetroFlow;
  readonly batch?: WorkBatch & { readonly slots?: number; readonly pilots?: { readonly done: number; readonly total: number; readonly state: RunStepState } };
  readonly lead?: WorkflowNode;
  readonly acceptanceSeat?: 'lead' | 'main';
  readonly reviewer?: WorkflowNode;
  readonly steps: readonly ExecutionRunStep[];
  readonly verdict?: string;
  readonly reason?: string;
  readonly held?: TicketItemHold;
  readonly handback?: TicketHandback;
  readonly tickets: readonly ExecutionRunTicket[];
  readonly todo: readonly RunTodoItem[];
  readonly decisions: readonly RunDecision[];
  readonly reviews: readonly ReviewRecord[];
  readonly heldCount: number;
  readonly repairRounds: number;
}

function parseTime(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function holdTagOf(hold: TicketItemHold): string | undefined {
  if (hold.owner_approval === 'spec-change') return 'spec change';
  if (hold.owner_approval === 'feature-deletion') return 'feature deletion';
  if (hold.kind === 'assumption') return 'assumption';
  if (hold.kind === 'blocker') return 'blocker';
  if (hold.kind === 'question') return 'question';
  if (hold.kind === 'review') return 'review';
  if (hold.kind === 'check') return 'check';
  if (hold.kind === 'dispatch') return 'dispatch';
  if (hold.kind === 'escalate') return 'escalated';
  return undefined;
}

function maxTime(...values: (number | null | undefined)[]): number | undefined {
  let best: number | undefined;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && (best === undefined || v > best)) best = v;
  }
  return best;
}

function stepToMetroState(state: RunStepState): MetroStationState {
  switch (state) {
    case 'running': return 'working';
    case 'asking': return 'asking';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'skipped':
    case 'cancelled': return 'stopped';
    default: return 'waiting';
  }
}

function readSteps(q: TicketQueue): ExecutionRunStep[] {
  return STEP_KEYS.map((key) => {
    const cursor = q.steps?.[key];
    const raw = cursor?.state;
    const state: RunStepState = raw === 'ready'
      ? 'waiting'
      : raw && STEP_STATES.has(raw as RunStepState)
        ? (raw as RunStepState)
        : q.state === 'completed' ? 'done' : 'waiting';
    const verdict = key === 'accept'
      ? (cursor?.answer?.trim() || q.verdict?.trim().split(/[:\s]/, 1)[0] || undefined)
      : undefined;
    const changedAt = parseTime(cursor?.changed_at) ?? undefined;
    return { key, state, ...(verdict ? { verdict } : {}), ...(changedAt !== undefined ? { changedAt } : {}) };
  });
}

export function jobTargetFor(home: string, worker: OwnerWorker | undefined, jobId: string | undefined): ExecutionRunJobTarget | undefined {
  return worker && jobId ? {
    target: { kind: 'worker', laneId: worker.laneId, workerId: worker.id },
    dir: join(home, 'jobs', jobId),
    tab: !worker.headless && worker.state !== 'queued' && worker.settledAt === null,
  } : undefined;
}

function parseGateStep(step: string, total: number | undefined, state: MetroGate['state']): MetroGate | undefined {
  const m = /^gate\[(\d+)\](?::\s*(.+))?/.exec(step);
  if (m && total !== undefined && total > 0) {
    const index = Number(m[1]);
    const passed = state === 'done' ? total : Math.max(0, Math.min(total, index - 1));
    const command = m[2]?.trim() || undefined;
    return { index, total, passed, state, ...(command ? { command } : {}) };
  }
  if (state === 'done' && total !== undefined && total > 0) {
    return { index: total, total, passed: total, state: 'done' };
  }
  return undefined;
}

function landProgress(land: LandFlow): LandProgress | undefined {
  const since = parseTime(land.step_started_at) ?? undefined;
  const gate = /^gate\[(\d+)\]/.exec(land.step), repair = /^repair (\d+)/.exec(land.step);
  if (isLandWait(land.step)) return { kind: 'lease', since };
  if (gate) {
    const index = Number(gate[1]);
    const total = land.config?.gate?.length;
    const passed = total !== undefined ? Math.max(0, Math.min(total, index - 1)) : Math.max(0, index - 1);
    return { kind: 'gate', index, total, passed, since };
  }
  if (repair) return { kind: 'repair', index: Number(repair[1]), total: SEALED_REPAIR_LIMIT, since };
}

interface WorkerStatusInfo {
  readonly state: RunStepState;
  readonly changedAt?: number;
}

function answeredQuestionTime(worker?: OwnerWorker): number | undefined {
  let best: number | undefined;
  if (worker?.files?.length) {
    for (const f of worker.files) {
      if (f.kind === 'question' && (f.state === 'answered' || f.state === 'departure')) best = maxTime(best, f.at);
    }
  }
  return best;
}

function workerStatusInfo(
  cache: JobIndexCache,
  jobId: string,
  fallback: RunStepState,
  worker?: OwnerWorker,
  qa?: { home: string; step: string; decisions?: readonly RunDecision[] },
): WorkerStatusInfo {
  const status = cache.readStatus<{ state?: string; started_at?: string; settled_at?: string; ended_at?: string }>(jobId);
  const v = status.status === 'ok' ? status.value : undefined;
  const observed = v?.state;
  const terminal: RunStepState | undefined = observed === 'failed' ? 'failed'
    : observed === 'stopped' ? 'cancelled'
      : observed && CLEAN_STATUS_STATES.has(observed) ? 'done'
        : observed === 'queued' ? 'waiting' : undefined;
  if (terminal) {
    const changedAt = terminal === 'waiting' ? undefined
      : (worker?.settledAt ?? parseTime(v?.ended_at) ?? parseTime(v?.settled_at) ?? worker?.startedAt ?? parseTime(v?.started_at) ?? undefined);
    return { state: terminal, changedAt };
  }
  const qInfo = qa
    ? workerQuestion(qa.home, cache, jobId, { step: qa.step }, qa.decisions, observed, worker)
    : undefined;
  const state: RunStepState = qInfo
    ? (qInfo.delivered ? 'running' : qInfo.asking ? 'asking' : observed === 'working' || observed === 'waiting_helper' ? 'running' : fallback)
    : (observed === 'waiting_orchestrator' || observed === 'blocked' || worker?.homeNeedsHuman ? 'asking'
      : observed === 'working' || observed === 'waiting_helper' ? 'running' : fallback);
  const changedAt = state === 'asking'
    ? (worker?.humanEndedAt ?? worker?.startedAt ?? parseTime(v?.started_at) ?? undefined)
    : state === 'running'
      ? (qInfo?.delivered ? qInfo.answerAt : maxTime(worker?.startedAt, parseTime(v?.started_at), qInfo?.answerAt ?? answeredQuestionTime(worker)))
      : undefined;
  return { state, changedAt };
}

function extractLandGateAndRepair(
  home: string,
  land: LandFlow,
  workers: ReadonlyMap<string, OwnerWorker>,
  cache: JobIndexCache,
  repairIdPrefix: string,
): { progress?: LandProgress; gate?: MetroGate; repair?: MetroRepair; repairs?: MetroRepair[] } {
  const progress = landProgress(land);
  const total = land.config?.gate?.length;
  const publishing = land.step === 'records' || land.step === 'fast-forward' || /^after\[/.test(land.step)
    || land.step === 'push' || land.step === 'cleanup' || land.step === 'done';
  const gateTiming = land.timings?.filter((timing) => /^gate\[/.test(timing.step)).at(-1);
  const rawRepairs = land.repairs ?? [];
  const lastRepair = rawRepairs.at(-1);
  let gate: MetroGate | undefined;
  if (progress?.kind === 'gate') {
    gate = parseGateStep(land.step, total, land.state === 'failed' ? 'failed' : 'working');
  } else if (lastRepair && /^gate\[/.test(lastRepair.step)) {
    const failed = progress?.kind === 'repair' || land.state === 'failed' || gateTiming?.ok === false;
    gate = parseGateStep(lastRepair.step, total, failed ? 'failed' : 'done');
  } else if (gateTiming) {
    gate = parseGateStep(gateTiming.step, total, gateTiming.ok ? 'done' : 'failed');
  } else if (publishing || land.landed_sha) {
    gate = parseGateStep('', total, 'done');
  }

  const jobRole = (jobId: string | undefined): string | undefined => {
    if (!jobId) return undefined;
    const fromWorker = workers.get(jobId)?.role;
    if (fromWorker) return fromWorker;
    if (!JOB_ID_RE.test(jobId)) return undefined;
    const read = cache.readJob<Job>(jobId);
    return read.status === 'ok' && read.value.job === jobId && typeof read.value.role === 'string' && read.value.role
      ? read.value.role
      : undefined;
  };
  const sourceRole = jobRole(land.job);
  const repairing = progress?.kind === 'repair' && activeLand(land) && !land.landed_sha;
  const repairs: MetroRepair[] = rawRepairs.map((attempt, idx) => {
    const round = idx + 1;
    const isLast = idx === rawRepairs.length - 1;
    const isActive = repairing && isLast;
    const jobReusedLater = Boolean(attempt.job && rawRepairs.slice(idx + 1).some((later) => later.job === attempt.job));
    const repairWorker = attempt.job ? workers.get(attempt.job) : undefined;
    const repairRole = jobRole(attempt.job) ?? sourceRole;
    const info = attempt.job && (!jobReusedLater || isActive)
      ? workerStatusInfo(cache, attempt.job, isActive ? 'running' : 'done', repairWorker)
      : undefined;
    const outcomeDone = attempt.outcome === 'settled; retrying gate' || attempt.outcome === 'gate passed';
    const repairState: MetroStationState = isActive
      ? (info ? stepToMetroState(info.state) : 'working')
      : outcomeDone ? 'done' : 'failed';
    const recordedAt = parseTime(attempt.changed_at);
    const startedAt = parseTime(attempt.started_at);
    const repairChangedAt = isActive
      ? (maxTime(info?.changedAt, recordedAt) ?? parseTime(land.step_started_at) ?? parseTime(land.updated_at) ?? undefined)
      : (maxTime(recordedAt, !jobReusedLater ? info?.changedAt : undefined) ?? startedAt ?? (isLast ? parseTime(land.updated_at) : null) ?? undefined);
    return {
      id: round === 1 ? `${repairIdPrefix}↻` : `${repairIdPrefix}↻${round}`,
      round,
      total: SEALED_REPAIR_LIMIT,
      state: repairState,
      ...(repairChangedAt !== undefined ? { changedAt: repairChangedAt } : {}),
      ...(repairRole ? { role: repairRole } : {}),
      ...(attempt.job ? {
        label: attempt.job.slice(0, 8),
        jobId: attempt.job,
        execJob: jobTargetFor(home, repairWorker, attempt.job),
      } : {}),
      ...(repairState === 'failed' && attempt.outcome ? { reason: attempt.outcome } : {}),
    };
  });
  const repair = repairs.at(-1);
  return { progress, gate, ...(repair ? { repair, repairs } : {}) };
}

function workerQuestion(
  home: string,
  cache: JobIndexCache,
  jobId: string,
  match: { ticket: string; answeredAt?: string } | { step: string },
  decisions: readonly RunDecision[] | undefined,
  status: string | undefined,
  worker?: OwnerWorker,
): { asking: boolean; answerAt?: number; delivered?: true } {
  let answerAt = maxTime('answeredAt' in match ? parseTime(match.answeredAt) : undefined, answeredQuestionTime(worker));
  for (const d of decisions ?? []) {
    if (d.kind !== 'question' || d.decision !== 'answer') continue;
    if (d.worker_job && d.worker_job !== jobId) continue;
    const matched = 'ticket' in match ? d.ticket === match.ticket : d.step === match.step && !d.ticket;
    if (matched) answerAt = maxTime(answerAt, parseTime(d.at));
  }
  const waiting = status === 'waiting_orchestrator';
  const asking = waiting || status === 'blocked' || Boolean(worker?.homeNeedsHuman);
  if ((waiting || !asking) && JOB_ID_RE.test(jobId)) {
    try {
      const qa = cache.readQa(jobId);
      if (qa.openIds.length) return { asking: true, answerAt };
      if (waiting && qa.allQuestionFiles.length) {
        // The answer may be on disk before the runner stamps answered_at or the worker updates STATUS.
        const seen = new Set(worker?.files?.filter(f => f.kind === 'question' && (f.state === 'answered' || f.state === 'departure')).map(f => f.rel));
        for (const file of qa.allQuestionFiles) {
          if (seen.has(`qa/${file}`)) continue;
          const path = join(home, 'jobs', jobId, 'qa', file.replace(/\.md$/, '.answer.md'));
          const stat = fs.lstatSync(path, { throwIfNoEntry: false });
          if (stat?.isFile()) answerAt = maxTime(answerAt, Math.floor(stat.mtimeMs));
        }
        return { asking: false, answerAt, delivered: true };
      }
    } catch { /* An unreadable Q&A directory is not evidence of delivery. */ }
  }
  return { asking, answerAt };
}

function ticketLand(
  home: string, item: TicketQueueItem, pass: HeaderPass, workers: ReadonlyMap<string, OwnerWorker>, cache: JobIndexCache,
) {
  if (!isFlowId(item.land)) return;
  try {
    // Read only the header; the recovery-aware land API can write to it.
    const land = pass.header<LandFlow>(`${item.land}.json`);
    if (land?.flow === item.land && land.job === item.job && typeof land.step === 'string' && land.step.trim() &&
        (land.landed_sha === undefined || (typeof land.landed_sha === 'string' && /^[\da-f]{7,64}$/i.test(land.landed_sha)))) {
      return { land, ...extractLandGateAndRepair(home, land, workers, cache, item.ticket) };
    }
  } catch { /* The ticket is still known, but its land record is not. */ }
}

function projectTicketItem(
  home: string,
  item: TicketQueueItem,
  decisions: readonly RunDecision[] | undefined,
  pass: HeaderPass,
  workers: ReadonlyMap<string, OwnerWorker>,
  cache: JobIndexCache,
  now: number,
): ExecutionRunTicket {
  const worker = item.job ? workers.get(item.job) : undefined;
  const execJob = jobTargetFor(home, worker, item.job);
  const heading = worker?.ticketTitle ?? worker?.briefTitle;
  const first = heading?.match(/^[^\s:]+/)?.[0];
  const title = first && (first === worker?.displayId || first === item.ticket) ? heading!.slice(first.length).replace(/^[:–—\s]+/, '') : heading;
  const itemChangedAt = parseTime(item.changed_at);
  // Keep the sealed land history even when the queue item itself has already settled.
  const landDetails = ticketLand(home, item, pass, workers, cache);
  const base = {
    ticket: item.ticket,
    role: item.role,
    ...(item.job ? { jobId: item.job } : {}),
    ...(title ? { title } : {}),
    ...(worker?.startedAt != null ? { since: worker.startedAt } : {}),
    ...(item.land ? { landFlow: item.land } : {}),
    ...(Array.isArray(item.blockers) ? { deps: item.blockers } : {}),
    ...(execJob ? { execJob } : {}),
    ...(landDetails?.repair ? { landRepair: landDetails.repair, landRepairs: landDetails.repairs } : {}),
  };

  if (item.failed) {
    const changedAt = parseTime(item.failed.at) ?? itemChangedAt ?? worker?.settledAt ?? worker?.startedAt ?? undefined;
    return { ...base, stage: 'failed', ...(changedAt !== undefined ? { changedAt } : {}), ...(item.failed.reason ? { reason: item.failed.reason } : {}) };
  }
  if (item.landed === true) {
    const workLand = worker?.flow?.kind === 'land' && worker.flow.landedSha ? worker.flow : undefined;
    const changedAt = parseTime(item.landed_at) ?? itemChangedAt ?? parseTime(landDetails?.land.landed_at) ?? workLand?.landedAt ?? workLand?.updatedAt ?? worker?.settledAt ?? undefined;
    return { ...base, stage: 'landed', ...(changedAt !== undefined ? { changedAt } : {}) };
  }
  if (item.held) {
    const holdTag = holdTagOf(item.held);
    const changedAt = parseTime(item.held.at) ?? itemChangedAt ?? worker?.humanEndedAt ?? worker?.settledAt ?? worker?.startedAt ?? undefined;
    return { ...base, stage: 'held', ...(changedAt !== undefined ? { changedAt } : {}), ...(holdTag ? { holdTag } : {}), ...(item.held.reason ? { reason: item.held.reason } : {}) };
  }

  if (landDetails) {
    const { land, progress, gate } = landDetails;
    if (land.state === 'failed' || land.state === 'cancelled') {
      const changedAt = parseTime(land.updated_at) ?? parseTime(land.step_started_at) ?? parseTime(land.created_at) ?? worker?.settledAt ?? worker?.startedAt ?? undefined;
      const reason = land.state === 'cancelled' ? 'cancelled' : typeof land.error === 'string' ? land.error : undefined;
      return { ...base, stage: 'failed', ...(changedAt !== undefined ? { changedAt } : {}), ...(gate ? { landGate: gate } : {}), ...(reason ? { reason } : {}) };
    }
    if (land.state === 'completed' || activeLand(land)) {
      if (land.landed_sha) {
        const changedAt = parseTime(land.landed_at) ?? parseTime(land.updated_at) ?? parseTime(land.step_started_at) ?? worker?.settledAt ?? worker?.startedAt ?? undefined;
        return { ...base, stage: 'landed', ...(changedAt !== undefined ? { changedAt } : {}) };
      }
      if (land.publish_pending) {
        const changedAt = parseTime(land.updated_at) ?? parseTime(land.step_started_at) ?? parseTime(land.created_at) ?? undefined;
        return { ...base, stage: 'land-gate', landingUnknown: true, ...(changedAt !== undefined ? { changedAt } : {}) };
      }
      if (land.state === 'completed') {
        const changedAt = parseTime(land.updated_at) ?? worker?.settledAt ?? worker?.startedAt ?? undefined;
        return { ...base, stage: 'settled', ...(changedAt !== undefined ? { changedAt } : {}) };
      }
      const since = parseTime(land.step_started_at) ?? parseTime(land.created_at) ?? undefined;
      const changedAt = since ?? parseTime(land.updated_at) ?? undefined;
      return { ...base, stage: 'land-gate', landStep: land.step, landProgress: progress,
        ...(gate ? { landGate: gate } : {}), since, ...(changedAt !== undefined ? { changedAt } : {}) };
    }
  }
  if (item.land) return { ...base, stage: 'land-gate', landingUnknown: true };
  if (!worker?.landingUnknown && worker?.flow?.kind === 'land') {
    const changedAt = worker.flow.updatedAt ?? worker.settledAt ?? worker.startedAt ?? undefined;
    if (worker.flow.state === 'failed') return { ...base, stage: 'failed', ...(changedAt !== undefined ? { changedAt } : {}), ...(worker.flow.error ? { reason: worker.flow.error } : {}) };
    if (worker.flow.state === 'cancelled') return { ...base, stage: 'failed', ...(changedAt !== undefined ? { changedAt } : {}), reason: 'cancelled' };
    if (worker.flow.landedSha) {
      const landedAt = worker.flow.landedAt ?? worker.flow.updatedAt ?? worker.settledAt ?? undefined;
      return { ...base, stage: 'landed', ...(landedAt !== undefined ? { changedAt: landedAt } : {}) };
    }
    if (worker.flow.state === 'completed') return { ...base, stage: 'settled', ...(changedAt !== undefined ? { changedAt } : {}) };
    return { ...base, stage: 'land-gate', ...(worker.flow.step ? { landStep: worker.flow.step } : {}), ...(changedAt !== undefined ? { changedAt } : {}) };
  }

  if (item.job) {
    if (worker) {
      if (worker.state === 'failed' || worker.state === 'stopped' || worker.state === 'error' || worker.work?.failed) {
        const changedAt = worker.settledAt ?? worker.humanEndedAt ?? worker.startedAt ?? undefined;
        return { ...base, stage: 'failed', ...(changedAt !== undefined ? { changedAt } : {}), ...(worker.work?.reason ? { reason: worker.work.reason } : {}) };
      }
      if (worker.settledAt !== null) {
        const changedAt = maxTime(worker.settledAt, itemChangedAt);
        return { ...base, stage: 'settled', ...(changedAt !== undefined ? { changedAt } : {}), ...(worker.landingUnknown ? { landingUnknown: true } : {}) };
      }
      if (worker.state === 'queued') return { ...base, stage: 'queued', ...(worker.startedAt != null ? { changedAt: worker.startedAt } : {}) };
      const status = cache.readStatus<{ state?: string }>(item.job);
      const statusState = status.status === 'ok' ? status.value.state : undefined;
      const { asking, delivered, answerAt } = workerQuestion(home, cache, item.job, { ticket: item.ticket, answeredAt: item.answered_at }, decisions, statusState, worker);
      const changedAt = asking ? (worker.humanEndedAt ?? worker.startedAt ?? undefined)
        : delivered ? answerAt : maxTime(worker.startedAt, itemChangedAt, answerAt);
      return { ...base, stage: 'worker', ...(asking ? { asking: true } : {}),
        ...(changedAt !== undefined ? { changedAt } : {}),
        ...(!delivered && workState(worker, now) === 'stalled' ? { stalled: true } : {}) };
    }
    const status = cache.readStatus<{ state?: unknown; error?: unknown; started_at?: string; settled_at?: string; ended_at?: string }>(item.job);
    const v = status.status === 'ok' ? status.value : undefined;
    const statusState = typeof v?.state === 'string' ? v.state : undefined;
    if (statusState === 'failed' || statusState === 'stopped') {
      const error = typeof v?.error === 'string' ? v.error : undefined;
      const changedAt = parseTime(v?.ended_at) ?? parseTime(v?.settled_at) ?? itemChangedAt ?? parseTime(v?.started_at) ?? undefined;
      return { ...base, stage: 'failed', ...(changedAt !== undefined ? { changedAt } : {}), ...(error ? { reason: error } : {}) };
    }
    if (statusState && CLEAN_STATUS_STATES.has(statusState)) {
      const changedAt = parseTime(v?.settled_at) ?? parseTime(v?.ended_at) ?? itemChangedAt ?? parseTime(v?.started_at) ?? undefined;
      return { ...base, stage: 'settled', ...(changedAt !== undefined ? { changedAt } : {}) };
    }
    if (statusState === 'queued') return { ...base, stage: 'queued' };
    const { asking, delivered, answerAt } = workerQuestion(home, cache, item.job, { ticket: item.ticket, answeredAt: item.answered_at }, decisions, statusState);
    const changedAt = asking ? (parseTime(v?.started_at) ?? itemChangedAt ?? undefined)
      : delivered ? answerAt : maxTime(parseTime(v?.started_at), itemChangedAt, answerAt);
    return { ...base, stage: 'worker', ...(asking ? { asking: true } : {}), ...(changedAt !== undefined ? { changedAt } : {}), ...(!statusState ? { statusUnknown: true } : {}) };
  }

  return { ...base, stage: 'queued', ...(itemChangedAt !== null ? { changedAt: itemChangedAt } : {}) };
}

function projectTickets(
  home: string,
  q: TicketQueue,
  pass: HeaderPass,
  workers: ReadonlyMap<string, OwnerWorker>,
  cache: JobIndexCache,
  now: number,
  open: boolean,
): ExecutionRunTicket[] {
  const out: ExecutionRunTicket[] = [];
  const seen = new Set<string>();
  for (const item of q.tickets ?? []) {
    if (!item?.ticket) continue;
    seen.add(item.ticket);
    out.push(projectTicketItem(home, item, q.decisions, pass, workers, cache, now));
  }
  if (open) {
    const blockedIds = new Set(q.blocked?.map(entry => entry?.ticket));
    for (const entry of q.future ?? []) {
      if (!entry?.ticket || seen.has(entry.ticket)) continue;
      seen.add(entry.ticket);
      out.push({ ticket: entry.ticket, title: entry.title, role: entry.role,
        stage: blockedIds.has(entry.ticket) ? 'blocked' : 'queued',
        // An omitted waiting_on in a future receipt means there are no unresolved blockers.
        deps: entry.blockers, blockers: entry.waiting_on ?? [] });
    }
  }
  for (const entry of q.queued ?? []) {
    if (!entry?.ticket || seen.has(entry.ticket)) continue;
    seen.add(entry.ticket);
    out.push({ ticket: entry.ticket, stage: 'queued', ...(entry.blockers?.length ? { blockers: entry.blockers } : {}) });
  }
  for (const entry of q.blocked ?? []) {
    if (!entry?.ticket || seen.has(entry.ticket)) continue;
    seen.add(entry.ticket);
    out.push({ ticket: entry.ticket, stage: 'blocked', ...(entry.blockers?.length ? { blockers: entry.blockers } : {}) });
  }
  return out;
}

/** Normalize for joins without changing the original IDs displayed by a legacy run. */
function queueTicketKey(ticket: string, feature?: string): string {
  const token = ticket.trim();
  const number = /^#?(\d+)$/.exec(token)?.[1];
  if (number) return feature ? `${feature.toLowerCase()}/${Number(number)}` : String(Number(number));
  const qualified = /^([\w.-]+)\/(\d+)$/.exec(token);
  return qualified ? `${qualified[1].toLowerCase()}/${Number(qualified[2])}` : targetKey(token);
}

function withTicketFacts(tickets: ExecutionRunTicket[], feature: string | undefined, lookup: ReturnType<typeof scanTicketStore>['lookup']) {
  const landed = new Set(tickets.filter(({ stage }) => stage === 'landed').map(({ ticket }) => queueTicketKey(ticket, feature)));
  return tickets.map((t) => {
    const fact = lookup(t.ticket, feature);
    if (!fact) return t;
    // Admitted items keep the edges recorded by their run; queued items have no admission record yet.
    const deps = t.deps ?? fact.blockers;
    const owner = t.ticket.includes('/') ? t.ticket.split('/')[0] : feature;
    const blockers = t.blockers ?? (t.stage === 'queued' || t.stage === 'blocked'
      ? deps?.filter((ref) => {
        const key = queueTicketKey(ref, owner), state = lookup(key)?.state;
        return !landed.has(key) && state !== 'done' && state !== 'dropped';
      }) : undefined);
    return { ...t, title: fact.title, ...(deps !== undefined ? { deps } : {}), ...(blockers?.length ? { blockers } : {}) };
  });
}

// Level the recorded edges only. Unknown/outside dependencies stay on their nodes;
// a damaged cycle has one unresolved wave rather than preventing the other waves.
function dependencyWaves<T>(nodes: readonly T[], key: (node: T) => string, needs: (node: T) => readonly string[]): T[][] {
  const pending = new Set(nodes.map(key)), waves: T[][] = [];
  let rest = [...nodes];
  while (rest.length) {
    const wave = rest.filter((node) => !needs(node).some((id) => pending.has(id)));
    if (!wave.length) { waves.push(rest); break; }
    waves.push(wave);
    for (const node of wave) pending.delete(key(node));
    rest = rest.filter((node) => pending.has(key(node)));
  }
  return waves;
}

function queueWaves(tickets: readonly ExecutionRunTicket[], feature?: string): NonNullable<ExecutionRun['queueWaves']> {
  const first = tickets.findIndex((ticket) => ticket.stage !== 'landed');
  const prefix = first < 0 ? tickets : tickets.slice(0, first);
  const current: ExecutionRunTicket[] = [], blocked: ExecutionRunTicket[] = [];
  for (const ticket of tickets.slice(prefix.length)) {
    (ticket.stage === 'blocked' || (ticket.stage === 'queued' && ticket.blockers?.length) ? blocked : current).push(ticket);
  }
  return { prefix, current, blocked: dependencyWaves(blocked,
    ({ ticket }) => queueTicketKey(ticket, feature),
    ({ ticket, blockers }) => (blockers ?? []).map((ref) => queueTicketKey(ref, ticket.includes('/') ? ticket.split('/')[0] : feature))) };
}

function ticketToMetroState(ticket: ExecutionRunTicket): MetroStationState {
  switch (ticket.stage) {
    case 'landed': return 'done';
    case 'failed': return 'failed';
    case 'held': return 'held';
    case 'queued':
    case 'blocked': return 'waiting';
    case 'settled': return ticket.landingUnknown ? 'unknown' : 'done';
    case 'land-gate':
      if (ticket.landingUnknown) return 'unknown';
      if (ticket.landProgress?.kind === 'lease') return 'lease';
      if (ticket.landGate?.state === 'failed' && !ticket.landRepair) return 'failed';
      return 'working';
    case 'worker':
      if (ticket.statusUnknown) return 'unknown';
      if (ticket.asking) return 'asking';
      if (ticket.stalled) return 'stalled';
      return 'working';
  }
}

function buildQueueMetro(
  home: string,
  q: TicketQueue,
  tickets: readonly ExecutionRunTicket[],
  waves: NonNullable<ExecutionRun['queueWaves']>,
  steps: readonly ExecutionRunStep[],
  reviewer: WorkflowNode | undefined,
  lead: WorkflowNode | undefined,
  workers: ReadonlyMap<string, OwnerWorker>,
): MetroFlow {
  const byId = new Set(tickets.map((t) => t.ticket));
  const normToId = new Map<string, string>();
  const bareToId = new Map<string, string>();
  for (const id of byId) {
    normToId.set(queueTicketKey(id, q.feature), id);
    if (/^#?\d+$/.test(id.trim())) bareToId.set(queueTicketKey(id), id);
  }
  const resolveRef = (ownerTicket: string, ref: string): string => {
    const trimmed = ref.trim();
    if (byId.has(trimmed)) return trimmed;
    const feature = ownerTicket.includes('/') ? ownerTicket.split('/')[0] : q.feature;
    const bare = bareToId.get(queueTicketKey(trimmed));
    return (/^\d+$/.test(trimmed) ? bare : undefined) ?? normToId.get(queueTicketKey(trimmed, feature)) ?? bare ?? trimmed;
  };

  const admitted = (q.tickets ?? []).filter((item) => item?.ticket);
  const waveFallback = admitted.length > 0 && !admitted.some((t) => Array.isArray(t.blockers));

  const edges: MetroEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const key = `${from}\0${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to });
  };
  const stationBlockers = new Map<string, string[]>();
  const recordBlockers = (t: ExecutionRunTicket) => {
    const raw = Array.isArray(t.deps) ? t.deps : (t.blockers ?? []);
    const resolved = [...new Set(raw.map((r) => resolveRef(t.ticket, r)).filter((r) => r && r !== t.ticket))];
    if (resolved.length) stationBlockers.set(t.ticket, resolved);
    return resolved;
  };

  if (!waveFallback) {
    const lastPrefix = waves.prefix.at(-1)?.ticket;
    for (const t of tickets) {
      for (const dep of recordBlockers(t)) addEdge(dep, t.ticket);
      // Mixed resumed run: a legacy resumed item without `deps` still chains after settled prefix.
      if (!Array.isArray(t.deps) && !t.blockers?.length && lastPrefix && lastPrefix !== t.ticket &&
          !waves.prefix.some((p) => p.ticket === t.ticket)) {
        addEdge(lastPrefix, t.ticket);
      }
    }
  } else {
    for (let i = 1; i < waves.prefix.length; i++) {
      addEdge(waves.prefix[i - 1].ticket, waves.prefix[i].ticket);
    }
    const lastPrefix = waves.prefix.at(-1)?.ticket;
    for (const t of waves.current) {
      if (Array.isArray(t.deps)) {
        for (const dep of recordBlockers(t)) addEdge(dep, t.ticket);
      } else if (lastPrefix) addEdge(lastPrefix, t.ticket);
    }
    for (const t of waves.blocked.flat()) {
      const inQueue = recordBlockers(t).filter((r) => byId.has(r));
      if (inQueue.length || Array.isArray(t.deps)) {
        for (const dep of inQueue) addEdge(dep, t.ticket);
      } else if (waves.current.length) {
        for (const cur of waves.current) addEdge(cur.ticket, t.ticket);
      } else if (lastPrefix) {
        addEdge(lastPrefix, t.ticket);
      }
    }
  }

  const stations: MetroStation[] = tickets.map((t) => {
    const blockers = stationBlockers.get(t.ticket);
    return {
      id: t.ticket,
      kind: 'worker',
      state: ticketToMetroState(t),
      ...(t.changedAt !== undefined ? { changedAt: t.changedAt } : {}),
      ...(t.title ? { title: t.title } : {}),
      ...(t.role ? { role: t.role } : {}),
      ...(blockers?.length ? { blockers } : {}),
      ...(t.landGate ? { gate: t.landGate } : {}),
      ...(t.landRepair ? { repair: t.landRepair } : {}),
      ...(t.landRepairs?.length ? { repairs: t.landRepairs } : {}),
      ...(t.holdTag ? { holdTag: t.holdTag } : {}),
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.jobId ? { jobId: t.jobId } : {}),
      ...(t.execJob ? { execJob: t.execJob } : {}),
    };
  });

  const hasOut = new Set(edges.map((e) => e.from));
  const sinks = tickets.filter((t) => !hasOut.has(t.ticket)).map((t) => t.ticket);
  const reviewStep = steps.find((s) => s.key === 'review');
  const acceptStep = steps.find((s) => s.key === 'accept');
  const acceptSeat: 'lead' | 'main' = q.handback_to === 'main' ? 'main' : 'lead';
  const acceptStarted = Boolean(lead) || (acceptStep?.state !== undefined && acceptStep.state !== 'waiting');
  const latestAcceptDecision = acceptStarted
    ? (q.decisions ?? []).filter((d) => d.kind === 'accept' && d.step === 'accept').at(-1)
    : undefined;
  const latestAcceptDecisionAt = latestAcceptDecision ? parseTime(latestAcceptDecision.at) ?? undefined : undefined;
  const settledAcceptJobId = !lead && acceptSeat === 'lead' &&
    (acceptStep?.state === 'done' || acceptStep?.state === 'failed') &&
    latestAcceptDecision && latestAcceptDecision.decision !== 'repair' && JOB_ID_RE.test(latestAcceptDecision.job)
    ? latestAcceptDecision.job : undefined;
  const acceptJobId = lead?.jobId ?? settledAcceptJobId;
  const acceptExecJob = lead?.execJob ?? (settledAcceptJobId ? jobTargetFor(home, workers.get(settledAcceptJobId), settledAcceptJobId) : undefined);

  stations.push({
    id: 'review',
    kind: 'review',
    role: 'reviewer',
    state: stepToMetroState(reviewer?.state ?? reviewStep?.state ?? 'waiting'),
    ...(maxTime(reviewer?.changedAt, reviewStep?.changedAt) !== undefined
      ? { changedAt: maxTime(reviewer?.changedAt, reviewStep?.changedAt) } : {}),
    ...(sinks.length ? { blockers: sinks } : {}),
    ...(reviewer?.jobId ? { jobId: reviewer.jobId } : {}),
    ...(reviewer?.execJob ? { execJob: reviewer.execJob } : {}),
  });
  for (const sink of sinks) edges.push({ from: sink, to: 'review' });

  const acceptChangedAt = maxTime(lead?.changedAt, acceptStep?.changedAt, latestAcceptDecisionAt);
  stations.push({
    id: 'accept',
    kind: 'accept',
    ...(acceptSeat === 'lead' ? { role: 'lead' } : {}),
    label: acceptSeat,
    state: stepToMetroState(lead?.state ?? acceptStep?.state ?? 'waiting'),
    ...(acceptChangedAt !== undefined ? { changedAt: acceptChangedAt } : {}),
    blockers: ['review'],
    ...(acceptJobId ? { jobId: acceptJobId } : {}),
    ...(acceptExecJob ? { execJob: acceptExecJob } : {}),
  });
  edges.push({ from: 'review', to: 'accept' });

  const lastChangedId = lastChangedStationId(stations);
  return {
    stations,
    edges,
    ...(lastChangedId !== undefined ? { lastChangedId } : {}),
    ...(waveFallback ? { waveFallback: true } : {}),
  };
}

const cursorState = (cursor?: Cursor): RunStepState => cursor && cursor.state !== 'ready' && STEP_STATES.has(cursor.state) ? cursor.state : 'waiting';
const workerTitle = (worker?: OwnerWorker) => worker?.ticketTitle ?? worker?.briefTitle;
const readOptional = <T>(pass: HeaderPass, file: string): T | null => {
  try { return pass.header<T>(file); } catch { return null; }
};

function projectComposedHandback(
  raw: (Run['handback'] & { request_id?: string; ask?: string; question?: string }) | undefined,
): TicketHandback | undefined {
  if (!raw || typeof raw.step !== 'string' || !raw.step || !Array.isArray(raw.choices)) return undefined;
  const choices = raw.choices.filter((c): c is string => typeof c === 'string' && c.length > 0);
  const question = typeof raw.ask === 'string' && raw.ask.trim()
    ? raw.ask.trim()
    : typeof raw.question === 'string' && raw.question.trim()
      ? raw.question.trim()
      : undefined;
  const request_id = typeof raw.request_id === 'string' && raw.request_id ? raw.request_id : undefined;
  return {
    step: raw.step,
    choices,
    ...(question ? { question } : {}),
    ...(request_id ? { request_id } : {}),
  };
}

function readFixedExecutionRun(
  home: string, id: string, pass: HeaderPass, root: string, workers: ReadonlyMap<string, OwnerWorker>, cache: JobIndexCache, now: number,
): ExecutionRun | undefined {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) return;
  const file = `${id}.json`;
  const getJob = (jobId: string): Job | undefined => {
    const read = cache.readJob<Job>(jobId);
    return read.status === 'ok' && read.value.job === jobId ? read.value : undefined;
  };
  const visible = (scope: Omit<RunScope, 'pane'>, cwd?: string) =>
    runVisible({ pane: '', project_root: scope.project_root ?? cwd }, null, root);
  const endedTime = (updated: number | null = null) => Math.min(updated ?? Infinity, fs.statSync(join(home, 'flows', file)).mtimeMs);
  const recent = (end: number) => end >= now - ENDED_MS && end <= now;
  const base = { flow: id, unattended: false, steps: [], tickets: [], todo: [], decisions: [], reviews: [], heldCount: 0, repairRounds: 0 };
  const nodeFor = (key: string, jobId: string | undefined, state: RunStepState, fields: Partial<WorkflowNode> = {}): WorkflowNode => {
    const worker = jobId ? workers.get(jobId) : undefined;
    const info = jobId ? workerStatusInfo(cache, jobId, state, worker) : { state, changedAt: undefined };
    return { key, state: info.state,
      jobId, execJob: jobTargetFor(home, worker, jobId), since: worker?.startedAt ?? undefined,
      ...(info.changedAt !== undefined ? { changedAt: info.changedAt } : {}), ...fields };
  };
  if (isBatchId(id)) {
    const b = pass.header<Batch>(file);
    if (b?.flow === id && b.scale && b.totals && visible(b, b.cwd) &&
        ['working', 'paused', 'stopped', 'completed'].includes(b.state)) {
      const open = batchActive(b) || b.state === 'paused', end = open ? undefined : endedTime();
      if (end !== undefined && !recent(end)) return;
      const index = readOptional<{ items: ItemResult[] }>(pass, `${id}/index.json`);
      const items = index?.items ?? [];
      const pilots = items.filter((item) => item.pilot);
      const done = pilots.filter((item) => item.state === 'done').length;
      const pilotState: RunStepState = done === pilots.length ? 'done' : pilots.some((item) => item.state === 'failed') ? 'failed'
        : pilots.some((item) => item.state === 'running') ? 'running' : 'waiting';
      const batch = { flow: id, role: b.scale.role, count: b.scale.count, state: b.state, reason: b.reason, totals: b.totals,
        slots: b.scale.max_parallel, pilots: index ? { done, total: pilots.length, state: pilotState } : undefined };
      const result = end === undefined ? undefined : b.state === 'stopped' ? 'stopped' : b.totals.failed > 0 ? 'failed' : 'done';
      const createdAt = parseTime(b.created_at);
      const batchUpdated = parseTime(b.updated_at);
      let metro: MetroFlow | undefined;
      if (open) {
        const itemWorkerAt = (subset: readonly ItemResult[]) => subset.reduce<number | undefined>((best, it) => {
          const w = it.job ? workers.get(it.job) : undefined;
          return maxTime(best, w?.settledAt, w?.humanEndedAt, w?.startedAt);
        }, undefined);
        const stations: MetroStation[] = [];
        const edges: MetroEdge[] = [];
        const hasPilot = Boolean(index && pilots.length > 0);
        const tail = items.filter((it) => !it.pilot);
        const totalNonWaiting = b.totals.done + b.totals.running + b.totals.failed + (b.totals.cancelled ?? 0);
        const pilotNonWaiting = pilots.filter((it) => it.state !== 'waiting').length;
        const poolChangedAt = parseTime(b.pool_changed_at);
        const tailHasActivity = hasPilot
          ? (poolChangedAt !== null || tail.some((it) => it.state !== 'waiting') || totalNonWaiting > pilotNonWaiting)
          : (poolChangedAt !== null || totalNonWaiting > 0);
        if (hasPilot) {
          // Resume retains item.stall to avoid pausing on the same observation again.
          const stalled = b.state === 'paused' ? pilots.find((item) => item.state === 'running' && item.stall &&
            b.reason === `pilot ${item.item} (${item.job}) stalled: ${item.stall.slice(0, 300)}`) : undefined;
          const pilotAt = maxTime(parseTime(b.pilot_changed_at), itemWorkerAt(pilots))
            ?? (pilotState !== 'waiting' ? ((!tailHasActivity ? batchUpdated : null) ?? createdAt ?? undefined) : undefined);
          stations.push({
            id: 'pilot',
            kind: 'worker',
            state: stalled ? 'stalled' : stepToMetroState(pilotState),
            ...(stalled ? { reason: stalled.stall } : {}),
            label: `${done}/${pilots.length}`,
            role: b.scale.role,
            ...(pilotAt !== undefined ? { changedAt: pilotAt } : {}),
          });
          edges.push({ from: 'pilot', to: 'pool' });
        }
        const poolCounts: MetroPoolCounts = {
          ...(b.totals.done ? { done: b.totals.done } : {}),
          ...(b.totals.running ? { working: b.totals.running } : {}),
          ...(b.totals.failed ? { failed: b.totals.failed } : {}),
          ...(b.totals.waiting ? { waiting: b.totals.waiting } : {}),
          ...(b.totals.cancelled ? { stopped: b.totals.cancelled } : {}),
        };
        const poolState: MetroStationState = b.totals.running ? 'working' : b.totals.waiting ? 'waiting' : b.totals.failed ? 'failed' : 'done';
        const poolWorkerAt = itemWorkerAt(hasPilot ? tail : items);
        const poolAt = poolChangedAt !== null
          ? maxTime(poolChangedAt, poolWorkerAt)
          : tailHasActivity
            ? maxTime(poolWorkerAt, batchUpdated, createdAt)
            : undefined;
        stations.push({
          id: 'pool',
          kind: 'pool',
          state: poolState,
          role: b.scale.role,
          pool: poolCounts,
          count: b.scale.count,
          ...(stations.length ? { blockers: ['pilot'] } : {}),
          ...(poolAt !== undefined ? { changedAt: poolAt } : {}),
          ...(b.reason ? { reason: b.reason } : {}),
        });
        stations.push({ id: 'summary', kind: 'summary', state: 'waiting', blockers: ['pool'] });
        edges.push({ from: 'pool', to: 'summary' });
        const lastChangedId = lastChangedStationId(stations);
        metro = { stations, edges, ...(lastChangedId !== undefined ? { lastChangedId } : {}) };
      }
      return { ...base, kind: 'batch', label: `${b.scale.role} ×${b.scale.count}`, batch, reason: b.reason,
        state: open && b.state === 'stopped' ? 'working' : b.state, result, createdAt, updatedAt: end ?? batchUpdated ?? null, endedAt: end,
        ...(metro ? { metro } : {}),
        jobIds: items.flatMap((item) => [item.job, ...item.previous?.map((a) => a.job) ?? []]).filter((job): job is string => !!job) };
    }
  }
  if (isFlowId(file.slice(0, -5))) {
    const land = pass.header<LandFlow>(file);
    if (land?.flow !== id || land.ticket_queue || !land.wt?.main_root || !visible({}, land.wt.main_root) || !activeLand(land) || typeof land.step !== 'string') return;
    const { progress, gate: metroGate, repair: metroRepair, repairs: metroRepairs } = extractLandGateAndRepair(home, land, workers, cache, 'gate');
    const waiting = progress?.kind === 'lease';
    const picking = land.step === 'prepare' || land.step === 'create integration' || land.step === 'cherry-pick';
    const publishing = land.step === 'records' || land.step === 'fast-forward' || /^after\[/.test(land.step)
      || land.step === 'push' || land.step === 'cleanup' || land.step === 'done';
    const gateTiming = land.timings?.filter((timing) => /^gate\[/.test(timing.step)).at(-1);
    const gate = progress?.kind === 'gate' ? progress : gateTiming ? landProgress({ ...land, step: gateTiming.step, step_started_at: undefined }) : undefined;
    const pickTiming = land.timings?.filter((timing) => timing.step === 'cherry-pick').at(-1);
    const integrationTiming = land.timings?.filter((timing) => timing.step === 'create integration').at(-1);
    const pastPrepare = progress?.kind === 'gate' || progress?.kind === 'repair' || publishing || Boolean(land.landed_sha) || Boolean(gateTiming);
    const pickState: RunStepState = picking
      ? 'running'
      : pickTiming
        ? (pickTiming.ok ? 'done' : 'failed')
        : pastPrepare
          ? (integrationTiming?.ok === false ? 'failed' : 'done')
          : 'waiting';
    const gateState: RunStepState = progress?.kind === 'gate' ? 'running'
      : gateTiming?.ok === false ? 'failed' : gateTiming?.ok && gate?.index === gate?.total ? 'done' : 'waiting';
    const job = workers.get(land.job), source = { jobId: land.job, execJob: jobTargetFor(home, job, land.job) };
    const createdAt = parseTime(land.created_at);
    const updatedAt = parseTime(land.updated_at);
    const stepStarted = parseTime(land.step_started_at);
    const landedAt = parseTime(land.landed_at);
    const pickChangedAt = picking
      ? (stepStarted ?? createdAt ?? undefined)
      : pickState !== 'waiting' ? (createdAt ?? undefined) : undefined;
    const gateChangedAt = progress?.kind === 'gate'
      ? (stepStarted ?? updatedAt ?? createdAt ?? undefined)
      : gateState === 'failed' || gateState === 'done' ? (updatedAt ?? stepStarted ?? createdAt ?? undefined) : undefined;
    const leaseChangedAt = waiting ? (stepStarted ?? updatedAt ?? createdAt ?? undefined) : undefined;
    const mergeChangedAt = land.landed_sha ? (landedAt ?? updatedAt ?? undefined) : publishing ? (stepStarted ?? updatedAt ?? undefined) : undefined;
    const repairNodes: WorkflowNode[][] = (metroRepairs ?? []).map((rep) => [{
      key: rep.round === 1 ? 'repair' : `repair-${rep.round}`,
      word: rep.round === 1 ? 'Repair' : `Repair ${rep.round}`,
      state: rep.state === 'working' ? 'running' as const
        : rep.state === 'asking' ? 'asking' as const
          : rep.state === 'done' ? 'done' as const
            : rep.state === 'stopped' ? 'cancelled' as const : 'failed' as const,
      progress: { kind: 'repair' as const, index: rep.round, total: rep.total },
      jobId: rep.jobId,
      ...(rep.changedAt !== undefined ? { changedAt: rep.changedAt } : {}),
      label: rep.label, role: rep.role, execJob: rep.execJob,
    }]);
    const nodes: WorkflowNode[][] = [
      [{ key: 'pick', word: 'Pick', state: pickState, ...(pickChangedAt !== undefined ? { changedAt: pickChangedAt } : {}), ...(picking && source) }],
      [{ key: 'gate', word: 'Gate', progress: gate, ...(metroGate ? { gate: metroGate } : {}), ...(metroRepair ? { repair: metroRepair } : {}), ...(metroRepairs?.length ? { repairs: metroRepairs } : {}),
        ...(gateChangedAt !== undefined ? { changedAt: gateChangedAt } : {}), ...(progress?.kind === 'gate' && source), state: gateState }],
      ...repairNodes,
      ...(waiting ? [[{ key: 'lease', word: 'Lease wait', progress, state: 'running' as const, ...(leaseChangedAt !== undefined ? { changedAt: leaseChangedAt } : {}), ...source }]] : []),
      [{ key: 'merge', word: 'Merge', state: land.landed_sha ? 'done' : publishing ? 'running' : 'waiting', ...(mergeChangedAt !== undefined ? { changedAt: mergeChangedAt } : {}), ...(publishing && source) }],
    ];
    const pickStation: MetroStation = {
      id: 'pick', kind: 'worker', state: stepToMetroState(pickState),
      ...(pickChangedAt !== undefined ? { changedAt: pickChangedAt } : {}), ...(picking ? source : {}),
    };
    const leaseStation: MetroStation | undefined = waiting ? {
      id: 'lease', kind: 'worker', state: 'lease',
      ...(leaseChangedAt !== undefined ? { changedAt: leaseChangedAt } : {}), ...source,
    } : undefined;
    const gateStation: MetroStation = {
      id: 'gate', kind: 'worker',
      state: stepToMetroState(gateState),
      ...(gateChangedAt !== undefined ? { changedAt: gateChangedAt } : {}),
      ...(metroGate ? { gate: metroGate } : {}),
      ...(metroRepair ? { repair: metroRepair } : {}),
      ...(metroRepairs?.length ? { repairs: metroRepairs } : {}),
      ...(progress?.kind === 'gate' ? source : {}),
      ...(land.error && gateState === 'failed' ? { reason: land.error } : {}),
    };
    const mergeStation: MetroStation = {
      id: 'merge', kind: 'worker', state: land.landed_sha ? 'done' : publishing ? 'working' : 'waiting',
      ...(mergeChangedAt !== undefined ? { changedAt: mergeChangedAt } : {}), ...(publishing ? source : {}),
    };
    const orderedLand: MetroStation[] = leaseStation
      ? (pickState === 'waiting' ? [leaseStation, pickStation, gateStation, mergeStation] : [pickStation, leaseStation, gateStation, mergeStation])
      : [pickStation, gateStation, mergeStation];
    const landStations: MetroStation[] = orderedLand.map((s, idx) => idx === 0 ? s : { ...s, blockers: [orderedLand[idx - 1].id] });
    const landEdges: MetroEdge[] = landStations.slice(1).map((s, idx) => ({ from: landStations[idx].id, to: s.id }));
    const landLastChanged = lastChangedStationId(landStations);
    return { ...base, kind: 'land', label: workerTitle(job) ?? land.job.slice(0, 8), state: 'working', nodes,
      metro: { stations: landStations, edges: landEdges, ...(landLastChanged !== undefined ? { lastChangedId: landLastChanged } : {}) },
      // Keep a settled source job's own recent outcome after the land flow closes.
      jobIds: [land.job, ...land.repairs?.flatMap(({ job }) => job ? [job] : []) ?? []],
      createdAt, updatedAt, reason: land.error };
  }
  const run = pass.header<Run & RunScope & { template?: string; cwd?: string; created_at?: string | number; updated_at?: string | number;
    job?: string; handback?: Run['handback'] & { request_id?: string; ask?: string; question?: string; refs?: string[] } }>(file);
  if (run?.flow !== id || run.state === 'proposed' || !Object.hasOwn(STATE_RANK, run.state)) return;
  const owner = JOB_ID_RE.test(id) ? getJob(id) : undefined;
  if (!visible({ project_root: run.project_root ?? owner?.project_root ?? owner?.worktree?.main_root }, run.cwd ?? owner?.cwd)) return;
  const open = run.state === 'working' || run.state === 'paused';
  const updatedAt = parseTime(run.updated_at);
  const createdAt = parseTime(run.created_at) ?? parseTime(owner?.created_at);
  const handback = projectComposedHandback(run.handback);
  const common = { ...base, state: run.state, createdAt, updatedAt, reason: run.reason, ...(handback ? { handback } : {}) };
  const parent = workers.get(id);
  if (JOB_ID_RE.test(id) && run.template === 'council') {
    const end = open ? undefined : endedTime(updatedAt ?? parent?.settledAt);
    if (end !== undefined && !recent(end)) return;
    const members = (owner?.council_members ?? []).map((member, i) => nodeFor(`member-${i}`, member.job, 'waiting',
      { label: member.preset, role: 'oracle', ...(member.failure ? { state: 'failed', reason: member.failure } : {}) }));
    const synthesis = nodeFor('synthesis', owner?.synthesis_job, run.state === 'completed' ? 'done' : 'waiting',
      { word: 'Synthesis', role: 'lead', label: owner?.synthesizer });
    const result = end === undefined ? undefined : run.state === 'completed' ? 'done' : run.state === 'failed' ? 'failed' : 'stopped';
    let metro: MetroFlow | undefined;
    if (open) {
      const councilStepAt = parseTime(run.steps?.council?.changed_at) ?? undefined;
      const memberStations: MetroStation[] = members.map((m) => {
        const at = m.changedAt ?? (m.state === 'failed' ? (updatedAt ?? createdAt ?? undefined) : undefined);
        return {
          id: m.key, kind: 'worker', state: stepToMetroState(m.state),
          ...(at !== undefined ? { changedAt: at } : {}),
          ...(m.label ? { label: m.label } : {}),
          role: m.role,
          ...(m.reason ? { reason: m.reason } : {}),
          ...(m.jobId ? { jobId: m.jobId } : {}),
          ...(m.execJob ? { execJob: m.execJob } : {}),
        };
      });
      const synthAt = synthesis.changedAt ?? (synthesis.state !== 'waiting' ? councilStepAt : undefined);
      const synthStation: MetroStation = {
        id: synthesis.key, kind: 'synth', state: stepToMetroState(synthesis.state),
        ...(synthAt !== undefined ? { changedAt: synthAt } : {}),
        ...(synthesis.label ? { label: synthesis.label } : {}),
        role: synthesis.role,
        ...(members.length ? { blockers: members.map((m) => m.key) } : {}),
        ...(synthesis.jobId ? { jobId: synthesis.jobId } : {}),
        ...(synthesis.execJob ? { execJob: synthesis.execJob } : {}),
      };
      const stations = [...memberStations, synthStation];
      const edges: MetroEdge[] = members.map((m) => ({ from: m.key, to: synthesis.key }));
      const lastChangedId = lastChangedStationId(stations);
      metro = { stations, edges, ...(lastChangedId !== undefined ? { lastChangedId } : {}) };
    }
    return { ...common, kind: 'council', label: workerTitle(parent) ?? id.slice(0, 8), endedAt: end, result,
      ...(metro ? { metro } : {}),
      nodes: [members, [synthesis]], jobIds: [id, ...[...members, synthesis].flatMap((node) => node.jobId ? [node.jobId] : [])] };
  }
  if (!open) return;
  if (JOB_ID_RE.test(id) && run.template === 'prewalk') {
    const specs = readOptional<PrewalkInputs>(pass, `${id}/manifest.json`)?.scouts ?? [];
    const outcomes = readOptional<{ scouts?: ScoutOutcome[] }>(pass, `${id}/index.json`)?.scouts;
    const scouts = new Map<string, string>();
    for (const [jobId, worker] of workers) if (worker.parentJobId === `thin-job:${id}`) {
      const job = getJob(jobId);
      if (job?.prewalk_kind) scouts.set(job.prewalk_kind, jobId);
    }
    const kinds = outcomes?.map(({ kind }) => kind) ?? (specs.length ? specs.map(({ kind }) => kind) : [...scouts.keys()]);
    const nodes = kinds.map((kind, i) => {
      const outcome = outcomes?.[i];
      return nodeFor(kind, outcome?.id ?? scouts.get(kind), outcome ? 'done' : 'waiting',
        { label: kind, word: 'Scout', ...(outcome?.failure ? { state: 'failed', reason: outcome.failure } : {}) });
    });
    const scoutNodes = nodes.length ? nodes : [{ key: 'scouts', word: 'Scouts', state: cursorState(run.steps?.scouts),
      changedAt: parseTime(run.steps?.scouts?.changed_at) ?? undefined }];
    const targetNode = nodeFor('target', id, cursorState(run.steps?.target), { word: 'Worker', role: parent?.role ?? undefined });
    const scoutsStepAt = parseTime(run.steps?.scouts?.changed_at) ?? undefined;
    const targetStepAt = parseTime(run.steps?.target?.changed_at) ?? undefined;
    const scoutStations: MetroStation[] = scoutNodes.map((n) => {
      const at = n.changedAt ?? (n.state !== 'waiting' ? (scoutsStepAt ?? updatedAt ?? createdAt ?? undefined) : undefined);
      return {
        id: n.key, kind: 'worker', state: stepToMetroState(n.state), role: 'sonic',
        ...(at !== undefined ? { changedAt: at } : {}),
        ...(n.label ? { label: n.label } : {}),
        ...(n.reason ? { reason: n.reason } : {}),
        ...(n.jobId ? { jobId: n.jobId } : {}),
        ...(n.execJob ? { execJob: n.execJob } : {}),
      };
    });
    const targetAt = targetNode.changedAt ?? (targetNode.state !== 'waiting' ? targetStepAt : undefined);
    const targetStation: MetroStation = {
      id: targetNode.key, kind: 'worker', state: stepToMetroState(targetNode.state),
      ...(targetAt !== undefined ? { changedAt: targetAt } : {}),
      ...(targetNode.role ? { role: targetNode.role } : {}),
      ...(workerTitle(parent) ? { title: workerTitle(parent) } : {}),
      blockers: scoutStations.map((s) => s.id),
      ...(targetNode.jobId ? { jobId: targetNode.jobId } : {}),
      ...(targetNode.execJob ? { execJob: targetNode.execJob } : {}),
    };
    const stations = [...scoutStations, targetStation];
    const edges: MetroEdge[] = scoutStations.map((s) => ({ from: s.id, to: targetStation.id }));
    const lastChangedId = lastChangedStationId(stations);
    return { ...common, kind: 'prewalk', label: workerTitle(parent) ?? id.slice(0, 8),
      metro: { stations, edges, ...(lastChangedId !== undefined ? { lastChangedId } : {}) },
      nodes: [scoutNodes, [targetNode]],
      jobIds: nodes.flatMap((node) => node.jobId ? [node.jobId] : []) };
  }
  const graph = readOptional<Pick<Graph, 'version' | 'name' | 'steps'>>(pass, `${id}/graph.json`);
  if (graph?.version !== 1 || !graph.steps || !run.steps) return;
  const stepEntries = Object.entries(graph.steps);
  const cursors: Partial<Record<string, ComposedCursor>> = run.steps;
  const composedItemStalled = (stepKey: string, idx: number, item: NonNullable<ComposedCursor['items']>[number]): boolean =>
    run.state === 'paused' &&
    (!run.handback || run.handback.step === stepKey) &&
    item.state === 'running' &&
    typeof item.stall === 'string' && item.stall.length > 0 &&
    run.reason === `pilot ${idx + 1} (${item.job}) stalled: ${item.stall.slice(0, 300)}`;
  const batchMembersChangedAt = (items: ComposedCursor['items']): number | undefined => {
    if (!Array.isArray(items)) return undefined;
    let best: number | undefined;
    for (const item of items) {
      const w = item.job ? workers.get(item.job) : undefined;
      best = maxTime(best, parseTime(item.changed_at), w?.settledAt, w?.humanEndedAt, w?.startedAt);
    }
    return best;
  };
  const nodes: WorkflowNode[] = stepEntries.map(([key, step]) => {
    const cursor = cursors[key];
    // A settled worker can still leave its workflow step running or asking.
    const jobId = step.kind === 'land' ? cursors[step.job]?.job : cursor?.job;
    const worker = jobId ? workers.get(jobId) : undefined;
    const changedAt = step.kind === 'batch'
      ? maxTime(parseTime(cursor?.changed_at), batchMembersChangedAt(cursor?.items))
      : parseTime(cursor?.changed_at) ?? undefined;
    return { key, state: cursorState(cursor), blockers: step.needs, reason: cursor?.reason,
      role: step.kind === 'job' || step.kind === 'batch' ? step.role : undefined,
      jobId, execJob: jobTargetFor(home, worker, jobId), since: worker?.startedAt ?? undefined,
      changedAt };
  });
  const stepIds = new Set(stepEntries.map(([key]) => key));
  const graphStations: MetroStation[] = stepEntries.map(([key, step], i) => {
    const node = nodes[i];
    const kind: MetroStationKind = step.kind === 'handback' ? 'accept'
      : step.kind === 'council' ? 'synth'
        : step.kind === 'batch' ? 'pool'
          : step.kind === 'job' && step.role === 'reviewer' ? 'review'
            : 'worker';
    let pool: MetroPoolCounts | undefined, count: number | undefined;
    let stalledReason: string | undefined;
    if (step.kind === 'batch') {
      const members = cursors[key]?.items;
      if (Array.isArray(members)) {
        const counts: Partial<Record<MetroStationState, number>> = {};
        for (let idx = 0; idx < members.length; idx++) {
          const item = members[idx];
          const itemStalled = composedItemStalled(key, idx, item);
          const state: MetroStationState = itemStalled ? 'stalled' : stepToMetroState(item.state);
          if (itemStalled) stalledReason ??= item.stall;
          counts[state] = (counts[state] ?? 0) + 1;
        }
        pool = counts;
        count = members.length;
      } else if (Array.isArray(step.items)) {
        count = step.items.length;
        pool = { waiting: count };
      }
    }
    const stationState: MetroStationState = stalledReason && !pool?.working ? 'stalled' : stepToMetroState(node.state);
    const stationReason = node.reason ?? stalledReason;
    return {
      id: key, kind, state: stationState,
      ...(pool ? { pool, count } : {}),
      ...(node.changedAt !== undefined ? { changedAt: node.changedAt } : {}),
      ...(node.role ? { role: node.role } : {}),
      ...(step.needs.length ? { blockers: step.needs } : {}),
      ...(stationReason ? { reason: stationReason } : {}),
      ...(node.jobId ? { jobId: node.jobId } : {}),
      ...(node.execJob ? { execJob: node.execJob } : {}),
    };
  });
  const graphEdges: MetroEdge[] = stepEntries.flatMap(([key, step]) =>
    step.needs.filter((dep) => dep !== key && stepIds.has(dep)).map((dep) => ({ from: dep, to: key })));
  const graphLastChanged = lastChangedStationId(graphStations);
  return { ...common, kind: 'graph', label: graph.name,
    metro: { stations: graphStations, edges: graphEdges, ...(graphLastChanged !== undefined ? { lastChangedId: graphLastChanged } : {}) },
    nodes: dependencyWaves(nodes, (node) => node.key, (node) => node.blockers ?? []),
    jobIds: nodes.flatMap((node) => node.jobId ? [node.jobId] : []) };
}

const STATE_RANK: Record<TicketQueue['state'], number> = {
  paused: 0,
  working: 1,
  failed: 2,
  completed: 2,
  cancelled: 2,
  stopped: 2,
};

function endedResult(tickets: readonly ExecutionRunTicket[]): ExecutionRun['result'] {
  if (tickets.some((ticket) => ticket.stage === 'failed')) return 'failed';
  if (tickets.some((ticket) => ticket.landingUnknown)) return undefined;
  return tickets.length && tickets.every((ticket) => ticket.stage === 'landed') ? 'landed' : 'not landed';
}

/** Paused/held runs first, then working (oldest first), then runs ended in the last 24 hours. */
export function readExecutionRuns(
  home: string,
  scope: { root: string; pane: string | null },
  workers: ReadonlyMap<string, OwnerWorker>,
  now = Date.now(),
): ExecutionRun[] {
  const pass = scan(home);
  const cache = getJobIndexCache(home);
  let ticketFacts: ReturnType<typeof scanTicketStore> | undefined;
  const runs = pass.files.flatMap((file) => {
    if (!file.endsWith('.json')) return [];
    const id = file.slice(0, -5);
    try {
      if (!isTicketQueueId(id)) {
        const run = readFixedExecutionRun(home, id, pass, scope.root, workers, cache, now);
        return run ? [run] : [];
      }
      const q = pass.header<TicketQueue>(file);
      if (!q || `${q.flow}.json` !== file || !Object.hasOwn(STATE_RANK, q.state)) return [];
      const projectRoot = q.project_root ?? q.root;
      // Scope strictly to this project: pane-less unattended runs show for their project, foreign runs stay out.
      if (!projectRoot || !runVisible({ ...q, project_root: projectRoot }, null, scope.root)) return [];
      const open = isOpenTicketRun(q);
      const createdAt = parseTime(q.created_at);
      const updatedAt = parseTime(q.updated_at);
      let endedAt: number | undefined;
      if (!open) {
        const mtime = fs.statSync(join(home, 'flows', file)).mtimeMs;
        endedAt = updatedAt !== null ? Math.min(updatedAt, mtime) : mtime;
        if (endedAt < now - ENDED_MS || endedAt > now) return [];
      }
      const items = projectTickets(home, q, pass, workers, cache, now, open);
      if (items.length) ticketFacts ??= scanTicketStore(scope.root);
      const tickets = ticketFacts ? withTicketFacts(items, q.feature, ticketFacts.lookup) : items;
      const steps = readSteps(q);
      const result = open ? undefined : endedResult(tickets);
      const heldCount = (q.tickets ?? []).filter((item) => item?.held).length + (q.held ? 1 : 0);
      const reviewWorker = q.review_job ? workers.get(q.review_job) : undefined;
      const reviewInfo = q.review_job
        ? workerStatusInfo(cache, q.review_job, cursorState(q.steps?.review), reviewWorker, { home, step: 'review', decisions: q.decisions })
        : undefined;
      const reviewer: WorkflowNode | undefined = q.review_job ? {
        key: 'review', role: 'reviewer', jobId: q.review_job,
        state: reviewInfo!.state,
        execJob: jobTargetFor(home, reviewWorker, q.review_job),
        since: reviewWorker?.startedAt ?? undefined,
        ...(reviewInfo!.changedAt !== undefined ? { changedAt: reviewInfo!.changedAt } : {}),
      } : undefined;
      const acceptSeat: 'lead' | 'main' = q.handback_to === 'main' ? 'main' : 'lead';
      const acceptActiveLead = acceptSeat === 'lead' && q.active_lead?.kind === 'accept' && q.active_lead.step === 'accept' &&
        (!q.steps?.accept || q.steps.accept.state !== 'waiting')
        ? q.active_lead : undefined;
      const leadWorker = acceptActiveLead ? workers.get(acceptActiveLead.job) : undefined;
      const leadInfo = acceptActiveLead ? workerStatusInfo(cache, acceptActiveLead.job, 'running', leadWorker) : undefined;
      const lead: WorkflowNode | undefined = acceptActiveLead ? {
        key: 'lead', role: 'lead', jobId: acceptActiveLead.job,
        state: leadInfo!.state,
        execJob: jobTargetFor(home, leadWorker, acceptActiveLead.job),
        since: leadWorker?.startedAt ?? undefined,
        ...(leadInfo!.changedAt !== undefined ? { changedAt: leadInfo!.changedAt } : {}),
      } : undefined;
      const waves = open ? queueWaves(tickets, q.feature) : undefined;
      const metro = open ? buildQueueMetro(home, q, tickets, waves!, steps, reviewer, lead, workers) : undefined;
      const run: ExecutionRun = {
        flow: q.flow,
        kind: 'queue',
        jobIds: [q.review_job, q.active_lead?.job, q.pending_answer?.lead_job, ...(q.unclosed_leads?.map((lead) => lead.job) ?? []),
          ...(q.tickets ?? []).map((ticket) => ticket?.job)]
          .filter((id): id is string => !!id),
        reviewer,
        acceptanceSeat: q.handback_to,
        lead,
        label: q.unattended?.objective || q.feature || q.flow.slice(0, 8),
        ...(q.feature ? { feature: q.feature } : {}),
        unattended: Boolean(q.unattended),
        state: q.state,
        createdAt,
        updatedAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(result ? { result } : {}),
        steps,
        ...(q.verdict ? { verdict: q.verdict } : {}),
        ...(q.reason ? { reason: q.reason } : {}),
        ...(q.held ? { held: q.held } : {}),
        ...(q.handback ? { handback: q.handback } : {}),
        tickets,
        queueWaves: waves,
        ...(metro ? { metro } : {}),
        todo: q.todo ?? [],
        decisions: q.decisions ?? [],
        reviews: q.reviews ?? [],
        heldCount,
        repairRounds: q.repair_rounds ?? 0,
      };
      return [run];
    } catch { return []; } // An unreadable or vanished header has no row.
  });
  const rank = (run: ExecutionRun) => run.state === 'working' && run.heldCount > 0 ? 0 : STATE_RANK[run.state];
  const nestedLand = new Set(runs.filter((run) => run.kind === 'queue' && run.endedAt === undefined)
    .flatMap((run) => run.tickets.map((ticket) => ticket.landFlow)));
  return runs.filter((run) => !nestedLand.has(run.flow)).sort((a, b) => rank(a) - rank(b)
    || (a.endedAt !== undefined && b.endedAt !== undefined ? b.endedAt - a.endedAt
      : (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity)) || a.flow.localeCompare(b.flow));
}

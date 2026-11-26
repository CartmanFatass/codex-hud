/** Ticket-queue runs shown on Execution, collected from flow headers and job state off the paint path. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { isFlowId, type LandFlow } from '../mcp/land-state.js';
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
import { getJobIndexCache, type JobIndexCache } from '../roles/job-index-cache.js';
import { isOpenTicketRun } from '../unattended/state.js';
import { headerScanner, type HeaderPass } from '../workflows/header-scan.js';
import { runVisible } from '../workflows/scope.js';
import type { OwnerWorker, WorkTarget } from './workboard-types.js';

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
}

export interface ExecutionRunTicket {
  readonly ticket: string;
  readonly role?: 'imp' | 'frontend-imp';
  readonly stage: TicketRunStage;
  readonly jobId?: string;
  readonly landFlow?: string;
  readonly landStep?: string;
  readonly blockers?: readonly string[];
  readonly asking?: boolean;
  readonly holdTag?: string;
  readonly reason?: string;
  readonly landingUnknown?: true;
  readonly execJob?: ExecutionRunJobTarget;
}

export interface ExecutionRun {
  readonly flow: string;
  readonly label: string;
  readonly unattended: boolean;
  readonly state: TicketQueue['state'];
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly endedAt?: number;
  readonly result?: 'failed' | 'landed' | 'not landed';
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
    return { key, state, ...(verdict ? { verdict } : {}) };
  });
}

function projectTicketItem(
  home: string,
  item: TicketQueueItem,
  pass: HeaderPass,
  workers: ReadonlyMap<string, OwnerWorker>,
  cache: JobIndexCache,
): ExecutionRunTicket {
  const worker = item.job ? workers.get(item.job) : undefined;
  const execJob: ExecutionRunJobTarget | undefined = worker && item.job
    ? {
      target: { kind: 'worker', laneId: worker.laneId, workerId: worker.id },
      dir: join(home, 'jobs', item.job),
      tab: !worker.headless && worker.state !== 'queued' && worker.settledAt === null,
    }
    : undefined;
  const base = {
    ticket: item.ticket,
    role: item.role,
    ...(item.job ? { jobId: item.job } : {}),
    ...(item.land ? { landFlow: item.land } : {}),
    ...(execJob ? { execJob } : {}),
  };

  if (item.failed) {
    return { ...base, stage: 'failed', ...(item.failed.reason ? { reason: item.failed.reason } : {}) };
  }
  if (item.landed === true) return { ...base, stage: 'landed' };
  if (item.held) {
    const holdTag = holdTagOf(item.held);
    return { ...base, stage: 'held', ...(holdTag ? { holdTag } : {}), ...(item.held.reason ? { reason: item.held.reason } : {}) };
  }

  // Read the referenced land header, never the recovery-aware land API. A bad land record must not hide its run.
  if (item.land) {
    try {
      const land = isFlowId(item.land) ? pass.header<LandFlow>(`${item.land}.json`) : null;
      if (land?.flow === item.land && land.job === item.job && typeof land.step === 'string' && land.step.trim() &&
          (land.landed_sha === undefined || (typeof land.landed_sha === 'string' && /^[\da-f]{7,64}$/i.test(land.landed_sha)))) {
        if (land.state === 'failed') return { ...base, stage: 'failed', ...(typeof land.error === 'string' ? { reason: land.error } : {}) };
        if (land.state === 'cancelled') return { ...base, stage: 'failed', reason: 'cancelled' };
        if (land.state === 'completed' || land.state === 'queued' || land.state === 'running') {
          if (land.landed_sha) return { ...base, stage: 'landed' };
          if (land.publish_pending) return { ...base, stage: 'land-gate', landingUnknown: true };
          if (land.state === 'completed') return { ...base, stage: 'settled' };
          return { ...base, stage: 'land-gate', landStep: land.step };
        }
      }
    } catch { /* The ticket is still known, but its land record is not. */ }
    return { ...base, stage: 'land-gate', landingUnknown: true };
  }
  if (!worker?.landingUnknown && worker?.flow?.kind === 'land') {
    if (worker.flow.state === 'failed') return { ...base, stage: 'failed', ...(worker.flow.error ? { reason: worker.flow.error } : {}) };
    if (worker.flow.state === 'cancelled') return { ...base, stage: 'failed', reason: 'cancelled' };
    if (worker.flow.landedSha) return { ...base, stage: 'landed' };
    if (worker.flow.state === 'completed') return { ...base, stage: 'settled' };
    return { ...base, stage: 'land-gate', ...(worker.flow.step ? { landStep: worker.flow.step } : {}) };
  }

  if (item.job) {
    if (worker) {
      if (worker.state === 'failed' || worker.state === 'stopped' || worker.state === 'error' || worker.work?.failed) {
        return { ...base, stage: 'failed', ...(worker.work?.reason ? { reason: worker.work.reason } : {}) };
      }
      if (worker.settledAt !== null) return { ...base, stage: 'settled', ...(worker.landingUnknown ? { landingUnknown: true } : {}) };
      if (worker.state === 'queued') return { ...base, stage: 'queued' };
      const status = cache.readStatus<{ state?: unknown }>(item.job);
      const statusState = status.status === 'ok' ? status.value.state : undefined;
      const asking = worker.homeNeedsHuman || statusState === 'waiting_orchestrator' || statusState === 'blocked';
      return { ...base, stage: 'worker', ...(asking ? { asking: true } : {}) };
    }
    const status = cache.readStatus<{ state?: unknown; error?: unknown }>(item.job);
    const statusState = status.status === 'ok' && typeof status.value.state === 'string' ? status.value.state : undefined;
    if (statusState === 'failed' || statusState === 'stopped') {
      const error = status.status === 'ok' && typeof status.value.error === 'string' ? status.value.error : undefined;
      return { ...base, stage: 'failed', ...(error ? { reason: error } : {}) };
    }
    if (statusState && CLEAN_STATUS_STATES.has(statusState)) return { ...base, stage: 'settled' };
    if (statusState === 'queued') return { ...base, stage: 'queued' };
    const asking = statusState === 'waiting_orchestrator' || statusState === 'blocked';
    return { ...base, stage: 'worker', ...(asking ? { asking: true } : {}) };
  }

  return { ...base, stage: 'queued' };
}

function projectTickets(
  home: string,
  q: TicketQueue,
  pass: HeaderPass,
  workers: ReadonlyMap<string, OwnerWorker>,
  cache: JobIndexCache,
): ExecutionRunTicket[] {
  const out: ExecutionRunTicket[] = [];
  const seen = new Set<string>();
  for (const item of q.tickets ?? []) {
    if (!item?.ticket) continue;
    seen.add(item.ticket);
    out.push(projectTicketItem(home, item, pass, workers, cache));
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

/** Paused runs first, then working (newest starts first), then runs ended in the last 24 hours. */
export function readExecutionRuns(
  home: string,
  scope: { root: string; pane: string | null },
  workers: ReadonlyMap<string, OwnerWorker>,
  now = Date.now(),
): ExecutionRun[] {
  const pass = scan(home);
  const cache = getJobIndexCache(home);
  const runs = pass.files.flatMap((file) => {
    if (!file.endsWith('.json') || !isTicketQueueId(file.slice(0, -5))) return [];
    try {
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
      const tickets = projectTickets(home, q, pass, workers, cache);
      const result = open ? undefined : endedResult(tickets);
      const heldCount = (q.tickets ?? []).filter((item) => item?.held).length + (q.held ? 1 : 0);
      const run: ExecutionRun = {
        flow: q.flow,
        label: q.unattended?.objective || q.feature || q.flow.slice(0, 8),
        unattended: Boolean(q.unattended),
        state: q.state,
        createdAt,
        updatedAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(result ? { result } : {}),
        steps: readSteps(q),
        ...(q.verdict ? { verdict: q.verdict } : {}),
        ...(q.reason ? { reason: q.reason } : {}),
        ...(q.held ? { held: q.held } : {}),
        ...(q.handback ? { handback: q.handback } : {}),
        tickets,
        todo: q.todo ?? [],
        decisions: q.decisions ?? [],
        reviews: q.reviews ?? [],
        heldCount,
        repairRounds: q.repair_rounds ?? 0,
      };
      return [run];
    } catch { return []; } // An unreadable or vanished header has no row.
  });
  return runs.sort((a, b) =>
    (STATE_RANK[a.state] ?? 2) - (STATE_RANK[b.state] ?? 2)
    || (b.endedAt ?? b.createdAt ?? 0) - (a.endedAt ?? a.createdAt ?? 0)
    || a.flow.localeCompare(b.flow));
}

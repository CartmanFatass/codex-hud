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
import { SEALED_REPAIR_LIMIT, type Cursor, type Run } from '../workflows/engine.js';
import type { Graph } from '../workflows/graph.js';
import { headerScanner, type HeaderPass } from '../workflows/header-scan.js';
import { runVisible, type RunScope } from '../workflows/scope.js';
import { workState } from './work-job.js';
import type { OwnerWorker, WorkBatch, WorkTarget } from './workboard-types.js';

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
  readonly landProgress?: LandProgress;
  readonly title?: string;
  readonly since?: number;
  readonly stalled?: true;
  readonly statusUnknown?: true;
  readonly blockers?: readonly string[];
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
  readonly since?: number;
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

function jobTargetFor(home: string, worker: OwnerWorker | undefined, jobId: string | undefined): ExecutionRunJobTarget | undefined {
  return worker && jobId ? {
    target: { kind: 'worker', laneId: worker.laneId, workerId: worker.id },
    dir: join(home, 'jobs', jobId),
    tab: !worker.headless && worker.state !== 'queued' && worker.settledAt === null,
  } : undefined;
}

function landProgress(land: LandFlow): LandProgress | undefined {
  const since = parseTime(land.step_started_at) ?? undefined;
  const gate = /^gate\[(\d+)\]/.exec(land.step), repair = /^repair (\d+)/.exec(land.step);
  if (isLandWait(land.step)) return { kind: 'lease', since };
  if (gate) return { kind: 'gate', index: Number(gate[1]), total: land.config?.gate?.length, since };
  if (repair) return { kind: 'repair', index: Number(repair[1]), total: SEALED_REPAIR_LIMIT, since };
}

function workerStepState(cache: JobIndexCache, jobId: string, fallback: RunStepState, worker?: OwnerWorker): RunStepState {
  const status = cache.readStatus<{ state?: string }>(jobId);
  const observed = status.status === 'ok' ? status.value.state : undefined;
  if (observed === 'failed') return 'failed';
  if (observed === 'stopped') return 'cancelled';
  if (observed && CLEAN_STATUS_STATES.has(observed)) return 'done';
  if (observed === 'waiting_orchestrator' || observed === 'blocked' || worker?.homeNeedsHuman) return 'asking';
  if (observed === 'working' || observed === 'waiting_helper') return 'running';
  return observed === 'queued' ? 'waiting' : fallback;
}

function projectTicketItem(
  home: string,
  item: TicketQueueItem,
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
  const base = {
    ticket: item.ticket,
    role: item.role,
    ...(item.job ? { jobId: item.job } : {}),
    ...(title ? { title } : {}),
    ...(worker?.startedAt != null ? { since: worker.startedAt } : {}),
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
          const progress = landProgress(land);
          const repairId = progress?.kind === 'repair' ? land.repairs?.at(-1)?.job : undefined;
          return { ...base, stage: 'land-gate', landStep: land.step, landProgress: progress,
            ...(repairId ? { jobId: repairId, execJob: jobTargetFor(home, workers.get(repairId), repairId) } : {}),
            since: parseTime(land.step_started_at) ?? parseTime(land.created_at) ?? undefined };
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
      return { ...base, stage: 'worker', ...(asking ? { asking: true } : {}),
        ...(workState(worker, now) === 'stalled' ? { stalled: true } : {}) };
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
    return { ...base, stage: 'worker', ...(asking ? { asking: true } : {}), ...(!statusState ? { statusUnknown: true } : {}) };
  }

  return { ...base, stage: 'queued' };
}

function projectTickets(
  home: string,
  q: TicketQueue,
  pass: HeaderPass,
  workers: ReadonlyMap<string, OwnerWorker>,
  cache: JobIndexCache,
  now: number,
): ExecutionRunTicket[] {
  const out: ExecutionRunTicket[] = [];
  const seen = new Set<string>();
  for (const item of q.tickets ?? []) {
    if (!item?.ticket) continue;
    seen.add(item.ticket);
    out.push(projectTicketItem(home, item, pass, workers, cache, now));
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

function queueWaves(tickets: readonly ExecutionRunTicket[]): NonNullable<ExecutionRun['queueWaves']> {
  const first = tickets.findIndex((ticket) => ticket.stage !== 'landed');
  const prefix = first < 0 ? tickets : tickets.slice(0, first);
  const current: ExecutionRunTicket[] = [], blocked: ExecutionRunTicket[] = [];
  for (const ticket of tickets.slice(prefix.length)) {
    (ticket.stage === 'blocked' || (ticket.stage === 'queued' && ticket.blockers?.length) ? blocked : current).push(ticket);
  }
  return { prefix, current, blocked: dependencyWaves(blocked, (ticket) => ticket.ticket, (ticket) => ticket.blockers ?? []) };
}

const cursorState = (cursor?: Cursor): RunStepState => cursor && cursor.state !== 'ready' && STEP_STATES.has(cursor.state) ? cursor.state : 'waiting';
const workerTitle = (worker?: OwnerWorker) => worker?.ticketTitle ?? worker?.briefTitle;
const readOptional = <T>(pass: HeaderPass, file: string): T | null => {
  try { return pass.header<T>(file); } catch { return null; }
};

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
    return { key, state: jobId ? workerStepState(cache, jobId, state, worker) : state,
      jobId, execJob: jobTargetFor(home, worker, jobId), since: worker?.startedAt ?? undefined, ...fields };
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
      return { ...base, kind: 'batch', label: `${b.scale.role} ×${b.scale.count}`, batch, reason: b.reason,
        state: open && b.state === 'stopped' ? 'working' : b.state, result, createdAt: parseTime(b.created_at), updatedAt: end ?? null, endedAt: end,
        jobIds: items.flatMap((item) => [item.job, ...item.previous?.map((a) => a.job) ?? []]).filter((job): job is string => !!job) };
    }
  }
  if (isFlowId(file.slice(0, -5))) {
    const land = pass.header<LandFlow>(file);
    if (land?.flow !== id || land.ticket_queue || !land.wt?.main_root || !visible({}, land.wt.main_root) || !activeLand(land) || typeof land.step !== 'string') return;
    const progress = landProgress(land);
    const repair = land.repairs?.at(-1), waiting = progress?.kind === 'lease', repairing = progress?.kind === 'repair';
    const picking = land.step === 'prepare' || land.step === 'cherry-pick';
    const publishing = land.step === 'records' || land.step === 'fast-forward' || /^after\[/.test(land.step);
    const gateTiming = land.timings?.filter((timing) => /^gate\[/.test(timing.step)).at(-1);
    const gate = progress?.kind === 'gate' ? progress : gateTiming ? landProgress({ ...land, step: gateTiming.step, step_started_at: undefined }) : undefined;
    const pickTiming = land.timings?.filter((timing) => timing.step === 'cherry-pick').at(-1);
    const pickState = picking ? 'running' : pickTiming ? pickTiming.ok ? 'done' : 'failed' : 'waiting';
    const job = workers.get(land.job), source = { jobId: land.job, execJob: jobTargetFor(home, job, land.job) };
    const nodes: WorkflowNode[][] = [
      [{ key: 'pick', word: 'Pick', state: pickState, ...(picking && source) }],
      [{ key: 'gate', word: 'Gate', progress: gate, ...(progress?.kind === 'gate' && source), state: progress?.kind === 'gate' ? 'running'
        : gateTiming?.ok === false ? 'failed' : gateTiming?.ok && gate?.index === gate?.total ? 'done' : 'waiting' }],
      ...(repair ? [[{ key: 'repair', word: 'Repair', state: repairing ? 'running' as const : repair.outcome === 'settled; retrying gate' ? 'done' as const : 'failed' as const,
        progress: { kind: 'repair' as const, index: land.repairs!.length, total: SEALED_REPAIR_LIMIT }, jobId: repair.job,
        label: repair.job?.slice(0, 8), role: repair.job ? 'imp' : undefined, execJob: jobTargetFor(home, repair.job ? workers.get(repair.job) : undefined, repair.job) }]] : []),
      ...(waiting ? [[{ key: 'lease', word: 'Lease wait', progress, state: 'running' as const, ...source }]] : []),
      [{ key: 'merge', word: 'Merge', state: land.landed_sha ? 'done' : publishing ? 'running' : 'waiting', ...(publishing && source) }],
    ];
    return { ...base, kind: 'land', label: workerTitle(job) ?? land.job.slice(0, 8), state: 'working', nodes,
      // Keep a settled source job's own recent outcome after the land flow closes.
      jobIds: [land.job, ...land.repairs?.flatMap(({ job }) => job ? [job] : []) ?? []],
      createdAt: parseTime(land.created_at), updatedAt: parseTime(land.updated_at), reason: land.error };
  }
  const run = pass.header<Run & RunScope & { template?: string; cwd?: string; created_at?: string | number; updated_at?: string | number;
    job?: string }>(file);
  if (run?.flow !== id || run.state === 'proposed' || !Object.hasOwn(STATE_RANK, run.state)) return;
  const owner = JOB_ID_RE.test(id) ? getJob(id) : undefined;
  if (!visible({ project_root: run.project_root ?? owner?.project_root ?? owner?.worktree?.main_root }, run.cwd ?? owner?.cwd)) return;
  const open = run.state === 'working' || run.state === 'paused';
  const updatedAt = parseTime(run.updated_at);
  const createdAt = parseTime(run.created_at) ?? parseTime(owner?.created_at);
  const common = { ...base, state: run.state, createdAt, updatedAt, reason: run.reason };
  const parent = workers.get(id);
  if (JOB_ID_RE.test(id) && run.template === 'council') {
    const end = open ? undefined : endedTime(updatedAt ?? parent?.settledAt);
    if (end !== undefined && !recent(end)) return;
    const members = (owner?.council_members ?? []).map((member, i) => nodeFor(`member-${i}`, member.job, 'waiting',
      { label: member.preset, role: 'oracle', ...(member.failure ? { state: 'failed', reason: member.failure } : {}) }));
    const synthesis = nodeFor('synthesis', owner?.synthesis_job, run.state === 'completed' ? 'done' : 'waiting',
      { word: 'Synthesis', role: 'lead', label: owner?.synthesizer });
    const result = end === undefined ? undefined : run.state === 'completed' ? 'done' : run.state === 'failed' ? 'failed' : 'stopped';
    return { ...common, kind: 'council', label: workerTitle(parent) ?? id.slice(0, 8), endedAt: end, result,
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
    return { ...common, kind: 'prewalk', label: workerTitle(parent) ?? id.slice(0, 8),
      nodes: [nodes.length ? nodes : [{ key: 'scouts', word: 'Scouts', state: cursorState(run.steps?.scouts) }],
        [nodeFor('target', id, cursorState(run.steps?.target), { word: 'Worker', role: parent?.role ?? undefined })]],
      jobIds: nodes.flatMap((node) => node.jobId ? [node.jobId] : []) };
  }
  const graph = readOptional<Pick<Graph, 'version' | 'name' | 'steps'>>(pass, `${id}/graph.json`);
  if (graph?.version !== 1 || !graph.steps || !run.steps) return;
  const nodes = Object.entries(graph.steps).map(([key, step]) => {
    const cursor = run.steps[key] as (Cursor & { job?: string }) | undefined;
    return nodeFor(key, cursor?.job ?? (step.kind === 'land' ? step.job : undefined), cursorState(cursor),
      { blockers: step.needs, role: step.kind === 'job' ? step.role : undefined, reason: cursor?.reason });
  });
  return { ...common, kind: 'graph', label: graph.name, nodes: dependencyWaves(nodes, (node) => node.key, (node) => node.blockers ?? []),
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
      const tickets = projectTickets(home, q, pass, workers, cache, now);
      const result = open ? undefined : endedResult(tickets);
      const heldCount = (q.tickets ?? []).filter((item) => item?.held).length + (q.held ? 1 : 0);
      const run: ExecutionRun = {
        flow: q.flow,
        kind: 'queue',
        jobIds: [q.review_job, q.active_lead?.job, q.pending_answer?.lead_job, ...(q.unclosed_leads?.map((lead) => lead.job) ?? []),
          ...(q.tickets ?? []).map((ticket) => ticket?.job)]
          .filter((id): id is string => !!id),
        reviewer: q.review_job ? { key: 'review', role: 'reviewer', jobId: q.review_job,
          state: workerStepState(cache, q.review_job, cursorState(q.steps?.review), workers.get(q.review_job)),
          execJob: jobTargetFor(home, workers.get(q.review_job), q.review_job), since: workers.get(q.review_job)?.startedAt ?? undefined } : undefined,
        acceptanceSeat: q.handback_to,
        lead: q.active_lead ? { key: 'lead', role: 'lead', jobId: q.active_lead.job,
          state: workerStepState(cache, q.active_lead.job, 'running', workers.get(q.active_lead.job)),
          execJob: jobTargetFor(home, workers.get(q.active_lead.job), q.active_lead.job), since: workers.get(q.active_lead.job)?.startedAt ?? undefined } : undefined,
        label: q.unattended?.objective || q.feature || q.flow.slice(0, 8),
        ...(q.feature ? { feature: q.feature } : {}),
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
        queueWaves: open ? queueWaves(tickets) : undefined,
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

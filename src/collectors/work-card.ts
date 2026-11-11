/** Pure work presentation. These facts never change execution, wait or acceptance. */
import type { OwnerWorker, EvidenceRef } from './workboard-types.js';
import type { SubagentTreeNode } from '../types.js';
import type { DispatchStatus } from '../roles/pi-dispatch-status.js';
export type WorkState = 'needs-you' | 'in-progress' | 'awaiting-acceptance' | 'stalled' | 'done';
export interface WorkFacts {
  readonly episode: string;
  readonly activityAt: number | null;
  readonly activityBasis: 'producer' | 'observed' | 'unknown';
  readonly signature: string;
  /** Internal primary semantic key, scoped to its session/start; never a protocol or persisted field. */
  readonly producerSignature?: string;
  /** Admitted helper semantics, retained only to date observed state transitions. */
  readonly helperSignature?: string | null;
  readonly phases: readonly string[];
  readonly phaseEvidence?: readonly EvidenceRef[];
  readonly request: boolean;
  readonly requestId?: string;
  /** Latest eligible answer when all questions admitted to this episode are written. Panel-local only. */
  readonly answeredRequestAt?: number;
  readonly requestInfo?: {
    readonly id: string;
    readonly question: string;
    readonly suggested: string;
    readonly options: readonly string[];
    readonly context?: string;
    readonly evidence?: EvidenceRef;
  };
  readonly failed: boolean;
  readonly result: boolean;
  readonly facadeClosed?: boolean;
  readonly facadeClosedAt?: number | null;
  readonly reason?: string;
  readonly reported?: {
    readonly tests: number | null;
    readonly passed: number | null;
    readonly failed: number | null;
    readonly files: number | null;
  };
}
export interface WorkCard {
  readonly state: WorkState;
  readonly role: string;
  readonly title: string;
  readonly phases: readonly string[];
  readonly reason: string | null;
  readonly elapsedMinutes: number | null;
  readonly inactivityMinutes: number | null;
  readonly worker: OwnerWorker;
  readonly deterministicState?: WorkState;
  readonly modelAttention?: boolean;
}
export const workMinute = (at: number | null | undefined, now: number): number | null =>
  typeof at === 'number' && Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60000)) : null;
export function projectWorkCard(
  worker: OwnerWorker,
  now: number,
  stallMinutes = 10,
  note?: import('./job-progress.js').JobProgressNote
): WorkCard {
  const w = worker.work;
  if (worker.id.startsWith('thin-job:')) {
    const result = worker.settledAt !== null;
    const inactive = workMinute(w?.activityAt, now);
    const state: WorkState =
      worker.homeNeedsHuman || w?.failed
        ? 'needs-you'
        : result
          ? w?.facadeClosed
            ? 'done'
            : 'awaiting-acceptance'
          : inactive !== null && inactive >= stallMinutes
            ? 'stalled'
            : 'in-progress';
    return {
      state,
      role: worker.role || 'agent',
      title: worker.task,
      phases: w?.phases ?? [],
      reason: w?.reason ?? null,
      elapsedMinutes: workMinute(
        worker.homeNeedsHuman
          ? worker.humanEndedAt
          : state === 'stalled'
            ? w?.activityAt
            : (worker.settledAt ?? worker.startedAt),
        now
      ),
      inactivityMinutes: inactive,
      worker,
    };
  }
  const result = w?.result ?? ['completed', 'idle_grace', 'awaiting-acceptance', 'done'].includes(worker.state);
  const failed = w?.failed ?? ['failed', 'error'].includes(worker.state);
  const request = w?.request ?? worker.state === 'waiting_orchestrator';
  const activity = w?.activityAt ?? null;
  const inactive = workMinute(activity, now);
  const state: WorkState =
    request || failed || worker.homeNeedsHuman
      ? 'needs-you'
      : result
        ? w?.facadeClosed === true
          ? 'done'
          : 'awaiting-acceptance'
        : worker.stale || worker.state === 'unknown' || activity === null
          ? 'stalled'
          : now - activity >= stallMinutes * 60000
            ? 'stalled'
            : 'in-progress';
  const elapsed =
    state === 'done'
      ? workMinute(w?.facadeClosedAt, now)
      : workMinute(worker.startedAt, result && worker.settledAt !== null ? worker.settledAt : now);
  return {
    state: note?.attention && state !== 'needs-you' ? 'needs-you' : state,
    deterministicState: state,
    modelAttention: note?.attention === true && state !== 'needs-you',
    role: worker.role === 'implementer' ? 'imp' : worker.role === 'architect' ? 'oracle' : worker.role || 'agent',
    title: worker.task,
    phases: [...(w?.phases ?? []), ...(state === 'done' ? ['done'] : [])],
    elapsedMinutes: elapsed,
    inactivityMinutes: inactive,
    reason: request
      ? 'Decision requested; inspect the job'
      : failed
        ? 'Work failed; inspect the job'
        : worker.homeNeedsHuman
          ? 'Ended needing a human'
          : state === 'stalled'
            ? worker.stale || activity === null
              ? 'Observation unavailable'
              : 'No new activity'
            : (w?.reason ??
              (result
                ? w?.phases.includes('build') && !w.phases.some((p) => p.startsWith('review'))
                  ? 'Build complete; review not observed'
                  : 'Result ready'
                : null)),
    worker,
  };
}
/** A native card has no invented phase strip or facade closure. */
export function nativeWorker(node: SubagentTreeNode, laneId = `native:${node.id}`): OwnerWorker {
  const start = node.turnStartedAt?.getTime() ?? node.startedAt?.getTime() ?? null;
  const times = [start, node.lastEventAt?.getTime()].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  const activity = times.length ? Math.max(...times) : null;
  return {
    id: node.id,
    nodeId: node.id,
    laneId,
    harness: node.ref?.harness ?? null,
    role: node.role ?? null,
    task: node.label || node.name,
    model: node.model ?? null,
    effort: node.effort ?? null,
    state: node.status,
    startedAt: start,
    settledAt: node.statusAt?.getTime() ?? null,
    phase: null,
    homeNeedsHuman: false,
    humanEndedAt: null,
    stale: node.status === 'unknown',
    evidence: [],
    work: {
      episode: node.id,
      signature: '',
      activityAt: activity,
      activityBasis: 'producer',
      phases: [],
      request: false,
      failed: node.status === 'error',
      result: node.status === 'completed',
    },
  };
}
const at = (s: string | null | undefined) => (s && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null);
export interface ReviewFact {
  round: number;
  verdict: 'accept' | 'changes-required';
  at: number | null;
}
/** Observed phases only; a review still running cannot start fixing. */
export function dispatchWorkFacts(
  status: DispatchStatus,
  reviews: readonly ReviewFact[],
  reportRevision: string | null,
  previous: WorkFacts | undefined,
  _observedAt: number,
  evidenceAt: number | null,
  request = status.state === 'waiting_orchestrator',
  helperFailed = false,
  role: string | null = null,
  startedAt: number | null = null,
  outputCurrent = true,
  producerAt: number | null = null
): WorkFacts {
  const episode = status.session_id;
  const start = startedAt;
  const current = reviews
    .filter((r) => r.at !== null && start !== null && r.at >= start)
    .sort((a, b) => a.round - b.round);
  const latest = current.at(-1);
  const pending = status.helper_pending;
  const phases: string[] = [];
  const build = role === 'implementer' || role === 'imp';
  if (build) phases.push('build');
  else if (role === 'architect' || role === 'oracle') phases.push('design');
  else if (role === 'reviewer') phases.push('review');
  else if (role === 'sonic') phases.push('chores');
  for (const [i, r] of current.entries()) {
    phases.push(`review r${r.round} ${r.verdict}`);
    if (
      build &&
      r.verdict === 'changes-required' &&
      (i < current.length - 1 || (pending?.kind === 'review' && pending.n! > r.round) || status.state === 'working')
    )
      phases.push('fixing');
  }
  if (pending?.kind === 'review') {
    const token = `review r${pending.n}`;
    if (!latest || latest.round !== pending.n) phases.push(token);
  } else if (pending?.kind === 'sonic') phases.push('chores');
  else if (pending?.kind === 'architect') phases.push('design');
  const result =
    outputCurrent && !!status.output_written && !!status.settled_at && ['idle_grace', 'closed'].includes(status.state);

  const failed =
    status.state === 'failed' || helperFailed || (['idle_grace', 'closed'].includes(status.state) && !result);
  // Producer heartbeat/updated_at, model/thinking, counters and file mtimes are deliberately absent.
  const signature = JSON.stringify([
    episode,
    start,
    role,
    status.state,
    status.output_written,
    status.settled_at,
    pending?.kind,
    pending?.n,
    request,
    helperFailed,
    current,
    reportRevision,
    outputCurrent,
  ]);
  const producerScope = JSON.stringify([episode, start]) + ':';
  const producerSignature =
    producerScope +
    JSON.stringify([role, status.state, status.output_written, status.settled_at, pending?.kind, pending?.n]);
  const sameEpisode = previous?.episode === episode && previous.producerSignature?.startsWith(producerScope) === true;
  const primaryChanged = sameEpisode && previous.producerSignature !== producerSignature;
  const same = sameEpisode && previous.signature === signature;
  // Removing/rejecting evidence repaints the facts, not the activity clock. A
  // primary heartbeat must not supply a fresh date for an artifact-only change.
  const dates = [
    evidenceAt,
    at(status.settled_at),
    start,
    primaryChanged ? producerAt : null,
    sameEpisode ? previous.activityAt : null,
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  const activityAt = same ? previous.activityAt : dates.length ? Math.max(...dates) : null;
  return {
    episode,
    signature,
    producerSignature,
    phases,
    request,
    failed,
    result,
    activityAt,
    activityBasis:
      same || (sameEpisode && activityAt === previous.activityAt)
        ? previous.activityBasis
        : activityAt !== null
          ? 'producer'
          : 'unknown',
  };
}

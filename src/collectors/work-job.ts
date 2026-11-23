/** Pure job facts and presentation state, shared by the panel and statusline. */
import type { OwnerWorker, EvidenceRef } from './workboard-types.js';
export type WorkState = 'needs-you' | 'in-progress' | 'queued' | 'awaiting-acceptance' | 'stalled' | 'done';
export interface WorkFacts {
  readonly episode: string;
  readonly activityAt: number | null;
  readonly activityBasis: 'producer' | 'observed' | 'unknown';
  readonly signature: string;
  readonly phases: readonly string[];
  readonly request: boolean;
  readonly requestId?: string;
  readonly requestInfo?: {
    /** Display overlay only; answer keys always select from the original options below. */
    readonly display?: import('./work-artifacts.js').QuestionFields;
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
}
export interface WorkJob {
  readonly state: WorkState;
  readonly role: string;
  readonly title: string;
  readonly phases: readonly string[];
  readonly reason: string | null;
  readonly elapsedMinutes: number | null;
  readonly inactivityMinutes: number | null;
  readonly worker: OwnerWorker;
}
export const workMinute = (at: number | null | undefined, now: number): number | null =>
  typeof at === 'number' && Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60000)) : null;
export function workState(worker: OwnerWorker, now: number, stallMinutes = 10): WorkState {
  const w = worker.work;
  const inactive = workMinute(w?.activityAt, now);
  if (worker.homeNeedsHuman || (w?.failed && !worker.failureObserved && !worker.superseded)) return 'needs-you';
  if (worker.state === 'queued') return 'queued';
  if (worker.settledAt !== null) return w?.facadeClosed ? 'done' : 'awaiting-acceptance';
  return worker.stale || (inactive !== null && inactive >= stallMinutes) ? 'stalled' : 'in-progress';
}
export function projectWorkJob(worker: OwnerWorker, now: number, stallMinutes = 10): WorkJob {
  const w = worker.work;
  const state = workState(worker, now, stallMinutes);
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
    inactivityMinutes: workMinute(w?.activityAt, now),
    worker,
  };
}

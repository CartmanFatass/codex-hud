/** Pure work presentation. These facts never change execution, wait or acceptance. */
import type { OwnerWorker, EvidenceRef } from './workboard-types.js';
import type { SubagentTreeNode } from '../types.js';
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
export interface WorkCard {
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
export function projectWorkCard(worker: OwnerWorker, now: number, stallMinutes = 10): WorkCard {
  const w = worker.work;
  const result = worker.settledAt !== null;
  const inactive = workMinute(w?.activityAt, now);
  const state: WorkState =
    worker.homeNeedsHuman || (w?.failed && !worker.failureObserved && !worker.superseded)
      ? 'needs-you'
      : worker.state === 'queued'
        ? 'queued'
        : result
          ? w?.facadeClosed
            ? 'done'
            : 'awaiting-acceptance'
          : worker.stale || (inactive !== null && inactive >= stallMinutes)
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
    resources: { context: node.contextUsage?.percent, rate: node.outputRate, spent: node.tokensSpent },
    nativeDepth: node.depth,
    ...(node.transcriptStep ? { transcriptStep: { text: node.transcriptStep, replaying: !!node.replaying } } : {}),
    state:
      node.status === 'completed'
        ? 'done'
        : node.status === 'error'
          ? 'failed'
          : node.status === 'unknown'
            ? 'unknown'
            : 'working',
    startedAt: start,
    settledAt: ['completed', 'error'].includes(node.status) ? (node.statusAt?.getTime() ?? null) : null,
    files: node.rolloutPath
      ? [
          {
            rel: node.rolloutPath.split('/').at(-1)!,
            kind: 'report',
            at: node.lastEventAt?.getTime() ?? 0,
            paths: [node.rolloutPath],
          },
        ]
      : [],
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
      facadeClosed: ['completed', 'error'].includes(node.status),
      reason:
        node.status === 'completed'
          ? 'Result ready'
          : node.status === 'error'
            ? 'Work failed; inspect the job'
            : // Not the current tool name: it flips every few seconds. The model sentence describes running work.
              undefined,
    },
  };
}

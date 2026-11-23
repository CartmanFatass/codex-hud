/** Legacy card projection and native workers. */
import type { OwnerWorker } from './workboard-types.js';
import type { SubagentTreeNode } from '../types.js';

export { projectWorkJob as projectWorkCard, workMinute } from './work-job.js';
export type { WorkJob as WorkCard, WorkFacts, WorkState } from './work-job.js';

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

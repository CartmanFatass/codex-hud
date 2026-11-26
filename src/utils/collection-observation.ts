import type { HudData, SubagentTree } from '../types.js';
import { eachThread } from '../collectors/subagent-tree.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
export function jobPanelObservation(board: WorkboardSnapshot, complete: boolean, nativeQuiet: boolean) {
  const active = board.workers.some((w) => w.state === 'working' || w.homeNeedsHuman || w.work?.request) ||
    board.batches?.some((b) => b.state === 'working' || b.totals.running > 0);
  const uncertain =
    !(complete && nativeQuiet) ||
    board.coverage.incomplete ||
    board.workers.some((w) => w.stale || w.settledAt === null || w.files?.some((f) => f.state === 'open'));
  return {
    activity: active ? ('active' as const) : uncertain ? ('uncertain' as const) : ('quiet' as const),
    fingerprint: active || uncertain ? undefined : JSON.stringify([board.workers, board.decisions, board.batches]),
    succeeded: complete,
  };
}

/** Stable source facts only: refresh timestamps must not keep a quiet session busy. */
export function collectionObservation(data: HudData | undefined | null, tree: SubagentTree | undefined) {
  let activity: 'active' | 'quiet' | 'uncertain' =
    !data || data.stale || data.health?.sessionBound !== true || !data.activity || !tree
      ? 'uncertain'
      : data.activity.state === 'idle'
        ? 'quiet'
        : 'active';
  const agents: unknown[] = [];
  if (tree)
    eachThread(tree.nodes, (node) => {
      if (node.status === 'running' || node.status === 'starting') activity = 'active';
      else if (node.status === 'unknown' && activity === 'quiet') activity = 'uncertain';
      agents.push([node.id, node.status, node.lastEventAt?.getTime(), node.statusAt?.getTime()]);
    });
  if (activity === 'quiet' && data?.pendingApproval) activity = 'uncertain';
  return {
    activity,
    fingerprint: JSON.stringify([
      data?.session?.id,
      data?.activity?.state,
      data?.activity?.updatedAt?.getTime(),
      data?.tokenUsageAt?.getTime(),
      data?.contextUsage?.used,
      data?.outputRate?.sampledAt?.getTime(),
      data?.pendingApproval?.callId,
      agents,
    ]),
  };
}

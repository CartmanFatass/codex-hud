import type { HudData, SubagentTree } from '../types.js';
import { eachThread } from '../collectors/subagent-tree.js';

/** Stable source facts only: refresh timestamps must not keep a quiet session busy. */
export function collectionObservation(data: HudData | undefined | null, tree: SubagentTree | undefined) {
  let activity: 'active' | 'quiet' | 'uncertain' = !data || data.stale || data.health?.sessionBound !== true
    || !data.activity || !tree ? 'uncertain' : data.activity.state === 'idle' ? 'quiet' : 'active';
  const agents: unknown[] = [];
  if (tree) eachThread(tree.nodes, node => {
    if (node.status === 'running' || node.status === 'starting') activity = 'active';
    else if (node.status === 'unknown' && activity === 'quiet') activity = 'uncertain';
    agents.push([node.id, node.status, node.lastEventAt?.getTime(), node.statusAt?.getTime()]);
  });
  const bridge = data?.bridgeHealth;
  if (activity === 'quiet' && (data?.pendingApproval || bridge?.stateMismatch || bridge?.probeFailed
    || (bridge && bridge.state !== 'connected'))) activity = 'uncertain';
  if (data?.modelHealth?.queued || data?.modelHealth?.running) activity = 'active';
  return { activity, fingerprint: JSON.stringify([
    data?.session?.id, data?.activity?.state, data?.activity?.updatedAt?.getTime(),
    data?.tokenUsageAt?.getTime(), data?.contextUsage?.used, data?.outputRate?.sampledAt?.getTime(),
    data?.pendingApproval?.callId, bridge?.state, bridge?.nativeState, bridge?.stateMismatch,
    data?.modelHealth?.lastSuccessAt, data?.modelHealth?.lastFailure?.at, agents,
  ]) };
}

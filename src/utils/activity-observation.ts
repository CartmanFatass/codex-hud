import type { ActivityObservation } from '../collectors/activity-journal.js';

/** Do not let retained display data become evidence for another session's journal. */
export function scopedActivityObservation(rootId: string, logRootId: string, input: ActivityObservation): ActivityObservation {
  const sameRoot = !!rootId && input.data?.session?.id === rootId;
  const fresh = sameRoot && !input.data?.stale && input.tree?.rootId === rootId;
  return { ...input,
    // Consumers may fall back to data.subagentTree; suppress that path too.
    data: sameRoot && input.data ? {...input.data,subagentTree:fresh?input.tree:undefined} : undefined,
    tree: fresh ? input.tree : undefined,
    logs: fresh && logRootId === rootId ? input.logs : undefined,
    git: sameRoot ? input.git : undefined,
    gitFresh: sameRoot && input.gitFresh,
    healthSignals: sameRoot ? input.healthSignals : undefined,
  };
}

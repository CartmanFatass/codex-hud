import type { LinkTreeProjection } from './types.js';

/** Read-only facts for a displayed conflict relation. Unknown records are not attributed. */
export function conflictDetails(tree: LinkTreeProjection, selectedKey: string) {
  const selected = tree.relations.filter(
    (relation) =>
      relation.attribution === 'conflict' &&
      relation.parentKey !== null &&
      `conflict:${relation.link.linkId}:${relation.parentKey}` === selectedKey
  );
  if (selected.length !== 1 || !selected[0].conflict) return null;
  const relation = selected[0];
  const conflict = relation.conflict!;
  const peers = tree.relations.filter((item) => item.attribution === 'conflict' && item.childKey === relation.childKey);
  const records = conflict.recordIds.map((id) => {
    const matches = peers.filter((item) => `link:${item.link.linkId}` === id);
    const match = matches.length === 1 ? matches[0] : null;
    const run = match && match.currentRun?.linkId === match.link.linkId ? match.currentRun : null;
    return { id, parentKey: match?.parentKey ?? null, runId: run?.runId ?? null, runState: run?.state ?? null };
  });
  return {
    count: conflict.count,
    since: conflict.since,
    records,
    notListed: Math.max(0, conflict.count - records.length),
  };
}

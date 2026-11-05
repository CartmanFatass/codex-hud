import type { LinkRelationProjection } from './types.js';

/** Aggregate facts only: record IDs do not prove a parent, run, timestamp or action target. */
export function conflictDetails(relation: LinkRelationProjection) {
  if (relation.attribution !== 'conflict' || !relation.conflict) return null;
  const { count, since, recordIds } = relation.conflict;
  return { count, since, recordIds, notListed: Math.max(0, count - recordIds.length) };
}

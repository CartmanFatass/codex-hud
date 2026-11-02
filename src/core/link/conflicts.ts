import { sessionRefKey } from '../identity.js';
import type { LedgerReadSnapshot } from '../ledger-read.js';
import type { LinkConflict } from './types.js';
import type { SessionRef } from '../types/identity.js';

export function combineConflicts(...values: (LinkConflict | null | undefined)[]): LinkConflict | null {
  const present = [...new Set(values.filter((value): value is LinkConflict => Boolean(value)))];
  if (!present.length) return null;
  const recordIds = [...new Set(present.flatMap((value) => value.recordIds))].sort();
  const omitted = present.reduce((sum, value) => sum + Math.max(0, value.count - value.recordIds.length), 0);
  return { count: recordIds.length + omitted, recordIds, since: Math.min(...present.map((value) => value.since)) };
}

/** Same-run explicit resolution only; current target conflicts also affect other relations to that exact ref. */
export function ledgerConflicts(
  snapshot: LedgerReadSnapshot,
  conflictTargets: ReadonlyMap<string, SessionRef> = new Map()
): Map<string, LinkConflict> {
  const resolved = new Set(
    snapshot.evidence
      .filter((record) => record.kind === 'conflict_resolved' && record.validation === 'accepted')
      .map((record) => JSON.stringify([record.runId, record.payload.resolves]))
  );
  const runs = new Map(snapshot.runs.map((run) => [run.runId, run]));
  const links = new Map(snapshot.links.map((link) => [link.linkId, link]));
  const targets = new Map<string, Set<string>>();
  for (const run of snapshot.runs) {
    const ref = run.targetSessionRef ?? links.get(run.linkId)?.childRef;
    if (!ref) continue;
    const key = sessionRefKey(ref);
    const group = targets.get(key) ?? new Set<string>();
    group.add(run.linkId);
    targets.set(key, group);
  }
  const result = new Map<string, LinkConflict>();
  for (const record of snapshot.evidence) {
    if (
      record.kind !== 'conflict' ||
      record.validation !== 'accepted' ||
      resolved.has(JSON.stringify([record.runId, record.evidenceId]))
    )
      continue;
    const run = record.runId ? runs.get(record.runId) : undefined;
    const linkId = record.linkId ?? run?.linkId;
    const ref =
      conflictTargets.get(record.evidenceId) ?? run?.targetSessionRef ?? (linkId ? links.get(linkId)?.childRef : null);
    const affected = new Set([...(linkId ? [linkId] : []), ...(ref ? (targets.get(sessionRefKey(ref)) ?? []) : [])]);
    for (const id of affected) {
      result.set(
        id,
        combineConflicts(result.get(id), {
          count: 1,
          recordIds: [record.evidenceId],
          since: record.observedAt,
        })!
      );
    }
  }
  return result;
}

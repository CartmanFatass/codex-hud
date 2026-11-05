import type { ReaderBudget } from '../interfaces/harness-adapter.js';
import type { SessionRef } from '../types/identity.js';
import type { LinkTreeProjection } from './types.js';

export type LinkReadPlan =
  | {
      target: { key: string; ref: SessionRef; kind: 'session' | 'native_topology' };
      budget: ReaderBudget;
      nextCursor: string;
    }
  | { target: null; reason: 'deadline' | 'bytes' | 'no_eligible_target'; nextCursor: string | null };

/** One grant at a time: B10 executes it, charges actual work, then replans against the same shared deadline.
 * A topology grant is for a future metered collection port, never raw adapter.children().
 */
export function planLinkRead(
  tree: LinkTreeProjection,
  input: { remainingMs: number; afterKey?: string; minimumBytes?: ReadonlyMap<string, number> }
): LinkReadPlan {
  if (!Number.isFinite(input.remainingMs) || input.remainingMs <= 0)
    return { target: null, reason: 'deadline', nextCursor: input.afterKey ?? null };
  if (tree.io.remainingBytes <= 0 || tree.io.exceeded)
    return { target: null, reason: 'bytes', nextCursor: input.afterKey ?? null };
  const retained = new Set(tree.nodes.map((node) => node.key));
  const eligible = tree.continuation.filter(
    (entry) =>
      entry.identity.kind === 'session' &&
      retained.has(entry.key) &&
      ['unloaded', 'native_topology'].includes(entry.reason)
  );
  if (!eligible.length) return { target: null, reason: 'no_eligible_target', nextCursor: input.afterKey ?? null };
  const previous = eligible.findIndex((entry) => entry.key === input.afterKey);
  // A blocked session remains in continuation, but cannot prevent other eligible work.
  // minimumBytes describes a native session record, not the separate topology operation.
  const entry = Array.from({ length: eligible.length }, (_, i) => eligible[(previous + 1 + i) % eligible.length]).find(
    (candidate) => {
      const minimum = candidate.reason === 'unloaded' ? (input.minimumBytes?.get(candidate.key) ?? 1) : 1;
      return (
        Number.isSafeInteger(minimum) && minimum >= 1 && minimum <= Math.min(tree.io.remainingBytes, 4 * 1024 * 1024)
      );
    }
  );
  if (!entry) return { target: null, reason: 'bytes', nextCursor: input.afterKey ?? null };
  return {
    target: {
      key: entry.key,
      ref: (entry.identity as { kind: 'session'; ref: SessionRef }).ref,
      kind: entry.reason === 'native_topology' ? 'native_topology' : 'session',
    },
    budget: {
      maxBytes: Math.min(4 * 1024 * 1024, tree.io.remainingBytes),
      maxRecords: 2000,
      budgetMs: Math.min(20, input.remainingMs),
    },
    nextCursor: entry.key,
  };
}

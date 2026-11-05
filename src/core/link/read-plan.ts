import type { ReaderBudget } from '../interfaces/harness-adapter.js';
import type { SessionRef } from '../types/identity.js';
import type { LinkTreeProjection } from './types.js';

export type LinkReadPlan =
  | {
      target: { key: string; ref: SessionRef; kind: 'session' | 'native_topology' };
      budget: ReaderBudget;
      nextCursor: string;
      continuation?: true;
    }
  | { target: null; reason: 'deadline' | 'bytes' | 'no_eligible_target'; nextCursor: string | null };

/** One grant at a time: B10 executes it, charges actual work, then replans against the same shared deadline.
 * A topology grant is for a future metered collection port, never raw adapter.children().
 */
export function planLinkRead(
  tree: LinkTreeProjection,
  input: {
    remainingMs: number;
    afterKey?: string;
    minimumBytes?: ReadonlyMap<string, number>;
    continuationKey?: string;
  }
): LinkReadPlan {
  if (!Number.isFinite(input.remainingMs) || input.remainingMs <= 0)
    return { target: null, reason: 'deadline', nextCursor: input.afterKey ?? null };
  if (tree.io.remainingBytes <= 0 || tree.io.exceeded)
    return { target: null, reason: 'bytes', nextCursor: input.afterKey ?? null };
  const order = tree.nodes.map((node) => node.key);
  const retained = new Set(order);
  const eligible = new Map<string, (typeof tree.continuation)[number]>();
  for (const entry of tree.continuation)
    if (
      entry.identity.kind === 'session' &&
      retained.has(entry.key) &&
      ['unloaded', 'native_topology'].includes(entry.reason) &&
      !eligible.has(entry.key)
    )
      eligible.set(entry.key, entry);
  if (!eligible.size) return { target: null, reason: 'no_eligible_target', nextCursor: input.afterKey ?? null };
  // Locate the cursor in retained order before filtering current work; a just-settled
  // target still anchors its successor. A genuinely removed target starts at the head.
  const previous = order.indexOf(input.afterKey ?? '');
  // A blocked session remains in continuation, but cannot prevent other eligible work.
  // minimumBytes describes a native session record, not the separate topology operation.
  const fits = (candidate: (typeof tree.continuation)[number] | undefined) => {
    if (!candidate) return false;
    const minimum = candidate.reason === 'unloaded' ? (input.minimumBytes?.get(candidate.key) ?? 1) : 1;
    return (
      Number.isSafeInteger(minimum) && minimum >= 1 && minimum <= Math.min(tree.io.remainingBytes, 4 * 1024 * 1024)
    );
  };
  const preferred = input.continuationKey ? eligible.get(input.continuationKey) : undefined;
  const continuation = preferred?.reason === 'unloaded' && fits(preferred);
  const entry = continuation
    ? preferred
    : Array.from({ length: order.length }, (_, i) => eligible.get(order[(previous + 1 + i) % order.length])).find(fits);
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
    ...(continuation ? { continuation: true as const } : {}),
  };
}

import type { LedgerEvent } from '../types/execution.js';
import type { Link } from '../types/lifecycle.js';

/** The intent callback precedes its intent.accepted event in one transaction.
 * Legacy registrations without an associated intent use the immutable creator.
 */
export function wakeContextBinding(
  link: Link,
  intent: LedgerEvent | null
): { contextId: string; generation: number } | null {
  if (!intent) return { contextId: link.parentContextId, generation: link.parentContextGeneration };
  const actor = intent.payload.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
  const value = actor as Record<string, unknown>;
  return value.kind === 'mcp' && typeof value.contextId === 'string' && Number.isSafeInteger(value.contextGeneration)
    ? { contextId: value.contextId, generation: Number(value.contextGeneration) }
    : null;
}

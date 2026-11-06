import { digest } from '../../../src/core/canonical.js';
import { object } from './io.js';
import type { CallResolution } from './resolvers.js';

export const LINKS_RESOURCE_MAX_BYTES = 128 * 1024;
export interface LinksResource {
  type: 'resource';
  resource: { uri: string; mimeType: 'application/json'; text: string };
}
type Projection = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const string: Check = (value) => typeof value === 'string';
const boolean: Check = (value) => typeof value === 'boolean';
const number: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const oneOf = (...values: string[]): Check => (value) => typeof value === 'string' && values.includes(value);

/** Copy only named scalar facts; never serialize arbitrary nested outcome objects. */
function scalars(value: Projection, fields: Record<string, Check>): Projection {
  const result: Projection = {};
  for (const [key, check] of Object.entries(fields)) {
    if (Object.hasOwn(value, key) && (value[key] === null || check(value[key]))) result[key] = value[key];
  }
  return result;
}
function ref(value: unknown): Projection | null | undefined {
  if (value === null) return null;
  if (!object(value)) return undefined;
  return scalars(value, { harness: oneOf('codex', 'claude', 'pi'), sourceId: string, sessionId: string, threadId: string });
}
function nested(target: Projection, key: string, value: unknown, fields: Record<string, Check>): void {
  if (value === null) target[key] = null;
  else if (object(value)) target[key] = scalars(value, fields);
}
function item(value: unknown): Projection {
  if (!object(value)) throw new Error('internal_error');
  const result = scalars(value, {
    linkId: string, runId: string, backend: string, role: string,
    linkState: string, runState: string,
    isCurrentRun: boolean, currentOwner: boolean, slotHeld: boolean,
    observationAvailability: oneOf('current', 'stale', 'unavailable'),
  });
  const child = ref(value.childRef);
  if (child !== undefined) result.childRef = child;
  nested(result, 'observationStamp', value.observationStamp, {
    seqDomain: string, commitSeq: number, inputLedgerSeq: number, runId: string,
    bindingGeneration: number, sourceGeneration: number,
  });
  if (object(result.observationStamp) && object(value.observationStamp)) {
    const stampedRef = ref(value.observationStamp.ref);
    if (stampedRef !== undefined) result.observationStamp.ref = stampedRef;
  }
  // No model text, stateKey, reason text, source arrays, labels or paths.
  nested(result, 'statusProjection', value.statusProjection, {
    activity: oneOf('working', 'waiting_input', 'idle', 'exited', 'unknown'),
    pendingReason: oneOf('none', 'approval', 'question', 'needs_human'),
    lastTurnOutcome: oneOf('none', 'completed', 'failed', 'interrupted'),
    liveness: oneOf('alive', 'gone', 'unknown'),
    isRunTerminal: boolean, asOfSeq: number, asOf: number, observedAt: number, lastEvidenceAt: number,
  });
  nested(result, 'freshnessNow', value.freshnessNow, {
    state: oneOf('fresh', 'stale', 'unknown'), staleSince: number, clockAnomaly: boolean,
  });
  return result;
}

/** Pure detached page, composed only after the service's owner/context authorization.
 * The URI is a content/scope identifier, never a read capability or stored receipt.
 */
export function linksResource(
  outcome: unknown,
  source: Extract<CallResolution, { ok: true }>
): { ok: true; content: LinksResource } | { ok: false; code: string } {
  if (!source.scopePremise) return { ok: false, code: 'identity_unverified' };
  if (!object(outcome) || outcome.ok !== true || !Array.isArray(outcome.items))
    return { ok: false, code: 'internal_error' };
  if (outcome.items.length > 50) return { ok: false, code: 'resource_too_large' };
  if (typeof outcome.hasMore !== 'boolean' || (outcome.nextCursor !== null && typeof outcome.nextCursor !== 'string'))
    return { ok: false, code: 'internal_error' };
  const page = {
    schemaVersion: 1,
    kind: 'owned-links-page',
    // Describes the payload, not whether any child's observation is current.
    availability: 'committed-metadata-only',
    hasMore: outcome.hasMore,
    nextCursor: outcome.nextCursor,
    items: outcome.items.map(item),
  };
  const text = JSON.stringify(page);
  if (Buffer.byteLength(text, 'utf8') > LINKS_RESOURCE_MAX_BYTES)
    return { ok: false, code: 'resource_too_large' };
  const snapshot = digest({
    page,
    sessionRef: source.sessionRef,
    processKey: source.processKey,
    scopePremise: source.scopePremise,
  });
  return {
    ok: true,
    content: { type: 'resource', resource: { uri: `hud://links/${snapshot}`, mimeType: 'application/json', text } },
  };
}

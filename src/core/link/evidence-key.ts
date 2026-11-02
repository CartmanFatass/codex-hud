import { digest } from '../canonical.js';
import type { LinkEvidence } from '../interfaces/session-evidence.js';
import { sessionRefKey } from '../identity.js';

/** Stable metadata ID; never expose claim fingerprints in a key or diagnostic. */
export function linkEvidenceKey(entry: LinkEvidence): string {
  return `transcript:${digest([
    entry.kind,
    sessionRefKey(entry.ref),
    entry.linkId,
    entry.nativeMessageId ?? null,
    Number.isFinite(entry.eventAt) ? entry.eventAt : null,
    entry.launchCallId ?? null,
    entry.launchCorrelationId ?? null,
    ...(entry.kind === 'tool_result'
      ? [entry.runId ?? null, entry.tool ?? null, entry.callId ?? null]
      : [entry.claimFingerprint ?? null]),
  ])}`;
}

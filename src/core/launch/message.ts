import { createHash } from 'node:crypto';

/** Explicit transport fallback only. Normal per-server env transport never emits this marker. */
export const LAUNCH_MESSAGE_PREFIX = '[hud-launch] ';
const MAX_CLAIM_BYTES = 4096;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');

export interface LaunchMessageAnchor {
  linkId: string;
  claimFingerprint: string;
  /** Read-only compatibility with the provisional B8 envelope. New writers omit these. */
  launchCallId?: string;
  launchCorrelationId?: string;
}

export function formatLaunchMessage(value: { linkId: string; claim: string }): string {
  if (!identifier(value.linkId) || !validClaim(value.claim)) throw new Error('invalid_launch_message');
  return LAUNCH_MESSAGE_PREFIX + JSON.stringify({ linkId: value.linkId, claim: value.claim });
}

function validClaim(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_CLAIM_BYTES;
}

/** Parse one line and immediately discard the credential. This result is safe for an observation checkpoint. */
export function parseLaunchMessage(line: string): LaunchMessageAnchor | null {
  if (!line.startsWith(LAUNCH_MESSAGE_PREFIX) || Buffer.byteLength(line, 'utf8') > 32_768) return null;
  try {
    const value: unknown = JSON.parse(line.slice(LAUNCH_MESSAGE_PREFIX.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    if (!identifier(envelope.linkId) || !validClaim(envelope.claim)) return null;
    return {
      linkId: envelope.linkId,
      claimFingerprint: createHash('sha256').update(envelope.claim, 'utf8').digest('hex'),
      ...(identifier(envelope.launchCallId) ? { launchCallId: envelope.launchCallId } : {}),
      ...(identifier(envelope.launchCorrelationId) ? { launchCorrelationId: envelope.launchCorrelationId } : {}),
    };
  } catch {
    return null;
  }
}

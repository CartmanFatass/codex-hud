import { digest, requireCanonicalAbsolutePath } from './canonical.js';
import type { Harness, SessionRef, SourceId } from './types/identity.js';

const harnesses: readonly string[] = ['claude', 'codex', 'pi'];
const sha256 = /^[0-9a-f]{64}$/;
export function validateSessionRef(ref: SessionRef): void {
  if (
    !harnesses.includes(ref.harness) ||
    !sha256.test(ref.sourceId) ||
    typeof ref.sessionId !== 'string' ||
    ref.sessionId.length === 0 ||
    (ref.threadId !== null && typeof ref.threadId !== 'string')
  )
    throw new TypeError('invalid_session_ref');
}
/** realpath is deliberately outside this pure API; unresolved roots cannot be supplied. */
export function makeSourceId(harness: Harness, alreadyCanonicalAbsoluteRoot: string): SourceId {
  if (!harnesses.includes(harness)) throw new TypeError('invalid_harness');
  requireCanonicalAbsolutePath(alreadyCanonicalAbsoluteRoot);
  return digest([harness, alreadyCanonicalAbsoluteRoot]);
}
export function sessionRefKey(ref: SessionRef): string {
  validateSessionRef(ref);
  return JSON.stringify([ref.harness, ref.sourceId, ref.sessionId, ref.threadId === '' ? null : ref.threadId]);
}
export function sameSessionRef(a: SessionRef, b: SessionRef): boolean {
  return sessionRefKey(a) === sessionRefKey(b);
}

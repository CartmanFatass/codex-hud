import { digest, requireCanonicalAbsolutePath } from './canonical.js';
import type { Harness, SourceId } from './types/identity.js';

const harnesses: readonly string[] = ['claude', 'codex', 'pi'];

/** realpath is deliberately outside this pure API; unresolved roots cannot be supplied. */
export function makeSourceId(harness: Harness, alreadyCanonicalAbsoluteRoot: string): SourceId {
  if (!harnesses.includes(harness)) throw new TypeError('invalid_harness');
  requireCanonicalAbsolutePath(alreadyCanonicalAbsoluteRoot);
  return digest([harness, alreadyCanonicalAbsoluteRoot]);
}

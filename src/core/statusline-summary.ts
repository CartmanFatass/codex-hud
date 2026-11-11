import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { makeSourceId, validateSessionRef } from './identity.js';
import type { SessionRef } from './types/identity.js';

/** Source selection is explicit; stdin paths and bare session IDs never select a source. */
export function statuslineRef(
  input: unknown,
  sourceRoot: string | undefined
): { ref: SessionRef; root: string } | null {
  if (!sourceRoot || !isAbsolute(sourceRoot) || sourceRoot.includes('\0')) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 256) return null;
  if (value.agent_id !== undefined && (typeof value.agent_id !== 'string' || value.agent_id.length > 256)) return null;
  const root = realpathSync(sourceRoot);
  if (!lstatSync(root).isDirectory()) return null;
  const ref: SessionRef = {
    harness: 'claude',
    sourceId: makeSourceId('claude', root),
    sessionId: value.session_id,
    threadId: typeof value.agent_id === 'string' && value.agent_id ? value.agent_id : null,
  };
  validateSessionRef(ref);
  return { ref, root };
}

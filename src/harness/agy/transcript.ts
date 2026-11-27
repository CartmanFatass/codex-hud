import { homedir } from 'node:os';
import { join } from 'node:path';

/** Native log for a recorded AGY session, never a search of other sessions. */
export function agyTranscriptPath(id: unknown): string | undefined {
  if (typeof id === 'string' && /^[\w-]{1,128}$/.test(id)) {
    return join(homedir(), '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  }
}

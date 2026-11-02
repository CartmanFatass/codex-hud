import { opendirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from './record.js';

/** Call ONLY from the owning harness exit path after its hook/MCP children ended.
 * The caller supplies its exact namespace; no daemon, polling or hot-path scan.
 * A finite limit returns incomplete so the launcher's existing cleanup can resume.
 */
export function cleanupHookNamespace(directory: string, limit = 4096): { removed: number; complete: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new Error('Invalid cleanup budget');
  privateDirectory(directory);
  const dir = opendirSync(directory);
  let removed = 0;
  try {
    for (;;) {
      if (removed === limit) return { removed, complete: false };
      const entry = dir.readSync();
      if (!entry) return { removed, complete: true };
      if (
        !entry.isFile() ||
        !(/^[a-f0-9]{64}\.(json|seen|conflict)$/.test(entry.name) || /^\.[a-f0-9-]{36}\.tmp$/.test(entry.name))
      )
        throw new Error('Unexpected hook namespace entry');
      unlinkSync(join(directory, entry.name));
      removed++;
    }
  } finally {
    dir.closeSync();
  }
}

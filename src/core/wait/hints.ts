import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';

/** The caller supplies its already verified HUD_HOME; writers never infer one. */
export function hintDirectory(home: string): string {
  return join(home, 'hints');
}

/** Best-effort post-commit signal. Directory creation belongs to worker startup,
 * so this path performs only an exclusive create and close, with no ledger read.
 * Recovery reads rediscover committed events if either operation fails.
 */
export function touchHint(home: string, runId: string, seq: number): void {
  if (!home || !/^[A-Za-z0-9_-]+$/.test(runId) || !Number.isSafeInteger(seq) || seq < 1) return;
  let fd: number | undefined;
  try {
    fd = openSync(
      join(hintDirectory(home), `${runId}.${seq}`),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    );
  } catch {
    return;
  }
  try {
    closeSync(fd);
  } catch {
    // A hint cannot turn a committed report or transition into a failed call.
  }
}

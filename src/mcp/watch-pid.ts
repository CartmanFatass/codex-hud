import { readFileSync } from 'node:fs';
import { isProcAlive, isValidPid, readProcCmdline } from '../utils/proc.js';

/** A ready marker belongs to another live watcher from this installation. */
export function watcherReady(pidFile: string, script: string): boolean {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return isValidPid(pid) && pid !== process.pid && isProcAlive(pid) &&
      (readProcCmdline(pid)?.includes(script) ?? false);
  } catch { return false; }
}

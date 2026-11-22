import { readFileSync } from 'node:fs';

/** A ready marker belongs to another live watcher from this installation. */
export function watcherReady(pidFile: string, script: string): boolean {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid &&
      readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(script);
  } catch { return false; }
}

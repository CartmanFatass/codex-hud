import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { binScript } from './paths.js';
import { isProcAlive, isValidPid, readProcCmdline } from '../utils/proc.js';

export function ensureJobWatcher(home: string) {
  mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
  const script = binScript('hud-watch');
  if (watcherReady(join(home, 'watch.pid'), script)) return;
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', env: { ...process.env, HUD_HOME: home } });
  child.on('error', (error) => console.error(`hud-watch: ${error.message}`));
  child.unref();
}

/** A ready marker belongs to another live watcher from this installation. */
export function watcherReady(pidFile: string, script: string): boolean {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return isValidPid(pid) && pid !== process.pid && isProcAlive(pid) &&
      (readProcCmdline(pid)?.includes(script) ?? false);
  } catch { return false; }
}

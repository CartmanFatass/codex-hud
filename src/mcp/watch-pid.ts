import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { binScript } from './paths.js';
import { v8HeapArgs } from '../../scripts/dist-lock.mjs';
import { isProcAlive, isValidPid, readProcCmdline } from '../utils/proc.js';

export function ensureJobWatcher(home: string) {
  mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
  const script = binScript('hud-watch');
  if (watcherReady(join(home, 'watch.pid'), script)) return;
  const env = { ...process.env, HUD_HOME: home };
  const child = spawn(process.execPath, [...v8HeapArgs('watch', env), script], { detached: true, stdio: 'ignore', env });
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

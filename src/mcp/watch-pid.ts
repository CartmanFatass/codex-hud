import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { binScript } from './paths.js';
import { v8HeapArgs } from '../../scripts/dist-lock.mjs';
import { isProcAlive, isValidPid, readProcCmdline } from '../utils/proc.js';

const launching = new Map<string, ReturnType<typeof spawn>>();

export function ensureJobWatcher(home: string, needed = () => true) {
  const script = binScript('hud-watch');
  if (launching.has(home) || watcherReady(join(home, 'watch.pid'), script) || !needed()) return;
  mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
  const env = { ...process.env, HUD_HOME: home };
  const child = spawn(process.execPath, [...v8HeapArgs('watch', env), script], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
  });
  launching.set(home, child);
  const clear = () => { if (launching.get(home) === child) launching.delete(home); };
  child.once('message', clear); // Ready; don't suppress a new launch during this watcher's later exit.
  child.once('exit', clear);
  child.once('error', (error) => { clear(); console.error(`hud-watch: ${error.message}`); });
  child.channel?.unref();
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

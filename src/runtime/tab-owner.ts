import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isActiveProcState, isValidPid, procStat, readProcEnviron } from '../utils/proc.js';

/** Herdr supplies pane/tab IDs; HUD supplies the job directory on pane creation.
 * Bracket the env read with start ticks so it cannot stamp a recycled PID. */
export function tabProcessStart(task: string, pane: string, tab: string, pid: unknown, launch?: string) {
  if (!isValidPid(pid)) return null;
  const before = procStat(pid), env = readProcEnviron(pid);
  if (!before || !env?.HUD_JOB_DIR || !isAbsolute(env.HUD_JOB_DIR) || env.HERDR_PANE_ID !== pane || env.HERDR_TAB_ID !== tab || env.HUD_TAB_LAUNCH !== launch) return null;
  try { if (realpathSync(env.HUD_JOB_DIR) !== task) return null; } catch { return null; }
  const after = procStat(pid);
  return after?.start === before.start && isActiveProcState(after.state) ? after.start : null;
}

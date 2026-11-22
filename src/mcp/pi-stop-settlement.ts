import * as fs from 'node:fs';
import { writePrivateFile } from '../utils/atomic-fs.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';

/** A Pi worker can exit without publishing its shutdown status. Don't replace a live writer. */
export function settleStoppedPi(statusFile: string, status: Record<string, unknown> | null) {
  if (!status || !workerTreeRootGone(status.pid, status.pid_start_time)) return null;
  // Preserve a terminal write made just before exit, and don't settle a replacement worker.
  let latest: (Record<string, unknown> & { state?: string }) | null;
  try { latest = JSON.parse(fs.readFileSync(statusFile, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!latest || latest.pid !== status.pid || latest.pid_start_time !== status.pid_start_time) return null;
  if (['closed', 'failed', 'stopped'].includes(latest.state ?? '')) return latest;
  if (!fs.existsSync(`${statusFile}.stop-requested`)) return null;
  const now = new Date().toISOString();
  const stopped = { ...latest, state: 'stopped', reason: null, blocked: false, idle_deadline_at: null,
    ended_at: now, exit_reason: 'stop requested', error: null, updated_at: now };
  writePrivateFile(statusFile, JSON.stringify(stopped) + '\n');
  return stopped;
}

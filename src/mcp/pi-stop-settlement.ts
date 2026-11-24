import * as fs from 'node:fs';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import type { JobStatus } from './job-contracts.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';

export const piTurnUnfinished = (status: Partial<JobStatus>) =>
  status.state === 'working' || status.state?.startsWith('waiting');

/** A Pi worker can exit without publishing its shutdown status. Don't replace a live writer. */
export function settleStoppedPi(statusFile: string, status: Partial<JobStatus> | null, paneGone = false) {
  if (!status || !workerTreeRootGone(status.pid, status.pid_start_time)) return null;
  // Preserve a terminal write made just before exit, and don't settle a replacement worker.
  let latest: Partial<JobStatus> | null;
  try { latest = readJsonFile(statusFile) as Partial<JobStatus> | null; }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!latest || latest.pid !== status.pid || latest.pid_start_time !== status.pid_start_time) return null;
  if (['closed', 'failed', 'stopped'].includes(latest.state ?? '')) return latest;
  const requested = fs.existsSync(`${statusFile}.stop-requested`);
  if (!requested && !(paneGone && piTurnUnfinished(latest))) return null;
  const now = new Date().toISOString();
  const stopped: JobStatus = { ...latest, state: 'stopped', reason: null, blocked: false, idle_deadline_at: null,
    ended_at: now, exit_reason: requested ? 'stop requested' : 'process exited without a report', error: null, updated_at: now };
  writePrivateFile(statusFile, JSON.stringify(stopped) + '\n');
  return stopped;
}

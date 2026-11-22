import * as fs from 'node:fs';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import type { JobStatus } from './job-contracts.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';

/** A Pi worker can exit without publishing its shutdown status. Don't replace a live writer. */
export function settleStoppedPi(statusFile: string, status: Partial<JobStatus> | null) {
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
  if (!fs.existsSync(`${statusFile}.stop-requested`)) return null;
  const now = new Date().toISOString();
  const stopped: JobStatus = { ...latest, state: 'stopped', reason: null, blocked: false, idle_deadline_at: null,
    ended_at: now, exit_reason: 'stop requested', error: null, updated_at: now };
  writePrivateFile(statusFile, JSON.stringify(stopped) + '\n');
  return stopped;
}

import * as fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { cliKinds } from '../roles/cli-kinds.js';
import { REPORT_SETTLED_EXIT } from './cli-judge.js';
import type { Job, JobStatus } from './job-contracts.js';

export const DEFAULT_RESUME_S = 1620;
export type NativeResume = { id: string; file?: string; message: string };

export function closedReport(job: Job, status: Partial<JobStatus> | null) {
  return job.resume_s !== undefined && !job.bro && !job.jev && status?.state === 'closed' && status.output_written === true &&
    (status.exit_reason === REPORT_SETTLED_EXIT || (!job.cli && status.exit_reason === 'settled'));
}

export function resumeDeadline(job: Job, status: Partial<JobStatus>) {
  if (!closedReport(job, status) || !job.resume_s || job.worktree_removed_at) return null;
  const ended = Date.parse(status.ended_at ?? status.settled_at ?? '');
  return Number.isFinite(ended) ? ended + job.resume_s * 1000 : null;
}

/** The native launcher must still confirm it opened this exact identity before any input. */
export function resumeIdentity(job: Job, status: JobStatus): Omit<NativeResume, 'message'> | null {
  if (job.cli) {
    const id = status.agent_session_id;
    return cliKinds[job.cli.agent]?.resume && id && /^[\w][\w.-]{0,127}$/.test(id) ? { id } : null;
  }
  const id = status.session_id, file = status.session_file;
  const native = piSessionIdentity(job, file);
  return id && native?.id === id ? native : null;
}

/** Read pi's own header, never the model's JSON output. */
export function piSessionIdentity(job: Job, file: string | null | undefined): Omit<NativeResume, 'message'> | null {
  if (!file || !isAbsolute(file)) return null;
  try {
    const path = fs.realpathSync(file);
    const { bytes } = readFileBounded(path, 64 * 1024);
    const head = JSON.parse(bytes.toString('utf8').split('\n', 1)[0]);
    if (head.type === 'session' && typeof head.id === 'string' && head.id && typeof head.cwd === 'string' &&
        isAbsolute(head.cwd) && fs.realpathSync(head.cwd) === fs.realpathSync(job.cwd)) return { id: head.id, file: path };
  } catch { /* Missing or unreadable native session: the caller will repair instead. */ }
  return null;
}

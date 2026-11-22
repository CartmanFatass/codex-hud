import * as fs from 'node:fs';
import { join } from 'node:path';
import { reportWasRead } from '../collectors/thin-jobs.js';
import { reportSignature } from '../roles/cli-turn.js';
import type { Job, JobStatus, SendOutcome } from './job-contracts.js';
import { jobFiles } from './paths.js';
export type { SendOutcome } from './job-contracts.js';

type SendHistory = Pick<Job, 'send_outcomes' | 'message_keys'>;

export function sendHistory(job: SendHistory): (SendOutcome | { key: string; legacy: true })[] {
  return [...(job.send_outcomes ?? []), ...(job.message_keys ?? []).map((key) => ({ key, legacy: true as const }))];
}

/** The report that was read must belong to the current, settled Pi turn. */
export function piReadSettlement(dir: string, job: SendHistory & Partial<Pick<Job,
  'read_at' | 'created_at' | 'pi_sent_at' | 'cli' | 'bro' | 'jev'>>, status: Pick<JobStatus, 'output_written' | 'settled_at'> | null) {
  if (status?.output_written !== true || typeof status.settled_at !== 'string' ||
      !job.read_at || job.cli || job.bro || job.jev || job.send_outcomes?.at(-1)?.exit_code === null) return null;
  // Legacy jobs with sends have no reliable turn boundary.
  const sentAt = job.pi_sent_at ?? (sendHistory(job).length ? undefined : job.created_at);
  const sent = Date.parse(sentAt ?? ''), settled = Date.parse(status.settled_at);
  if (!(settled >= sent && Date.parse(job.read_at) > sent)) return null;
  const report = fs.statSync(join(dir, jobFiles.report), { throwIfNoEntry: false });
  if (!report?.isFile() || Math.floor(report.mtimeMs) <= sent || Math.floor(report.mtimeMs) > settled ||
      !reportWasRead(job.read_at, report.mtimeMs)) return null;
  const sig = reportSignature(dir);
  return sig ? JSON.stringify([sentAt, status.settled_at, sig]) : null;
}

import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileStampOf, statsMtimeMs } from '../roles/job-index-cache.js';
import { reportWasRead } from '../collectors/thin-jobs.js';
import { reportSignature } from '../roles/cli-turn.js';
import type { Job, JobStatus, SendOutcome } from './job-contracts.js';
import { jobFiles } from './paths.js';
export type { SendOutcome } from './job-contracts.js';

type SendHistory = Pick<Job, 'send_outcomes' | 'message_keys'>;

export function sendHistory(job: SendHistory): (SendOutcome | { key: string; legacy: true })[] {
  return [...(job.send_outcomes ?? []), ...(job.message_keys ?? []).map((key) => ({ key, legacy: true as const }))];
}

/** Fresh native Pi settlement for this turn. Pre-upgrade jobs still require a read. */
export function piReportSettlement(dir: string, job: SendHistory & Partial<Pick<Job,
  'read_at' | 'read_report_stamp' | 'created_at' | 'pi_sent_at' | 'cli' | 'bro' | 'jev' | 'resume_s'>>, status: Pick<JobStatus, 'output_written' | 'settled_at'> | null) {
  const legacy = job.resume_s === undefined;
  if (status?.output_written !== true || typeof status.settled_at !== 'string' ||
      job.cli || job.bro || job.jev || (legacy && !job.read_at)) return null;
  // Legacy jobs with sends have no reliable turn boundary.
  const sentAt = job.pi_sent_at ?? (sendHistory(job).length ? undefined : job.created_at);
  const sent = Date.parse(sentAt ?? ''), settled = Date.parse(status.settled_at);
  const pending = job.send_outcomes?.at(-1);
  if (pending?.exit_code === null && (!pending.resumed || !job.pi_sent_at)) return null;
  if (!(settled >= sent) || (legacy && !(Date.parse(job.read_at!) > sent))) return null;
  const report = fs.statSync(join(dir, jobFiles.report), { bigint: true, throwIfNoEntry: false });
  if (!report?.isFile()) return null;
  const mtime = statsMtimeMs(report.mtimeNs);
  if ((legacy ? Math.floor(mtime) : mtime) <= sent || Math.floor(mtime) > settled ||
      (legacy && !reportWasRead(job, mtime, fileStampOf(report)))) return null;
  const sig = reportSignature(dir);
  return sig ? JSON.stringify([sentAt, status.settled_at, sig]) : null;
}

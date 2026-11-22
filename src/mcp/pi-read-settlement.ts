import * as fs from 'node:fs';
import { join } from 'node:path';
import { reportWasRead } from '../collectors/thin-jobs.js';
import { reportSignature } from '../roles/cli-turn.js';

export type SendOutcome = { key: string; derived_key?: string; recorded_at?: string; exit_code: number | null; stderr_tail: string };
type SendHistory = { send_outcomes?: SendOutcome[]; message_keys?: string[] };

export function sendHistory(job: SendHistory): (SendOutcome | { key: string; legacy: true })[] {
  return [...(job.send_outcomes ?? []), ...(job.message_keys ?? []).map((key) => ({ key, legacy: true as const }))];
}

/** The report that was read must belong to the current, settled Pi turn. */
export function piReadSettlement(dir: string, job: SendHistory & {
  read_at?: string; created_at?: string; pi_sent_at?: string; cli?: unknown; bro?: unknown; jev?: unknown;
}, status: { output_written?: unknown; settled_at?: unknown } | null) {
  if (status?.output_written !== true || typeof status.settled_at !== 'string' ||
      !job.read_at || job.cli || job.bro || job.jev || job.send_outcomes?.at(-1)?.exit_code === null) return null;
  // Legacy jobs with sends have no reliable turn boundary.
  const sentAt = job.pi_sent_at ?? (sendHistory(job).length ? undefined : job.created_at);
  const sent = Date.parse(sentAt ?? ''), settled = Date.parse(status.settled_at);
  if (!(settled >= sent && Date.parse(job.read_at) > sent)) return null;
  const report = fs.statSync(join(dir, 'report.md'), { throwIfNoEntry: false });
  if (!report?.isFile() || Math.floor(report.mtimeMs) <= sent || Math.floor(report.mtimeMs) > settled ||
      !reportWasRead(job.read_at, report.mtimeMs)) return null;
  const sig = reportSignature(dir);
  return sig ? JSON.stringify([sentAt, status.settled_at, sig]) : null;
}

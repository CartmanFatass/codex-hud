import * as fs from 'node:fs';
import { join } from 'node:path';
import { JOB_ID_RE, type JobIndexCache } from '../roles/job-index-cache.js';
import { readReportMeta } from '../roles/report-meta.js';
import { readFileBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { firstReportProse } from '../utils/report-summary.js';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';

export const synthesisTemplate =
  'Write one converged plan for the original brief using the independent member reports. Include a table of disagreements: point; each member’s position; the choice; why. List open questions for the owner. Where members disagree on a fact the original attachments would settle, list it under open questions for the main session to check, naming the file if a member cited one. Do no new work beyond the plan.';

export const MAIN_COUNCIL_COLLECTED_REASON = 'members collected by main';

const RESULT_HEAD_BYTES = 2048;
const TERMINAL_STATES = new Set(['closed', 'done', 'failed', 'stopped']);
const SETTLED_STATES = new Set(['idle_grace', 'done', 'closed', 'failed', 'stopped']);

function digestLine(text: string, budget: number) {
  let line = '';
  for (const ch of text.trim()) {
    budget -= Buffer.byteLength(JSON.stringify(ch)) - 2;
    if (budget < 0) return line + '…';
    line += ch;
  }
  return line;
}

function fallbackResultLine(text: string) {
  const head = Buffer.from(text.slice(0, RESULT_HEAD_BYTES)).subarray(0, RESULT_HEAD_BYTES).toString('utf8');
  return (firstReportProse(head) ?? 'Report ready').slice(0, 240);
}

function readJson<T>(cache: JobIndexCache, file: string): T | null {
  const res = cache.readJson<T>(file);
  if (res.status === 'ok') return res.value;
  if (res.status === 'missing' || res.status === 'invalid') return null;
  if (res.status === 'truncated') {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
    catch { return null; }
  }
  return null;
}

function hasReason(status: JobStatus): boolean {
  return Boolean(
    (typeof status.reason === 'string' && status.reason.trim()) ||
    (typeof status.exit_reason === 'string' && status.exit_reason.trim())
  );
}

export interface SettleMainCouncilOptions {
  trigger: 'read' | 'watcher';
  activeFlow?: boolean;
  now?: string;
}

/** Settle an open synthesizer:main council once every member has settled, or record main's collection on a closed one that has no reason yet. */
export function settleMainCouncil(
  home: string,
  cache: JobIndexCache,
  id: string,
  options: SettleMainCouncilOptions
): { job: Job; status: JobStatus } | null {
  const jobsDir = join(home, 'jobs');
  const dir = join(jobsDir, id);
  const jobFile = join(dir, jobFiles.job);
  const statusFile = join(dir, jobFiles.status);
  const rawJob = readJson<Job>(cache, jobFile);
  if (!rawJob || rawJob.role !== 'council' || rawJob.synthesizer !== 'main' ||
      !Array.isArray(rawJob.council_members) || rawJob.council_members.length === 0) {
    return null;
  }
  const status = readJson<JobStatus>(cache, statusFile);
  if (status?.state === 'closed') {
    if (options.trigger !== 'read' || hasReason(status)) return null;
    const nextStatus: JobStatus = {
      ...status,
      reason: MAIN_COUNCIL_COLLECTED_REASON,
      exit_reason: MAIN_COUNCIL_COLLECTED_REASON,
    };
    cache.writeJsonAtomic(statusFile, nextStatus as unknown as Record<string, unknown>, { mkdir: false });
    return { job: rawJob, status: nextStatus };
  }
  if (TERMINAL_STATES.has(status?.state ?? '')) return null;

  const updatedMembers: NonNullable<Job['council_members']> = [];
  let reportedCount = 0;
  let readCount = 0;
  let latestMemberReadAt: string | undefined;

  for (const member of rawJob.council_members) {
    if (member.failure) {
      updatedMembers.push({ ...member });
      continue;
    }
    if (typeof member.job !== 'string' || !JOB_ID_RE.test(member.job)) return null;
    const memberDir = join(jobsDir, member.job);
    const memberJob = readJson<Job>(cache, join(memberDir, jobFiles.job));
    const memberStatus = readJson<JobStatus>(cache, join(memberDir, jobFiles.status));
    if (!memberJob && !memberStatus && !fs.existsSync(memberDir)) {
      if (member.digest !== undefined) {
        reportedCount++;
        updatedMembers.push({ ...member });
        continue;
      }
      updatedMembers.push({ ...member, failure: digestLine('child receipt disappeared', 400) });
      continue;
    }
    const memberState =
      memberStatus?.state ??
      (memberJob && typeof memberJob.dispatch_exit_code === 'number' && memberJob.dispatch_exit_code !== 0 ? 'failed' : null);
    if (!SETTLED_STATES.has(memberState ?? '')) return null;

    if (memberState === 'failed' || memberState === 'stopped') {
      const reason = memberStatus?.exit_reason ?? memberStatus?.error ?? memberStatus?.reason ?? memberState;
      updatedMembers.push({ ...member, failure: digestLine(String(reason), 400) });
      continue;
    }
    const memberReport = cache.readReportStat(memberDir);
    if (!memberReport.present) {
      updatedMembers.push({ ...member, failure: digestLine('settled without a report', 400) });
      continue;
    }
    reportedCount++;
    let digest = member.digest;
    if (digest === undefined) {
      try {
        digest =
          readReportMeta(memberDir)?.summary ??
          fallbackResultLine(readFileBounded(join(memberDir, jobFiles.report), RESULT_HEAD_BYTES).bytes.toString('utf8'));
      } catch {
        digest = 'Report ready';
      }
    }
    if (typeof memberJob?.read_at === 'string' && memberJob.read_at.length > 0) {
      readCount++;
      if (!latestMemberReadAt || memberJob.read_at > latestMemberReadAt) latestMemberReadAt = memberJob.read_at;
    }
    updatedMembers.push({ ...member, digest });
  }

  if (options.trigger === 'watcher') {
    const parentRead = typeof rawJob.read_at === 'string' && rawJob.read_at.length > 0;
    const membersRead = !options.activeFlow && reportedCount > 0 && readCount === reportedCount;
    if (!parentRead && !membersRead) return null;
  }

  const now = options.now ?? new Date().toISOString();
  const roster = updatedMembers
    .map((m, i) => `Member ${i + 1} (${m.preset}${m.job ? `, ${m.job}` : ''}): ${m.failure ? `failed — ${m.failure}` : 'report available'}`)
    .join('\n');

  if (reportedCount < 2) {
    const updatedJob: Job = { ...rawJob, council_members: updatedMembers };
    const nextStatus: JobStatus = {
      state: 'failed',
      exit_reason: `Fewer than two member reports. ${roster}`,
      ended_at: status?.ended_at ?? now,
    };
    cache.writeJsonAtomic(jobFile, updatedJob as unknown as Record<string, unknown>, { indent: 2, mkdir: false });
    cache.writeJsonAtomic(statusFile, nextStatus as unknown as Record<string, unknown>, { mkdir: false });
    return { job: updatedJob, status: nextStatus };
  }

  const reportPath = join(dir, jobFiles.report);
  if (!fs.existsSync(reportPath)) {
    let task = '';
    try {
      const briefText = fs.readFileSync(join(dir, jobFiles.brief), 'utf8');
      task = typeof rawJob.task_length === 'number' ? briefText.slice(0, rawJob.task_length) : briefText;
    } catch { /* Missing brief: still emit synthesis template and member roster. */ }
    writePrivateFile(reportPath, `${synthesisTemplate}\n\nOriginal brief:\n${task}\n\n${roster}`, { mkdir: false });
  }
  const reportStamp = cache.readReportStat(dir).stamp;
  const updatedJob: Job = {
    ...rawJob,
    council_members: updatedMembers,
    ...(options.trigger === 'watcher'
      ? {
          read_at: rawJob.read_at ?? latestMemberReadAt ?? now,
          ...(reportStamp ? { read_report_stamp: reportStamp } : {}),
        }
      : {}),
  };
  const nextStatus: JobStatus = {
    state: 'closed',
    reason: MAIN_COUNCIL_COLLECTED_REASON,
    exit_reason: MAIN_COUNCIL_COLLECTED_REASON,
    output_written: true,
    settled_at: status?.settled_at ?? now,
    ended_at: status?.ended_at ?? now,
  };
  cache.writeJsonAtomic(jobFile, updatedJob as unknown as Record<string, unknown>, { indent: 2, mkdir: false });
  cache.writeJsonAtomic(statusFile, nextStatus as unknown as Record<string, unknown>, { mkdir: false });
  return { job: updatedJob, status: nextStatus };
}

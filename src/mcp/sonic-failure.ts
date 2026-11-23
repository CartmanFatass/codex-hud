/** Best-effort evidence when the runner itself dies, distinct from the harness's exit receipt. */
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { readFileBounded, readJsonBounded, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';

export const missingRunnerReceipt = 'sonic runner exited without an exit receipt';
type Identity = Pick<JobStatus, 'pid' | 'pid_start_time' | 'boot_id'>;
type Death = Identity & { code: number | null; signal: NodeJS.Signals | null };
const sameRunner = (a: Identity, b: Identity) => a.pid === b.pid && a.pid_start_time === b.pid_start_time && a.boot_id === b.boot_id;

export function recordRunnerDeath(dir: string, id: Identity, code: number | null, signal: NodeJS.Signals | null) {
  try {
    if (fs.existsSync(join(dir, jobFiles.sonicExit))) return;
    if (!sameRunner(id, readJsonBounded(join(dir, jobFiles.status), 8192) as JobStatus)) return;
    writeJsonPrivate(join(dir, jobFiles.runnerDeath), { ...id, code, signal }, { mkdir: false });
  } catch { /* Retention, a replaced turn, or a failed write must not bring down the launcher. */ }
}

// A short-lived launcher may already have exited. Record what we can before the default termination.
export function observeOwnExit(dir: string, status: JobStatus) {
  const id = { pid: process.pid, pid_start_time: status.pid_start_time, boot_id: status.boot_id };
  process.once('exit', code => recordRunnerDeath(dir, id, code, null));
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(signal, () => {
    recordRunnerDeath(dir, id, null, signal);
    process.kill(process.pid, signal);
  });
}

export function parentStartedAt(dir: string, job: Job) {
  if (!job.parent_job || !/^j[0-9a-f]{16}$/.test(job.parent_job)) return;
  try {
    const parent = readJsonBounded(join(dirname(dir), job.parent_job, jobFiles.status), 8192) as JobStatus;
    if (parent.started_at && Number.isFinite(Date.parse(parent.started_at))) return parent.started_at;
  } catch { /* No comparable parent turn. */ }
}

function tail(path: string, limit: number) {
  try {
    const offset = Math.max(0, fs.lstatSync(path).size - limit);
    return readFileBounded(path, limit, { offset }).bytes.toString('utf8');
  } catch { return null; }
}

function recoverPartialReport(dir: string) {
  const path = join(dir, jobFiles.report);
  if (fs.existsSync(path)) return;
  const session = tail(join(dir, jobFiles.sonicSession), 256 * 1024);
  if (!session) return;
  const text: string[] = [];
  for (const line of session.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // A cut first line or an interrupted append.
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const content = entry.message.content;
    if (typeof content === 'string') text.push(content);
    else if (Array.isArray(content)) for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
    }
  }
  const excerpt = text.join('\n\n').trim().slice(-8192);
  if (excerpt) try { writePrivateFile(path, `# Partial sonic report\n\n${excerpt}\n`, { exclusive: true, mkdir: false }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export function missingRunnerEvidence(dir: string, job: Job, status: Partial<JobStatus>) {
  let death;
  try {
    const record = readJsonBounded(join(dir, jobFiles.runnerDeath), 1024) as Death;
    if (sameRunner(status, record)) death = record;
  } catch { /* SIGKILL after launcher loss leaves no wait status; do not guess. */ }
  if (status.slot === 'sonic') recoverPartialReport(dir);
  const restart = status.parent_started_at && Date.parse(parentStartedAt(dir, job) ?? '') > Date.parse(status.parent_started_at);
  return { runner_exit_code: death?.code ?? null, runner_exit_signal: death?.signal ?? null,
    stderr_tail: tail(join(dir, jobFiles.sonicStderr), 1024), ...(restart && { exit_reason: `${missingRunnerReceipt}: parent session restarted` }) };
}

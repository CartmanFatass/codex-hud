import * as fs from 'node:fs';
import { join } from 'node:path';
import { readJsonBounded, writePrivateFile } from '../utils/atomic-fs.js';
import type { JobStatus, SendOutcome } from './job-contracts.js';
import { jobFiles } from './paths.js';

const LIMIT = 64 * 1024;
const queueFile = (dir: string) => join(dir, jobFiles.headlessSends);
export const hasHeadlessSends = (dir: string) => fs.existsSync(queueFile(dir));
export const clearHeadlessSends = (dir: string) => fs.rmSync(queueFile(dir), { force: true });
export type HeadlessSend = SendOutcome & { text: string };

// Queue mutations share the job directory's reopen lock.
export function readHeadlessSends(dir: string): HeadlessSend[] {
  try { return readJsonBounded(queueFile(dir), LIMIT) as HeadlessSend[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function writeHeadlessSends(dir: string, sends: HeadlessSend[]) {
  const body = JSON.stringify(sends);
  if (Buffer.byteLength(body) > LIMIT) return false;
  writePrivateFile(queueFile(dir), body, { mkdir: false });
  return true;
}

export const noHeadlessReport = (agent = 'pi') => `${agent} exited without a declared report`;
export function headlessFollowupReady(status: Partial<JobStatus> | null) {
  return status?.slot === 'headless' && (status.state === 'closed' ||
    (status.state === 'failed' && status.exit_reason === noHeadlessReport(status.agent)));
}

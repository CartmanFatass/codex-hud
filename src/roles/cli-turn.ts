import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, readJsonBounded } from '../utils/atomic-fs.js';
import { jobFiles } from '../mcp/paths.js';
import type { Turn, DoneReceipt } from '../mcp/job-contracts.js';
export type { Turn, DoneReceipt } from '../mcp/job-contracts.js';

export function reportSignature(dir: string): string | null {
  try {
    const file = join(dir, jobFiles.report);
    const body = fs.readFileSync(file);
    if (!body.toString('utf8').trim()) return null;
    return `${fs.statSync(file).mtimeMs}:${body.length}:${createHash('sha256').update(body).digest('hex')}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readTurn(dir: string): Turn | null {
  try {
    return readJsonFile(join(dir, jobFiles.turn)) as Turn;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const DONE_FILE = jobFiles.done;
export const receiptForTurn = (turn: Turn, done: DoneReceipt | null | undefined): done is DoneReceipt =>
  done?.seq === turn.seq && done.sent_at === turn.sent_at && typeof done.report_sig === 'string' &&
  done.report_sig !== turn.report_sig && Number.isFinite(Date.parse(done.at));
export const turnToken = (turn: Turn) => `${turn.seq}@${turn.sent_at}`;

export function readDone(dir: string): DoneReceipt | null {
  try {
    return readJsonBounded(join(dir, DONE_FILE), 1024) as DoneReceipt;
  } catch { return null; } // Missing or unreadable evidence does not authorize a close.
}

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, readJsonBounded } from '../utils/atomic-fs.js';

export interface Turn {
  seq: number;
  sent_at: string;
  report_sig: string | null;
  report_prompt_sent?: boolean;
  first_sent_at?: string;
  caller_token?: string; // HUD follow-ups keep the caller task but advance the report token.
  send?: { key: string; pid: number; start: string | null };
}

export function reportSignature(dir: string): string | null {
  try {
    const file = join(dir, 'report.md');
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
    return readJsonFile(join(dir, 'turn.json')) as Turn;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const DONE_FILE = 'done.json';
export type DoneReceipt = Pick<Turn, 'seq' | 'sent_at'> & { report_sig: string; at: string };
export const receiptForTurn = (turn: Turn, done: DoneReceipt | null | undefined): done is DoneReceipt =>
  done?.seq === turn.seq && done.sent_at === turn.sent_at && typeof done.report_sig === 'string' &&
  done.report_sig !== turn.report_sig && Number.isFinite(Date.parse(done.at));
export const turnToken = (turn: Turn) => `${turn.seq}@${turn.sent_at}`;

export function readDone(dir: string): DoneReceipt | null {
  try {
    return readJsonBounded(join(dir, DONE_FILE), 1024) as DoneReceipt;
  } catch { return null; } // Missing or unreadable evidence does not authorize a close.
}

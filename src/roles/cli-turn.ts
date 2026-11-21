import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';

export interface Turn {
  seq: number;
  sent_at: string;
  report_sig: string | null;
  report_prompt_sent?: boolean;
  first_sent_at?: string;
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
    return JSON.parse(fs.readFileSync(join(dir, 'turn.json'), 'utf8')) as Turn;
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
    const fd = fs.openSync(join(dir, DONE_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      return st.isFile() && st.size <= 1024 ? JSON.parse(fs.readFileSync(fd, 'utf8')) as DoneReceipt : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; } // Missing or unreadable evidence does not authorize a close.
}

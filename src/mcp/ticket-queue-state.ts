import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDirSafe, writeJsonPrivate } from '../utils/atomic-fs.js';

export const isTicketQueueId = (id: unknown): id is string => typeof id === 'string' && /^q[0-9a-f]{16}$/.test(id);
export const queueFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export const queueIds = (home: string) => readDirSafe(join(home, 'flows')).filter(file => file.endsWith('.json'))
  .map(file => file.slice(0, -5)).filter(isTicketQueueId);

export interface TicketQueueItem {
  ticket: string; path: string; role: 'imp' | 'frontend-imp'; job?: string; land?: string; landed?: true;
}
export interface TicketQueue {
  flow: string; root: string; feature: string; pane: string; task: boolean; max_parallel: number;
  created_at: string; updated_at: string; pid?: number; start?: string;
  state: 'working' | 'completed' | 'failed' | 'cancelled'; tickets: TicketQueueItem[];
  reason?: string; remaining?: string[];
}
export function readTicketQueue(home: string, id: string): TicketQueue | null {
  if (!isTicketQueueId(id)) return null;
  try { return JSON.parse(fs.readFileSync(queueFile(home, id), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function writeTicketQueue(home: string, q: TicketQueue, create = false) {
  q.updated_at = new Date().toISOString();
  writeJsonPrivate(queueFile(home, q.flow), q, { mkdir: false, exclusive: create });
}
export function cancelTicketQueue(home: string, q: TicketQueue) {
  if (q.state === 'working') fs.closeSync(fs.openSync(`${queueFile(home, q.flow)}.cancel`, 'a', 0o600));
}
export const queueCancelled = (home: string, q: TicketQueue) => fs.existsSync(`${queueFile(home, q.flow)}.cancel`);
export function ticketQueueView(q: TicketQueue) {
  const { flow, feature, state, reason, remaining, max_parallel } = q;
  return { flow, feature, state, reason, remaining, ...(max_parallel && { max_parallel }),
    landed: q.tickets.filter(item => item.landed).map(item => item.ticket),
    jobs: q.tickets.map(({ ticket, job, land }) => ({ ticket, job, land })) };
}
export function ticketQueueNotice(q: TicketQueue) {
  const { landed } = ticketQueueView(q);
  return `${q.flow} (ticket queue ${q.feature}) — ${q.reason ?? q.state}. Landed: ${landed.join(', ') || 'none'}.` +
    (q.state === 'completed' ? '' : ` Still running: ${q.remaining?.join(', ') || 'none'}.`);
}
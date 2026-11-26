import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDirSafe, writeJsonPrivate } from '../utils/atomic-fs.js';
import type { Cursor } from '../workflows/engine.js';
import type { RunScope } from '../workflows/scope.js';
import { requestStop, stopRequested } from '../workflows/store.js';
import type { Job } from './job-contracts.js';

export const isTicketQueueId = (id: unknown): id is string => typeof id === 'string' && /^q[0-9a-f]{16}$/.test(id);
export const queueFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export const queueIds = (home: string) => readDirSafe(join(home, 'flows')).filter(file => file.endsWith('.json'))
  .map(file => file.slice(0, -5)).filter(isTicketQueueId);

export type TicketHandbackKind = 'question' | 'blocker' | 'check' | 'review' | 'land' | 'worker' | 'dispatch' | 'queue';
export interface TicketHandback {
  step: string; choices: string[]; kind?: TicketHandbackKind;
  ticket?: string; job?: string; question?: string; land?: string;
}
export interface TicketQueueItem {
  ticket: string; path: string; role: 'imp' | 'frontend-imp'; job?: string; land?: string; landed?: true; base_moves?: number;
  dispatch_queue?: string; // Keep the original worker request key across explicit resumes.
}
export interface TicketQueue extends RunScope {
  flow: string; root: string; cwd?: string; feature: string; pane: string; task: boolean; max_parallel: number;
  created_at: string; updated_at: string; pid?: number; start?: string;
  template?: 'ticket-queue'; host?: 'detached'; cost?: 'cheap' | 'costly'; cost_reasons?: string[];
  steps?: Record<string, Cursor>;
  epoch?: number; settled?: number; streak?: number; failures?: number;
  notices?: Record<string, string>;
  handback?: TicketHandback;
  state: 'working' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'stopped'; tickets: TicketQueueItem[];
  reason?: string; remaining?: string[]; queued?: { ticket: string; blockers: string[] }[];
  dispatcher?: Job['dispatcher'];
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
  if (q.state === 'working') requestStop(home, q.flow);
}
export const queueCancelled = (home: string, q: TicketQueue) => stopRequested(home, q.flow);
export function ticketQueueView(q: TicketQueue) {
  const { flow, feature, state, remaining, queued, max_parallel } = q;
  const reason = q.reason ?? (queued?.length ? `Queued: ${queued.map(({ ticket, blockers }) => `${ticket} waiting on ${blockers.join(', ')}`).join('; ')}` : undefined);
  const base_moves = q.tickets.reduce((total, item) => total + (item.base_moves ?? 0), 0);
  return { flow, feature, state, reason, remaining, ...(queued?.length && { queued }), ...(max_parallel && { max_parallel }), ...(base_moves && { base_moves }),
    landed: q.tickets.filter(item => item.landed).map(item => item.ticket),
    jobs: q.tickets.map(({ ticket, job, land }) => ({ ticket, job, land })) };
}
export function ticketQueueNotice(q: TicketQueue) {
  const { landed, base_moves, reason } = ticketQueueView(q);
  return `${q.flow} (ticket queue ${q.feature}) — ${reason ?? q.state}. Landed: ${landed.join(', ') || 'none'}.` +
    (base_moves ? ` Base moves absorbed: ${base_moves}.` : '') +
    (q.state === 'completed' ? '' : ` Still running: ${q.remaining?.join(', ') || 'none'}.`);
}
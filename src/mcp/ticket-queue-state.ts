import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDirSafe, writeJsonPrivate } from '../utils/atomic-fs.js';
import type { Cursor } from '../workflows/engine.js';
import type { RunScope } from '../workflows/scope.js';
import { requestStop, stopRequested } from '../workflows/store.js';
import type { Job } from './job-contracts.js';
import type { OwnerApproval, UnattendedItem } from '../unattended/state.js';

export const isTicketQueueId = (id: unknown): id is string => typeof id === 'string' && /^q[0-9a-f]{16}$/.test(id);
export const queueFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export const queueIds = (home: string) => readDirSafe(join(home, 'flows')).filter(file => file.endsWith('.json'))
  .map(file => file.slice(0, -5)).filter(isTicketQueueId);

export type TicketHandbackKind = 'question' | 'blocker' | 'assumption' | 'escalate' | 'check' | 'review' | 'land' | 'worker' | 'dispatch' | 'queue';
export interface TicketHandback {
  step: string; choices: string[]; kind?: TicketHandbackKind;
  ticket?: string; job?: string; question?: string; land?: string; owner_approval?: OwnerApproval;
}
export interface RunTodoItem {
  source: string; kind: 'assumed' | 'lead'; text: string;
}
export interface RunDecision {
  step: string; kind: 'question' | 'accept'; job: string; decision: string; reason?: string; at: string;
  ticket?: string; question?: string;
}
export interface ActiveLead {
  job: string; kind: 'question' | 'accept' | 'preland'; step: string; round: number;
  ticket?: string; worker_job?: string; question?: string;
}
export interface ReviewRecord {
  round: number; job: string; summary?: string; findings?: Job['findings']; reviewed?: Job['reviewed'];
}
export interface TicketQueueItem {
  ticket: string; path: string; role: 'imp' | 'frontend-imp'; job?: string; land?: string; landed?: true; base_moves?: number;
  dispatch_queue?: string; // Keep the original worker request key across explicit resumes.
  approved_head?: string;
}
export interface TicketQueue extends RunScope {
  flow: string; root: string; cwd?: string; feature: string; pane: string; workspace?: string; task: boolean; max_parallel: number;
  created_at: string; updated_at: string; pid?: number; start?: string;
  start_head?: string;
  template?: 'ticket-queue'; host?: 'detached'; cost?: 'cheap' | 'costly'; cost_reasons?: string[];
  unattended?: UnattendedItem;
  handback_to?: 'lead' | 'main';
  escalation_rule?: string;
  lead_preset?: string;
  steps?: Record<string, Cursor>;
  epoch?: number; settled?: number; streak?: number; failures?: number;
  notices?: Record<string, string>;
  handback?: TicketHandback;
  repair_rounds?: number;
  todo?: RunTodoItem[];
  decisions?: RunDecision[];
  reviews?: ReviewRecord[];
  review_job?: string;
  active_lead?: ActiveLead;
  verdict?: string;
  pause_notice?: string;
  no_wake?: true;
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
  const { flow, feature, state, remaining, queued, max_parallel, verdict, todo, decisions, reviews, repair_rounds, handback, pause_notice } = q;
  const reason = q.reason ?? (queued?.length ? `Queued: ${queued.map(({ ticket, blockers }) => `${ticket} waiting on ${blockers.join(', ')}`).join('; ')}` : undefined);
  const base_moves = q.tickets.reduce((total, item) => total + (item.base_moves ?? 0), 0);
  return { flow, feature, state, reason, remaining, ...(queued?.length && { queued }), ...(max_parallel && { max_parallel }), ...(base_moves && { base_moves }),
    ...(verdict && { verdict }), ...(todo?.length && { todo }), ...(decisions?.length && { decisions }),
    ...(reviews?.length && { reviews }), ...(repair_rounds && { repair_rounds }),
    ...(handback && { handback }), ...(pause_notice && { pause_notice }),
    landed: q.tickets.filter(item => item.landed).map(item => item.ticket),
    jobs: q.tickets.map(({ ticket, job, land }) => ({ ticket, job, land })) };
}
export function ticketQueueNotice(q: TicketQueue) {
  const { landed, base_moves, reason } = ticketQueueView(q);
  const verdict = q.state === 'completed' && q.verdict ? ` Verdict: ${q.verdict.replace(/\.+$/, '')}.` : '';
  const todo = q.state === 'completed' && q.todo?.length ? ` Todo: ${q.todo.length}.` : '';
  return `${q.flow} (ticket queue ${q.feature}) — ${reason ?? q.state}. Landed: ${landed.join(', ') || 'none'}.` +
    verdict + todo +
    (base_moves ? ` Base moves absorbed: ${base_moves}.` : '') +
    (q.state === 'completed' ? '' : ` Still running: ${q.remaining?.join(', ') || 'none'}.`);
}
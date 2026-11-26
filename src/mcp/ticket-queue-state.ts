import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDirSafe, writeJsonPrivate } from '../utils/atomic-fs.js';
import type { Cursor } from '../workflows/engine.js';
import type { RunScope } from '../workflows/scope.js';
import { requestStop, stopRequested } from '../workflows/store.js';
import type { Job } from './job-contracts.js';
import type { OwnerApproval, UnattendedRun } from '../unattended/state.js';

export const isTicketQueueId = (id: unknown): id is string => typeof id === 'string' && /^q[0-9a-f]{16}$/.test(id);
export const queueFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export const queueIds = (home: string) => readDirSafe(join(home, 'flows')).filter(file => file.endsWith('.json'))
  .map(file => file.slice(0, -5)).filter(isTicketQueueId);

export type TicketHandbackKind = 'question' | 'blocker' | 'assumption' | 'escalate' | 'check' | 'review' | 'land' | 'worker' | 'dispatch' | 'queue';
export interface TicketHandback {
  step: string; choices: string[]; kind?: TicketHandbackKind;
  ticket?: string; job?: string; question?: string; land?: string; owner_approval?: OwnerApproval;
  assumption?: { head: string; report_sig: string };
}
export interface TicketItemHold {
  reason: string; at: string; kind?: TicketHandbackKind; owner_approval?: OwnerApproval;
  head?: string; report_sig?: string;
}
export interface TicketItemFailure {
  reason: string; at: string; kind?: TicketHandbackKind;
}
export interface RunTodoItem {
  source: string; kind: 'assumed' | 'lead'; text: string;
}
export interface RunDecision {
  step: string; kind: 'question' | 'accept' | 'ambiguity' | 'assumption'; job: string; decision: string; reason?: string; at: string;
  ticket?: string; question?: string; close_error?: string;
}
export interface ActiveLead {
  job: string; kind: 'question' | 'accept' | 'ambiguity' | 'assumption'; step: string; round: number;
  ticket?: string; worker_job?: string; question?: string;
  head?: string; report_sig?: string;
}
export interface PendingAnswerDelivery {
  step: string; worker_job: string; question: string; answer: string;
  attempts: number; last_error?: string; ticket?: string; lead_job: string;
}
export interface UnclosedLead {
  job: string; reason: string; at: string;
}
export interface ReviewRecord {
  round: number; job: string; summary?: string; findings?: Job['findings']; reviewed?: Job['reviewed'];
}
export interface TicketQueueItem {
  ticket: string; path: string; role: 'imp' | 'frontend-imp'; job?: string; land?: string; landed?: true; base_moves?: number;
  /** Declared dependency refs recorded at admission (empty array = root; absent on legacy records). */
  blockers?: string[];
  /** ISO timestamp when this ticket landed. */
  landed_at?: string;
  /** ISO timestamp when a worker question for this ticket was answered. */
  answered_at?: string;
  /** ISO timestamp of the latest station transition (landed, failed, held, unheld, answered). */
  changed_at?: string;
  dispatch_queue?: string; // Keep the original worker request key across explicit resumes.
  approved_head?: string;
  approved_report_sig?: string;
  approved_assumptions_head?: string;
  approved_assumptions_sig?: string;
  held?: TicketItemHold;
  failed?: TicketItemFailure;
}
export interface TicketQueue extends RunScope {
  flow: string; root: string; cwd?: string; feature: string; pane: string; workspace?: string; task: boolean; max_parallel: number;
  created_at: string; updated_at: string; pid?: number; start?: string;
  start_head?: string;
  superseded_by?: string; // A successor may expire while this paused receipt remains.
  template?: 'ticket-queue'; host?: 'detached'; cost?: 'cheap' | 'costly'; cost_reasons?: string[];
  unattended?: UnattendedRun;
  handback_to?: 'lead' | 'main';
  escalation_rule?: string;
  steps?: Record<string, Cursor>;
  epoch?: number; settled?: number; streak?: number; failures?: number;
  notices?: Record<string, string>;
  handback?: TicketHandback;
  held?: TicketItemHold;
  repair_rounds?: number;
  repair_admitted_base?: number;
  todo?: RunTodoItem[];
  decisions?: RunDecision[];
  reviews?: ReviewRecord[];
  review_job?: string;
  active_lead?: ActiveLead;
  pending_answer?: PendingAnswerDelivery;
  unclosed_leads?: UnclosedLead[];
  verdict?: string;
  state: 'working' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'stopped'; tickets: TicketQueueItem[];
  reason?: string; remaining?: string[];
  queued?: { ticket: string; blockers: string[] }[];
  blocked?: { ticket: string; blockers: string[] }[];
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
  const { flow, feature, state, remaining, queued, blocked, max_parallel, verdict, todo, decisions, reviews, repair_rounds, handback, held, unclosed_leads } = q;
  const reason = q.reason ?? (queued?.length ? `Queued: ${queued.map(({ ticket, blockers }) => `${ticket} waiting on ${blockers.join(', ')}`).join('; ')}` : undefined);
  const base_moves = q.tickets.reduce((total, item) => total + (item.base_moves ?? 0), 0);
  const heldItems = q.tickets.filter(item => item.held).map(({ ticket, job, held: h }) => ({ ticket, ...(job && { job }), ...h! }));
  const failedItems = q.tickets.filter(item => item.failed).map(({ ticket, job, failed: f }) => ({ ticket, ...(job && { job }), ...f! }));
  const pause_notice = state === 'paused' && !Object.keys(q.notices ?? {}).length
    ? ticketQueueNotice(q).replace(/\r?\n/g, ' | ') : undefined;
  return { flow, feature, ...(q.unattended && { objective: q.unattended.objective }), state, reason, remaining,
    ...(queued?.length && { queued }), ...(blocked?.length && { blocked }), ...(max_parallel && { max_parallel }),
    ...(base_moves && { base_moves }),
    ...(verdict && { verdict }), ...(todo?.length && { todo }), ...(decisions?.length && { decisions }),
    ...(reviews?.length && { reviews }), ...(repair_rounds && { repair_rounds }),
    ...(handback && { handback }), ...(held && { held }),
    ...(heldItems.length && { held_items: heldItems }),
    ...(failedItems.length && { failed_items: failedItems }),
    ...(unclosed_leads?.length && { unclosed_leads }),
    ...(pause_notice && { pause_notice }),
    landed: q.tickets.filter(item => item.landed).map(item => item.ticket),
    jobs: q.tickets.map(({ ticket, job, land }) => ({ ticket, job, land })) };
}
export const MAX_REPAIR_ROUNDS = 2;

/** Check admission and reset the workflow steps for another repair round. Callers own hand-back and lead closure. */
export function prepareTicketQueueRepair(q: TicketQueue, stepKeys: readonly string[], workset: () => {
  tickets: readonly { ticket: string }[]; queued?: readonly unknown[];
}, reason?: string) {
  if ((q.repair_rounds ?? 0) >= MAX_REPAIR_ROUNDS) {
    return { kind: 'cap', reason: `max repair rounds (${MAX_REPAIR_ROUNDS}) reached${reason ? `: ${reason}` : ''}` } as const;
  }
  const { tickets, queued } = workset();
  if (!queued?.length && !tickets.some(t => !q.tickets.some(own => own.ticket === t.ticket))) return { kind: 'no_work' } as const;
  q.repair_rounds = (q.repair_rounds ?? 0) + 1;
  q.repair_admitted_base = q.tickets.length;
  delete q.review_job;
  q.steps = Object.fromEntries(stepKeys.map(key => [key, { state: 'waiting' as const }]));
  return { kind: 'ready' } as const;
}

const MAX_RUN_DECISIONS = 100;

export function recordDecision(q: TicketQueue, entry: RunDecision): void {
  const list = q.decisions ?? [];
  list.push(entry);
  q.decisions = list.length > MAX_RUN_DECISIONS ? list.slice(-MAX_RUN_DECISIONS) : list;
}

export function ticketQueueNotice(q: TicketQueue) {
  const landed = q.tickets.filter(item => item.landed).map(item => item.ticket);
  const base_moves = q.tickets.reduce((total, item) => total + (item.base_moves ?? 0), 0);
  const reason = q.reason ?? (q.queued?.length ? `Queued: ${q.queued.map(({ ticket, blockers }) => `${ticket} waiting on ${blockers.join(', ')}`).join('; ')}` : undefined);
  const verdict = q.state === 'completed' && q.verdict ? ` Verdict: ${q.verdict.replace(/\.+$/, '')}.` : '';
  const todo = q.state === 'completed' && q.todo?.length ? ` Todo: ${q.todo.length}.` : '';
  const heldCount = q.tickets.filter(item => item.held).length;
  const held = heldCount ? ` Held: ${heldCount}.` : '';
  const heldHint = q.state === 'paused' && !q.unattended && heldCount && !/\bhud_land\b/.test(reason ?? '')
    ? ' Manual resolution required: worker correction, hud_land, or stop.' : '';
  const reply = q.state === 'paused' && q.handback && q.steps?.[q.handback.step]?.state === 'asking'
    ? ` Reply: hud_respond job=${q.flow} answer=<${q.handback.choices.join('|')}>[: reason].` : '';
  return `${q.flow} (ticket queue ${q.feature}) — ${reason ?? q.state}. Landed: ${landed.join(', ') || 'none'}.` +
    verdict + todo + held + heldHint +
    (base_moves ? ` Base moves absorbed: ${base_moves}.` : '') +
    (q.state === 'completed' ? '' : ` Still running: ${q.remaining?.join(', ') || 'none'}.`) +
    reply;
}
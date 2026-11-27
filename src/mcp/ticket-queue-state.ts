import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDirSafe, writeJsonPrivate } from '../utils/atomic-fs.js';
import { isProcAlive, isValidPid, procStat } from '../utils/proc.js';
import type { Cursor } from '../workflows/engine.js';
import type { RunScope } from '../workflows/scope.js';
import { requestStop, stopRequested } from '../workflows/store.js';
import type { Job } from './job-contracts.js';
import type { OwnerApproval, UnattendedRun } from '../unattended/state.js';

export const isTicketQueueId = (id: unknown): id is string => typeof id === 'string' && /^q[0-9a-f]{16}$/.test(id);
export const queueFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export const queueIds = (home: string) => readDirSafe(join(home, 'flows')).filter(file => file.endsWith('.json'))
  .map(file => file.slice(0, -5)).filter(isTicketQueueId);

export const QUEUE_TASK_TTL_MS = 3 * 60 * 60_000;
export type QueueTaskMarker = {
  flow: string;
  epoch: number;
  pane: string;
  pid: number;
  start: string;
  expires: number;
};

export const queueTaskFile = (home: string, flow: string) => join(home, 'flows', flow, 'task.json');

export function readQueueTask(home: string, flow: string): QueueTaskMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(queueTaskFile(home, flow), 'utf8')) as Partial<QueueTaskMarker>;
    if (
      raw?.flow !== flow ||
      typeof raw.epoch !== 'number' || !Number.isSafeInteger(raw.epoch) || raw.epoch < 0 ||
      typeof raw.pane !== 'string' ||
      !isValidPid(raw.pid) ||
      typeof raw.start !== 'string' || !raw.start ||
      typeof raw.expires !== 'number' || !Number.isFinite(raw.expires)
    ) return null;
    return raw as QueueTaskMarker;
  } catch { return null; }
}

export function claimQueueTask(
  home: string,
  q: Pick<TicketQueue, 'flow' | 'epoch' | 'pane'>,
  expires = Date.now() + QUEUE_TASK_TTL_MS,
): QueueTaskMarker | null {
  const start = procStat(process.pid)?.start;
  if (!start) return null;
  const marker: QueueTaskMarker = {
    flow: q.flow,
    epoch: q.epoch ?? 0,
    pane: q.pane,
    pid: process.pid,
    start,
    expires,
  };
  try {
    writeJsonPrivate(queueTaskFile(home, q.flow), marker);
    return marker;
  } catch { return null; }
}

export function clearQueueTask(home: string, flow: string, expectedEpoch?: number) {
  const file = queueTaskFile(home, flow);
  try {
    if (expectedEpoch !== undefined) {
      const existing = readQueueTask(home, flow);
      if (existing && existing.epoch !== expectedEpoch) return;
    }
    fs.unlinkSync(file);
  } catch { /* gone */ }
}

/** Reserve queue notices for an active MCP task only when a live task exists for this exact epoch. */
export function liveQueueTask(
  home: string,
  q: Pick<TicketQueue, 'flow' | 'epoch' | 'pane' | 'task'>,
  now = Date.now(),
): QueueTaskMarker | null {
  if (!q.task) return null;
  const marker = readQueueTask(home, q.flow);
  if (!marker) return null;
  if (marker.epoch !== (q.epoch ?? 0)) return null;
  if (marker.pane !== q.pane) return null;
  if (marker.expires <= now) return null;
  if (!isProcAlive(marker.pid, marker.start)) return null;
  return marker;
}

export type TicketHandbackKind = 'question' | 'blocker' | 'assumption' | 'escalate' | 'check' | 'review' | 'land' | 'worker' | 'dispatch' | 'queue';
export interface TicketHandback {
  step: string; choices: string[]; kind?: TicketHandbackKind;
  ticket?: string; job?: string; question?: string; land?: string; owner_approval?: OwnerApproval;
  request_id?: string;
  assumption?: { head: string; report_sig: string };
}
export function escalatedQuestion(handback?: Pick<TicketHandback, 'kind' | 'job' | 'question'>) {
  if (handback?.kind === 'escalate' && handback.job && handback.question) {
    return { job: handback.job, question: handback.question };
  }
}

export const questionReply = (job: string, question: string) =>
  `Answer the worker: hud_respond job=${job} request_id=${question} answer=<answer>`;

export interface TicketItemHold {
  reason: string; at: string; kind?: TicketHandbackKind; owner_approval?: OwnerApproval;
  head?: string; report_sig?: string; request_id?: string;
}
export interface TicketItemFailure {
  reason: string; at: string; kind?: TicketHandbackKind;
}
export interface RunTodoItem {
  source: string; kind: 'assumed' | 'lead' | 'try' | 'blocker'; text: string;
}
export interface RunDecision {
  step: string; kind: 'question' | 'accept' | 'ambiguity' | 'assumption' | 'blocker'; job: string; decision: string; reason?: string; at: string;
  ticket?: string; worker_job?: string; question?: string; close_error?: string;
}
export interface ActiveLead {
  job: string; kind: 'question' | 'accept' | 'ambiguity' | 'assumption' | 'blocker'; step: string; round: number;
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
  repo?: string; // Registered target main checkout; root remains the tracker.
  /** Repair round at admission (0 for the initial round; absent on legacy records). */
  round?: number;
  /** Canonical <feature>/<NN> slice refs fixed by this repair ticket (recorded at admission). */
  repairs?: string[];
  /** Declared dependency refs recorded at admission (empty array = root; absent on legacy records). */
  blockers?: string[];
  /** ISO timestamp when this ticket landed. */
  landed_at?: string;
  /** ISO timestamp when a worker question for this ticket was answered. */
  answered_at?: string;
  /** ISO timestamp of the latest station transition (landed, failed, held, unheld, answered). */
  changed_at?: string;
  held_land?: string; // Manual land that cleared this hold; retain its evidence for review and acceptance.
  dispatch_queue?: string; // Keep the original worker request key across explicit resumes.
  repair_job?: string; // A replacement repair reports on the original managed checkout.
  approved_head?: string;
  approved_report_sig?: string;
  approved_assumptions_head?: string;
  approved_assumptions_sig?: string;
  held?: TicketItemHold;
  failed?: TicketItemFailure;
}
export const TICKET_QUEUE_STATES = ['working', 'completed', 'failed', 'cancelled', 'paused', 'stopped', 'superseded'] as const;

export interface TicketQueue extends RunScope {
  flow: string; root: string; cwd?: string; feature: string; pane: string; workspace?: string; task: boolean; max_parallel: number;
  created_at: string; updated_at: string; pid?: number; start?: string;
  start_head?: string;
  superseded_by?: string; // A successor may expire while this receipt remains.
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
  state: (typeof TICKET_QUEUE_STATES)[number]; tickets: TicketQueueItem[];
  reason?: string; remaining?: string[];
  /** Display workset, independent of which tickets the queue may dispatch or wait for. */
  future?: { ticket: string; title: string; role: TicketQueueItem['role']; blockers: string[]; waiting_on?: string[] }[];
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
  if (q.state === 'working') {
    syncBlockerHandback(q);
    for (const { ticket, held } of q.tickets) {
      if (held?.kind !== 'blocker' || !held.request_id) continue;
      (q.notices ??= {})[`handback-${held.request_id}`] =
        `${q.flow} held ${ticket}: ${held.reason} — reply hud_respond job=${q.flow} request_id=${held.request_id} answer=resume`;
    }
  }
  q.updated_at = new Date().toISOString();
  writeJsonPrivate(queueFile(home, q.flow), q, { mkdir: false, exclusive: create });
}
export function cancelTicketQueue(home: string, q: TicketQueue) {
  if (q.state === 'working') requestStop(home, q.flow);
}
export const queueCancelled = (home: string, q: TicketQueue) => stopRequested(home, q.flow);
export function blockerHandbackItem(q: TicketQueue, requestId?: string): TicketQueueItem | undefined {
  return q.tickets.find(item => item.held?.kind === 'blocker' && item.held.request_id &&
    (requestId === undefined || item.held.request_id === requestId));
}

export function clearItemHold(q: TicketQueue, item: TicketQueueItem) {
  if (q.notices && item.held?.request_id) delete q.notices[`handback-${item.held.request_id}`];
  delete item.held;
  item.changed_at = new Date().toISOString();
}

export function syncBlockerHandback(q: TicketQueue) {
  const item = blockerHandbackItem(q);
  if (q.handback?.request_id === item?.held?.request_id) return false;
  if (item) {
    q.handback = {
      step: 'tickets', choices: ['resume'], kind: 'blocker', ticket: item.ticket, job: item.repair_job ?? item.job,
      request_id: item.held!.request_id,
      ...(item.held!.owner_approval && { owner_approval: item.held!.owner_approval }),
    };
  } else if (q.handback?.kind === 'blocker') delete q.handback;
  return true;
}

export function ticketQueueView(q: TicketQueue) {
  const { flow, feature, state, remaining, queued, blocked, max_parallel, verdict, todo, decisions, reviews, repair_rounds, handback, held, unclosed_leads } = q;
  const reason = q.reason ?? (queued?.length ? `Queued: ${queued.map(({ ticket, blockers }) => `${ticket} waiting on ${blockers.join(', ')}`).join('; ')}` : undefined);
  const base_moves = q.tickets.reduce((total, item) => total + (item.base_moves ?? 0), 0);
  const heldItems = q.tickets.flatMap(({ ticket, job, repair_job, held: h }) => h ? [{ ticket, job: repair_job ?? job, ...h }] : []);
  const failedItems = q.tickets.filter(item => item.failed).map(({ ticket, job, failed: f }) => ({ ticket, ...(job && { job }), ...f! }));
  const pause_notice = state === 'paused' && !Object.keys(q.notices ?? {}).length
    ? ticketQueueNotice(q).replace(/\r?\n/g, ' | ') : undefined;
  return { flow, feature, ...(q.unattended && { objective: q.unattended.objective }), state, reason, remaining,
    ...(q.superseded_by && { superseded_by: q.superseded_by }),
    ...(queued?.length && { queued }), ...(blocked?.length && { blocked }), ...(max_parallel && { max_parallel }),
    ...(base_moves && { base_moves }),
    ...(verdict && { verdict }), ...(todo?.length && { todo }), ...(decisions?.length && { decisions }),
    ...(reviews?.length && { reviews }), ...(repair_rounds !== undefined && { repair_rounds }),
    ...(handback && { handback }), ...(held && { held }),
    ...(heldItems.length && { held_items: heldItems }),
    ...(failedItems.length && { failed_items: failedItems }),
    ...(unclosed_leads?.length && { unclosed_leads }),
    ...(pause_notice && { pause_notice }),
    landed: q.tickets.filter(item => item.landed).map(item => item.ticket),
    jobs: q.tickets.map(({ ticket, job, land }) => ({ ticket, job, land })) };
}
/** Check admission and reset the workflow steps for another repair round. Callers own hand-back and lead closure. */
export function prepareTicketQueueRepair(q: TicketQueue, stepKeys: readonly string[], workset: () => {
  tickets: readonly { ticket: string }[]; queued?: readonly unknown[];
}) {
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
  if (q.state === 'superseded') {
    return `${q.flow} (ticket queue ${q.feature}) — superseded${q.superseded_by ? ` by ${q.superseded_by}` : ''}. Landed: ${landed.join(', ') || 'none'}.`;
  }
  const base_moves = q.tickets.reduce((total, item) => total + (item.base_moves ?? 0), 0);
  const reason = q.reason ?? (q.queued?.length ? `Queued: ${q.queued.map(({ ticket, blockers }) => `${ticket} waiting on ${blockers.join(', ')}`).join('; ')}` : undefined);
  const verdict = q.state === 'completed' && q.verdict ? ` Verdict: ${q.verdict.replace(/\.+$/, '')}.` : '';
  const todo = q.state === 'completed' && q.todo?.length ? ` Todo: ${q.todo.length}.` : '';
  const heldCount = q.tickets.filter(item => item.held).length;
  const held = heldCount ? ` Held: ${heldCount}.` : '';
  const heldHint = q.state === 'paused' && !q.unattended && heldCount && !/\bhud_land\b/.test(reason ?? '')
    ? ' Manual resolution required: worker correction, hud_land, or stop.' : '';
  const question = q.state === 'paused' ? escalatedQuestion(q.handback) : undefined;
  const reply = question ? ` ${questionReply(question.job, question.question)}.${q.unattended ? ''
    : ` To stop the queue: hud_respond job=${q.flow} answer=stop.`}`
    : q.state === 'paused' && q.handback && q.steps?.[q.handback.step]?.state === 'asking'
      ? ` Reply: hud_respond job=${q.flow} answer=<${q.handback.choices.join('|')}>[: reason].` : '';
  return `${q.flow} (ticket queue ${q.feature}) — ${reason ?? q.state}. Landed: ${landed.join(', ') || 'none'}.` +
    verdict + todo + held + heldHint +
    (base_moves ? ` Base moves absorbed: ${base_moves}.` : '') +
    (q.state === 'completed' ? '' : ` Still running: ${q.remaining?.join(', ') || 'none'}.`) +
    reply;
}
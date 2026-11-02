import { canonicalJson, requireCanonicalAbsolutePath } from '../core/canonical.js';
import { sameSessionRef } from '../core/identity.js';
import type { LedgerEvent } from '../core/types/execution.js';
import type { HostLocator } from '../core/types/capabilities.js';
import type { OwnerKey, SessionRef } from '../core/types/identity.js';
import type { ProcessStamp } from '../core/types/supervision.js';
import { linkOwner } from './intents.js';
import { insertRecord, readLink, readRun } from './records.js';
import type { LedgerTransaction } from './transaction.js';

export const NOTIFY_EVENT_VERSION = 'events.v1.1' as const;

export interface WakeRegistration {
  adapter: 'claude_background_wait_v1' | 'codex_queue_v1' | 'pi_extension_v1' | 'none';
  adapterVersion: 1;
  ownerKey: OwnerKey;
  contextGeneration: number;
  parentRef: SessionRef;
  parentStamp: ProcessStamp | null;
  target: { codexHome: string; threadId: string } | { socketPath: string } | Record<string, never>;
  reason?: string;
}
export interface WakeRevocation {
  registrationSeq: number;
  reason: 'generation_changed' | 'session_replaced' | 'parent_offline' | 'link_closed' | 'adapter_rejected';
}
export type WakeDelivery = { registrationSeq: number; throughSeq: number } & (
  | { result: 'wait_return' }
  | { result: 'accepted'; attempt: 1 | 2 }
  | { result: 'rejected'; attempt: 1 | 2; reason: string }
  | { result: 'unknown'; attempt: 1; exhausted?: never }
  | { result: 'unknown'; attempt: 2; exhausted: true }
);
export interface RetireRequest {
  cause: 'retire_after_report' | 'retire_idle' | 'retire_blocked_wait' | 'runtime_limit';
  rule: 'after_report' | 'idle' | 'blocked_wait' | 'max_runtime';
  actor: { kind: 'policy' };
  deadlineAt: number;
  eligibility: {
    reportSeq?: number;
    newerWorkChecked: true;
    quiescence: 'observed' | 'not_required' | 'unobservable';
    pendingInput: 'none' | 'unobservable' | 'policy_override';
  };
  graceMs: number;
}
export interface SurfaceCreated {
  locator: HostLocator;
  occupantGeneration: number;
}
export interface HandoffRecord {
  sha256: string;
  bytes: number;
  retained: true;
  fromLinkId?: string;
  fromRunId?: string;
}
function invalid(): never {
  throw new TypeError('notify_payload_invalid');
}
function object(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
}
function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
  object(value);
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    invalid();
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) invalid();
}
function code(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) invalid();
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
}
function stamp(value: unknown): void {
  if (value === null) return;
  keys(value, ['pid', 'proc_start', 'boot_id', 'pid_domain']);
  integer(value.pid, 1);
  for (const key of ['proc_start', 'boot_id', 'pid_domain']) text(value[key]);
  if (!/^[0-9]+$/.test(value.proc_start)) invalid();
}
function ref(value: unknown): void {
  keys(value, ['harness', 'sourceId', 'sessionId', 'threadId']);
  if (!['claude', 'codex', 'pi'].includes(value.harness) || !/^[a-f0-9]{64}$/.test(value.sourceId)) invalid();
  text(value.sessionId);
  if (value.threadId !== null) text(value.threadId);
}
function path(value: unknown): void {
  text(value);
  requireCanonicalAbsolutePath(value);
}
function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
function append(
  tx: LedgerTransaction,
  linkId: string,
  runId: string | null,
  kind: string,
  payload: unknown,
  at: number
): number {
  integer(at, 0, Date.now());
  if (Buffer.byteLength(canonicalJson(payload)) > 16384) invalid();
  insertRecord(tx, 'events', { linkId, runId, kind, payload, at });
  return Number(tx.get('SELECT last_insert_rowid() AS seq')!.seq);
}
/** Trusted writer ports. Call inside the caller's existing authorized transaction;
 * target/host/retention verification happens outside SQLite. These events grant no authority.
 */
export function recordWakeRegistered(
  tx: LedgerTransaction,
  linkId: string,
  supplied: WakeRegistration,
  at: number
): number {
  const p = copy(supplied);
  keys(
    p,
    ['adapter', 'adapterVersion', 'ownerKey', 'contextGeneration', 'parentRef', 'parentStamp', 'target'],
    ['reason']
  );
  if (
    !['claude_background_wait_v1', 'codex_queue_v1', 'pi_extension_v1', 'none'].includes(p.adapter) ||
    p.adapterVersion !== 1
  )
    invalid();
  integer(p.contextGeneration, 1);
  ref(p.parentRef);
  stamp(p.parentStamp);
  const link = readLink(tx, linkId);
  if (!link.parentRef || !sameSessionRef(p.parentRef, link.parentRef) || p.ownerKey !== linkOwner(tx, link)) invalid();
  const target: Record<string, unknown> = p.target;
  if (p.adapter === 'codex_queue_v1') {
    keys(p.target, ['codexHome', 'threadId']);
    path(target.codexHome);
    text(target.threadId);
    if (p.parentRef.harness !== 'codex' || target.threadId !== (p.parentRef.threadId ?? p.parentRef.sessionId))
      invalid();
  } else if (p.adapter === 'pi_extension_v1') {
    keys(p.target, ['socketPath']);
    path(target.socketPath);
    if (p.parentRef.harness !== 'pi') invalid();
  } else {
    keys(p.target, []);
    if (p.adapter === 'claude_background_wait_v1' && p.parentRef.harness !== 'claude') invalid();
  }
  if (p.adapter === 'none') {
    if (p.reason === undefined) invalid();
    code(p.reason);
  } else if (p.reason !== undefined) invalid();
  return append(tx, linkId, null, 'wake.registered', p, at);
}
function registration(tx: LedgerTransaction, linkId: string, seq: number): void {
  integer(seq, 1);
  if (
    !tx.get("SELECT 1 FROM events WHERE seq=? AND link_id=? AND run_id IS NULL AND kind='wake.registered'", seq, linkId)
  )
    invalid();
}
export function recordWakeRevoked(tx: LedgerTransaction, linkId: string, supplied: WakeRevocation, at: number): number {
  const p = copy(supplied);
  keys(p, ['registrationSeq', 'reason']);
  if (
    !['generation_changed', 'session_replaced', 'parent_offline', 'link_closed', 'adapter_rejected'].includes(p.reason)
  )
    invalid();
  registration(tx, linkId, p.registrationSeq);
  return append(tx, linkId, null, 'wake.revoked', p, at);
}
export function recordWakeDelivered(tx: LedgerTransaction, linkId: string, supplied: WakeDelivery, at: number): number {
  const p = copy(supplied);
  keys(p, ['registrationSeq', 'throughSeq', 'result'], ['attempt', 'reason', 'exhausted']);
  registration(tx, linkId, p.registrationSeq);
  integer(p.throughSeq);
  if (!['accepted', 'rejected', 'unknown', 'wait_return'].includes(p.result)) invalid();
  if (p.result === 'wait_return') {
    if ('attempt' in p || 'reason' in p || 'exhausted' in p) invalid();
  } else {
    integer(p.attempt, 1, 2);
    if (p.result === 'rejected') code(p.reason);
    else if ('reason' in p) invalid();
    if (p.result === 'unknown' && p.attempt === 2) {
      if (p.exhausted !== true) invalid();
    } else if ('exhausted' in p) invalid();
  }
  const high = Number(tx.get('SELECT coalesce(max(seq),0) AS seq FROM events')!.seq);
  if (p.throughSeq > high) invalid();
  return append(tx, linkId, null, 'wake.delivered', p, at);
}
export function validateRetireRequest(tx: LedgerTransaction, runId: string, supplied: unknown): RetireRequest {
  const p = copy(supplied);
  keys(p, ['cause', 'rule', 'actor', 'deadlineAt', 'eligibility', 'graceMs']);
  const rules = {
    retire_after_report: 'after_report',
    retire_idle: 'idle',
    retire_blocked_wait: 'blocked_wait',
    runtime_limit: 'max_runtime',
  };
  if (typeof p.cause !== 'string' || !Object.hasOwn(rules, p.cause) || rules[p.cause as keyof typeof rules] !== p.rule)
    invalid();
  keys(p.actor, ['kind']);
  if (p.actor.kind !== 'policy') invalid();
  integer(p.deadlineAt);
  integer(p.graceMs, 0, 60000);
  keys(p.eligibility, ['newerWorkChecked', 'quiescence', 'pendingInput'], ['reportSeq']);
  if (
    p.eligibility.newerWorkChecked !== true ||
    !['observed', 'not_required', 'unobservable'].includes(p.eligibility.quiescence) ||
    !['none', 'unobservable', 'policy_override'].includes(p.eligibility.pendingInput)
  )
    invalid();
  const run = readRun(tx, runId);
  if (p.eligibility.reportSeq !== undefined) {
    integer(p.eligibility.reportSeq, 1);
    if (
      !tx.get(
        "SELECT 1 FROM events WHERE seq=? AND run_id=? AND link_id=? AND kind='report.received'",
        p.eligibility.reportSeq,
        runId,
        run.linkId
      )
    )
      invalid();
  }
  return p as unknown as RetireRequest;
}
export function recordRetireRequested(
  tx: LedgerTransaction,
  runId: string,
  supplied: RetireRequest,
  at: number
): number {
  const p = validateRetireRequest(tx, runId, supplied);
  return append(tx, readRun(tx, runId).linkId, runId, 'retire.requested', p, at);
}
export function recordSurfaceCreated(
  tx: LedgerTransaction,
  runId: string,
  supplied: SurfaceCreated,
  at: number
): number {
  const p = copy(supplied);
  keys(p, ['locator', 'occupantGeneration']);
  integer(p.occupantGeneration, 1);
  const l = p.locator;
  object(l);
  if (!['herdr', 'tmux'].includes(l.kind)) invalid();
  keys(
    l,
    l.kind === 'herdr'
      ? ['kind', 'server', 'workspace', 'tab', 'pane', 'process', 'runId', 'bindingGeneration']
      : ['kind', 'server', 'session', 'pane', 'process', 'runId', 'bindingGeneration']
  );
  stamp(l.process);
  integer(l.bindingGeneration, 1);
  for (const key of Object.keys(l).filter((k) => !['process', 'bindingGeneration'].includes(k))) text((l as any)[key]);
  const run = readRun(tx, runId);
  if (l.runId !== runId || l.bindingGeneration !== run.expectedGeneration) invalid();
  return append(tx, run.linkId, runId, 'surface.created', p, at);
}
export function recordHandoff(tx: LedgerTransaction, linkId: string, supplied: HandoffRecord, at: number): number {
  const p = copy(supplied);
  keys(p, ['sha256', 'bytes', 'retained'], ['fromLinkId', 'fromRunId']);
  if (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) || p.retained !== true) invalid();
  integer(p.bytes);
  readLink(tx, linkId);
  if (p.fromLinkId !== undefined) text(p.fromLinkId);
  if (p.fromRunId !== undefined) text(p.fromRunId);
  return append(tx, linkId, null, 'handoff.recorded', p, at);
}

/** One shared definition for durable wake hints/notices. report.received references
 * an accepted reports row (whose status has all four allowed values); event payload
 * deliberately contains only reportId. This predicate never grants read authority.
 */
export function isWakeWorthyEvent(event: Pick<LedgerEvent, 'kind' | 'runId' | 'linkId' | 'payload'>): boolean {
  if (
    typeof event.linkId !== 'string' ||
    !event.linkId ||
    typeof event.runId !== 'string' ||
    !event.runId ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  )
    return false;
  if (event.kind === 'report.received')
    return typeof event.payload.reportId === 'string' && event.payload.reportId.length > 0;
  if (event.kind === 'run.terminal') return ['ended', 'failed', 'cancelled'].includes(event.payload.state as string);
  return event.kind === 'run.state' && event.payload.state === 'uncertain';
}

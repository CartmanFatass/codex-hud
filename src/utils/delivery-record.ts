/** Private, atomic, epoch-bound delivery state records at `.noticed` / `.observed` paths. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { readRegularNoFollow, writeJsonPrivate } from './atomic-fs.js';
import { isProcAlive, isValidPid, procStat } from './proc.js';

export type DeliveryState = 'pending' | 'claimed' | 'sending' | 'accepted' | 'unknown' | 'abandoned';
export type DeliveryVia =
  | 'codex-queue' | 'agy-mailbox' | 'herdr-prompt' | 'watch-stdout'
  | 'claude-mod' | 'pi-steer' | 'mcp-task' | 'mcp-changes' | 'legacy';

export interface DeliveryRecord {
  v: 1;
  state: Exclude<DeliveryState, 'pending'>;
  epoch: string | number;
  pid?: number;
  start?: string;
  via?: DeliveryVia;
  reason?: string;
  at: number;
  expires?: number;
}

const VALID_STATES = new Set<DeliveryRecord['state']>(['claimed', 'sending', 'accepted', 'unknown', 'abandoned']);
export const DEFAULT_CLAIM_LEASE_MS = 15 * 60_000;
let cachedStart: string | undefined;
const ownStart = () => (cachedStart ??= procStat(process.pid)?.start);

function parseRecord(data: Buffer, mtimeMs: number): DeliveryRecord | null {
  if (data.length === 0) return { v: 1, state: 'accepted', epoch: '', via: 'legacy', at: Math.floor(mtimeMs) };
  try {
    const raw = JSON.parse(data.toString('utf8')) as Partial<DeliveryRecord>;
    if (raw?.v !== 1 || !VALID_STATES.has(raw.state as DeliveryRecord['state'])) return null;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
    if (typeof raw.epoch !== 'string' && typeof raw.epoch !== 'number') return null;
    return raw as DeliveryRecord;
  } catch { return null; }
}

const procAlive = (r: DeliveryRecord) => isValidPid(r.pid) && typeof r.start === 'string' && isProcAlive(r.pid, r.start);

export function readDeliveryRecord(file: string, now = Date.now()): { state: DeliveryState; record?: DeliveryRecord; reclaimable: boolean } {
  let opened: { data: Buffer; stat: fs.Stats } | null;
  try { opened = readRegularNoFollow(file); }
  catch { return { state: 'unknown', reclaimable: false }; }
  if (!opened) {
    try { if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { state: 'pending', reclaimable: true }; }
    catch { /* Fail closed. */ }
    return { state: 'unknown', reclaimable: false };
  }
  const record = parseRecord(opened.data, opened.stat.mtimeMs);
  if (!record) return { state: 'unknown', reclaimable: false };
  if (record.state === 'claimed') {
    const reclaimable = !procAlive(record) || (typeof record.expires === 'number' && now >= record.expires);
    return { state: 'claimed', record, reclaimable };
  }
  if (record.state === 'sending' && !procAlive(record)) {
    return { state: 'unknown', record: { ...record, state: 'unknown', reason: 'sender_exited' }, reclaimable: false };
  }
  return { state: record.state, record, reclaimable: false };
}

export const isDeliveryClaimable = (file: string, now = Date.now()): boolean => readDeliveryRecord(file, now).reclaimable;
export const isDeliveryActive = (file: string, now = Date.now()): boolean => {
  const { state } = readDeliveryRecord(file, now);
  return state === 'pending' || state === 'claimed' || state === 'sending';
};

function ownedRecord(file: string, states: readonly DeliveryRecord['state'][]): DeliveryRecord | null {
  const start = ownStart();
  if (!start) return null;
  try {
    const opened = readRegularNoFollow(file);
    const record = opened && opened.data.length > 0 ? parseRecord(opened.data, opened.stat.mtimeMs) : null;
    return record && states.includes(record.state) && record.pid === process.pid && record.start === start ? record : null;
  } catch { return null; }
}

function transitionOwned(file: string, states: readonly DeliveryRecord['state'][], next: (cur: DeliveryRecord) => DeliveryRecord): boolean {
  const cur = ownedRecord(file, states);
  if (!cur) return false;
  try { writeJsonPrivate(file, next(cur), { mkdir: false }); return true; }
  catch { return false; }
}

export function claimDelivery(file: string, epoch: string | number, { leaseMs = DEFAULT_CLAIM_LEASE_MS, now = Date.now() } = {}): DeliveryRecord | null {
  const start = ownStart();
  if (!start) return null;
  const record: DeliveryRecord = { v: 1, state: 'claimed', epoch, pid: process.pid, start, at: now, expires: now + leaseMs };
  const tryCreate = (): 'ok' | 'exists' | 'gone' => {
    try { writeJsonPrivate(file, record, { exclusive: true, mkdir: false }); return 'ok'; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'exists';
      if (code === 'ENOENT') return 'gone';
      throw error;
    }
  };
  const first = tryCreate();
  if (first !== 'exists') return first === 'ok' ? record : null;
  const existing = readDeliveryRecord(file, now);
  if (!existing.reclaimable) return null;
  if (existing.state === 'pending') return tryCreate() === 'ok' ? record : null;
  if (existing.state !== 'claimed' || !existing.record) return null;

  const prior = existing.record;
  const tmp = `${file}.reclaim.${process.pid}.${randomUUID()}.tmp`;
  try { fs.renameSync(file, tmp); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && tryCreate() === 'ok' ? record : null; }
  try {
    const moved = readRegularNoFollow(tmp);
    const rec = moved ? parseRecord(moved.data, moved.stat.mtimeMs) : null;
    if (rec?.state !== 'claimed' || rec.pid !== prior.pid || rec.start !== prior.start || rec.at !== prior.at) {
      try { fs.linkSync(tmp, file); } catch { /* Replaced concurrently. */ }
      return null;
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* Cleaned. */ } }
  return tryCreate() === 'ok' ? record : null;
}

export const markDeliverySending = (file: string, now = Date.now()) =>
  transitionOwned(file, ['claimed'], cur => ({ v: 1, state: 'sending', epoch: cur.epoch, pid: cur.pid, start: cur.start, at: now }));

export const revertDeliveryClaim = (file: string, { leaseMs = DEFAULT_CLAIM_LEASE_MS, now = Date.now() } = {}) =>
  transitionOwned(file, ['sending', 'claimed'], cur => ({ v: 1, state: 'claimed', epoch: cur.epoch, pid: cur.pid, start: cur.start, at: now, expires: now + leaseMs }));

export const markDeliveryAccepted = (file: string, via: DeliveryVia, now = Date.now()) =>
  transitionOwned(file, ['claimed', 'sending'], cur => ({ v: 1, state: 'accepted', epoch: cur.epoch, via, at: now }));

export const markDeliveryUnknown = (file: string, reason: string, now = Date.now()) =>
  transitionOwned(file, ['claimed', 'sending'], cur => ({ v: 1, state: 'unknown', epoch: cur.epoch, reason: reason.slice(0, 200), at: now }));

export function markDeliveryAbandoned(file: string, reason: string, epoch: string | number, now = Date.now()): boolean {
  try { writeJsonPrivate(file, { v: 1, state: 'abandoned', epoch, reason: reason.slice(0, 200), at: now } satisfies DeliveryRecord, { mkdir: false }); return true; }
  catch { return false; }
}

export function releaseDelivery(file: string): boolean {
  if (!ownedRecord(file, ['claimed', 'sending'])) return false;
  try { fs.unlinkSync(file); return true; }
  catch { return false; }
}

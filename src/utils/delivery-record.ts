/** Private, atomic, epoch-bound delivery state records at `.noticed` / `.observed` paths. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { readRegularNoFollow, writeJsonPrivate } from './atomic-fs.js';
import { isProcAlive, isValidPid, procStat } from './proc.js';

export type DeliveryState = 'pending' | 'claimed' | 'sending' | 'accepted' | 'unknown' | 'abandoned';
export type DeliveryVia =
  | 'codex-queue' | 'agy-mailbox' | 'herdr-prompt' | 'watch-stdout'
  | 'claude-mod' | 'pi-steer' | 'mcp-task' | 'mcp-changes' | 'legacy';

export type DeliveryOutcome = 'sent' | 'refused' | 'indeterminate';
type NoticeIdentity = { marker: string; epoch: string | number };
export type DeliveryNotice = NoticeIdentity & { line: string; current: () => boolean };

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

// A reused key can name a new obligation in a later epoch. Never displace a live send or a legacy receipt.
const otherEpoch = ({ state, record }: ReturnType<typeof readDeliveryRecord>, epoch?: string | number) =>
  epoch !== undefined && !!record && record.epoch !== epoch && record.via !== 'legacy' && state !== 'claimed' && state !== 'sending';
export const isDeliveryClaimable = (file: string, now = Date.now(), epoch?: string | number): boolean => {
  const view = readDeliveryRecord(file, now);
  return view.reclaimable || otherEpoch(view, epoch);
};
export const isDeliveryActive = (file: string, now = Date.now(), epoch?: string | number): boolean => {
  const view = readDeliveryRecord(file, now);
  return view.state === 'pending' || view.state === 'claimed' || view.state === 'sending' || otherEpoch(view, epoch);
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

function transitionOwned(file: string, states: readonly DeliveryRecord['state'][], next: (cur: DeliveryRecord) => DeliveryRecord | null): boolean {
  const cur = ownedRecord(file, states);
  if (!cur) return false;
  try {
    const record = next(cur);
    if (!record) return false;
    writeJsonPrivate(file, record, { mkdir: false, beforeRename: () => {
      const fresh = ownedRecord(file, [cur.state]);
      if (fresh?.at !== cur.at || fresh.epoch !== cur.epoch) throw Error('notice claim changed');
    } });
    return true;
  } catch { return false; }
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
  if (!existing.reclaimable && !otherEpoch(existing, epoch)) return null;
  const prior = existing.record;
  if (!prior) return tryCreate() === 'ok' ? record : null;
  const tmp = `${file}.reclaim.${process.pid}.${randomUUID()}.tmp`;
  try { fs.renameSync(file, tmp); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && tryCreate() === 'ok' ? record : null; }
  try {
    const moved = readRegularNoFollow(tmp);
    const rec = moved ? parseRecord(moved.data, moved.stat.mtimeMs) : null;
    if (!rec || rec.epoch !== prior.epoch || rec.pid !== prior.pid || rec.start !== prior.start || rec.at !== prior.at ||
        (rec.state !== prior.state && !(rec.state === 'sending' && prior.reason === 'sender_exited'))) {
      try { fs.linkSync(tmp, file); } catch { /* Replaced concurrently. */ }
      return null;
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* Cleaned. */ } }
  return tryCreate() === 'ok' ? record : null;
}

export const revertDeliveryClaim = ({ marker, epoch }: NoticeIdentity, now = Date.now()) =>
  transitionOwned(marker, ['sending'], cur => cur.epoch !== epoch ? null
    : { ...cur, state: 'claimed', at: now, expires: now + DEFAULT_CLAIM_LEASE_MS });

// The send gate is shared by all transports, including pull responses and mailbox publication.
export function beginNotice({ marker, epoch, current }: DeliveryNotice): boolean {
  let sending = false, unavailable = false;
  const transitioned = transitionOwned(marker, ['claimed'], cur => {
    const at = Date.now();
    if (cur.epoch !== epoch || (cur.expires ?? 0) <= at) return null;
    try { sending = current(); }
    catch { unavailable = true; return null; }
    return sending ? { v: 1, state: 'sending', epoch, at, pid: cur.pid, start: cur.start }
      : { v: 1, state: 'abandoned', epoch, at, reason: 'source_changed' };
  });
  if (unavailable) releaseDelivery({ marker, epoch });
  return transitioned && sending;
}

export function settleNotice(notice: NoticeIdentity, outcome: DeliveryOutcome, via: DeliveryVia, reason = 'indeterminate') {
  if (outcome === 'refused') return releaseDelivery(notice, 'sending');
  const { marker, epoch } = notice;
  return transitionOwned(marker, ['sending'], cur => cur.epoch !== epoch ? null : outcome === 'sent'
    ? { v: 1, state: 'accepted', epoch, via, at: Date.now() }
    : { v: 1, state: 'unknown', epoch, reason: reason.slice(0, 200), at: Date.now() });
}

export function releaseDelivery({ marker, epoch }: NoticeIdentity, state: 'claimed' | 'sending' = 'claimed'): boolean {
  if (ownedRecord(marker, [state])?.epoch !== epoch) return false;
  try { fs.unlinkSync(marker); return true; }
  catch { return false; }
}

/** Private, atomic, epoch-bound delivery state records at `.noticed` / `.observed` paths. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname } from 'node:path';
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
const claimable = (view: ReturnType<typeof readDeliveryRecord>, epoch?: string | number) =>
  view.reclaimable || otherEpoch(view, epoch);
export const isDeliveryClaimable = (file: string, now = Date.now(), epoch?: string | number): boolean =>
  claimable(readDeliveryRecord(file, now), epoch);
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

// Lock the stable parent, not the marker inode that a transition replaces. No lock file to create or prune.
function withDeliveryLock<T>(file: string, action: () => T): T | null {
  let fd: number;
  try { fd = fs.openSync(dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    if (spawnSync('flock', ['-x', '-w', '1', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 1500 }).status !== 0) return null;
    return action();
  } finally { fs.closeSync(fd); }
}

function transitionOwned(file: string, states: readonly DeliveryRecord['state'][], next: (cur: DeliveryRecord) => DeliveryRecord | null): boolean {
  try {
    return withDeliveryLock(file, () => {
      const cur = ownedRecord(file, states);
      const record = cur && next(cur);
      if (!record) return false;
      writeJsonPrivate(file, record, { mkdir: false, beforeRename: () => {
        const fresh = ownedRecord(file, [cur.state]);
        if (fresh?.at !== cur.at || fresh.epoch !== cur.epoch) throw Error('notice claim changed');
      } });
      return true;
    }) ?? false;
  } catch { return false; }
}

export function claimDelivery(file: string, epoch: string | number, { leaseMs = DEFAULT_CLAIM_LEASE_MS, now = Date.now() } = {}): DeliveryRecord | null {
  if (!isDeliveryClaimable(file, now, epoch)) return null;
  const start = ownStart();
  if (!start) return null;
  const record: DeliveryRecord = { v: 1, state: 'claimed', epoch, pid: process.pid, start, at: now, expires: now + leaseMs };
  try {
    return withDeliveryLock(file, () => {
      const existing = readDeliveryRecord(file, now);
      if (!claimable(existing, epoch)) return null;
      writeJsonPrivate(file, record, { exclusive: existing.state === 'pending', mkdir: false });
      return record;
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') return null;
    throw error;
  }
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
  try {
    return withDeliveryLock(marker, () => {
      if (ownedRecord(marker, [state])?.epoch !== epoch) return false;
      fs.unlinkSync(marker);
      return true;
    }) ?? false;
  } catch { return false; }
}

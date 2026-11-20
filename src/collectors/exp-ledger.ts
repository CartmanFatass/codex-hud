import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expMicros, type ExpAccount, type ExpBalance, type ExpGrant } from '../exp-config.js';
import { grantCycle } from '../exp-cycle.js';
import { tryExpLock } from './exp-lock.js';

export interface ExpTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type ExpCost = { type: 'cost'; id: string; at: string; model: string; tokens: ExpTokens } & (
  { source: 'reported' | 'priced'; costMicros: number } | { source: 'unpriced'; costMicros: null }
);
interface Calibration {
  type: 'calibration';
  id: string;
  at: string;
  remainingMicros: number;
}

const ledgerFile = (hudHome: string, account: ExpAccount) => join(hudHome, 'exp', `ledger-${account}.jsonl`);
export function prepareExpDir(hudHome: string): string {
  const dir = join(hudHome, 'exp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('EXP directory is not a directory');
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  return dir;
}

/** Check and append under one writer slot per ledger, held across both operations. */
export async function appendExpEvent(
  hudHome: string,
  account: ExpAccount,
  event: ExpCost | Calibration,
  stillEnabled?: () => boolean
): Promise<void> {
  const dir = prepareExpDir(hudHome);
  const path = join(fs.realpathSync(dir), basename(ledgerFile(hudHome, account)));
  const deadline = performance.now() + 2000;
  for (;;) {
    const release = await tryExpLock('ledger', path);
    if (!release) {
      if (performance.now() >= deadline) throw new Error('EXP ledger busy');
      await sleep(5 + Math.random() * 10);
      continue;
    }
    try {
      if (stillEnabled && !stillEnabled()) return;
      const { O_RDWR, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
      const fd = fs.openSync(path, O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error('EXP ledger is not a file');
        if ((stat.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
        const raw = fs.readFileSync(fd, 'utf8');
        if (raw && !raw.endsWith('\n')) throw new Error('Incomplete EXP ledger line');
        if (raw.split('\n').some((line) => line && JSON.parse(line).id === event.id)) return;
        const line = Buffer.from(JSON.stringify(event) + '\n');
        if (fs.writeSync(fd, line) !== line.length) throw new Error('Incomplete EXP ledger write');
        return;
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      await release();
    }
  }
}

interface Cached {
  key: string;
  from: number;
  until: number;
  balance: ExpBalance;
}
// Only the latest small projection for each account; JSONL remains the authority.
const snapshots = new Map<ExpAccount, Cached>();
const signature = (s: fs.BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

export function readExpBalance(
  hudHome: string,
  account: ExpAccount,
  grant: ExpGrant,
  now: number,
  legacySavedAt?: number
): ExpBalance | undefined {
  const path = ledgerFile(hudHome, account);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const stat = fd === undefined ? undefined : fs.fstatSync(fd, { bigint: true });
    if (stat && !stat.isFile()) return;
    const revision = stat ? signature(stat) : 'missing';
    const key = JSON.stringify([path, grant, legacySavedAt, revision]);
    const cached = snapshots.get(account);
    if (cached?.key === key && cached.from <= now && now < cached.until) return cached.balance;

    const cycle = grantCycle(grant, now, legacySavedAt);
    const raw = fd === undefined ? '' : fs.readFileSync(fd, 'utf8');
    // A concurrent append is visible on the next read. Never publish/cache a torn or mixed generation.
    if (fd !== undefined && signature(fs.fstatSync(fd, { bigint: true })) !== revision) return;
    if (raw && !raw.endsWith('\n')) return;
    const ids = new Set<string>();
    const costs: { at: number; micros: number }[] = [];
    let calibration: Calibration | undefined;
    let calibrationMs = -Infinity;
    let until = cycle.end;
    let unpriced = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line) as ExpCost | Calibration;
      if (typeof event.id !== 'string' || typeof event.at !== 'string') return;
      const at = Date.parse(event.at);
      if (!Number.isFinite(at)) return;
      if (ids.has(event.id)) continue;
      ids.add(event.id);
      if (at > now) {
        until = Math.min(until, at);
        continue;
      }
      if (event.type === 'calibration' && expMicros(event.remainingMicros)) {
        if (at >= calibrationMs) {
          calibration = event;
          calibrationMs = at;
        }
      } else if (event.type === 'cost' && (event.source === 'unpriced' || expMicros(event.costMicros))) {
        if (at < cycle.start) continue;
        if (event.source === 'unpriced') unpriced++;
        else costs.push({ at, micros: event.costMicros });
      } else return;
    }
    const calibrated = calibration !== undefined && calibrationMs >= cycle.start;
    const base = calibrated ? calibration!.remainingMicros : cycle.grantMicros;
    let billedMicros = 0,
      sinceBase = 0;
    for (const { at, micros } of costs) {
      billedMicros += micros;
      if (!calibrated || at > calibrationMs) sinceBase += micros;
    }
    if (!expMicros(billedMicros)) return;
    const balance: ExpBalance = {
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      timeZone: cycle.timeZone,
      remainingMicros: base === null ? null : base - sinceBase,
      billedMicros,
      unpriced,
      lastCalibration: calibration && { at: calibration.at, remainingMicros: calibration.remainingMicros },
    };
    snapshots.set(account, { key, from: now, until, balance });
    return balance;
  } catch {
    // A ledger we cannot read must not look like an unused grant.
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

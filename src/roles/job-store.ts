/**
 * Per-job files under `$HUD_HOME/jobs`. Receipts are private and replaced by rename.
 * Locks serialise attempts that share a request key, including across processes.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const tails = new Map<string, Promise<void>>();

/**
 * Replace `file` by rename, mode 0600. The rename is not fsynced: a crash can
 * lose the last replacement. That is accepted for a receipt. A missing update
 * is reconciled from herdr instead of repeating a side effect.
 */
export function writePrivate(file: string, content: string): void {
  const dir = join(file, '..');
  let dirInfo: fs.Stats | undefined;
  try {
    dirInfo = fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (dirInfo?.isSymbolicLink()) throw new Error('unsafe_path');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink()) throw new Error('unsafe_path');
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed, or the write itself failed. */
    }
  }
}

export { readPrivateJson } from './job-receipt.js';

function lockAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * How long a waiter stays on a live lock before returning `busy`.
 * 180s covers several 60s herdr calls (tab create, start, prompt).
 * A live holder is stolen only when its heartbeat is older than this.
 */
export const LOCK_WAIT_MS = 180_000;
/** How often the holder refreshes the lock file mtime while its body runs. */
export const LOCK_HEARTBEAT_MS = 30_000;
/** An empty or unreadable token is left alone until it is older than this. */
const UNPARSEABLE_GRACE_MS = 2_000;
const LOCK_POLL_MS = 20;

export class LockBusy extends Error {
  readonly name = 'LockBusy';
  readonly code = 'busy';

  constructor() {
    super('busy');
  }
}

function tokenPid(holder: string): number | null {
  if (!holder) return null;
  const pid = Number(holder.split(':')[0]);
  return Number.isInteger(pid) && pid >= 2 ? pid : null;
}

function mtimeAge(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Steal a dead pid, or a live holder whose heartbeat mtime is older than
 * `LOCK_WAIT_MS`. A fresh live holder is not stolen. An empty or unparseable
 * token stays until its mtime is older than a short grace, so the window
 * between create and write is not taken.
 */
function holderAbandoned(file: string, holder: string): boolean {
  const age = mtimeAge(file);
  const pid = tokenPid(holder);
  if (pid === null) return age > UNPARSEABLE_GRACE_MS;
  if (!lockAlive(pid)) return true;
  return age >= LOCK_WAIT_MS;
}

function beat(file: string, token: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') !== token) return;
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    /* The holder released it, or replaced it. */
  }
}

async function acquireFile(file: string, token: string, waitMs: number): Promise<void> {
  const dir = join(file, '..');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = '';
      try {
        holder = fs.readFileSync(file, 'utf8');
      } catch {
        holder = '';
      }
      if (holderAbandoned(file, holder)) {
        try {
          if (fs.readFileSync(file, 'utf8') === holder) fs.unlinkSync(file);
        } catch {
          /* The holder released it, or replaced it. */
        }
        continue;
      }
      if (Date.now() >= deadline) throw new LockBusy();
      await delay(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseFile(file: string, token: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file);
  } catch {
    /* Already released. */
  }
}

/**
 * One at a time for `name`, in this process and across processes.
 *
 * Callers in this process share a promise chain, so they wait instead of
 * seeing `busy`. A different process waits until `waitMs` (default
 * `LOCK_WAIT_MS`) and then throws `LockBusy`. While the body runs, the holder
 * refreshes the lock file's mtime. A waiter steals a dead pid, or a live pid
 * whose heartbeat is older than `LOCK_WAIT_MS`.
 */
export async function withLock<T>(
  home: string,
  name: string,
  body: () => Promise<T>,
  waitMs = LOCK_WAIT_MS,
  heartbeatMs = LOCK_HEARTBEAT_MS
): Promise<T> {
  const key = `${home}\0${name}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  tails.set(key, chained);
  await previous;
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const file = join(home, 'jobs', 'locks', name);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await acquireFile(file, token, waitMs);
    timer = setInterval(() => beat(file, token), heartbeatMs);
    timer.unref();
    return await body();
  } finally {
    if (timer) clearInterval(timer);
    releaseFile(file, token);
    release();
    if (tails.get(key) === chained) tails.delete(key);
  }
}

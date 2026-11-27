import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { JOB_ID_RE } from '../roles/job-index-cache.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

const MAX_JOBS = 512;
const MAX_BYTES = 16 * 1024;
const indexFile = (home: string) => join(home, 'flake-block-index.json');
const lockFile = (home: string) => join(home, 'flake-block-index.lock');

function runFlock(args: string[], fd: number): number | null {
  let res = spawnSync('flock', args, { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 2000 });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    res = spawnSync('/usr/bin/flock', args, { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 2000 });
  }
  return res.error ? null : res.status;
}

function withFlakeBlockFlock<T>(home: string, blocking: boolean, fn: () => T): { acquired: true; value: T } | { acquired: false } {
  if (blocking) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(lockFile(home), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if (!blocking) return { acquired: false };
    throw err;
  }
  try {
    const status = runFlock(blocking ? ['-x', '-w', '1', '3'] : ['-nx', '3'], fd);
    if (status !== 0) return { acquired: false };
    return { acquired: true, value: fn() };
  } finally {
    fs.closeSync(fd);
  }
}

/** Serialize flake-block index writes with synchronous best-effort prunes. */
export function withFlakeBlockIndexLock<T>(home: string, fn: () => T): Promise<T> {
  return withAbstractLock('flake-block-index', home, () => {
    const res = withFlakeBlockFlock(home, true, fn);
    if (!res.acquired) throw new Error('flake block index lock timeout');
    return res.value;
  });
}

export function readFlakeBlockJobs(home: string): string[] {
  try {
    const ids = readJsonBounded(indexFile(home), MAX_BYTES);
    if (!Array.isArray(ids)) throw new Error('invalid flake block index');
    return ids.slice(0, MAX_JOBS).filter((id): id is string => typeof id === 'string' && JOB_ID_RE.test(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Called under `withFlakeBlockIndexLock`, before writing the job's refusal.
 * Keep claims in the index: a failed delivery can release its marker. */
export function indexFlakeBlockJob(home: string, id: string): void {
  const ids = readFlakeBlockJobs(home).filter(candidate => candidate !== id);
  writeJsonPrivate(indexFile(home), [id, ...ids].slice(0, MAX_JOBS));
}

/** Best-effort synchronous prune serialized with `withFlakeBlockIndexLock`.
 * Skips when contended so a notice tick never blocks on an active writer. */
export function pruneFlakeBlockJobs(home: string, shouldPrune: (id: string) => boolean): boolean {
  const res = withFlakeBlockFlock(home, false, () => {
    const current = readFlakeBlockJobs(home);
    if (!current.length) return false;
    const next = current.filter(id => !shouldPrune(id));
    if (next.length === current.length) return false;
    writeJsonPrivate(indexFile(home), next);
    return true;
  });
  return res.acquired && res.value;
}

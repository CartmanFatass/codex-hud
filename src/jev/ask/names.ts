// Operation key → on-disk name. Shared so the record writer and the wait lease
// agree, without an import cycle between records.ts and lease.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { JevFailure } from './error.js';

/** The CLI accepts this set. Colons are the provider separator in `ask-pro:<sha>`. */
const OPERATION_KEY = /^[A-Za-z0-9_.:-]{1,120}$/;

export function assertOperationKey(key: string): void {
  if (!OPERATION_KEY.test(key)) throw new JevFailure('invalid_key', 'question key has unsupported characters');
}

/** `key'` in the design: `:` becomes `_` so the name is one path segment. */
export function operationStem(key: string): string {
  assertOperationKey(key);
  return key.replaceAll(':', '_');
}

export function operationPath(stateDir: string, key: string): string {
  return path.join(stateDir, 'operations', `${operationStem(key)}.json`);
}

/** A missing or non-directory state dir is refused. Callers must not create it. */
export function assertStateDir(stateDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new JevFailure('jev_state_dir_missing', 'state_dir does not exist');
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new JevFailure('jev_state_dir_missing', 'state_dir does not exist');
}

export function fsyncDirectory(dir: string, fsync: (fd: number) => void): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fsync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create `operations/` inside an existing state dir. `recursive` is off so a typo
 * cannot create the state dir. The state dir is fsynced only when this call creates
 * the new directory entry.
 */
export function ensureOperationsDir(stateDir: string, fsync: (fd: number) => void): string {
  assertStateDir(stateDir);
  const dir = path.join(stateDir, 'operations');
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!fs.statSync(dir).isDirectory()) throw error;
    return dir;
  }
  fsyncDirectory(stateDir, fsync);
  return dir;
}

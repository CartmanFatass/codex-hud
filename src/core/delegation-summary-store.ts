import * as fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './canonical.js';
import { sessionRefKey } from './identity.js';
import type { SessionRef } from './types/identity.js';
import { PrivateLedgerGate } from '../ledger/local-manager.js';
import {
  DELEGATION_SUMMARY_MAX_BYTES,
  validateDelegationSummary,
  type CommittedDelegationSummary,
} from './delegation-summary-schema.js';

export function summaryFileIdentity(file: string, directory = false): string {
  const stat = fs.lstatSync(file);
  if (
    !isAbsolute(file) ||
    fs.realpathSync(file) !== file ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('unsafe_summary_path');
  return `${stat.dev}:${stat.ino}`;
}
export function delegationSummaryPath(home: string, ref: SessionRef): string {
  return join(home, 'delegation-summaries-v1', `${digest(sessionRefKey(ref))}.json`);
}

/** Constant file count, exact byte cap, no SQLite/transcript/collector reads or writes. */
export function readDelegationSummary(
  home: string,
  ref: SessionRef,
  options: { nowMs?: number; budgetMs?: number; clock?: () => number } = {}
): CommittedDelegationSummary | null {
  const clock = options.clock ?? (() => performance.now());
  const start = clock();
  const budget = Math.min(20, options.budgetMs ?? 20);
  const timely = () => Number.isFinite(budget) && budget > 0 && clock() - start < budget;
  let fd: number | undefined;
  let result: CommittedDelegationSummary | null = null;
  try {
    if (!timely()) return null;
    const gate = new PrivateLedgerGate(home);
    const ledgerIdentity = summaryFileIdentity(gate.path);
    const dir = join(home, 'delegation-summaries-v1');
    const dirIdentity = summaryFileIdentity(dir, true);
    const file = delegationSummaryPath(home, ref);
    const fileIdentity = summaryFileIdentity(file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      `${stat.dev}:${stat.ino}` !== fileIdentity ||
      stat.size > DELEGATION_SUMMARY_MAX_BYTES ||
      !timely()
    )
      return null;
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!n) break;
      count += n;
      if (!timely()) return null;
    }
    if (count !== stat.size) return null;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)));
    const now = options.nowMs ?? Date.now();
    if (!validateDelegationSummary(value, ref, now) || value.ledgerFileIdentity !== ledgerIdentity) return null;
    gate.check();
    if (summaryFileIdentity(dir, true) !== dirIdentity || summaryFileIdentity(file) !== fileIdentity) return null;
    result = value;
  } catch {
    result = null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        result = null;
      }
  }
  return timely() ? result : null;
}

/** Atomic whole-envelope publication only. No v2 snapshot or observation/checkpoint is modified. */
export function writeDelegationSummary(home: string, value: CommittedDelegationSummary): boolean {
  let temporary: string | undefined;
  try {
    if (!validateDelegationSummary(value, value.parent, Date.now())) return false;
    const gate = new PrivateLedgerGate(home);
    if (summaryFileIdentity(gate.path) !== value.ledgerFileIdentity) return false;
    const directory = join(home, 'delegation-summaries-v1');
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const directoryIdentity = summaryFileIdentity(directory, true);
    const file = delegationSummaryPath(home, value.parent);
    try {
      summaryFileIdentity(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > DELEGATION_SUMMARY_MAX_BYTES) return false;
    temporary = join(directory, `.pending-${randomUUID()}`);
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    gate.check();
    if (summaryFileIdentity(directory, true) !== directoryIdentity) return false;
    fs.renameSync(temporary, file);
    temporary = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temporary)
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* only this writer's temporary */
      }
  }
}

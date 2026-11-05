/** Linux-only, bounded private-file operations. No home discovery or initialization. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export const LIMIT = 64 * 1024;
export const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export class MigrationError extends Error {}
export function fail(reason: string): never {
  throw new MigrationError(reason);
}
export interface Fingerprint {
  hash: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  size: number;
  mtimeMs: number;
}
export interface Snapshot {
  bytes: Buffer;
  fingerprint: Fingerprint;
}
export interface Directory {
  path: string;
  fdPath: string;
  identity: { dev: number; ino: number };
  check(): void;
  sync(): void;
}
export function privateDirectory<T>(directory: string, work: (directory: Directory) => T): T {
  if (process.platform !== 'linux') fail('migration_linux_only');
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory) || path.normalize(directory) !== directory)
    fail('migration_unsafe_directory');
  const validate = () => {
    const s = fs.lstatSync(directory);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory ||
      s.uid !== process.getuid?.() ||
      process.getuid?.() !== process.geteuid?.() ||
      (s.mode & 0o077) !== 0
    )
      fail('migration_unsafe_directory');
    return s;
  };
  const first = validate();
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (first.dev !== opened.dev || first.ino !== opened.ino) fail('migration_directory_changed');
    const check = () => {
      const now = validate();
      if (now.dev !== opened.dev || now.ino !== opened.ino) fail('migration_directory_changed');
    };
    check();
    return work({
      path: directory,
      fdPath: `/proc/self/fd/${fd}`,
      identity: { dev: opened.dev, ino: opened.ino },
      check,
      sync: () => fs.fsyncSync(fd),
    });
  } finally {
    fs.closeSync(fd);
  }
}
export function readPrivate(file: string, limit = LIMIT): Snapshot | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return fail('migration_unsafe_file');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      ![0o400, 0o600].includes(stat.mode & 0o7777) ||
      stat.size > limit
    )
      fail('migration_unsafe_file');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) fail('migration_input_limit');
    const after = fs.fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      fail('migration_input_changed');
    const bytes = Buffer.from(buffer.subarray(0, size));
    return {
      bytes,
      fingerprint: {
        hash: hash(bytes),
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode & 0o777,
        uid: stat.uid,
        size,
        mtimeMs: stat.mtimeMs,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}
export const fingerprint = (value: Snapshot | null): Fingerprint | null => value?.fingerprint ?? null;
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function createPrivate(file: string, bytes: Buffer, mode = 0o600): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function locked<T>(dir: Directory, work: () => T): T {
  const lock = path.join(dir.fdPath, '.hud-migrate.lock');
  let fd: number;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('migration_busy');
    throw error;
  }
  const original = fs.fstatSync(fd);
  try {
    dir.check();
    return work();
  } finally {
    fs.closeSync(fd);
    const current = fs.lstatSync(lock);
    if (current.dev === original.dev && current.ino === original.ino) fs.unlinkSync(lock);
  }
}
export function jsonObject(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      (_key, value: unknown) => {
        if (
          typeof value === 'number' &&
          (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        )
          throw new Error('unrepresentable_number');
        return value;
      }
    );
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    /* Stable error, never echo input (which may contain credentials). */
  }
  return fail('migration_invalid_json');
}

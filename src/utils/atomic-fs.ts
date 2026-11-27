import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

interface WriteOptions {
  mkdir?: boolean;
  dotPrefix?: boolean;
  beforeRename?: () => void;
  exclusive?: boolean;
  fsync?: boolean;
}

/** Publish a complete file in its own directory. The returned stat belongs to the
 * published inode, even if a competing writer has already replaced the path. */
export function writeFileAtomic(file: string, data: string | Uint8Array, options: WriteOptions & { mode?: number } = {}): fs.Stats {
  const dir = dirname(file);
  if (options.mkdir !== false) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `${options.dotPrefix ? '.' : ''}${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  let renamed = false;
  try {
    let stat: fs.Stats;
    try {
      fs.writeFileSync(fd, data);
      fs.fchmodSync(fd, options.mode ?? 0o600);
      if (options.fsync) fs.fsyncSync(fd);
      stat = fs.fstatSync(fd);
    } finally { fs.closeSync(fd); }
    options.beforeRename?.();
    if (options.exclusive) fs.linkSync(temp, file); // Never replace an existing claim.
    else { fs.renameSync(temp, file); renamed = true; }
    return stat;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(temp); } catch { /* Preserve the original failure. */ }
    }
  }
}

export function writePrivateFile(file: string, data: string | Uint8Array, options?: WriteOptions): fs.Stats {
  return writeFileAtomic(file, data, options);
}

export function writeJsonPrivate(file: string, value: unknown, options?: WriteOptions): void {
  writePrivateFile(file, JSON.stringify(value) + '\n', options);
}

/** Missing, malformed and unreadable are distinguished by the caller. For files
 * without a size contract, retain readFileSync's existing symlink behavior. */
export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readDirSafe(dir: string): string[] {
  try { return fs.readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Read a regular file through one fd without following a leaf symlink or blocking on a FIFO. */
export function readRegularNoFollow(file: string): { data: Buffer; stat: fs.Stats } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    return stat.isFile() ? { data: fs.readFileSync(fd), stat } : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Read from one opened inode; never block opening a FIFO. Probe one extra byte
 * and handle short reads, without allocating the full limit for a small file. */
export function readFileBounded(file: string, limit: number, options: {
  followSymlinks?: boolean;
  validate?: (stat: fs.Stats) => void;
  offset?: number;
} = {}): { bytes: Buffer; stat: fs.Stats; truncated: boolean } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (options.followSymlinks ? 0 : fs.constants.O_NOFOLLOW));
  try {
    const stat = fs.fstatSync(fd);
    options.validate?.(stat);
    if (!stat.isFile()) throw new Error('bounded_regular_file_required');
    const offset = options.offset ?? 0;
    const oversize = stat.size - offset > limit;
    const cap = oversize ? limit : limit + 1;
    let buffer = Buffer.alloc(Math.min(Math.max(0, stat.size - offset) + 1, cap));
    let length = 0;
    while (length < cap) {
      if (length === buffer.length) { // The file grew after fstat (or reports size zero).
        const larger = Buffer.alloc(Math.min(cap, Math.max(4096, length * 2)));
        buffer.copy(larger); buffer = larger;
      }
      const count = fs.readSync(fd, buffer, length, buffer.length - length, offset + length);
      if (!count) break;
      length += count;
    }
    return { bytes: buffer.subarray(0, Math.min(length, limit)), stat, truncated: oversize || length > limit };
  } finally { fs.closeSync(fd); }
}

export function readJsonBounded(file: string, limit: number): unknown {
  const { bytes, truncated } = readFileBounded(file, limit);
  if (truncated) throw new Error('file_too_large');
  return JSON.parse(bytes.toString('utf8'));
}

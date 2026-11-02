import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { Refusal } from './errors.js';

/** One bounded snapshot; no retry, transcript-wide scan, or follow of a final symlink. */
export function readBounded(file: string, maxBytes: number, tail = false, pseudo = false): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Refusal('identity_unverified');
    const length = pseudo ? maxBytes : Math.min(stat.size, maxBytes);
    const start = tail ? Math.max(0, stat.size - length) : 0;
    const buffer = Buffer.alloc(length);
    const n = readSync(fd, buffer, 0, length, start);
    const after = fstatSync(fd);
    if (after.ino !== stat.ino || after.size < stat.size) throw new Refusal('identity_unverified');
    let text = buffer.subarray(0, n).toString('utf8');
    if (tail && start > 0) text = text.slice(text.indexOf('\n') + 1);
    // An incomplete final record never supplies identity.
    if (!pseudo && tail && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
    return text;
  } finally {
    closeSync(fd);
  }
}
export function readJson(file: string, maxBytes = 16384): unknown {
  const text = readBounded(file, maxBytes + 1);
  if (Buffer.byteLength(text) > maxBytes) throw new Refusal('identity_unverified');
  return JSON.parse(text) as unknown;
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

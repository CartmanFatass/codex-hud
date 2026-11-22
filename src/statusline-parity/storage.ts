/** Bounded, private display-only state. Never follows a link or opens a FIFO for reading. */
import * as fs from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { getHudDisplayHome } from '../hud-home.js';
export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function noLinks(file: string): void {
  if (!isAbsolute(file)) throw new Error('absolute_path_required');
  for (let p = file; ; p = dirname(p)) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error('symlink_refused');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (p === dirname(p)) break;
  }
}
export function readBytes(file: string, limit = 1024 * 1024): Buffer | null {
  noLinks(file);
  try {
    const { bytes, truncated } = readFileBounded(file, limit, { validate: (s) => {
      if (!s.isFile() || s.size > limit) throw new Error('bounded_regular_file_required');
    } });
    if (truncated) throw new Error('file_too_large');
    return bytes;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export function readJson(file: string): Record<string, unknown> | null {
  const b = readBytes(file);
  try {
    if (!b) return null;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error('invalid_json');
  }
}
export function saveJson(file: string, value: unknown): void {
  noLinks(file);
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  noLinks(file);
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('cache_limit');
  writePrivateFile(file, bytes, { mkdir: false });
}
export function cachePath(env: NodeJS.ProcessEnv, kind: string, identity: string): string {
  return join(
    getHudDisplayHome(env),
    'statusline',
    kind + '-' + createHash('sha256').update(identity).digest('hex') + '.json'
  );
}
export function cached<T>(file: string): T | null {
  try {
    const s = fs.lstatSync(file);
    if (s.uid !== process.getuid?.() || s.mode & 0o077 || s.nlink !== 1) return null;
    const v = readJson(file);
    return record(v).version === 1 ? (v as T) : null;
  } catch {
    return null;
  }
}
export function signature(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return '-';
  }
}

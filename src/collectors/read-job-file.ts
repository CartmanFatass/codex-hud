import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

type Reading = { text: string; stamp: string; size?: number };
const readings = new Map<string, Reading>();

/** Bounded, signature-cached reads of regular evidence files, never following symlinks. */
export function readJobFile(file: string, limit = 4096): Reading {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (fs.realpathSync(file) !== file || !before.isFile()) throw new Error('unsafe');
    const key = `${file}:${limit}`, stamp = `${before.ino}:${before.size}:${before.mtimeMs}`;
    const hit = readings.get(key);
    if (hit?.stamp === stamp) return hit;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd), buffer = Buffer.alloc(Math.min(limit, s.size));
    if (!s.isFile() || s.ino !== before.ino || s.dev !== before.dev) throw new Error('changed');
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (fs.realpathSync(file) !== file || fs.statSync(file).ino !== s.ino) throw new Error('changed');
    const bytes = buffer.subarray(0, n);
    const text = n < s.size ? new StringDecoder('utf8').write(bytes) : bytes.toString('utf8');
    const result = { text, stamp, size: s.size };
    readings.set(key, result);
    if (readings.size > 1000) readings.delete(readings.keys().next().value!);
    return result;
  } catch {
    return { text: '', stamp: '' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

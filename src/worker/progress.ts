import * as fs from 'node:fs';
import { join } from 'node:path';
import { jobFiles } from '../mcp/paths.js';
import { writePrivateFile } from '../utils/atomic-fs.js';

export function progress({ dir }: { dir: string }, message: string, source?: 'checkpoint') {
  const text = [...message.replace(/[\r\n\u2028\u2029]+/gu, ' ').replace(/\p{Cc}/gu, '').trim()]
    .slice(0, 240).join('').trimEnd();
  if (!text) throw new Error('usage: hud-progress [--dir <job-dir>] <message>');
  const record = JSON.stringify({ at: new Date().toISOString(), text, source }) + '\n';
  const file = join(dir, jobFiles.progress);
  const { O_RDWR, O_CREAT, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(file, O_RDWR | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    const limit = 64 * 1024;
    if (!fs.fstatSync(fd).isFile()) throw new Error('progress.jsonl is not a regular file');
    const buffer = Buffer.alloc(limit + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > limit) throw new Error('progress.jsonl exceeds 64 KiB');
    const previous = buffer.subarray(0, size).toString('utf8');
    const rows = previous.trimEnd().split('\n').filter(Boolean);
    if (rows.length < 50 && (!previous || previous.endsWith('\n'))) fs.appendFileSync(fd, record);
    else writePrivateFile(file, [...rows.slice(-49), record.trimEnd()].join('\n') + '\n', { mkdir: false });
  } finally { fs.closeSync(fd); }
  return { ok: true };
}

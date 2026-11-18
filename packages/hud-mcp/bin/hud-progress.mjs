#!/usr/bin/env node
/** Publish one optional milestone from a local worker. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

try {
  const { values, positionals } = parseArgs({ options: { dir: { type: 'string' } }, allowPositionals: true });
  const path = values.dir ?? process.env.HUD_JOB_DIR;
  const dir = path && fs.realpathSync(path);
  const root = join(fs.realpathSync(process.env.HUD_HOME || join(homedir(), '.hud')), 'jobs');
  if (!dir || dirname(dir) !== root || !/^j[0-9a-f]{16}$/.test(basename(dir)) ||
      JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).job !== basename(dir)) {
    throw new Error('--dir must name a job directory under HUD_HOME');
  }
  const text = [...positionals.join(' ').replace(/[\r\n\u2028\u2029]+/gu, ' ').replace(/\p{Cc}/gu, '').trim()]
    .slice(0, 240).join('').trimEnd();
  if (!text) throw new Error('usage: hud-progress [--dir <job-dir>] <message>');
  const record = JSON.stringify({ at: new Date().toISOString(), text }) + '\n';
  const file = join(dir, 'progress.jsonl');
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
    else {
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, [...rows.slice(-49), record.trimEnd()].join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      try { fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
    }
  } finally { fs.closeSync(fd); }
} catch (error) {
  console.error(`hud-progress: ${error.message}`);
  process.exitCode = 1;
}

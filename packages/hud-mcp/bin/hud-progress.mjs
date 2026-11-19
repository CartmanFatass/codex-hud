#!/usr/bin/env node
/** Publish an optional milestone or explicitly declare completion from a local worker. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

function replace(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { dir: { type: 'string' }, done: { type: 'boolean' }, turn: { type: 'string' } },
    allowPositionals: true,
  });
  const path = values.dir ?? process.env.HUD_JOB_DIR;
  const dir = path && fs.realpathSync(path);
  const root = join(fs.realpathSync(process.env.HUD_HOME || join(homedir(), '.hud')), 'jobs');
  if (!dir || dirname(dir) !== root || !/^j[0-9a-f]{16}$/.test(basename(dir))) {
    throw new Error('--dir must name a job directory under HUD_HOME');
  }
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
  if (job.job !== basename(dir)) throw new Error('--dir must name a job directory under HUD_HOME');
  if (values.done) {
    if (positionals.length || job.bro || job.jev) throw new Error('--done is for local worker reports, not milestones');
    const { DONE_FILE, readTurn, turnToken, reportSignature } = await import('../dist/packages/hud-mcp/src/cli-judge.js');
    if (job.cli) {
      const turn = readTurn(dir);
      if (!turn || values.turn !== turnToken(turn)) throw new Error('use the --turn token from the prompt you are answering');
      const sig = reportSignature(dir);
      if (!sig || sig === turn.report_sig) throw new Error('write a fresh report for this turn first');
      const latest = readTurn(dir);
      if (!latest || turnToken(latest) !== values.turn) throw new Error('the turn changed; no receipt recorded');
      replace(join(dir, DONE_FILE), JSON.stringify({ seq: turn.seq, sent_at: turn.sent_at, report_sig: sig, at: new Date().toISOString() }) + '\n');
    } else {
      // Pi has its own turn-end declaration. Capture ancestry before native shutdown can orphan it.
      if (values.turn || !reportSignature(dir)) throw new Error('write the pi report first; pi does not use --turn');
      const { rememberWorkerTree } = await import('../dist/src/roles/worker-tree.js');
      const status = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8'));
      const { issue } = rememberWorkerTree(dir, status);
      if (issue) console.error(`hud-progress: ${issue}; the watcher will retry cleanup`);
    }
    return;
  }
  if (values.turn !== undefined) throw new Error('--turn requires --done');
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
    else replace(file, [...rows.slice(-49), record.trimEnd()].join('\n') + '\n');
  } finally { fs.closeSync(fd); }
}

try { await main(); } catch (error) {
  console.error(`hud-progress: ${error.message}`);
  process.exitCode = 1;
}

/** Run main-session checks once for the declared report. Never write lifecycle state. */
import { checkBinding, CHECKS_FILE, CHECK_TIMEOUT_MS, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { procStat } from '../utils/proc.js';
import { readJsonFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import type { CheckBinding, CheckReceipt, CheckResult, Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export function main() {
  const dir = fs.realpathSync(process.argv[2]), file = join(dir, CHECKS_FILE);
  const expected = JSON.parse(process.argv[3]) as CheckBinding;
  const TAIL_BYTES = 2048;
  const { HUD_JOB_DIR: _workerJob, ...env } = process.env;
  function run(command: string, cwd: string): Promise<CheckResult> {
    const start = performance.now();
    return new Promise((resolve) => {
      const child = spawn('bash', ['-lc', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = Buffer.alloc(0), timedOut = false;
      const append = (chunk: Buffer) => { tail = Buffer.concat([tail, chunk.subarray(-TAIL_BYTES)]).subarray(-TAIL_BYTES); };
      const killGroup = () => {
        if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) => append(Buffer.from(error.message)));
      child.once('exit', killGroup); // Leftovers must not keep this check (or its output pipes) alive.
      const timeout = setTimeout(() => {
        timedOut = true;
        killGroup();
        child.stdout.destroy(); child.stderr.destroy();
      }, CHECK_TIMEOUT_MS);
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve({ command, exit_code: timedOut ? null : code, duration_ms: Math.round(performance.now() - start),
          output_tail: tail.toString('utf8'), ...(timedOut ? { timed_out: true } : {}) });
      });
    });
  }
  function save(receipt: CheckReceipt) {
    writeJsonPrivate(file, receipt, { mkdir: false });
  }
  // ensureWatcher permits racing starts. Only one helper for this directory may run commands.
  const lock = createServer((socket) => socket.destroy());
  lock.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; });
  lock.listen(`\0myhud-check-${createHash('sha256').update(dir).digest('hex')}`, async () => {
    try {
      const job = readJsonFile(join(dir, jobFiles.job)) as Job;
      const binding = checkBinding(dir, job, readJsonFile(join(dir, jobFiles.status)) as JobStatus);
      if (!binding || !sameChecks(binding, expected)) return;
      const prior = readCheckReceipt(dir);
      const interrupted = sameChecks(prior, binding);
      if (interrupted && prior?.state === 'done') return;
      const results: CheckResult[] = [];
      save({ ...binding, state: 'running', pid: process.pid, start: procStat(process.pid)?.start, results });
      for (const command of job.checks!) results.push(interrupted
        ? { command, exit_code: null, duration_ms: 0, output_tail: 'Check helper interrupted; result unavailable.' }
        : await run(command, job.cwd));
      save({ ...binding, state: 'done', results });
    } finally { lock.close(); }
  });
}

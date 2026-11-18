#!/usr/bin/env node
/** Dispatch a sonic sub-task and collect it separately, from any local HUD worker. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { sonicState } from './sonic-jobs.mjs';

const idPattern = /^j[0-9a-f]{16}$/;
function readJob(dir) {
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
  if (job.job !== basename(dir)) throw new Error('not a HUD job directory');
  return job;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['start', 'wait'].includes(command)) throw new Error('usage: hud-sonic start|wait --dir <own job dir>');
  const string = { type: 'string' };
  const { values } = parseArgs({ args, options: {
    dir: string,
    ...(command === 'start' ? { 'task-file': string, thinking: string } : { job: string, timeout: string }),
  } });
  if (!values.dir) throw new Error('--dir must name your job directory under HUD_HOME');
  const dir = fs.realpathSync(values.dir);
  const root = join(fs.realpathSync(process.env.HUD_HOME || join(homedir(), '.hud')), 'jobs');
  if (dirname(dir) !== root || !idPattern.test(basename(dir))) throw new Error('--dir must name your job directory under HUD_HOME');
  const parent = readJob(dir);
  if (command === 'start') {
    if (parent.role === 'sonic') throw new Error('a sonic worker cannot start sonic');
    if (!values['task-file']) throw new Error('--task-file is required');
    if (values.thinking !== undefined && !['off', 'low', 'medium', 'high'].includes(values.thinking)) {
      throw new Error('--thinking must be off, low, medium or high');
    }
    const task = fs.readFileSync(values['task-file'], 'utf8');
    const { dispatchJob } = await import('../dist/packages/hud-mcp/src/thin-main.js');
    const result = await dispatchJob({
      role: 'sonic', request_key: `sonic:${randomUUID()}`, cwd: parent.cwd, task, thinking: values.thinking,
    }, parent.herdr_pane, parent.job);
    if (!result.job) throw new Error(result.error ?? result.code);
    // A launch failure with a job receipt is also collectable via wait, after inspecting STATUS.
    console.log(result.job);
    return;
  }
  if (!idPattern.test(values.job ?? '')) throw new Error('--job must be a sonic child job id');
  const child = join(root, values.job);
  if (fs.realpathSync(child) !== child || readJob(child).parent_job !== parent.job) {
    throw new Error('job is not a sonic child of this --dir');
  }
  const seconds = Number(values.timeout ?? '480');
  if (values.timeout?.trim() === '' || !Number.isFinite(seconds * 1000) || seconds < 0) {
    throw new Error('--timeout must be a nonnegative number of seconds');
  }
  const deadline = performance.now() + seconds * 1000;
  for (;;) {
    const status = sonicState(child);
    if (status.state === 'failed') throw new Error(status.reason);
    if (status.state === 'settled') {
      const report = join(child, 'report.md');
      const body = fs.readFileSync(report, 'utf8');
      fs.writeFileSync(join(child, 'sonic-collected'), '', { mode: 0o600 });
      process.stdout.write(`${report}\n${body}`);
      return;
    }
    const left = deadline - performance.now();
    if (left <= 0) {
      console.log('still working: run wait again');
      return 3;
    }
    await sleep(Math.min(250, left));
  }
}
try {
  process.exitCode = await main() ?? 0;
} catch (error) {
  console.error(`hud-sonic: ${error.message}`);
  process.exitCode = 1;
}

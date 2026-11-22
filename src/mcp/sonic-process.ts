/** One-shot pi launch and lifecycle. No herdr session, idle grace or turn driver. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureJobWatcher } from './watch-pid.js';
import { binScript, jobFiles } from './paths.js';
import type { Job, JobStatus } from './job-contracts.js';
import { publishRunnerLifetime } from '../utils/runner-lifetime.js';
import { procStat, readBootId } from '../utils/proc.js';
import { readJsonBounded, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';
import { rememberWorkerTree, sonicRoot } from '../roles/worker-tree.js';
import { readDone, reportSignature } from '../roles/cli-turn.js';
import { waitUntilFs } from '../utils/fs-wait.js';

export const SONIC_TIMEOUT_MS = 10 * 60_000;
export function startSonicProcess(dir: string, job: Job, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HUD_HOME: dirname(dirname(dir)), HUD_JOB_DIR: dir };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_ENV;
  const fds: number[] = [];
  try {
    for (const name of [jobFiles.sonicStdout, jobFiles.sonicStderr]) fds.push(fs.openSync(join(dir, name), 'wx', 0o600));
    const child = spawn(process.execPath, [binScript('sonic-run'), dir, ...args], { cwd: job.cwd, env, detached: true,
      stdio: ['pipe', fds[0]!, fds[1]!] });
    child.once('error', () => {}); // A failed spawn has no PID; a failed handshake never starts pi.
    child.stdin!.on('error', () => {});
    child.unref();
    try {
      const pid = child.pid, start = pid && procStat(pid)?.start, boot = readBootId();
      if (!pid || !start || !boot) throw Error('cannot identify sonic runner');
      const status: JobStatus = { state: 'working', slot: 'sonic', task_dir: dir, harness: 'pi', role: 'sonic',
        pid, pid_start_time: start, boot_id: boot, started_at: new Date().toISOString() };
      writeJsonPrivate(join(dir, jobFiles.status), status, { mkdir: false });
      const capture = rememberWorkerTree(dir, status);
      if (capture.issue || !capture.snapshot) throw Error(capture.issue ?? 'cannot capture sonic runner');
      child.stdin!.end('start');
    } catch (error) { child.stdin!.destroy(); throw error; }
  } finally { for (const fd of fds) fs.closeSync(fd); }
}

/** Run in the owned runner, after the dispatch handshake. Retain the pi PID before a runner crash could orphan it. */
export async function runSonicPi(dir: string, argv: string[]) {
  // No input until dispatch has durably bound this runner to STATUS. A lost launcher closes the pipe.
  await publishRunnerLifetime(dir);
  let go = '';
  for await (const chunk of process.stdin) go += chunk;
  if (go !== 'start') return;
  const status = readJsonBounded(join(dir, jobFiles.status), 8192) as JobStatus;
  const child = spawn('pi', argv, { stdio: ['ignore', 'inherit', 'inherit'] });
  const exit = new Promise<{ code: number | null; signal?: string | null; error?: string }>(resolve => {
    child.once('error', error => resolve({ code: null, error: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (child.pid) {
    const capture = rememberWorkerTree(dir, status);
    if (capture.issue || !capture.snapshot) {
      child.kill('SIGKILL');
      throw Error(capture.issue ?? 'cannot capture sonic child');
    }
  }
  // Wake a replacement watcher if the original died while pi was running. The watcher is
  // the sole terminal writer, even when the dispatcher's MCP connection is already gone.
  const wake = () => ensureJobWatcher(dirname(dirname(dir)));
  const timer = setTimeout(wake, Math.max(1, Date.parse(status.started_at!) + SONIC_TIMEOUT_MS - Date.now()));
  try {
    const result = await exit;
    writeJsonPrivate(join(dir, jobFiles.sonicExit), { ...result, at: Date.now() }, { mkdir: false });
    wake();
  } finally { clearTimeout(timer); }
}

export function sonicExit(dir: string, status: Partial<JobStatus>): Pick<JobStatus, 'state' | 'exit_reason'> | null {
  if (fs.existsSync(join(dir, jobFiles.stopRequested))) return { state: 'stopped', exit_reason: 'stopped' };
  const deadline = Date.parse(status.started_at!) + SONIC_TIMEOUT_MS;
  const timeout = { state: 'failed', exit_reason: 'timeout' } as const;
  if (fs.existsSync(join(dir, jobFiles.sonicTimeout))) return timeout;
  // Check the exit receipt after observing liveness (the runner publishes it before exiting).
  const root = sonicRoot(dir, status.pid!, status.pid_start_time!, status.boot_id);
  let exit;
  try { exit = readJsonBounded(join(dir, jobFiles.sonicExit), 4096) as { at: number; code: number | null; signal?: string; error?: string }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (Date.now() >= deadline) return timeout;
    return root === 'owned' ? null : { state: 'failed', exit_reason: 'sonic runner exited without an exit receipt' };
  }
  if (exit.at >= deadline) return timeout;
  if (exit.code !== 0) return { state: 'failed', exit_reason: exit.error || `pi exited: ${exit.signal || exit.code}` };
  const sig = readDone(dir)?.report_sig;
  return sig && sig === reportSignature(dir) ? { state: 'closed', exit_reason: 'settled' }
    : { state: 'failed', exit_reason: 'pi exited without a declared report' };
}

export async function killSonicRoot(dir: string, status: Partial<JobStatus>) {
  const owned = () => sonicRoot(dir, status.pid!, status.pid_start_time!, status.boot_id) === 'owned';
  if (owned()) {
    try { process.kill(status.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    for (let i = 0; i < 10 && owned(); i++) await delay(20);
  }
  return !owned();
}

export async function stopSonic(dir: string, timeout = false) {
  const read = () => (readJsonBounded(join(dir, jobFiles.status), 8192) as JobStatus).state;
  const terminal = (state: string) => ['closed', 'failed', 'stopped'].includes(state);
  if (!fs.existsSync(join(dir, jobFiles.status)) || !terminal(read())) {
    writePrivateFile(join(dir, timeout ? jobFiles.sonicTimeout : jobFiles.stopRequested), '', { mkdir: false });
    ensureJobWatcher(dirname(dirname(dir)));
    return waitUntilFs<boolean>({ targets: [{ dir, filter: (name) => !name || name === jobFiles.status }], timeoutMs: 10000,
      check: ({ timedOut }) => {
        const done = fs.existsSync(join(dir, jobFiles.status)) && terminal(read());
        return done || timedOut ? { done: true, value: done } : { done: false };
      } });
  }
  return true;
}

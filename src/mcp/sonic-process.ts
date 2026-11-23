/** One detached runner per headless turn. Sonic is one-shot; other roles reopen their job's session. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureJobWatcher } from './watch-pid.js';
import { hasHeadlessSends, noHeadlessReport } from './headless-sends.js';
import { sonicSession } from './sonic-session.js';
import { briefPrompt } from './brief-prompt.js';
import { binScript, jobFiles } from './paths.js';
import type { Job, JobStatus } from './job-contracts.js';
import { publishRunnerLifetime } from '../utils/runner-lifetime.js';
import { procStat, readBootId } from '../utils/proc.js';
import { readFileBounded, readJsonBounded, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';
import { rememberWorkerTree, sonicRoot } from '../roles/worker-tree.js';
import { readDone, readTurn, receiptForTurn, reportSignature } from '../roles/cli-turn.js';
import { REPORT_SETTLED_EXIT } from './cli-judge.js';
import { waitUntilFs } from '../utils/fs-wait.js';
import { progress } from '../worker/progress.js';
import { monitorSonic, sonicLimitDefaults, type SonicLimits, type SonicStop } from './sonic-policy.js';

export function startHeadlessProcess(dir: string, job: Job, args: string[], session?: { file?: string; id?: string; initialId?: string }, limits?: SonicLimits) {
  const env: NodeJS.ProcessEnv = { ...process.env, HUD_HOME: dirname(dirname(dir)), HUD_JOB_DIR: dir };
  if (session?.file && session.id) env.HUD_RESUME_SESSION_ID = session.id;
  else delete env.HUD_RESUME_SESSION_ID;
  if (job.cli?.agent === 'claude') {
    // Like a worker tab, this is a separate Claude session, not a nested Claude invocation.
    delete env.CLAUDECODE;
    if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = resolve(env.CLAUDE_CONFIG_DIR);
  }
  delete env.HERDR_PANE_ID;
  delete env.HERDR_ENV;
  const fds: number[] = [];
  const created: string[] = [];
  try {
    const { O_WRONLY, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    for (const name of [jobFiles.sonicStdout, jobFiles.sonicStderr]) {
      const path = join(dir, name);
      const fd = fs.openSync(path, session?.id ? O_WRONLY | O_APPEND | O_NOFOLLOW | O_NONBLOCK : 'wx', 0o600);
      fds.push(fd);
      if (!session?.id) created.push(path);
      if (!fs.fstatSync(fd).isFile()) throw Error('worker log is not a regular file');
    }
    const child = spawn(process.execPath, [binScript('sonic-run'), dir, ...args], { cwd: job.cwd, env, detached: true,
      stdio: ['pipe', fds[0]!, fds[1]!] });
    child.once('error', () => {}); // A failed spawn has no PID; a failed handshake never starts the harness.
    child.stdin!.on('error', () => {});
    child.unref();
    try {
      const pid = child.pid, start = pid && procStat(pid)?.start, boot = readBootId();
      if (!pid || !start || !boot) throw Error('cannot identify sonic runner');
      if (session?.id) {
        fs.rmSync(join(dir, jobFiles.sonicExit), { force: true });
        if (!job.cli) fs.rmSync(join(dir, jobFiles.done), { force: true });
      }
      const status: JobStatus = { state: 'working', slot: session ? 'headless' : 'sonic', task_dir: dir, role: job.role,
        ...(job.cli ? { harness: 'cli', agent: job.cli.agent, agent_session_id: session?.id ?? session?.initialId }
          : { harness: 'pi', session_file: session?.file, session_id: session?.id }), ...(limits && { sonic_limits: limits }),
        pid, pid_start_time: start, boot_id: boot, started_at: new Date().toISOString() };
      writeJsonPrivate(join(dir, jobFiles.status), status, { mkdir: false });
      const capture = rememberWorkerTree(dir, status);
      if (capture.issue || !capture.snapshot) throw Error(capture.issue ?? 'cannot capture sonic runner');
      child.stdin!.end('start');
    } catch (error) { child.stdin!.destroy(); throw error; }
  } catch (error) {
    // A subsequent attempt can start another headless place. Only remove files this failed launch created.
    for (const path of created) fs.rmSync(path, { force: true });
    throw error;
  } finally { for (const fd of fds) fs.closeSync(fd); }
}

type HeadlessExit = { code: number | null; signal?: string | null; paused?: boolean; error?: string; agent_session_id?: string };

function cliStreamSession(dir: string, agent: string, offset: number) {
  // The native init record precedes conversation output. Read only this turn's bounded log prefix.
  const stdout = fs.fstatSync(1);
  const { bytes, truncated } = readFileBounded(join(dir, jobFiles.sonicStdout), 256 * 1024, { offset,
    validate: stat => { if (stat.dev !== stdout.dev || stat.ino !== stdout.ino) throw Error('worker log changed'); } });
  const lines = bytes.toString('utf8').split('\n');
  if (truncated) lines.pop();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const id = agent === 'claude' && event?.type === 'system' && event.subtype === 'init' ? event.session_id
      : agent === 'agy' && event?.event === 'init' ? event.conversation_id : undefined;
    if (typeof id === 'string' && /^[\w][\w.-]{0,127}$/.test(id)) return id;
  }
}

async function launchTurn(dir: string, argv: string[], status: JobStatus, command: string) {
  const pause = join(dir, jobFiles.pauseRequested);
  if (status.harness === 'cli') fs.rmSync(pause, { force: true }); // A fresh handoff for each native turn.
  const child = spawn(command, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
  const exit = new Promise<HeadlessExit>(resolve => {
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
  if (status.harness !== 'cli') return exit;
  const controller = new AbortController();
  let escalation;
  try {
    const ended = await Promise.race([exit, waitUntilFs<'pause'>({ signal: controller.signal, timeoutMs: Infinity,
      targets: [{ dir, filter: name => !name || name === jobFiles.pauseRequested }],
      check: () => fs.existsSync(pause) ? { done: true, value: 'pause' as const } : { done: false },
    })]);
    if (ended !== 'pause') return ended;
    // The question and ancestry snapshot are durable. End the native process, not the runner;
    // the watcher reaps its descendants before allowing hud_respond to reopen the session.
    child.kill('SIGTERM');
    escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
    return { ...await exit, paused: true };
  } finally { controller.abort(); clearTimeout(escalation); }
}

/** Run in the owned runner, after the dispatch handshake. Capture the child before a crash could orphan it. */
export async function runHeadlessTurn(dir: string, argv: string[]) {
  // No input until dispatch has durably bound this runner to STATUS. A lost launcher closes the pipe.
  await publishRunnerLifetime(dir);
  let go = '';
  for await (const chunk of process.stdin) go += chunk;
  if (go !== 'start') return;
  const status = readJsonBounded(join(dir, jobFiles.status), 8192) as JobStatus;
  const agent = status.harness === 'cli' ? status.agent : undefined;
  const offset = agent ? fs.fstatSync(1).size : 0;
  if (!agent) process.umask(0o077); // Pi creates and appends its native session file.
  const session = sonicSession(dir), resuming = status.slot === 'sonic' && fs.existsSync(session);
  // Wake a replacement watcher if the original died while the harness was running. The watcher is
  // the sole terminal writer, even when the dispatcher's MCP connection is already gone.
  const wake = () => ensureJobWatcher(dirname(dirname(dir)));
  const inspect = status.slot === 'sonic' && monitorSonic(dir, status.sonic_limits ?? sonicLimitDefaults, Date.parse(status.started_at!));
  const timer = inspect ? setInterval(() => {
    const result = inspect(Date.now());
    if (result.stop) {
      writeJsonPrivate(join(dir, jobFiles.sonicStop), result.stop, { mkdir: false });
      clearInterval(timer);
      wake();
    } else if (result.progress) {
      progress({ dir }, result.progress, 'checkpoint');
      wake();
    }
  }, 1000) : undefined;
  try {
    let result = await launchTurn(dir, argv, status, agent ?? 'pi');
    // JSON mode emits the session header before input. Only retry a rejected Sonic open,
    // never replay work after Pi may already have taken the continuation.
    if (resuming && result.code !== null && result.code !== 0 && fs.statSync(join(dir, jobFiles.sonicStdout)).size === 0 &&
        Date.now() < headlessDeadline(status) && ![jobFiles.stopRequested, jobFiles.sonicStop, jobFiles.sonicTimeout].some(f => fs.existsSync(join(dir, f)))) {
      fs.renameSync(session, `${session}.rejected`);
      result = await launchTurn(dir, [...argv.slice(0, -1), briefPrompt(join(dir, jobFiles.brief))], status, 'pi');
    }
    if (agent && (result.code === 0 || result.paused)) {
      try { result.agent_session_id = cliStreamSession(dir, agent, offset); }
      catch (error) { result.error = (error as Error).message; }
    }
    writeJsonPrivate(join(dir, jobFiles.sonicExit), { ...result, at: Date.now() }, { mkdir: false });
    wake();
  } finally { clearInterval(timer); }
}

export const headlessDeadline = (status: Partial<JobStatus>) => status.slot === 'headless' ? Infinity : Date.parse(status.started_at!) + (status.sonic_limits ?? sonicLimitDefaults).max_s * 1000;

export function sonicExit(dir: string, status: Partial<JobStatus>, asking = false):
    Pick<JobStatus, 'state' | 'exit_reason' | 'agent_session_id' | 'declared_report_sig'> | null {
  if (fs.existsSync(join(dir, jobFiles.stopRequested))) return { state: 'stopped', exit_reason: 'stopped' };
  const deadline = headlessDeadline(status);
  const timeout = { state: 'failed', exit_reason: 'timeout' } as const;
  if (fs.existsSync(join(dir, jobFiles.sonicTimeout))) return timeout;
  try {
    const reason = readJsonBounded(join(dir, jobFiles.sonicStop), 1024) as SonicStop;
    return { state: 'failed', exit_reason: reason };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Check the exit receipt after observing liveness (the runner publishes it before exiting).
  const root = sonicRoot(dir, status.pid!, status.pid_start_time!, status.boot_id);
  let exit;
  try { exit = readJsonBounded(join(dir, jobFiles.sonicExit), 4096) as HeadlessExit & { at: number }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (Date.now() >= deadline) return timeout;
    return root !== 'gone' ? null : { state: 'failed', exit_reason: 'sonic runner exited without an exit receipt' };
  }
  if (exit.at >= deadline) return timeout;
  const agent = status.harness === 'cli' ? status.agent : undefined;
  if ((exit.code !== 0 && !(agent && asking && exit.paused)) || exit.error)
    return { state: 'failed', exit_reason: exit.error || `${agent ?? 'pi'} exited: ${exit.signal || exit.code}`,
      ...(agent && { agent_session_id: null }) };
  if (agent) {
    const id = exit.agent_session_id;
    if (!id || (status.agent_session_id && status.agent_session_id !== id))
      return { state: 'failed', agent_session_id: null, exit_reason: status.agent_session_id
        ? `${agent} did not open the recorded session` : `${agent} exited without a native session ID` };
    if (asking) return { state: 'waiting_orchestrator', agent_session_id: id };
    const turn = readTurn(dir), done = readDone(dir);
    return turn && receiptForTurn(turn, done) && done.report_sig === reportSignature(dir)
      ? { state: 'closed', exit_reason: REPORT_SETTLED_EXIT, agent_session_id: id, declared_report_sig: done.report_sig }
      : { state: 'failed', exit_reason: noHeadlessReport(agent), agent_session_id: id };
  }
  if (asking) return { state: 'waiting_orchestrator' };
  const sig = readDone(dir)?.report_sig;
  return sig && sig === reportSignature(dir) ? { state: 'closed', exit_reason: 'settled' }
    : { state: 'failed', exit_reason: noHeadlessReport() };
}

export async function killSonicRoot(dir: string, status: Partial<JobStatus>) {
  const root = () => sonicRoot(dir, status.pid!, status.pid_start_time!, status.boot_id);
  const state = root();
  if (state === 'gone') return true;
  if (state === 'owned') {
    try { process.kill(status.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  for (let i = 0; i < 10 && root() !== 'gone'; i++) await delay(20);
  return root() === 'gone';
}

export async function stopSonic(dir: string) {
  const read = () => (readJsonBounded(join(dir, jobFiles.status), 8192) as JobStatus).state;
  const terminal = (state: string) => ['closed', 'failed', 'stopped'].includes(state);
  if (hasHeadlessSends(dir) || !fs.existsSync(join(dir, jobFiles.status)) || !terminal(read())) {
    const request = () => {
      writePrivateFile(join(dir, jobFiles.stopRequested), '', { mkdir: false });
      ensureJobWatcher(dirname(dirname(dir)));
    };
    request();
    return waitUntilFs<boolean>({ targets: [{ dir, filter: (name) => !name || name === jobFiles.status }], timeoutMs: 10000,
      check: ({ timedOut, reason }) => {
        const done = fs.existsSync(join(dir, jobFiles.status)) && terminal(read());
        if (!done && reason === 'fallback') request(); // Re-signal if watcher startup raced the file event.
        return done || timedOut ? { done: true, value: done } : { done: false };
      } });
  }
  return true;
}

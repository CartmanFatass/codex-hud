/** Shared herdr-hud direct-exec helpers for CLI and Pi tab launches:
 * reply validation, SESSION receipt writing, failure retention,
 * and interactive readiness polling (including Codex). */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { herdrId } from '../../roles/herdr-run.js';
import { request as herdrRequest, type HerdrReply } from '../../runtime/herdr-socket.js';
import { writePrivateFile } from '../../utils/atomic-fs.js';
import { isValidPid } from '../../utils/proc.js';
import { workerAlive } from '../cli-judge.js';
import type { Job, JobStatus, SessionReceipt } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { jobCache, readCachedStatus, writeCreateStatus } from '../store/job-store.js';
import { ensureWatcher, launchError, launchFailure, type DispatchResult } from './proc.js';

export interface DirectStartIdentity {
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly launchId: string;
  readonly pid: number;
  readonly pidStart: string;
}

export function writeSessionReceipt(dir: string, fields: SessionReceipt): void {
  const entries = Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (entries.some(([, value]) => /[\r\n]/.test(value))) throw new Error('newlines in SESSION values');
  const sessionFile = join(dir, jobFiles.session);
  writePrivateFile(
    sessionFile,
    entries.map(([k, v]) => `${k}=${v}\n`).join(''),
    { mkdir: false }
  );
  jobCache.invalidateFile(sessionFile);
}

/** Validate direct-exec `agent.start` reply: requires consistent tab, root pane, terminal_id, launch_id, pid, pid_start_time. */
export function parseDirectStartReply(reply: HerdrReply): DirectStartIdentity | null {
  const res = reply.result;
  if (!res) return null;
  const tabId = res.tab?.tab_id;
  const paneId = res.root_pane?.pane_id;
  if (!herdrId(tabId) || !herdrId(paneId)) return null;

  const terminalIds = [res.root_pane?.terminal_id, res.agent?.terminal_id].filter((id): id is string => herdrId(id));
  const fallbackTerminalId = herdrId(res.tab?.terminal_id) ? res.tab.terminal_id : undefined;
  const terminalId = terminalIds[0] ?? fallbackTerminalId;
  if (!terminalId || terminalIds.some((id) => id !== terminalId)) return null;

  const launchIds = [res.launch_id, res.tab?.launch_id, res.root_pane?.launch_id, res.agent?.launch_id]
    .filter((id): id is string => herdrId(id));
  const launchId = launchIds[0];
  if (!launchId || launchIds.some((id) => id !== launchId)) return null;

  const pid = res.pid;
  const rawStart = res.pid_start_time;
  const pidStart = typeof rawStart === 'number' && Number.isSafeInteger(rawStart) && rawStart >= 0
    ? String(rawStart)
    : typeof rawStart === 'string' && /^\d+$/.test(rawStart) ? rawStart : undefined;
  if (!isValidPid(pid) || !pidStart) return null;

  return { tabId, paneId, terminalId, launchId, pid, pidStart };
}

/** Known pre-spawn rejection codes from herdr-hud (`src/app/agents.rs` and `src/api/server.rs`).
 * Only these prove nothing was spawned and justify trying the next place.
 * `agent_start_failed` (which can occur after tab creation) and all other errors are unknown. */
export const DIRECT_PRE_SPAWN_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_params',
  'unknown_method',
  'invalid_agent_name',
  'unsupported_agent_kind',
  'invalid_agent_argument',
  'invalid_env',
  'workspace_not_found',
  'agent_pane_not_found',
  'agent_name_taken',
  'invalid_agent_timeout',
  'agent_pane_busy',
  'agent_pane_unavailable',
]);

/** Send direct-exec `agent.start` over the socket.
 * - Known pre-spawn RPC rejection code -> pre-spawn rejection (`preInput: true, cleanupFailed: false`).
 * - `agent_start_failed`, any other error, lost/timed-out, or malformed/ambiguous reply ->
 *   unknown state (`preInput: false, cleanupFailed: true, launchUnknown: true`),
 *   blocking `canTryNext` and worktree cleanup. */
export async function startDirectAgent(
  params: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<{ ok: true; identity: DirectStartIdentity } | { ok: false; result: DispatchResult }> {
  const reply = await herdrRequest('agent.start', params, { timeoutMs }).catch(() => null);
  if (!reply) {
    return {
      ok: false,
      result: {
        ...launchError('herdr agent.start failed: no response (launch state unknown)'),
        preInput: false,
        cleanupFailed: true,
        launchUnknown: true,
      },
    };
  }
  if (reply.error) {
    const preSpawn = typeof reply.error.code === 'string' && DIRECT_PRE_SPAWN_ERROR_CODES.has(reply.error.code);
    return {
      ok: false,
      result: preSpawn
        ? { exit_code: 1, stdout: '', stderr: JSON.stringify(reply), preInput: true, cleanupFailed: false }
        : { exit_code: 1, stdout: '', stderr: JSON.stringify(reply), preInput: false, cleanupFailed: true, launchUnknown: true },
    };
  }
  const identity = parseDirectStartReply(reply);
  if (!identity) {
    return {
      ok: false,
      result: {
        ...launchError('direct-exec agent.start returned incomplete or ambiguous identity (launch state unknown)'),
        preInput: false,
        cleanupFailed: true,
        launchUnknown: true,
      },
    };
  }
  return { ok: true, identity };
}

export function writeDirectSessionReceipt(
  dir: string,
  identity: DirectStartIdentity,
  meta: {
    task: string;
    endpoint?: string;
    tabName: string;
    right?: string;
    rightTerminalId?: string;
    orch?: string;
    base: string;
    primary: string;
  }
): void {
  writeSessionReceipt(dir, {
    TASK: meta.task,
    LAUNCH_ID: identity.launchId,
    TERMINAL_ID: identity.terminalId,
    DIRECT_EXEC: '1',
    PID: String(identity.pid),
    PID_START: identity.pidStart,
    HERDR_SOCKET_PATH: meta.endpoint ?? '',
    TAB: identity.tabId,
    TAB_NAME: meta.tabName,
    LEFT: identity.paneId,
    RIGHT: meta.right ?? '',
    ...(meta.rightTerminalId ? { RIGHT_TERMINAL_ID: meta.rightTerminalId } : {}),
    ORCH: meta.orch ?? '',
    BASE: meta.base,
    PRIMARY: meta.primary,
  });
}

/** Retain a direct-exec launch after any post-spawn failure (readiness failure, early crash,
 * resume mismatch, prompt refusal, split failure): keeps SESSION.txt and the pane open for
 * failure retention, marks STATUS.json failed with exact pid/start, wakes the watcher so the
 * reaper's proofs own tab close, and blocks `canTryNext` from launching a second place. */
export function retainDirectFailure(
  dir: string,
  job: Job,
  harness: 'cli' | 'pi',
  agent: string | undefined,
  identity: DirectStartIdentity,
  failure: DispatchResult
): DispatchResult {
  const info = launchFailure(failure);
  const now = new Date().toISOString();
  jobCache.invalidateFile(join(dir, jobFiles.status));
  const existing = readCachedStatus(job.job).status;
  const status: JobStatus = {
    version: 1,
    task_dir: fs.realpathSync(dir),
    slot: 'primary',
    harness,
    ...(agent ? { agent } : {}),
    role: job.role,
    model: job.model ?? null,
    thinking: job.thinking ?? null,
    ...(existing ?? {}),
    ...(failure.status ?? {}),
    state: 'failed',
    pid: identity.pid,
    pid_start_time: identity.pidStart,
    exit_reason: info.code,
    error: info.reason,
    ended_at: now,
    updated_at: now,
  };
  writeCreateStatus(dir, status);
  ensureWatcher();
  return { ...failure, status, preInput: false, cleanupFailed: false };
}

/** Mirror herdr-hud `src/pane/agent_detection.rs:363-378` Codex composer prompt readiness check. */
export function codexPromptReady(content: string): boolean {
  const recent = content
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .slice(-12)
    .join('')
    .replace(/\s+/g, '');
  return (
    recent.includes('›AskCodextodoanything') &&
    !recent.includes('model:loading') &&
    !recent.includes('Resumingsession')
  );
}

const DIRECT_READY_POLL_MS = 100;

function directError(code: string, message: string): DispatchResult {
  return {
    exit_code: 1,
    stdout: '',
    stderr: JSON.stringify({ error: { code, message } }),
  };
}

/** Shared readiness polling for direct-exec CLI and Pi agents.
 * Mirrors herdr `src/cli/agent.rs:420-490`, treating a prompt-ready Codex with `agent_status: 'unknown'`
 * (via `interactive_ready: true` or the screen-ready composer signal) as ready instead of timing out. */
export async function waitDirectReady(opts: {
  name: string;
  paneId: string;
  launchId: string;
  terminalId: string;
  kind: string;
  pid: number;
  pidStart: string;
  timeoutMs: number;
}): Promise<DispatchResult> {
  const { name, paneId, launchId, terminalId, kind, pid, pidStart, timeoutMs } = opts;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (workerAlive(pid, pidStart) === false) {
      return directError('agent_start_failed', `agent ${name} process exited before becoming interactive`);
    }
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) {
      return directError('agent_not_ready', `agent ${name} did not become ready within ${timeoutMs}ms`);
    }
    const queryTimeout = Math.min(2000, remaining);
    let reply = await herdrRequest('agent.get', { target: name }, { timeoutMs: queryTimeout }).catch(() => null);
    if (!reply || reply.error) {
      reply = await herdrRequest('agent.get', { target: paneId }, { timeoutMs: queryTimeout }).catch(() => null);
    }
    const agent = reply && !reply.error ? reply.result?.agent : undefined;
    if (agent) {
      if ((agent.terminal_id && agent.terminal_id !== terminalId) || (agent.launch_id && agent.launch_id !== launchId)) {
        return directError('agent_name_lost', `agent ${name} target changed during startup`);
      }
      if (agent.agent && agent.agent !== kind) {
        return directError('agent_kind_mismatch', `expected ${kind}, detected ${agent.agent}`);
      }
      if (agent.name && agent.name !== name) {
        return directError('agent_name_lost', `agent ${name} name changed during startup`);
      }
      const status = agent.agent_status;
      if (status === 'blocked') {
        return directError('agent_not_ready', `agent ${name} is blocked during startup and is not ready for prompts`);
      }
      if (status === 'idle' || status === 'done') {
        if (workerAlive(pid, pidStart) === false) {
          return directError('agent_start_failed', `agent ${name} process exited before becoming interactive`);
        }
        return { exit_code: 0, stdout: JSON.stringify(reply), stderr: '' };
      }
      if (status === 'unknown' && kind === 'codex') {
        if (agent.interactive_ready === true) {
          return { exit_code: 0, stdout: JSON.stringify(reply), stderr: '' };
        }
        const read = await herdrRequest('pane.read', { pane_id: paneId, source: 'recent' }, { timeoutMs: queryTimeout }).catch(() => null);
        const text = read?.result?.read?.text ?? read?.result?.text;
        if (typeof text === 'string' && codexPromptReady(text)) {
          return { exit_code: 0, stdout: JSON.stringify(reply), stderr: '' };
        }
      }
    }
    if (workerAlive(pid, pidStart) === false) {
      return directError('agent_start_failed', `agent ${name} process exited before becoming interactive`);
    }
    const wait = Math.min(DIRECT_READY_POLL_MS, Math.max(0, Math.ceil(deadline - performance.now())));
    if (wait <= 0) {
      return directError('agent_not_ready', `agent ${name} did not become ready within ${timeoutMs}ms`);
    }
    await sleep(wait);
  }
}

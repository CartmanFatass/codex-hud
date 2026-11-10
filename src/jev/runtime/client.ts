// Attach to the one Jev runtime for a HUD home, starting it when the socket is down.
// The child keeps the real HOME and an allow-list. Credential names are stripped.
// JEV_RUNTIME_* is set from ConnectOptions only. A dropped socket is retried once.
// A readJob that hits its own deadline is not retried.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostProxyEnv, loadJevConfig, proxyForSpawn } from '../ask/config.js';
import { JevFailure } from '../ask/error.js';
import { probePid } from '../ask/lease.js';
import { cappedReadWaitMs, JevRuntimeError, loadRuntimeConfig } from './executor.js';
import { isPublicIpcCode, jevCall } from './ipc.js';
import type { JevCreateRequest, JevExecutor, JevFollowUp, JevJob, JevReadOptions } from './types.js';

export interface ConnectOptions {
  graceMs?: number;
  /** Stand-in browser and provider. Production leaves this unset. */
  fake?: boolean;
  /** Tests can point at a compiled entry. The default is the sibling entry.js. */
  entry?: string;
  /** Tests pass a directory they created. The child does not invent one. */
  stateDir?: string;
  /** Internal test/child plumbing, not environment configuration: all four or JSON only. */
  cdpUrl?: string;
  chrome?: string;
  profile?: string;
  /** Tests inject proxy support. Production asks Node, then the version. */
  envProxy?: EnvProxySupport;
}

/** Whether this Node accepts `--use-env-proxy` and honors `NODE_USE_ENV_PROXY`. */
export interface EnvProxySupport {
  flag: boolean;
  envVar: boolean;
}

export interface ConnectedJev extends JevExecutor {
  readonly socketPath: string;
  status(): Promise<{ pid: number; retained: number; jobs: number }>;
}

const EXACT_ENV = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
]);

const READ_DEADLINE_MARGIN_MS = 5_000;

type Invoke = (
  method: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number
) => Promise<unknown>;

/** `min(waitMs, 120s) + 5s`. The server answers before this when the wait elapses. */
export function readDeadlineMs(waitMs: number | undefined): number {
  return cappedReadWaitMs(waitMs) + READ_DEADLINE_MARGIN_MS;
}

/**
 * `--use-env-proxy` when the flag set lists it, or when the version is Node ≥ 24 or Node 22.21+.
 * `NODE_USE_ENV_PROXY` follows that flag, or the set when the set names the variable.
 */
export function detectEnvProxySupport(
  flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
  version: string = process.versions.node
): EnvProxySupport {
  const flag = flags.has('--use-env-proxy') || envProxyByVersion(version);
  return { flag, envVar: flag || flags.has('NODE_USE_ENV_PROXY') };
}

function envProxyByVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 22 && minor >= 21);
}

export async function connectJevExecutor(hudHome: string, options: ConnectOptions = {}): Promise<ConnectedJev> {
  if (!hudHome.startsWith('/')) throw new JevRuntimeError('invalid_request', 'HUD home must be absolute');
  const socketPath = join(hudHome, 'jev-runtime', 'runtime.sock');
  await ensureRunning(hudHome, socketPath, options);
  const invoke: Invoke = (method, args, signal, timeoutMs) =>
    callWithRetry(hudHome, socketPath, options, method, args, signal, timeoutMs);
  return {
    socketPath,
    // SAFETY: the typed request is a JSON object, revalidated by the runtime's parseCreate.
    createJob: (request) => invoke('createJob', request as unknown as Record<string, unknown>) as Promise<JevJob>,
    readJob: (jobId, read) => readCall(invoke, jobId, read),
    sendFollowUp: (jobId, followUp) => invoke('sendFollowUp', { jobId, followUp }) as Promise<JevJob>,
    closeJob: (jobId) => invoke('closeJob', { jobId }) as Promise<JevJob>,
    status: () => invoke('status', {}) as Promise<{ pid: number; retained: number; jobs: number }>,
  };
}

function readCall(invoke: Invoke, jobId: string, options: JevReadOptions = {}): Promise<JevJob> {
  const args: Record<string, unknown> = { jobId };
  if (options.resume === true) args.resume = true;
  if (options.waitMs !== undefined) args.waitMs = options.waitMs;
  if (options.afterSeq !== undefined) args.afterSeq = options.afterSeq;
  return invoke('readJob', args, options.signal, readDeadlineMs(options.waitMs)) as Promise<JevJob>;
}

/** One retry after the runtime has gone away. A caller abort is not retried. */
async function callWithRetry(
  hudHome: string,
  socketPath: string,
  options: ConnectOptions,
  method: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<unknown> {
  try {
    return await Promise.resolve().then(() => jevCall(socketPath, method, args, signal, timeoutMs));
  } catch (error) {
    if (!retryableJevError(error, method)) throw error;
    await ensureRunning(hudHome, socketPath, options);
    return jevCall(socketPath, method, args, signal, timeoutMs);
  }
}

/** A dropped socket is retried. A `readJob` that reached its own deadline is not. */
export function retryableJevError(error: unknown, method: string): boolean {
  const value = error as { code?: unknown; deadline?: unknown };
  if (value.code === 'ENOENT' || value.code === 'ECONNREFUSED') return true;
  if (value.code !== 'runtime_timeout') return false;
  return !(method === 'readJob' && value.deadline === true);
}

async function ensureRunning(hudHome: string, socketPath: string, options: ConnectOptions): Promise<void> {
  // Validate all locations before even reusing a runtime; preserve the named pre_send diagnostic.
  if ([options.stateDir, options.cdpUrl, options.chrome, options.profile].some((value) => value !== undefined)) {
    loadJevConfig({ configJson: { jev: options } });
  } else loadRuntimeConfig(hudHome);
  if (await ping(socketPath)) return;
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'starting');
  if (!claim(lock)) {
    if (await waitForPing(socketPath, 8_000)) return;
    if (!(await stealDead(lock))) {
      if (await waitForPing(socketPath, 1_000)) return;
      throw new JevRuntimeError('runtime_start_failed', 'runtime_start_failed');
    }
  }
  try {
    if (await ping(socketPath)) return;
    const started = spawnChild(hudHome, socketPath, options);
    const abort = new AbortController();
    const onGone = () => abort.abort();
    started.child.once('exit', onGone);
    started.child.once('error', onGone);
    if (started.child.exitCode !== null || started.child.signalCode !== null) onGone();
    try {
      const childGone = () => started.child.exitCode !== null || started.child.signalCode !== null;
      if (!(await waitForPing(socketPath, 8_000, abort.signal, childGone))) {
        throw childStartError(started.errFile, started.errAt);
      }
    } finally {
      started.child.removeListener('exit', onGone);
      started.child.removeListener('error', onGone);
    }
  } finally {
    releaseStart(lock);
  }
}

interface StartLock {
  pid: number;
  pidStart: string;
}

function claim(lock: string): boolean {
  const probe = probePid(process.pid);
  const body = JSON.stringify({ pid: process.pid, pidStart: typeof probe === 'object' ? probe.alive : '' });
  try {
    writeFileSync(lock, `${body}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Take a lock only when its pid is dead or its start time changed. A live starter is left alone. */
function stealDead(lock: string): boolean {
  const brake = `${lock}.break`;
  let brakeFd: number;
  try {
    brakeFd = openSync(brake, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const before = readStartLock(lock);
    if (before && holderLive(before)) return false;
    const after = readStartLock(lock);
    if (after && holderLive(after)) return false;
    if (before && after && (before.pid !== after.pid || before.pidStart !== after.pidStart)) return false;
    try {
      unlinkSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return claim(lock);
  } finally {
    closeSync(brakeFd);
    try {
      unlinkSync(brake);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function holderLive(body: StartLock): boolean {
  const probe = probePid(body.pid);
  if (probe === 'dead') return false;
  if (probe === 'unknown' || !body.pidStart) return true;
  return probe.alive === body.pidStart;
}

function readStartLock(file: string): StartLock | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; pidStart?: unknown };
    if (!parsed || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null;
    return { pid: parsed.pid, pidStart: typeof parsed.pidStart === 'string' ? parsed.pidStart : '' };
  } catch {
    return null;
  }
}

function releaseStart(lock: string): void {
  const body = readStartLock(lock);
  if (!body || body.pid !== process.pid) return;
  try {
    unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function spawnChild(
  hudHome: string,
  socketPath: string,
  options: ConnectOptions
): { child: ChildProcess; errFile: string; errAt: number } {
  const entry = options.entry ?? fileURLToPath(new URL('./entry.js', import.meta.url));
  const support = options.envProxy ?? detectEnvProxySupport();
  const env = childEnv(hudHome, options, support);
  const errFile = join(dirname(socketPath), 'child.err');
  let errAt = 0;
  try {
    errAt = statSync(errFile).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const errFd = openSync(errFile, 'a', 0o600);
  const child = spawn(process.execPath, childArgv(entry, hudHome, support), {
    env,
    detached: true,
    stdio: ['ignore', 'ignore', errFd],
  });
  child.unref();
  closeSync(errFd);
  child.on('error', () => undefined);
  return { child, errFile, errAt };
}

function childArgv(entry: string, hudHome: string, support: EnvProxySupport): string[] {
  const args: string[] = [];
  if (support.flag) args.push('--use-env-proxy');
  args.push(entry, hudHome);
  return args;
}

/** The last `jev-runtime: <code>` line in this spawn's stderr, when that code is public. */
function childStartError(file: string, from: number): JevRuntimeError {
  let text = '';
  try {
    text = readFileSync(file).subarray(from).toString('utf8');
  } catch {
    text = '';
  }
  let code = '';
  for (const line of text.split('\n')) {
    const match = /^jev-runtime: (\S+)$/.exec(line.trim());
    if (match?.[1]) code = match[1];
  }
  if (code && isPublicIpcCode(code)) return new JevRuntimeError(code, code);
  return new JevRuntimeError('runtime_start_failed', 'runtime_start_failed');
}

/** Allow-list, then drop credential names. Config proxy wins. A missing config does not block the spawn. */
function childEnv(hudHome: string, options: ConnectOptions, support: EnvProxySupport): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || !forwardable(name)) continue;
    env[name] = value;
  }
  if (!env.PATH) env.PATH = '/usr/bin';
  if (!env.TMPDIR) env.TMPDIR = '/tmp';
  if (options.fake) env.JEV_RUNTIME_FAKE = '1';
  if (options.graceMs !== undefined) env.JEV_RUNTIME_GRACE_MS = String(options.graceMs);
  if (options.stateDir) env.JEV_RUNTIME_STATE_DIR = options.stateDir;
  if (options.cdpUrl) env.JEV_RUNTIME_CDP_URL = options.cdpUrl;
  if (options.chrome) env.JEV_RUNTIME_CHROME = options.chrome;
  if (options.profile) env.JEV_RUNTIME_PROFILE = options.profile;
  if (support.envVar) env.NODE_USE_ENV_PROXY = '1';
  else delete env.NODE_USE_ENV_PROXY;
  let proxy: Record<string, string>;
  try {
    proxy = options.stateDir ? proxyForSpawn(process.env) : hostProxyEnv(loadRuntimeConfig(hudHome));
  } catch (error) {
    if (!(error instanceof JevFailure)) throw error;
    proxy = proxyForSpawn(process.env);
  }
  for (const [name, value] of Object.entries(proxy)) {
    if (!forwardable(name)) continue;
    env[name] = value;
  }
  return env;
}

function forwardable(name: string): boolean {
  if (/API_KEY|TOKEN|SECRET|OPENAI_|TYPESAFE_|TEXT_MODEL_/.test(name)) return false;
  return EXACT_ENV.has(name) || name.startsWith('LC_');
}

async function ping(file: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    const timeout = AbortSignal.timeout(500);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    await jevCall(file, 'status', {}, combined, 500);
    return true;
  } catch {
    return false;
  }
}

async function waitForPing(file: string, ms: number, signal?: AbortSignal, gone?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (signal?.aborted || gone?.()) return false;
    if (await ping(file, signal)) return true;
    if (signal?.aborted || gone?.()) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (signal?.aborted || gone?.()) return false;
  return ping(file);
}

// Browser lock and per-key wait lease (design §4.5 H2).
// `browser.lock` is a heartbeat lease, not the host socket's pid file.
// A lock or break file appears only after its body is linked into place, so a
// reader never sees a half-written file. An unreadable file is stale only when
// its mtime is older than 30s. Stale also means the heartbeat is older than 30s,
// or the holder is in this pid namespace and that pid is dead or its start time
// no longer matches. A pid in another namespace is never treated as dead.
// `pidStart` is stored so the start-time check has something to compare.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JevFailure } from './error.js';
import { assertStateDir, ensureOperationsDir, fsyncDirectory, operationStem } from './names.js';

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;
/** Crash leftovers. A live save's temp is younger than this and is left alone. */
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** Host jobs poll until this elapses, then `browser_busy`. The CLI does not wait. */
export const BROWSER_LOCK_WAIT_MS = 10 * 60_000;

export interface LockBody {
  nonce: string;
  holder: string;
  pid: number;
  pidns: string;
  /** `/proc/<pid>/stat` starttime ticks. Empty when the holder could not read it. */
  pidStart: string;
  jobId: string;
  phase: string;
  since: number;
  heartbeat: number;
}

export type PidProbe = 'dead' | 'unknown' | { alive: string };

export interface LeaseDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fsync: (fd: number) => void;
  pid: () => number;
  pidns: () => string | null;
  probePid: (pid: number) => PidProbe;
  random: () => string;
}

export interface LeaseHooks {
  /** Runs after this process links `browser.lock`, before the nonce re-read. */
  afterCreate?: () => void;
  /** Runs after the break mutex is held, before the nonce and heartbeat are re-checked. */
  afterBreakMutex?: () => void;
  /** Runs once, immediately before a non-waiting acquire throws `browser_busy`. */
  onBusy?: () => void;
  /** Runs after a stale break file is renamed aside, before it is re-read. */
  afterStaleRename?: (stalePath: string) => void;
}

export interface LockRequest {
  jobId: string;
  phase: string;
  holder?: 'cli' | 'hud';
  heartbeat?: boolean;
  deps?: Partial<LeaseDeps>;
  hooks?: LeaseHooks;
}

export interface AcquireOptions extends LockRequest {
  stateDir: string;
  kind?: 'browser' | 'wait';
  /** Required when `kind` is `wait`. */
  key?: string;
  waitMs?: number;
  pollMs?: number;
}

export class HeldLease {
  lost = false;
  private released = false;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly kind: 'browser' | 'wait',
    readonly stateDir: string,
    readonly nonce: string,
    readonly path: string,
    readonly jobId: string,
    readonly phase: string,
    private readonly deps: LeaseDeps,
    /** Set on a wait lease. A browser lease is for every key in `stateDir`. */
    readonly key: string | undefined
  ) {}

  /**
   * Rewrite `heartbeat` on the inode we already hold. A replaced lock is left alone.
   * File errors mark the lease lost. This runs from a timer and must not throw.
   */
  beat(): void {
    if (this.released || this.lost) return;
    try {
      if (!rewriteHeartbeat(this.path, this.nonce, this.deps.now(), this.deps)) this.lost = true;
    } catch {
      this.lost = true;
    }
  }

  /**
   * Unlink the lock only when it still carries our nonce.
   * The check and the unlink are not one step: a breaker can win between them.
   * A lost lease leaves the file; it stays until a later acquire finds it stale.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.lost) return;
    const current = loadLock(this.path);
    if (current.kind === 'body' && current.body.nonce === this.nonce) {
      fs.rmSync(this.path, { force: true });
      fsyncDirectory(path.dirname(this.path), this.deps.fsync);
    }
  }

  startHeartbeat(): void {
    if (this.timer || this.released) return;
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }
}

export function assertLeaseHeld(lease: HeldLease): void {
  if (lease.lost) throw new JevFailure('lease_lost', 'browser lock is no longer held');
  const current = loadLock(lease.path);
  if (current.kind !== 'body' || current.body.nonce !== lease.nonce) {
    throw new JevFailure('lease_lost', 'browser lock is no longer held');
  }
}

export function isLockStale(body: LockBody, now: number, deps: Pick<LeaseDeps, 'pidns' | 'probePid'>): boolean {
  if (!Number.isFinite(body.heartbeat) || now - body.heartbeat > STALE_MS) return true;
  const ours = deps.pidns();
  if (!body.pidns || !ours || body.pidns !== ours) return false;
  const probe = deps.probePid(body.pid);
  if (probe === 'dead') return true;
  if (probe === 'unknown') return false;
  if (body.pidStart && probe.alive !== body.pidStart) return true;
  return false;
}

/** CLI path: one attempt, then `browser_busy`. */
export function tryAcquireBrowserLock(options: AcquireOptions): HeldLease {
  const deps = resolveDeps(options.deps);
  sweepAcquireTemps(options.stateDir, deps);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const step = acquireOnce(options, deps);
    if (step.kind === 'lease') return step.lease;
    if (step.kind === 'retry') continue;
    options.hooks?.onBusy?.();
    throw busyError(step.busy);
  }
  options.hooks?.onBusy?.();
  throw busyError(null);
}

/** Host path: poll until `waitMs` (design: 10 minutes), then `browser_busy`. */
export async function acquireBrowserLock(options: AcquireOptions & { waitMs: number }): Promise<HeldLease> {
  const deps = resolveDeps(options.deps);
  sweepAcquireTemps(options.stateDir, deps);
  const deadline = deps.now() + options.waitMs;
  const poll = options.pollMs ?? 250;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const step = acquireOnce(options, deps);
    if (step.kind === 'lease') return step.lease;
    if (step.kind === 'retry') continue;
    if (deps.now() >= deadline) throw busyError(step.busy);
    await deps.sleep(poll);
    if (deps.now() >= deadline) {
      const last = acquireOnce(options, deps);
      if (last.kind === 'lease') return last.lease;
      throw busyError(last.kind === 'busy' ? last.busy : null);
    }
  }
  throw busyError(null);
}

export type WaitJoin =
  | { role: 'owner'; observe: true; lease: HeldLease }
  | { role: 'tail'; observe: false; holder: string; phase: string; since: number; jobId: string };

/**
 * Second waiter on a live per-key lease tails the record and must not open an observer page.
 * A stale lease is broken and this caller becomes the owner.
 */
export function acquireWaitLease(stateDir: string, key: string, request: LockRequest): WaitJoin {
  const deps = resolveDeps(request.deps);
  const lockPath = waitLeasePath(stateDir, key);
  const once = () =>
    tryAcquireBrowserLock({
      ...request,
      stateDir,
      kind: 'wait',
      key,
      deps,
      heartbeat: request.heartbeat,
    });
  try {
    return { role: 'owner', observe: true, lease: once() };
  } catch (error) {
    if (!(error instanceof JevFailure) || error.code !== 'browser_busy') throw error;
    const existing = loadLock(lockPath);
    const tail = liveTail(existing, deps);
    if (tail) return tail;
    if (existing.kind === 'missing') {
      try {
        return { role: 'owner', observe: true, lease: once() };
      } catch (retryError) {
        if (!(retryError instanceof JevFailure) || retryError.code !== 'browser_busy') throw retryError;
        const again = loadLock(lockPath);
        const retried = liveTail(again, deps);
        if (retried) return retried;
        throw waitBusyError(again);
      }
    }
    throw waitBusyError(existing);
  }
}

export function defaultLeaseDeps(): LeaseDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fsync: (fd) => fs.fsyncSync(fd),
    pid: () => process.pid,
    pidns: readPidNamespace,
    probePid,
    random: () => randomBytes(16).toString('hex'),
  };
}

export function probePid(pid: number): PidProbe {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return 'unknown';
    const ticks = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/)[19];
    // Field 22 of /proc/pid/stat is starttime; after the comm `)` it sits at index 19.
    return ticks ? { alive: ticks } : 'unknown';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown';
  }
}

export function readPidNamespace(): string | null {
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

interface BreakBody {
  pid: number;
  pidns: string;
  pidStart: string;
  since: number;
}

type Step = { kind: 'lease'; lease: HeldLease } | { kind: 'retry' } | { kind: 'busy'; busy: LockBody | null };

type LoadedLock =
  { kind: 'missing' } | { kind: 'corrupt'; raw: string; mtimeMs: number } | { kind: 'body'; body: LockBody };

type LockSnapshot = { kind: 'body'; body: LockBody } | { kind: 'corrupt'; raw: string };

function acquireOnce(options: AcquireOptions, deps: LeaseDeps): Step {
  assertStateDir(options.stateDir);
  if (options.kind === 'wait') ensureOperationsDir(options.stateDir, deps.fsync);
  const paths = lockPaths(options);
  const mine = makeBody(options, deps);
  let created = false;
  try {
    linkExclusive(paths.path, `${JSON.stringify(mine)}\n`, deps);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created) {
    options.hooks?.afterCreate?.();
    const seen = loadLock(paths.path);
    if (seen.kind === 'body' && seen.body.nonce === mine.nonce) {
      return { kind: 'lease', lease: startLease(options, mine, paths.path, deps) };
    }
  }
  const current = loadLock(paths.path);
  if (current.kind === 'missing') return { kind: 'retry' };
  if (current.kind === 'body' && !isLockStale(current.body, deps.now(), deps)) {
    return { kind: 'busy', busy: current.body };
  }
  if (current.kind === 'corrupt' && !isAged(current.mtimeMs, deps.now())) return { kind: 'busy', busy: null };
  const snapshot: LockSnapshot =
    current.kind === 'body' ? { kind: 'body', body: current.body } : { kind: 'corrupt', raw: current.raw };
  if (!breakStale(paths, snapshot, options.hooks, deps)) {
    const again = loadLock(paths.path);
    if (again.kind === 'body' && !isLockStale(again.body, deps.now(), deps)) return { kind: 'busy', busy: again.body };
    if (again.kind === 'corrupt' && !isAged(again.mtimeMs, deps.now())) return { kind: 'busy', busy: null };
    const busy = again.kind === 'body' ? again.body : current.kind === 'body' ? current.body : null;
    return { kind: 'busy', busy };
  }
  return { kind: 'retry' };
}

function breakStale(
  paths: { path: string; breakPath: string },
  snapshot: LockSnapshot,
  hooks: LeaseHooks | undefined,
  deps: LeaseDeps
): boolean {
  const mine = takeBreakMutex(paths.breakPath, deps, hooks);
  if (!mine) return false;
  try {
    hooks?.afterBreakMutex?.();
    const again = loadLock(paths.path);
    const unchanged =
      (snapshot.kind === 'corrupt' && again.kind === 'corrupt' && again.raw === snapshot.raw) ||
      (snapshot.kind === 'body' &&
        again.kind === 'body' &&
        again.body.nonce === snapshot.body.nonce &&
        again.body.heartbeat === snapshot.body.heartbeat);
    if (unchanged) {
      fs.rmSync(paths.path, { force: true });
      fsyncDirectory(path.dirname(paths.path), deps.fsync);
      return true;
    }
    return again.kind === 'missing';
  } finally {
    releaseOwnBreak(paths.breakPath, mine, deps);
  }
}

function takeBreakMutex(breakPath: string, deps: LeaseDeps, hooks?: LeaseHooks): BreakBody | null {
  const mine = breakBody(deps);
  const encoded = `${JSON.stringify(mine)}\n`;
  try {
    linkExclusive(breakPath, encoded, deps);
    return mine;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const judged = judgeBreak(breakPath, deps);
  if (!judged) return null;
  const stalePath = uniqueStalePath(breakPath, deps);
  try {
    fs.renameSync(breakPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  hooks?.afterStaleRename?.(stalePath);
  let moved = '';
  try {
    moved = fs.readFileSync(stalePath, 'utf8');
  } catch {
    return null;
  }
  if (moved !== judged.raw) {
    restoreBreak(stalePath, breakPath);
    return null;
  }
  try {
    linkExclusive(breakPath, encoded, deps);
    return mine;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  } finally {
    // The renamed body is not the mutex once this process has published its own file,
    // or once another process won the name.
    fs.rmSync(stalePath, { force: true });
  }
}

function releaseOwnBreak(breakPath: string, mine: BreakBody, deps: LeaseDeps): void {
  const current = loadBreak(breakPath);
  if (!current || !breakEqual(current, mine)) return;
  try {
    fs.rmSync(breakPath, { force: true });
    fsyncDirectory(path.dirname(breakPath), deps.fsync);
  } catch {
    // Cleanup must not throw out of the acquire attempt. A leftover break file
    // is stale once its pid dies or it is older than 30s.
  }
}

function judgeBreak(file: string, deps: LeaseDeps): { raw: string } | null {
  let stat: fs.Stats;
  let raw: string;
  try {
    stat = fs.statSync(file);
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseBreak(raw);
  if (parsed) return isBreakStale(parsed, deps) ? { raw } : null;
  return isAged(stat.mtimeMs, deps.now()) ? { raw } : null;
}

function isBreakStale(body: BreakBody, deps: LeaseDeps): boolean {
  if (!Number.isFinite(body.since) || deps.now() - body.since > STALE_MS) return true;
  const ours = deps.pidns();
  if (!body.pidns || !ours || body.pidns !== ours) return false;
  const probe = deps.probePid(body.pid);
  if (probe === 'dead') return true;
  if (probe === 'unknown') return false;
  if (body.pidStart && probe.alive !== body.pidStart) return true;
  return false;
}

function isAged(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > STALE_MS;
}

function startLease(options: AcquireOptions, body: LockBody, lockPath: string, deps: LeaseDeps): HeldLease {
  const lease = new HeldLease(
    options.kind === 'wait' ? 'wait' : 'browser',
    options.stateDir,
    body.nonce,
    lockPath,
    body.jobId,
    body.phase,
    deps,
    options.kind === 'wait' ? options.key : undefined
  );
  if (options.heartbeat !== false) lease.startHeartbeat();
  return lease;
}

function makeBody(options: AcquireOptions, deps: LeaseDeps): LockBody {
  const now = deps.now();
  const pid = deps.pid();
  const probe = deps.probePid(pid);
  return {
    nonce: deps.random(),
    holder: options.holder ?? 'hud',
    pid,
    pidns: deps.pidns() ?? '',
    pidStart: typeof probe === 'object' ? probe.alive : '',
    jobId: options.jobId,
    phase: options.phase,
    since: now,
    heartbeat: now,
  };
}

function breakBody(deps: LeaseDeps): BreakBody {
  const pid = deps.pid();
  const probe = deps.probePid(pid);
  return { pid, pidns: deps.pidns() ?? '', pidStart: typeof probe === 'object' ? probe.alive : '', since: deps.now() };
}

function breakEqual(a: BreakBody, b: BreakBody): boolean {
  return a.pid === b.pid && a.pidns === b.pidns && a.pidStart === b.pidStart && a.since === b.since;
}

function lockPaths(options: AcquireOptions): { path: string; breakPath: string } {
  if (options.kind === 'wait') {
    if (!options.key) throw new JevFailure('invalid_key', 'wait lease needs a key');
    const file = path.join(options.stateDir, 'operations', `${operationStem(options.key)}.wait.lease`);
    return { path: file, breakPath: `${file}.break` };
  }
  const file = path.join(options.stateDir, 'browser.lock');
  return { path: file, breakPath: `${file}.break` };
}

function waitLeasePath(stateDir: string, key: string): string {
  return path.join(stateDir, 'operations', `${operationStem(key)}.wait.lease`);
}

function liveTail(loaded: LoadedLock, deps: LeaseDeps): WaitJoin | null {
  if (loaded.kind !== 'body' || isLockStale(loaded.body, deps.now(), deps)) return null;
  return {
    role: 'tail',
    observe: false,
    holder: loaded.body.holder,
    phase: loaded.body.phase,
    since: loaded.body.since,
    jobId: loaded.body.jobId,
  };
}

function rewriteHeartbeat(lockPath: string, nonce: string, heartbeat: number, deps: LeaseDeps): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'r+');
  } catch {
    return false;
  }
  let ok = false;
  try {
    const parsed = parseLock(fs.readFileSync(fd, 'utf8'));
    if (parsed && parsed.nonce === nonce) {
      parsed.heartbeat = heartbeat;
      const next = `${JSON.stringify(parsed)}\n`;
      fs.writeSync(fd, next, 0, 'utf8');
      fs.ftruncateSync(fd, Buffer.byteLength(next));
      deps.fsync(fd);
      ok = true;
    }
  } catch {
    ok = false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** Publish `file` only once `body` is durable. `EEXIST` from the link means the name is taken. */
function linkExclusive(file: string, body: string, deps: LeaseDeps): void {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tmp = `${file}.${deps.pid()}.${deps.random()}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        last = error;
        continue;
      }
      throw error;
    }
    try {
      fs.writeFileSync(fd, body);
      deps.fsync(fd);
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // The temp name is removed below.
      }
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    fs.rmSync(tmp, { force: true });
    fsyncDirectory(path.dirname(file), deps.fsync);
    return;
  }
  throw last instanceof Error ? last : new Error('lock temp name is busy');
}

function uniqueStalePath(breakPath: string, deps: LeaseDeps): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${breakPath}.${deps.pid()}.${deps.random()}.stale`;
    try {
      fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
  return `${breakPath}.${deps.pid()}.${deps.random()}.stale`;
}

/** Put the renamed inode back without replacing a break file created since the rename. */
function restoreBreak(stalePath: string, breakPath: string): void {
  try {
    fs.linkSync(stalePath, breakPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  fs.rmSync(stalePath, { force: true });
}

function sweepAcquireTemps(stateDir: string, deps: LeaseDeps): void {
  const now = deps.now();
  sweepOldTemps(stateDir, now);
  sweepOldTemps(path.join(stateDir, 'operations'), now);
}

function sweepOldTemps(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.tmp') && !name.endsWith('.stale')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > TEMP_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

function loadLock(file: string): LoadedLock {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const parsed = parseLock(text);
  if (!parsed) return { kind: 'corrupt', raw: text, mtimeMs: stat.mtimeMs };
  return { kind: 'body', body: parsed };
}

function parseLock(text: string): LockBody | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.nonce !== 'string' || !raw.nonce) return null;
  if (typeof raw.heartbeat !== 'number' || !Number.isFinite(raw.heartbeat)) return null;
  if (typeof raw.since !== 'number' || !Number.isFinite(raw.since)) return null;
  return {
    nonce: raw.nonce,
    holder: typeof raw.holder === 'string' ? raw.holder : 'unknown',
    pid: typeof raw.pid === 'number' && Number.isInteger(raw.pid) ? raw.pid : 0,
    pidns: typeof raw.pidns === 'string' ? raw.pidns : '',
    pidStart: typeof raw.pidStart === 'string' ? raw.pidStart : '',
    jobId: typeof raw.jobId === 'string' ? raw.jobId : '',
    phase: typeof raw.phase === 'string' ? raw.phase : '',
    since: raw.since,
    heartbeat: raw.heartbeat,
  };
}

function loadBreak(file: string): BreakBody | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseBreak(text);
}

function parseBreak(text: string): BreakBody | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.pid !== 'number' || typeof value.since !== 'number') return null;
    return {
      pid: value.pid,
      pidns: typeof value.pidns === 'string' ? value.pidns : '',
      pidStart: typeof value.pidStart === 'string' ? value.pidStart : '',
      since: value.since,
    };
  } catch {
    return null;
  }
}

function busyError(body: LockBody | null): JevFailure {
  return new JevFailure('browser_busy', body ? `browser lock held by ${body.holder}` : 'browser lock is busy', {
    holder: body?.holder ?? 'unknown',
    phase: body?.phase ?? '',
    since: body?.since ?? 0,
  });
}

function waitBusyError(loaded: LoadedLock): JevFailure {
  const body = loaded.kind === 'body' ? loaded.body : null;
  return new JevFailure('wait_busy', body ? `wait lease held by ${body.holder}` : 'wait lease is busy', {
    holder: body?.holder ?? 'unknown',
    phase: body?.phase ?? '',
    since: body?.since ?? 0,
  });
}

function resolveDeps(overrides?: Partial<LeaseDeps>): LeaseDeps {
  return { ...defaultLeaseDeps(), ...overrides };
}

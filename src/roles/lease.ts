/** Project-local leases; the mutex covers only short file mutations, never a lease wait. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { leaseActive, leaseJob, readLease, type LeaseCommandGroup, type LeaseRecord } from '../collectors/thin-jobs.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { waitUntilFs, type FsWaitCheckContext, type WatchTarget } from '../utils/fs-wait.js';
import {
  isActiveProcState,
  isValidPid,
  listProcPids,
  procStat,
  readBootId,
  readProcStat,
  readProcUid,
} from '../utils/proc.js';
import { sharedRoot } from './projects.js';

const MAX_WAIT = 300;
const COMMAND_GROUP_KILL_TIMEOUT_MS = 5_000;
export const LEASE_TOOL = {
  name: 'hud_lease',
  description: 'Named project lease: shared use needs granted:true; release after.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    release: { type: 'boolean' },
    wait_s: { type: 'number', minimum: 0, default: 120, description: `Max ${MAX_WAIT}s; 0 checks once.` },
  }, required: ['name'], additionalProperties: false },
};

type HeldBy = Pick<LeaseRecord, 'holder' | 'since'>;
type Result = { granted: true } | { granted: false; held_by: HeldBy } | { released: boolean; held_by?: HeldBy };
type Caller = { home: string; cwd: string; holder: string | null; worker?: boolean; fallback?: boolean };
type WaitOptions = {
  fallbackIntervalMs?: number;
  onCheck?: (reason: FsWaitCheckContext['reason'], done: boolean) => void;
};
export type TerminateCommandGroupResult = 'terminated' | 'gone' | 'reused' | 'other-boot';
const heldBy = ({ holder, since }: LeaseRecord) => ({ holder, since });
const validStart = (start: unknown): start is string => typeof start === 'string' && /^\d+$/.test(start);

function publish(file: string, lease: LeaseRecord): void {
  writeJsonPrivate(file, lease, { mkdir: false, exclusive: true });
}

function leaseLocation(home: string, cwd: string, name: string, mkdir: boolean): { project: string; dir: string; entry: string; file: string | null } {
  const project = sharedRoot(cwd);
  const dir = join(home, 'leases');
  const entry = createHash('sha256').update(JSON.stringify([project, name])).digest('hex') + '.json';
  if (mkdir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { project, dir, entry, file: join(fs.realpathSync(dir), entry) };
  }
  try { return { project, dir, entry, file: join(fs.realpathSync(dir), entry) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { project, dir, entry, file: null };
    throw error;
  }
}

function sameDeadLease(a: LeaseRecord, b: LeaseRecord): boolean {
  return a.holder === b.holder && a.kind === b.kind && a.pid === b.pid &&
    a.pid_start_time === b.pid_start_time && isDeepStrictEqual(a.command_group, b.command_group);
}

/** Collect caller and ancestor PIDs/process groups so we never signal ourselves or our ancestry. */
export function callerProtection(): { pids: Set<number>; pgrps: Set<number> } {
  const pids = new Set<number>();
  const pgrps = new Set<number>();
  for (let id = process.pid; id > 1;) {
    if (pids.has(id)) break;
    pids.add(id);
    const stat = readProcStat(id, { strict: true });
    if (!stat) break;
    if (stat.pgrp > 1) pgrps.add(stat.pgrp);
    id = stat.ppid;
  }
  return { pids, pgrps };
}

function collectOwnedGroupMembers(
  pgid: number,
  leaderStart: string,
  myUid: number | undefined,
  protectedPids: Set<number>,
): Array<{ pid: number; start: string }> {
  const members: Array<{ pid: number; start: string }> = [];
  const startTicks = BigInt(leaderStart);
  for (const id of listProcPids()) {
    if (!isValidPid(id)) continue;
    if (myUid !== undefined && readProcUid(id) !== myUid) continue;
    const stat = readProcStat(id, { strict: true });
    if (!stat || !isActiveProcState(stat.state)) continue;
    if (stat.pgrp !== pgid || stat.session !== pgid || BigInt(stat.start) < startTicks) continue;
    if (protectedPids.has(id)) throw new Error(`refusing to signal command group ${pgid} containing protected PID ${id}`);
    members.push({ pid: id, start: stat.start });
  }
  return members;
}

/**
 * Terminate a dead lease holder's recorded detached command group, identified only by exact
 * (pid, start ticks, boot_id) plus detached group/session leader and UID ownership checks.
 * Never kills by name or a reused PID; refuses (throws) whenever ownership or exit is unsure.
 */
export async function terminateCommandGroup(
  raw: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TerminateCommandGroupResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('lease command_group identity malformed; refusing to proceed');
  }
  const { pid, start, boot_id: bootId } = raw as Record<string, unknown>;
  if (!isValidPid(pid) || !validStart(start) || typeof bootId !== 'string' || !bootId) {
    throw new Error('lease command_group identity incomplete; refusing to proceed');
  }
  const currentBoot = readBootId({ strict: true });
  if (!currentBoot) throw new Error('boot identity unavailable; refusing to proceed');
  if (bootId !== currentBoot) return 'other-boot';

  const { pids: protectedPids, pgrps: protectedPgrps } = callerProtection();
  const myUid = process.getuid?.();
  const leader = readProcStat(pid, { strict: true });

  if (!leader) {
    // Leader exited: never signal -pid without a verified leader start-tick match.
    // Fail closed if any owned process still occupies the recorded detached group/session.
    const remaining = collectOwnedGroupMembers(pid, start, myUid, protectedPids);
    if (remaining.length > 0) {
      throw new Error(`dead land command group ${pid} leader exited with unverified members remaining; left alone`);
    }
    return 'gone';
  }
  if (leader.start !== start) {
    // PID was reused by another process; Linux cannot reuse PID while any member stays in pgrp/session.
    return 'reused';
  }
  if (protectedPids.has(pid) || protectedPgrps.has(pid)) {
    throw new Error(`refusing to signal protected command group ${pid}`);
  }
  if (leader.pgrp !== pid || leader.session !== pid) {
    throw new Error(`PID ${pid} is not a detached command group leader; left alone`);
  }
  if (myUid !== undefined && readProcUid(pid) !== myUid) {
    throw new Error(`PID ${pid} owner mismatch; left alone`);
  }

  const members = collectOwnedGroupMembers(pid, start, myUid, protectedPids);
  if (!isActiveProcState(leader.state) && members.length === 0) return 'gone';

  // Final identity check immediately before signalling the process group.
  const verified = readProcStat(pid, { strict: true });
  if (!verified || verified.start !== start || verified.pgrp !== pid || verified.session !== pid ||
      (myUid !== undefined && readProcUid(pid) !== myUid)) {
    if (verified && verified.start !== start) return 'reused';
    if (!verified && collectOwnedGroupMembers(pid, start, myUid, protectedPids).length === 0) return 'gone';
    throw new Error(`command group ${pid} identity changed before signalling; left alone`);
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }

  const memberAlive = ({ pid: mPid, start: mStart }: { pid: number; start: string }) => {
    const stat = readProcStat(mPid, { strict: true });
    return stat?.start === mStart && isActiveProcState(stat.state);
  };
  const leaderAlive = () => {
    const stat = readProcStat(pid, { strict: true });
    return stat?.start === start && isActiveProcState(stat.state);
  };
  const deadline = performance.now() + (options.timeoutMs ?? COMMAND_GROUP_KILL_TIMEOUT_MS);
  for (;;) {
    const liveMembers = members.filter(memberAlive);
    if (!leaderAlive() && liveMembers.length === 0) {
      const stillLeader = readProcStat(pid, { strict: true });
      if (stillLeader?.start === start && stillLeader.pgrp === pid && stillLeader.session === pid &&
          (myUid === undefined || readProcUid(pid) === myUid)) {
        const extra = collectOwnedGroupMembers(pid, start, myUid, protectedPids);
        if (extra.length === 0) return 'terminated';
        for (const m of extra) {
          if (!members.some(e => e.pid === m.pid && e.start === m.start)) members.push(m);
        }
        try { process.kill(-pid, 'SIGKILL'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      } else if (stillLeader && stillLeader.start !== start) {
        return 'terminated';
      } else {
        const remaining = collectOwnedGroupMembers(pid, start, myUid, protectedPids);
        if (remaining.length === 0) return 'terminated';
        if (performance.now() >= deadline) {
          throw new Error(`dead land command group ${pid} left unverified members running`);
        }
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(`dead land command group ${pid} did not terminate within timeout`);
    }
    // If a verified member changed pgrp just before SIGKILL, signal its exact verified (pid, start).
    for (const m of liveMembers) {
      if (protectedPids.has(m.pid)) continue;
      const stat = readProcStat(m.pid, { strict: true });
      if (stat?.start === m.start && isActiveProcState(stat.state) &&
          (myUid === undefined || readProcUid(m.pid) === myUid) &&
          stat.pgrp !== pid) {
        try { process.kill(m.pid, 'SIGKILL'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    await delay(25, undefined, { signal: options.signal });
  }
}

/** Synchronously update or clear `command_group` on a lease currently owned by this process. */
export function setLeaseCommandGroup(
  name: string,
  caller: Caller,
  commandGroup: LeaseCommandGroup | undefined,
  expected?: LeaseCommandGroup,
): void {
  const { home, cwd, holder, worker } = caller;
  if (!holder) return;
  const kind = worker ? 'worker' : 'main';
  const { file } = leaseLocation(home, cwd, name, false);
  if (!file) return;
  const lease = readLease(file);
  const selfStart = procStat(process.pid)?.start;
  if (!lease || lease.kind !== kind || lease.holder !== holder || lease.pid !== process.pid ||
      (lease.pid_start_time !== undefined && selfStart !== undefined && lease.pid_start_time !== selfStart)) return;
  if (commandGroup === undefined) {
    if (lease.command_group === undefined) return;
    if (expected && !isDeepStrictEqual(lease.command_group, expected)) return;
    const { command_group: _dropped, ...rest } = lease;
    writeJsonPrivate(file, rest, { mkdir: false });
    return;
  }
  writeJsonPrivate(file, { ...lease, command_group: commandGroup }, { mkdir: false });
}

/** Terminate and clear the recorded command group on an exact dead main-checkout lease during recovery. */
export async function reapDeadLeaseCommandGroup(
  home: string,
  cwd: string,
  name: string,
  deadOwner: { holder: string; pid: number; start: string },
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  const { file } = leaseLocation(home, cwd, name, false);
  if (!file) return false;
  const lease = readLease(file);
  if (!lease || lease.kind !== 'main' || lease.holder !== deadOwner.holder ||
      lease.pid !== deadOwner.pid || lease.pid_start_time !== deadOwner.start ||
      lease.command_group === undefined || leaseActive(home, lease)) {
    return false;
  }
  await terminateCommandGroup(lease.command_group, options);
  await withAbstractLock('lease', file, () => {
    const current = readLease(file);
    if (current && !leaseActive(home, current) && sameDeadLease(current, lease)) fs.unlinkSync(file);
  }, { signal: options?.signal });
  return true;
}

export async function takeLease(
  args: Record<string, unknown>,
  caller: Caller,
  signal?: AbortSignal,
  waitOptions?: WaitOptions,
): Promise<Result> {
  const { home, cwd, holder, worker, fallback } = caller;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name || name.length > 120 || /\p{Cc}/u.test(name)) throw new Error('invalid_arguments: name');
  if (args.release !== undefined && typeof args.release !== 'boolean') throw new Error('invalid_arguments: release');
  const seconds = args.wait_s === undefined ? 120 : args.wait_s;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('invalid_arguments: wait_s');
  if (!holder) throw new Error('hud_lease needs the main session’s HERDR_PANE_ID');
  signal?.throwIfAborted();
  const kind = worker ? 'worker' : 'main';
  const { project, dir, entry, file: resolvedFile } = leaseLocation(home, cwd, name, true);
  const file = resolvedFile!;
  const own = (lease: LeaseRecord) => lease.kind === kind && lease.holder === holder;

  let holderJobDir: string | undefined;
  const blocked = (lease: LeaseRecord): Result => {
    holderJobDir = lease.kind === 'worker' ? join(home, 'jobs', lease.holder) : undefined;
    return { granted: false, held_by: heldBy(lease) };
  };
  const attempt = async (): Promise<Result> => {
    for (;;) {
      // Only a possible grant or release takes the mutex. Recheck the file once inside it.
      const peek = readLease(file);
      if (!args.release && peek && !own(peek) && leaseActive(home, peek)) return blocked(peek);
      let staleLease: LeaseRecord | undefined;
      const result = await withAbstractLock<Result | 'cleanup'>('lease', file, () => {
        const lease = readLease(file);
        if (args.release) {
          if (lease && own(lease)) { fs.unlinkSync(file); return { released: true }; }
          return lease && leaseActive(home, lease) ? { released: false, held_by: heldBy(lease) } : { released: false };
        }
        if (lease && leaseActive(home, lease)) return own(lease) ? { granted: true } : blocked(lease);
        const job = worker ? leaseJob(home, holder) : undefined;
        if (job?.terminal) throw new Error('hud_lease cannot grant a lease to a terminal job');
        const workerPid = job?.status?.pid;
        const pid = typeof workerPid === 'number' && Number.isSafeInteger(workerPid) && workerPid > 1 ? workerPid : fallback ? null : process.pid;
        if (!pid) throw new Error('hud_lease: worker PID is not recorded yet; try again');
        const start = job?.status?.pid_start_time;
        const record: LeaseRecord = { project, name, holder, kind, since: new Date().toISOString(), pid,
          pid_start_time: pid === workerPid && typeof start === 'string' ? start : procStat(pid)?.start };
        if (!leaseActive(home, record)) throw new Error('hud_lease cannot grant a lease to an exited holder');
        if (lease && lease.command_group !== undefined) {
          staleLease = lease;
          return 'cleanup';
        }
        if (lease) fs.unlinkSync(file);
        publish(file, record);
        return { granted: true };
      }, { signal });
      if (result !== 'cleanup') return result;
      // Outside the short lease mutex: verify and terminate the dead holder's recorded command group
      // before removing its lease or granting to the next holder.
      await terminateCommandGroup(staleLease!.command_group, { signal });
      await withAbstractLock('lease', file, () => {
        const current = readLease(file);
        if (current && !leaseActive(home, current) && sameDeadLease(current, staleLease!)) fs.unlinkSync(file);
      }, { signal });
    }
  };

  return waitUntilFs<Result>({
    targets: (): WatchTarget[] => [
      { dir, filter: (name) => name === null || name === entry },
      ...(holderJobDir && fs.existsSync(holderJobDir) ? [{
        dir: holderJobDir, filter: (name: string | null) => name === null || name === 'STATUS.json' || name === 'job.json',
      }] : []),
    ],
    timeoutMs: args.release ? 0 : Math.min(seconds, MAX_WAIT) * 1000,
    signal,
    coalesceMs: 10,
    fallbackIntervalMs: waitOptions?.fallbackIntervalMs ?? 750, // An exited process need not change any watched file.
    check: async ({ timedOut, reason }) => {
      const value = await attempt();
      const done = !('granted' in value && !value.granted && !timedOut);
      waitOptions?.onCheck?.(reason, done);
      return done ? { done: true, value } : { done: false };
    },
  });
}

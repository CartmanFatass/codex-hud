/** Project-local leases; the mutex covers only short file mutations, never a lease wait. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { leaseActive, leaseJob, readLease, type LeaseCustodian, type LeaseRecord } from '../collectors/thin-jobs.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { waitUntilFs, type FsWaitCheckContext, type WatchTarget } from '../utils/fs-wait.js';
import { isActiveProcState, isValidPid, procStat, readBootId, readProcStat } from '../utils/proc.js';
import { sharedRoot } from './projects.js';

const MAX_WAIT = 300;
const CUSTODIAN_WAIT_MS = 5_000;
export const LEASE_FALLBACK_MS = 750;
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
export type LandLease = { home: string; cwd: string; holder: string };
const heldBy = ({ holder, since }: LeaseRecord) => ({ holder, since });

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
    a.pid_start_time === b.pid_start_time && isDeepStrictEqual(a.custodian, b.custodian);
}

function bootIdentity(): string {
  const id = readBootId({ strict: true });
  if (!id) throw Error('Land custodian: boot identity unavailable');
  return id;
}

function assertCustodianClean(lease: LeaseRecord) {
  if (lease.custodian_error && lease.custodian?.boot_id === bootIdentity()) {
    throw Error(`${lease.custodian_error}; refusing to proceed`);
  }
}

/** Only observe the exact recorded process; never send it or its group a signal. */
async function waitForCustodian(raw: LeaseCustodian, signal?: AbortSignal) {
  if (!raw || !isValidPid(raw.pid) || typeof raw.start !== 'string' || !/^\d+$/.test(raw.start) ||
      typeof raw.boot_id !== 'string' || !raw.boot_id) {
    throw Error('Land custodian identity incomplete; refusing to proceed');
  }
  if (raw.boot_id !== bootIdentity()) return;
  const deadline = performance.now() + CUSTODIAN_WAIT_MS;
  for (;;) {
    const stat = readProcStat(raw.pid, { strict: true });
    if (stat?.start !== raw.start || !isActiveProcState(stat.state)) return;
    const left = deadline - performance.now();
    if (left <= 0) throw Error(`Land custodian PID ${raw.pid} is still active; refusing to proceed`);
    await delay(Math.min(left, 25), undefined, { signal });
  }
}

/** The observer registers itself under the same mutex as acquisition, before it authorizes any payload. */
export async function registerLandCustodian({ home, cwd, holder }: LandLease, helperPid: number) {
  const { file } = leaseLocation(home, cwd, 'main-checkout', false);
  const self = readProcStat(process.pid, { strict: true });
  if (!file || self?.pgrp !== process.pid || self.session !== process.pid) throw Error('Land custodian could not verify its launch');
  const custodian: LeaseCustodian = { pid: process.pid, start: self.start, boot_id: bootIdentity() };
  await withAbstractLock('lease', file, () => {
    const lease = readLease(file);
    const helper = readProcStat(helperPid, { strict: true });
    if (!lease || lease.kind !== 'main' || lease.holder !== holder || lease.pid !== helperPid ||
        !helper || lease.pid_start_time !== helper.start || !isActiveProcState(helper.state)) {
      throw Error('Land custodian could not verify the helper owns the main-checkout lease');
    }
    assertCustodianClean(lease);
    // Fail closed if the observer exits before publishing the outcome of cleanup.
    writeJsonPrivate(file, { ...lease, custodian,
      custodian_error: `Land custodian PID ${custodian.pid} did not confirm its command group stopped` }, { mkdir: false });
  });
  return async (custodian_error?: string) => {
    await withAbstractLock('lease', file, () => {
      const lease = readLease(file);
      if (!lease || !isDeepStrictEqual(lease.custodian, custodian)) throw Error('Land custodian lost its lease record');
      writeJsonPrivate(file, { ...lease, custodian_error }, { mkdir: false });
    });
  };
}

async function clearDeadCustodianLease(file: string, lease: LeaseRecord, home: string, signal?: AbortSignal) {
  await waitForCustodian(lease.custodian!, signal);
  await withAbstractLock('lease', file, () => {
    const current = readLease(file);
    if (current && !leaseActive(home, current) && sameDeadLease(current, lease)) {
      // The exiting observer may have set or cleared its failure reason while we waited.
      assertCustodianClean(current);
      fs.unlinkSync(file);
    }
  }, { signal });
}

/** Recovery may clear the exact dead owner's lease only after its custodian has finished. */
export async function awaitDeadLandCustodian(
  { home, cwd, holder }: LandLease,
  deadOwner: { pid: number; start: string },
) {
  const { file } = leaseLocation(home, cwd, 'main-checkout', false);
  if (!file) return;
  const lease = await withAbstractLock('lease', file, () => readLease(file));
  if (!lease || lease.kind !== 'main' || lease.holder !== holder || lease.pid !== deadOwner.pid ||
      lease.pid_start_time !== deadOwner.start || lease.custodian === undefined || leaseActive(home, lease)) return;
  await clearDeadCustodianLease(file, lease, home);
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
          if (lease && own(lease)) {
            if (lease.custodian_error) return { released: false, held_by: heldBy(lease) };
            fs.unlinkSync(file); return { released: true };
          }
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
        if (lease && lease.custodian !== undefined) {
          staleLease = lease;
          return 'cleanup';
        }
        if (lease) fs.unlinkSync(file);
        publish(file, record);
        return { granted: true };
      }, { signal });
      if (result !== 'cleanup') return result;
      // The custodian owns cleanup. Wait outside the short lease mutex before reclaiming.
      await clearDeadCustodianLease(file, staleLease!, home, signal);
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
    fallbackIntervalMs: waitOptions?.fallbackIntervalMs ?? LEASE_FALLBACK_MS, // An exited process need not change any watched file.
    check: async ({ timedOut, reason }) => {
      const value = await attempt();
      const done = !('granted' in value && !value.granted && !timedOut);
      waitOptions?.onCheck?.(reason, done);
      return done ? { done: true, value } : { done: false };
    },
  });
}

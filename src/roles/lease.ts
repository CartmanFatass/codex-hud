/** Project-local leases; the mutex covers only short file mutations, never a lease wait. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { leaseActive, leaseJob, readLease, type LeaseRecord } from '../collectors/thin-jobs.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { waitUntilFs, type FsWaitCheckContext, type WatchTarget } from '../utils/fs-wait.js';
import { procStat } from '../utils/proc.js';
import { sharedRoot } from './projects.js';

const MAX_WAIT = 300;
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
const heldBy = ({ holder, since }: LeaseRecord) => ({ holder, since });

function publish(file: string, lease: LeaseRecord): void {
  writeJsonPrivate(file, lease, { mkdir: false, exclusive: true });
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
  const project = sharedRoot(cwd), kind = worker ? 'worker' : 'main';
  const dir = join(home, 'leases');
  const entry = createHash('sha256').update(JSON.stringify([project, name])).digest('hex') + '.json';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(fs.realpathSync(dir), entry);
  const own = (lease: LeaseRecord) => lease.kind === kind && lease.holder === holder;

  let holderJobDir: string | undefined;
  const blocked = (lease: LeaseRecord): Result => {
    holderJobDir = lease.kind === 'worker' ? join(home, 'jobs', lease.holder) : undefined;
    return { granted: false, held_by: heldBy(lease) };
  };
  const attempt = (): Result | Promise<Result> => {
    // Only a possible grant or release takes the mutex. Recheck the file once inside it.
    const peek = readLease(file);
    if (!args.release && peek && !own(peek) && leaseActive(home, peek)) return blocked(peek);
    return withAbstractLock<Result>('lease', file, () => {
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
      if (lease) fs.unlinkSync(file);
      publish(file, record);
      return { granted: true };
    }, { signal });
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

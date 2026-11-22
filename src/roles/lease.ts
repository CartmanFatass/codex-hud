/** Project-local leases; flock covers only short file mutations, never a wait. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { leaseActive, leaseJob, readLease, type LeaseRecord } from '../collectors/thin-jobs.js';
import { sharedRoot } from './projects.js';
import { executable } from './roster.js';
import { procStat } from '../utils/proc.js';

const MAX_WAIT = 300;
export const LEASE_TOOL = {
  name: 'hud_lease',
  description: 'Take the named project lease before using a shared resource, and release it when finished. Only use the resource after granted:true.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    release: { type: 'boolean' },
    wait_s: { type: 'number', minimum: 0, default: 120, description: `Wait capped at ${MAX_WAIT}s; 0 checks once.` },
  }, required: ['name'], additionalProperties: false },
};

type HeldBy = Pick<LeaseRecord, 'holder' | 'since'>;
type Result = { granted: true } | { granted: false; held_by: HeldBy } | { released: boolean; held_by?: HeldBy };
type Caller = { home: string; cwd: string; holder: string | null; worker?: boolean; fallback?: boolean };
const heldBy = ({ holder, since }: LeaseRecord) => ({ holder, since });

function locked<T>(dir: string, flock: string, run: () => T): T {
  const fd = fs.openSync(dir, 'r');
  try {
    // The child and parent share the open file description; closing the parent's fd unlocks it.
    const lock = spawnSync(flock, ['-x', '-w', '1', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 1500 });
    if (lock.status !== 0 || lock.error) throw new Error(`hud_lease: flock could not lock ${dir}: ${lock.error?.message || lock.stderr?.toString().trim() || lock.status}`);
    return run();
  } finally { fs.closeSync(fd); }
}

function publish(file: string, lease: LeaseRecord): void {
  writeJsonPrivate(file, lease, { mkdir: false, exclusive: true });
}

export async function takeLease(args: Record<string, unknown>, caller: Caller, signal?: AbortSignal): Promise<Result> {
  const { home, cwd, holder, worker, fallback } = caller;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name || name.length > 120 || /\p{Cc}/u.test(name)) throw new Error('invalid_arguments: name');
  if (args.release !== undefined && typeof args.release !== 'boolean') throw new Error('invalid_arguments: release');
  const seconds = args.wait_s === undefined ? 120 : args.wait_s;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('invalid_arguments: wait_s');
  if (!holder) throw new Error('hud_lease needs the main session’s HERDR_PANE_ID');
  const flock = executable('flock');
  if (!flock) throw new Error('hud_lease requires util-linux flock on PATH');
  const project = sharedRoot(cwd), kind = worker ? 'worker' : 'main';
  const dir = join(home, 'leases');
  const file = join(dir, createHash('sha256').update(JSON.stringify([project, name])).digest('hex') + '.json');
  const own = (lease: LeaseRecord) => lease.kind === kind && lease.holder === holder;
  const deadline = performance.now() + Math.min(seconds, MAX_WAIT) * 1000;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    signal?.throwIfAborted();
    // Contended acquisition polls read-only; only a possible grant or release takes flock.
    const peek = readLease(file);
    const result = !args.release && peek && !own(peek) && leaseActive(home, peek)
      ? { granted: false as const, held_by: heldBy(peek) }
      : locked<Result>(dir, flock, () => {
        const lease = readLease(file);
        if (args.release) {
          if (lease && own(lease)) { fs.unlinkSync(file); return { released: true }; }
          return lease && leaseActive(home, lease) ? { released: false, held_by: heldBy(lease) } : { released: false };
        }
        if (lease && leaseActive(home, lease)) {
          return own(lease) ? { granted: true } : { granted: false, held_by: heldBy(lease) };
        }
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
      });
    const left = deadline - performance.now();
    if (!('granted' in result) || result.granted || left <= 0) return result;
    await sleep(Math.min(250, left), undefined, { signal });
  }
}

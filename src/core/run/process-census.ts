import { closeSync, constants, openSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import type { ProcRecord } from './process.js';
import type { ProcessScope, ProcessStamp } from '../types/supervision.js';
import { readProcessDomain } from '../process-domain.js';

export interface CensusRecord extends ProcRecord {
  threads: number;
}

/** Parse the identity and membership fields strictly; NaN must never filter a live process out. */
export function parseProcessStat(
  pid: number,
  text: string,
  domain: Pick<ProcessStamp, 'boot_id' | 'pid_domain'>
): CensusRecord {
  const end = text.lastIndexOf(') ');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !text.startsWith(`${pid} (`) || end < 3)
    throw new Error('invalid process stat');
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const number = (index: number, signed = false): number => {
    const value = fields[index] ?? '';
    if (!(signed ? /^-?\d+$/ : /^\d+$/).test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error('invalid process stat');
    return Number(value);
  };
  if (!/^[RSDZTWtXxKWPIN]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[19] ?? ''))
    throw new Error('invalid process stat');
  const threads = number(17);
  if (threads < 1) throw new Error('invalid process stat');
  return {
    stamp: { pid, proc_start: fields[19], boot_id: domain.boot_id, pid_domain: domain.pid_domain },
    state: fields[0],
    flags: number(6),
    pgid: number(2),
    sid: number(3),
    ppid: number(1),
    tty: number(4, true),
    foregroundPgid: number(5, true),
    threads,
  };
}

export interface CensusAccess {
  list(path: string): string[];
  text(path: string): string;
  visibility(domain: Pick<ProcessStamp, 'boot_id' | 'pid_domain'>): string | null;
}

/** A restricted, overmounted or unrecognised proc view is not absence evidence. No caching. */
export function procVisibility(domain: Pick<ProcessStamp, 'boot_id' | 'pid_domain'>): string | null {
  let fd: number | undefined;
  try {
    if (process.platform !== 'linux' || statfsSync('/proc').type !== 0x9fa0) return null;
    const here = readProcessDomain({ machineIdPolicy: 'follow' });
    if (here.bootId !== domain.boot_id || here.runPidDomain !== domain.pid_domain) return null;
    fd = openSync('/proc', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const id = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1];
    if (!id) return null;
    return procMountWitness(readFileSync('/proc/self/mountinfo', 'utf8'), id);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Pure validation of the active mount and any numeric metadata masks. */
export function procMountWitness(mountinfo: string, id: string): string | null {
  const lines = mountinfo.trim().split('\n');
  const active = lines.filter((line) => line.split(' ', 1)[0] === id);
  if (active.length !== 1) return null;
  const [mount, filesystem] = active[0].split(' - ');
  const fields = mount.split(' '),
    fs = filesystem?.split(' ');
  if (fields[3] !== '/' || fields[4] !== '/proc' || fs?.[0] !== 'proc') return null;
  // Reject unknown superblock options too: future visibility filters must be reviewed.
  if (!fs[2]?.split(',').every((option) => /^(rw|ro|hidepid=(0|off)|gid=\d+|subset=all)$/.test(option))) return null;
  if (fields[5]?.split(',').some((option) => option.startsWith('hidepid=') && !/^hidepid=(0|off)$/.test(option)))
    return null;
  // A bind/mask over a numeric directory or its metadata can conceal identities.
  if (lines.some((line) => /^\/proc\/(?:\d+|self|thread-self)(?:\/|$)/.test(line.split(' ')[4] ?? ''))) return null;
  return active[0];
}

export const linuxCensusAccess: CensusAccess = {
  list: (path) => readdirSync(path),
  text: (path) => readFileSync(path, 'utf8'),
  visibility: procVisibility,
};

export interface ZombieProofOptions {
  /** Bounded race/fault seams only. Production always uses the real procfs reader. */
  afterSnapshot?: (scan: 1 | 2) => void;
  access?: CensusAccess;
}

function same(a: ProcessStamp, b: ProcessStamp): boolean {
  return a.pid === b.pid && a.proc_start === b.proc_start && a.boot_id === b.boot_id && a.pid_domain === b.pid_domain;
}
function terminal(record: CensusRecord): boolean {
  return record.state === 'Z' || record.state === 'X';
}

/** Exposed for repeatable proof-cost measurements; any failed read invalidates this entire census. */
export function readProcessCensus(
  domain: Pick<ProcessStamp, 'boot_id' | 'pid_domain'>,
  access: CensusAccess = linuxCensusAccess,
  afterSnapshot?: () => void
): Map<number, CensusRecord> {
  const pids = access.list('/proc').filter((name) => /^\d+$/.test(name));
  afterSnapshot?.();
  const records = new Map<number, CensusRecord>();
  for (const name of pids) {
    const pid = Number(name);
    if (records.has(pid)) throw new Error('duplicate process identity');
    records.set(pid, parseProcessStat(pid, access.text(`/proc/${pid}/stat`), domain));
  }
  return records;
}

export function terminalThreadGroup(record: CensusRecord, access: CensusAccess = linuxCensusAccess): boolean {
  if (!terminal(record) || record.threads !== 1) return false;
  const path = `/proc/${record.stamp.pid}/task`;
  const tids = access.list(path);
  if (tids.length !== 1 || tids[0] !== String(record.stamp.pid)) return false;
  const task = parseProcessStat(record.stamp.pid, access.text(`${path}/${tids[0]}/stat`), record.stamp);
  return (
    same(task.stamp, record.stamp) &&
    terminal(task) &&
    task.threads === 1 &&
    task.sid === record.sid &&
    task.pgid === record.pgid
  );
}

/** Two bounded censuses, with full identity corroboration before SID filtering (RUNZ1 ruling). */
export function proveZombieSessionGone(
  scope: ProcessScope,
  subjects: readonly ProcessStamp[],
  options: ZombieProofOptions = {}
): boolean {
  if (
    scope.scope_kind !== 'pgid' ||
    !Number.isSafeInteger(scope.pgid) ||
    scope.pgid <= 0 ||
    scope.sid !== scope.pgid ||
    scope.pgid !== scope.group_leader.pid ||
    scope.boot_id !== scope.group_leader.boot_id ||
    scope.pid_domain !== scope.group_leader.pid_domain
  )
    return false;
  const access = options.access ?? linuxCensusAccess;
  try {
    const witness = access.visibility(scope);
    if (witness === null) return false;
    const first = readProcessCensus(scope, access, () => options.afterSnapshot?.(1));
    const session = [...first.values()].filter((record) => record.sid === scope.sid);
    if (session.length === 0 || !session.every((record) => terminalThreadGroup(record, access))) return false;
    // A different leader instance can never be corroboration for this frozen scope.
    const leader = first.get(scope.group_leader.pid);
    if (leader && (!same(leader.stamp, scope.group_leader) || leader.sid !== scope.sid || leader.pgid !== scope.pgid))
      return false;
    for (const subject of subjects) {
      const record = first.get(subject.pid);
      if (record && same(record.stamp, subject) && !terminalThreadGroup(record, access)) return false;
    }
    const second = readProcessCensus(scope, access, () => options.afterSnapshot?.(2));
    for (const record of second.values()) {
      const previous = first.get(record.stamp.pid);
      if (!previous || !same(previous.stamp, record.stamp)) return false;
      if (record.sid === scope.sid && (previous.sid !== scope.sid || !terminalThreadGroup(record, access)))
        return false;
    }
    for (const subject of subjects) {
      const record = second.get(subject.pid);
      if (record && same(record.stamp, subject) && !terminalThreadGroup(record, access)) return false;
    }
    return access.visibility(scope) === witness;
  } catch {
    // ENOENT/ESRCH after enumeration is churn, not a complete negative observation.
    return false;
  }
}

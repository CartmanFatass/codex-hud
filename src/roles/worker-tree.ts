import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function readProcStat(pid: number) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '')) throw Error(`unreadable process identity for PID ${pid}`);
  return { state: fields[0], ppid: Number(fields[1]), threads: Number(fields[17]), start: fields[19]! };
}

export function procStat(pid: number) {
  try { return readProcStat(pid); } catch { return null; }
}

type Stamp = { pid: number; start: string };
type Snapshot = { version: 2; bootId: string; pid: number; start: string; members: Stamp[] };
type Capture = { snapshot?: Snapshot; issue?: string };
const validPid = (pid: unknown): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1;
const validStart = (start: unknown): start is string => typeof start === 'string' && /^\d+$/.test(start);
const active = (state: string | undefined) => !/^[ZXx]$/.test(state ?? '');
const boot = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
export const UNVERIFIED_TREE_NOTE = 'descendants without captured ancestry left alone';

/** Capture only individually verified parent/child links, before quit or native shutdown can orphan them. */
export function rememberWorkerTree(dir: string, status: unknown, carry?: Snapshot): Capture {
  let snapshot: Snapshot | undefined, issue: string | undefined;
  const owned = new Map<number, Stamp>();
  const unresolved = (error: unknown) => `worker-tree snapshot unresolved: ${(error as Error).message}`;
  try {
    if (!status || typeof status !== 'object') return {};
    const { pid, pid_start_time: start, slot, task_dir } = status as Record<string, unknown>;
    if (slot !== 'primary' || !validPid(pid) || !validStart(start) ||
        (task_dir !== dir && task_dir !== fs.realpathSync(dir))) return {};
    const session = fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8');
    const pane = /^LEFT=([^\r\n]+)$/m.exec(session)?.[1];
    if (!pane || pane === /^ORCH=([^\r\n]+)$/m.exec(session)?.[1]) return {};
    const bootId = boot(), file = join(dir, 'worker-tree.json');
    if (!bootId) throw Error('boot identity unavailable');
    const matches = (value: Snapshot | undefined) => value?.version === 2 && value.bootId === bootId &&
      value.pid === pid && value.start === start && Array.isArray(value.members);
    snapshot = { version: 2, bootId, pid, start, members: [] };
    const add = (member: Stamp) => {
      if (!member || !validPid(member.pid) || !validStart(member.start) || member.pid === pid || member.pid === process.pid) return;
      owned.set(member.pid, member);
    };
    if (carry && matches(carry)) for (const member of carry.members) add(member);
    let prior;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        if (!fs.fstatSync(fd).isFile()) throw Error('worker-tree.json is not a regular file');
        prior = JSON.parse(fs.readFileSync(fd, 'utf8')) as Snapshot;
      } finally { fs.closeSync(fd); }
    } catch (error) {
      // Failed disk reads must not discard ownership we can still prove from the live root.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') issue = unresolved(error);
    }
    // Version 1 included group/tag guesses; none of that evidence is eligible for signalling.
    if (prior && matches(prior)) for (const member of prior.members) if (!owned.has(member?.pid)) add(member);
    if (readProcStat(pid)?.start === start) {
      const children = new Map<number, Stamp[]>();
      for (const name of fs.readdirSync('/proc')) {
        const id = Number(name);
        if (!/^\d+$/.test(name) || !validPid(id) || id === pid || id === process.pid) continue;
        const child = readProcStat(id);
        if (!child || !active(child.state) || Number(child.start) < Number(start)) continue;
        const member = { pid: id, start: child.start };
        const siblings = children.get(child.ppid);
        if (siblings) siblings.push(member); else children.set(child.ppid, [member]);
      }
      const parents = [{ pid, start }];
      for (const parent of parents) for (const child of children.get(parent.pid) ?? []) {
        const current = readProcStat(child.pid);
        // Check the child first, then recheck the parent's identity: a recycled PPID alone is not ancestry.
        if (current?.start !== child.start || current.ppid !== parent.pid || readProcStat(parent.pid)?.start !== parent.start) continue;
        parents.push(child);
        add(child);
      }
    }
    snapshot.members = [...owned.values()];
    const data = JSON.stringify(snapshot);
    if (!issue && JSON.stringify(prior) !== data) {
      const temp = `${file}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, file);
      } finally { fs.rmSync(temp, { force: true }); }
    }
    return { snapshot, issue };
  } catch (error) {
    if (snapshot) snapshot.members = [...owned.values()];
    return { snapshot, issue: issue ?? unresolved(error) };
  }
}

/** Keep the external reaper's worker/tab checks; clean only descendants with captured ancestry. */
export async function reapWorkerTree<T>(dir: string, status: unknown, reap: () => T | Promise<T>, ok: (result: T) => boolean, carry?: Snapshot) {
  const before = rememberWorkerTree(dir, status, carry);
  const result = await reap();
  const after = rememberWorkerTree(dir, status, before.snapshot ?? carry);
  const snapshot = after.snapshot ?? before.snapshot;
  let issue = before.issue ?? after.issue;
  if (snapshot) {
    const protectedPids = new Set<number>();
    try {
      for (let id = process.pid; id > 1; id = readProcStat(id)?.ppid ?? 0) protectedPids.add(id);
      if (boot() === snapshot.bootId && !protectedPids.has(snapshot.pid)) {
        const members = snapshot.members.filter(({ pid }) => !protectedPids.has(pid));
        const live = ({ pid, start }: Stamp) => {
          try {
            const stat = readProcStat(pid);
            return stat?.start === start && active(stat.state);
          } catch (error) { issue ??= `worker-tree identity unresolved: ${(error as Error).message}`; return false; }
        };
        const signal = (name: NodeJS.Signals) => {
          for (const member of members) if (live(member)) {
            // Node's numeric kill is not atomic with /proc: exit and reuse between the two remain possible.
            try { process.kill(member.pid, name); } catch { /* Verify again below; never signal blindly. */ }
          }
        };
        if (members.some(live)) {
          signal('SIGTERM');
          await delay(250);
          signal('SIGKILL');
          for (let attempt = 0; attempt < 10 && members.some(live); attempt++) await delay(50);
        }
        if (members.some(live)) issue ??= 'worker descendants still running';
      }
    } catch (error) { issue ??= `worker-tree identity unresolved: ${(error as Error).message}`; }
  }
  return { result, complete: ok(result) && !issue, issue, snapshot };
}

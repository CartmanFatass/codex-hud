import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  isActiveProcState as active,
  isValidPid as validPid,
  listProcPids,
  procStat,
  readBootId,
  readProcCmdline,
  readProcStat as readStat,
} from '../utils/proc.js';
import { binScript, jobFiles } from '../mcp/paths.js';
import type { WorkerTreeSnapshot as Snapshot } from '../mcp/job-contracts.js';

export { procStat };

const readProcStat = (pid: number) => readStat(pid, { strict: true });

type Stamp = Snapshot['members'][number];
type Capture = { snapshot?: Snapshot; issue?: string; missingAfterExit?: boolean };
const validStart = (start: unknown): start is string => typeof start === 'string' && /^\d+$/.test(start);
const boot = () => readBootId({ strict: true }) ?? '';
export const UNVERIFIED_TREE_NOTE = 'descendants without captured ancestry left alone';

function recordedRootAlive(pid: number, start: string) {
  const stat = readProcStat(pid);
  return stat?.start === start && active(stat.state);
}

export function workerTreeRootGone(pid: unknown, start: unknown) {
  try { return validPid(pid) && validStart(start) && !recordedRootAlive(pid, start); }
  catch { return false; } // Unreadable /proc is not confirmation of exit.
}

/** Headless roots are HUD's own per-job runner, not a herdr pane. Verify the actual launch argv. */
export function sonicRoot(dir: string, pid: number, start: string, bootId: unknown): 'owned' | 'gone' {
  if (!validPid(pid) || !validStart(start) || !bootId) throw Error('missing sonic process identity');
  if (boot() !== bootId || !recordedRootAlive(pid, start)) return 'gone';
  const args = readProcCmdline(pid);
  if (args?.[1] === binScript('sonic-run') && args[2] === dir && recordedRootAlive(pid, start)) return 'owned';
  if (!recordedRootAlive(pid, start)) return 'gone';
  throw Error('sonic runner identity unresolved');
}

/** Capture only individually verified parent/child links, before quit or native shutdown can orphan them. */
export function rememberWorkerTree(dir: string, status: unknown, carry?: Snapshot): Capture {
  let snapshot: Snapshot | undefined, issue: string | undefined;
  const owned = new Map<number, Stamp>();
  const unresolved = (error: unknown) => `worker-tree snapshot unresolved: ${(error as Error).message}`;
  try {
    if (!status || typeof status !== 'object') return {};
    const { pid, pid_start_time: start, slot, task_dir } = status as Record<string, unknown>;
    if (!validPid(pid) || !validStart(start) || (task_dir !== dir && task_dir !== fs.realpathSync(dir))) return {};
    if (slot === 'sonic') {
      const bootId = (status as Record<string, unknown>).boot_id;
      if (bootId !== boot()) return {};
      sonicRoot(dir, pid, start, bootId);
    } else {
      if (slot !== 'primary') return {};
      const session = fs.readFileSync(join(dir, jobFiles.session), 'utf8');
      const pane = /^LEFT=([^\r\n]+)$/m.exec(session)?.[1];
      if (!pane || pane === /^ORCH=([^\r\n]+)$/m.exec(session)?.[1]) return {};
    }
    const bootId = boot(), file = join(dir, jobFiles.workerTree);
    if (!bootId) throw Error('boot identity unavailable');
    // Version 1 included group/tag guesses; none of that evidence is eligible for signalling.
    const matches = (value: Snapshot | undefined): value is Snapshot => value?.version === 2 && value.bootId === bootId &&
      value.pid === pid && value.start === start && Array.isArray(value.members);
    const add = (member: Stamp) => {
      if (!member || !validPid(member.pid) || !validStart(member.start) || member.pid === pid || (slot !== 'sonic' && member.pid === process.pid)) return;
      const previous = owned.get(member.pid);
      if (!previous || Number(member.start) > Number(previous.start)) owned.set(member.pid, member);
    };
    const recover = (value: Snapshot | undefined) => {
      if (!matches(value)) return false;
      snapshot ??= { version: 2, bootId, pid, start, members: [] };
      for (const member of value.members) add(member);
      return true;
    };
    const readSnapshot = (path: string): Snapshot | undefined => {
      try {
        const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          if (!fs.fstatSync(fd).isFile()) throw Error('worker-tree snapshot is not a regular file');
          return JSON.parse(fs.readFileSync(fd, 'utf8')) as Snapshot;
        } finally { fs.closeSync(fd); }
      } catch (error) {
        // Incomplete staged files cannot authorize signalling. Other I/O failures remain unresolved.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') issue ??= unresolved(error);
      }
    };
    recover(carry);
    const prior = readSnapshot(file);
    recover(prior);
    const staged = new Map<string, string>();
    for (const name of fs.readdirSync(dir)) {
      if (!/^worker-tree\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const path = join(dir, name), value = readSnapshot(path);
      if (recover(value)) staged.set(JSON.stringify(value), path);
    }
    if (recordedRootAlive(pid, start)) {
      snapshot ??= { version: 2, bootId, pid, start, members: [] };
      const children = new Map<number, Stamp[]>();
      for (const id of listProcPids()) {
        if (!validPid(id) || id === pid || (slot !== 'sonic' && id === process.pid)) continue;
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
    if (!snapshot) return { issue, missingAfterExit: true };
    snapshot.members = [...owned.values()];
    const data = JSON.stringify(snapshot);
    if (!issue && JSON.stringify(prior) !== data) {
      let temp = staged.get(data);
      if (!temp) {
        temp = `${file}.${randomUUID()}.tmp`;
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); } }
        catch (error) { fs.rmSync(temp, { force: true }); throw error; }
      }
      // If rename fails (e.g. ENOSPC), keep the complete private file for a later reaper.
      fs.renameSync(temp, file);
    }
    return { snapshot, issue };
  } catch (error) {
    if (snapshot) snapshot.members = [...owned.values()];
    return { snapshot, issue: issue ?? unresolved(error) };
  }
}

/** Keep the external reaper's worker/tab checks; clean only descendants with captured ancestry. */
export async function reapWorkerTree<T>(dir: string, status: unknown, reap: () => T | Promise<T>, ok: (result: T) => boolean,
  { carry, expectSnapshot, signal }: { carry?: Snapshot; expectSnapshot?: boolean; signal?: AbortSignal } = {}) {
  const before = rememberWorkerTree(dir, status, carry);
  const result = await reap();
  // A cancelled reaper may not have verified tab ownership yet.
  if (signal?.aborted) return { result, complete: false, issue: undefined, snapshot: before.snapshot ?? carry };
  const after = rememberWorkerTree(dir, status, before.snapshot ?? carry);
  const snapshot = after.snapshot ?? before.snapshot;
  let issue = before.issue ?? after.issue;
  if (!snapshot && expectSnapshot && (before.missingAfterExit || after.missingAfterExit))
    issue ??= 'worker-tree snapshot unresolved: recorded root exited before any matching ancestry snapshot could be recovered';
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
        const signalMembers = (name: NodeJS.Signals) => {
          for (const member of members) if (live(member)) {
            // Node's numeric kill is not atomic with /proc: exit and reuse between the two remain possible.
            try { process.kill(member.pid, name); } catch { /* Verify again below; never signal blindly. */ }
          }
        };
        if (members.some(live)) {
          signalMembers('SIGTERM');
          await delay(250, undefined, { signal });
          signalMembers('SIGKILL');
          for (let attempt = 0; attempt < 10 && members.some(live); attempt++) await delay(50, undefined, { signal });
        }
        if (members.some(live)) issue ??= 'worker descendants still running';
      }
    } catch (error) {
      if (signal?.aborted) return { result, complete: false, issue: undefined, snapshot };
      issue ??= `worker-tree identity unresolved: ${(error as Error).message}`;
    }
  }
  return { result, complete: ok(result) && !issue, issue, snapshot };
}

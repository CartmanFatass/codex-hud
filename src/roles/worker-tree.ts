import { sameTaskDirectory, tabProcessStart } from '../runtime/tab-owner.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
export function sonicRoot(dir: string, pid: number, start: string, bootId: unknown): 'owned' | 'exiting' | 'gone' {
  if (!validPid(pid) || !validStart(start) || !bootId) throw Error('missing sonic process identity');
  if (boot() !== bootId || !recordedRootAlive(pid, start)) return 'gone';
  const args = readProcCmdline(pid);
  if (args?.[1] === binScript('sonic-run') && args[2] === dir && recordedRootAlive(pid, start)) return 'owned';
  if (!recordedRootAlive(pid, start)) return 'gone';
  // Linux can clear cmdline before stat reaches zombie state. Wait for definitive
  // exit rather than signalling without argv evidence or deferring the whole reap.
  if (args?.length === 0) return 'exiting';
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
    if ((task_dir !== undefined || pid != null || start != null) && !sameTaskDirectory(dir, task_dir))
      throw Error('worker receipt task directory mismatch');
    if (pid == null && start == null) return {}; // No process identity was published.
    if (!validPid(pid) || !validStart(start)) throw Error('incompatible worker PID/start receipt');
    const headless = slot === 'sonic' || slot === 'headless';
    let captureLive = true;
    if (headless) {
      const bootId = (status as Record<string, unknown>).boot_id;
      if (bootId !== boot()) throw Error('worker receipt boot identity mismatch');
      captureLive = sonicRoot(dir, pid, start, bootId) === 'owned';
    } else {
      if (slot !== 'primary') throw Error('worker receipt slot mismatch');
      const session = fs.readFileSync(join(dir, jobFiles.session), 'utf8');
      const pane = /^LEFT=([^\r\n]+)$/m.exec(session)?.[1];
      if (!pane || pane === /^ORCH=([^\r\n]+)$/m.exec(session)?.[1]) throw Error('missing or protected worker pane identity');
    }
    const bootId = boot(), file = join(dir, jobFiles.workerTree);
    if (!bootId) throw Error('boot identity unavailable');
    // Version 1 included group/tag guesses; none of that evidence is eligible for signalling.
    const matches = (value: Snapshot | undefined): value is Snapshot => value?.version === 2 && value.bootId === bootId &&
      value.pid === pid && value.start === start && Array.isArray(value.members);
    const add = (member: Stamp) => {
      if (!member || !validPid(member.pid) || !validStart(member.start) || member.pid === pid || (!headless && member.pid === process.pid)) return;
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
    if (captureLive && recordedRootAlive(pid, start)) {
      snapshot ??= { version: 2, bootId, pid, start, members: [] };
      const children = new Map<number, Stamp[]>();
      for (const id of listProcPids()) {
        if (!validPid(id) || id === pid || (!headless && id === process.pid)) continue;
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
        // detached:true creates a new session, but not a new PPID. A registered sonic
        // runner owns its entire subtree; other detached helpers still belong to this turn.
        if (current.session === child.pid) {
          const argv = readProcCmdline(child.pid), childDir = argv?.[2];
          if (argv?.[1] === binScript('sonic-run') && childDir && dirname(childDir) === dirname(dir) &&
              fs.existsSync(join(dir, jobFiles.sonic, basename(childDir)))) continue;
        }
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

type Grant = 'root' | 'pane' | 'none';
/** Explicitly tied to the snapshot's root instance; an exit code, even zero,
 * never attests ownership. A verified root may still need its children stopped. */
export function tabTreeGrant(result: { stdout: string; reason: string }, snapshot: Snapshot): Grant {
  if (result.reason !== 'ok' && result.reason !== 'failed') return 'none';
  const first = result.stdout.split('\n', 1)[0], stamp = `${snapshot.pid}:${snapshot.start}`;
  return first === `tree-owner ${stamp}` ? 'root' : first === `tree-pane ${stamp}` ? 'pane' : 'none';
}
/** Keep the reaper's worker/tab checks; clean only descendants with captured ancestry. */
export async function reapWorkerTree<T>(dir: string, status: unknown, reap: () => T | Promise<T>, ok: (result: T) => boolean,
  { carry, expectSnapshot, signal, treeGrant }: { carry?: Snapshot; expectSnapshot?: boolean; signal?: AbortSignal; treeGrant?: (result: T, snapshot: Snapshot) => Grant } = {}) {
  const before = rememberWorkerTree(dir, status, carry);
  const result = await reap();
  // A cancelled reaper may not have verified tab ownership yet.
  if (signal?.aborted) return { result, complete: false, issue: undefined, snapshot: before.snapshot ?? carry };
  const after = rememberWorkerTree(dir, status, before.snapshot ?? carry);
  const snapshot = after.snapshot ?? before.snapshot;
  const missingSnapshot = !snapshot && expectSnapshot && (before.missingAfterExit || after.missingAfterExit);
  const missingNote = missingSnapshot
    ? 'worker-tree snapshot unresolved: recorded root exited before any matching ancestry snapshot could be recovered' : undefined;
  // An unreadable snapshot or /proc is not proof that ancestry is unrecoverable.
  const unrecoverable = after.missingAfterExit && !after.issue ? missingNote : undefined;
  let issue = unrecoverable ?? before.issue ?? after.issue ?? missingNote;
  if (snapshot) {
    const slot = (status as { slot?: string } | null)?.slot;
    const grant = treeGrant ? treeGrant(result, snapshot) : ok(result) || slot === 'headless' || slot === 'sonic' ? 'root' : 'none';
    const protectedPids = new Set<number>();
    try {
      for (let id = process.pid; id > 1; id = readProcStat(id)?.ppid ?? 0) protectedPids.add(id);
      if (boot() === snapshot.bootId && !protectedPids.has(snapshot.pid)) {
        let members = snapshot.members.filter(({ pid }) => !protectedPids.has(pid));
        const live = ({ pid, start }: Stamp) => {
          try {
            const stat = readProcStat(pid);
            return stat?.start === start && active(stat.state);
          } catch (error) { issue ??= `worker-tree identity unresolved: ${(error as Error).message}`; return false; }
        };
        if (grant !== 'root' && members.some(live)) {
          const session = grant === 'pane' ? fs.readFileSync(join(dir, jobFiles.session), 'utf8') : '';
          const pane = /^LEFT=(.+)$/m.exec(session)?.[1], tab = /^TAB=(.+)$/m.exec(session)?.[1];
          members = members.filter(member => {
            if (!live(member)) return false;
            if (pane && tab && tabProcessStart(fs.realpathSync(dir), pane, tab, member.pid, /^LAUNCH=(.+)$/m.exec(session)?.[1]) === member.start) return true;
            issue ??= 'worker descendant cleanup not authorized; left alone';
            return false;
          });
        }
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
  return { result, complete: ok(result) && !issue, issue, snapshot, unrecoverable };
}

/** End only verified live descendants of a running process (never the root itself or caller ancestors). */
export async function killDescendantTree(rootPid: number, rootStart: string,
  { dir, signal }: { dir?: string; signal?: AbortSignal } = {}): Promise<number> {
  if (!validPid(rootPid) || !validStart(rootStart) || !recordedRootAlive(rootPid, rootStart)) return 0;
  const protectedPids = new Set<number>([rootPid]);
  for (let id = process.pid; id > 1; id = readProcStat(id)?.ppid ?? 0) protectedPids.add(id);
  const children = new Map<number, Stamp[]>();
  for (const id of listProcPids()) {
    if (!validPid(id) || protectedPids.has(id)) continue;
    const child = readProcStat(id);
    if (!child || !active(child.state) || Number(child.start) < Number(rootStart)) continue;
    const member = { pid: id, start: child.start };
    const siblings = children.get(child.ppid);
    if (siblings) siblings.push(member); else children.set(child.ppid, [member]);
  }
  const members: Stamp[] = [];
  const parents: Stamp[] = [{ pid: rootPid, start: rootStart }];
  for (const parent of parents) for (const child of children.get(parent.pid) ?? []) {
    const current = readProcStat(child.pid);
    // Check the child first, then recheck the parent's identity: a recycled PPID alone is not ancestry.
    if (current?.start !== child.start || current.ppid !== parent.pid || readProcStat(parent.pid)?.start !== parent.start) continue;
    if (dir && current.session === child.pid) {
      const argv = readProcCmdline(child.pid), childDir = argv?.[2];
      if (argv?.[1] === binScript('sonic-run') && childDir && dirname(childDir) === dirname(dir) &&
          fs.existsSync(join(dir, jobFiles.sonic, basename(childDir)))) continue;
    }
    parents.push(child);
    members.push(child);
  }
  if (!members.length) return 0;
  // Signal leaves first so a child exits before a parent shell can mask or respawn it.
  const targets = [...members].reverse();
  const live = ({ pid, start }: Stamp) => {
    const stat = readProcStat(pid);
    return stat?.start === start && active(stat.state);
  };
  const signalMembers = (name: NodeJS.Signals) => {
    for (const member of targets) if (live(member)) {
      try { process.kill(member.pid, name); } catch { /* Verify again below; never signal blindly. */ }
    }
  };
  signalMembers('SIGTERM');
  for (let attempt = 0; attempt < 5 && targets.some(live); attempt++) await delay(50, undefined, { signal });
  if (targets.some(live)) {
    signalMembers('SIGKILL');
    for (let attempt = 0; attempt < 10 && targets.some(live); attempt++) await delay(50, undefined, { signal });
  }
  return members.length;
}

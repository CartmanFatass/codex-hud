import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function procStat(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '')
      ? { state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]), threads: Number(fields[17]), start: fields[19] }
      : null;
  } catch { return null; }
}

type Stamp = { pid: number; start: string };
const live = ({ pid, start }: Stamp) => {
  const stat = procStat(pid);
  return stat?.start === start && !/^[ZXx]$/.test(stat.state);
};
const boot = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

/** Preserve positive ownership evidence before /quit can reparent the worker's children. */
export function rememberWorkerTree(dir: string, status: unknown): Stamp[] {
  if (!status || typeof status !== 'object') return [];
  const { pid, pid_start_time: start, slot, task_dir } = status as Record<string, unknown>;
  if (slot !== 'primary' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 ||
    typeof start !== 'string' || !/^\d+$/.test(start)) return [];
  if (task_dir !== dir && task_dir !== fs.realpathSync(dir)) return [];
  let session;
  try { session = fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const pane = /^LEFT=([^\r\n]+)$/m.exec(session)?.[1];
  if (!pane || pane === /^ORCH=([^\r\n]+)$/m.exec(session)?.[1]) return [];
  const root = procStat(pid), bootId = boot();
  const file = join(dir, 'worker-tree.json');
  const owned = new Map<number, Stamp>();
  try {
    const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prior.bootId === bootId && prior.pid === pid && prior.start === start)
      for (const member of prior.members) if (live(member)) owned.set(member.pid, member);
  } catch { /* No usable pre-quit snapshot. */ }

  // Never operate on this caller's own process tree. Real worker panes are siblings of the caller.
  for (let id = process.pid; id > 1; id = procStat(id)?.ppid ?? 0) if (id === pid) return [];
  if (!root || root.start === start) {
    const children = new Map<number, Stamp[]>();
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const id = Number(name), p = procStat(id);
      if (!p || id <= 1 || id === pid || /^[ZXx]$/.test(p.state) || Number(p.start) < Number(start)) continue;
      const member = { pid: id, start: p.start };
      const siblings = children.get(p.ppid);
      if (siblings) siblings.push(member); else children.set(p.ppid, [member]);
      // A job-pane marker alone is not ownership (e.g. other commands run in that pane).
      // An orphan must also be in the worker-led process group; never signal an entire group by number.
      if (p.pgid === pid && (!root || root.pgid === pid)) {
        try {
          const env = fs.readFileSync(`/proc/${id}/environ`, 'utf8').split('\0');
          if (env.includes(`HUD_JOB_DIR=${dir}`) && env.includes(`HERDR_PANE_ID=${pane}`)) owned.set(id, member);
        } catch { /* No verified group membership. */ }
      }
    }
    const parents = [...owned.values()];
    if (procStat(pid)?.start === start) parents.push({ pid, start });
    for (const parent of parents) {
      if (procStat(parent.pid)?.start !== parent.start) continue;
      for (const child of children.get(parent.pid) ?? []) {
        if (owned.has(child.pid) || !live(child) || procStat(child.pid)?.ppid !== parent.pid) continue;
        owned.set(child.pid, child); parents.push(child);
      }
    }
  }
  const members = [...owned.values()];
  if (members.length) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ bootId, pid, start, members }), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return members;
}

/** Keep the external reaper's worker/tab checks; clean only individually verified descendants. */
export async function reapWorkerTree<T>(dir: string, status: unknown, reap: () => T | Promise<T>, ok: (result: T) => boolean) {
  const before = rememberWorkerTree(dir, status);
  const result = await reap();
  // Even a failed worker exit can be waiting for these descendants; leave the worker/tab retry to pi-role-reap.
  const members = [...new Map([...before, ...rememberWorkerTree(dir, status)].map((member) => [member.pid, member])).values()];
  const signal = (name: NodeJS.Signals) => {
    for (const member of members) if (live(member)) {
      try { process.kill(member.pid, name); } catch { /* Liveness below keeps failed cleanup retryable. */ }
    }
  };
  if (members.some(live)) {
    signal('SIGTERM');
    await delay(250);
    signal('SIGKILL');
    for (let attempt = 0; attempt < 10 && members.some(live); attempt++) await delay(50);
  }
  return { result, complete: ok(result) && !members.some(live) };
}

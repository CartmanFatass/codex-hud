import * as fs from 'node:fs';

/** Linux x86_64/arm64/WSL2 USER_HZ (sysconf(_SC_CLK_TCK)). */
export const LINUX_USER_HZ = 100;

export interface ProcStat {
  state: string;
  ppid: number;
  pgrp: number;
  session: number;
  threads: number;
  start: string;
}

export interface ProcChildren {
  pids: number[];
  truncated: boolean;
}

export const isValidPid = (pid: unknown): pid is number =>
  typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1;

export const isActiveProcState = (state: string | undefined): boolean =>
  !/^[ZXx]$/.test(state ?? '');

const isMissingProc = (error: unknown): boolean =>
  ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Parse `/proc/<pid>/stat` after the final ')' (comm may contain spaces or parentheses). */
export function parseProcStat(raw: string): ProcStat | null {
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const start = fields[19];
  if (!state || !/^\d+$/.test(start ?? '')) return null;
  return {
    state,
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    session: Number(fields[3]),
    threads: Number(fields[17]),
    start,
  };
}

/** Read `/proc/<pid>/stat`. With `strict`, only ENOENT/ESRCH returns null; unreadable or malformed throws. */
export function readProcStat(pid: number, options?: { strict?: boolean }): ProcStat | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw: string;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if (isMissingProc(error)) return null;
    if (options?.strict) throw error;
    return null;
  }
  const parsed = parseProcStat(raw);
  if (!parsed && options?.strict) throw Error(`unreadable process identity for PID ${pid}`);
  return parsed;
}

export function procStat(pid: number): ProcStat | null {
  return readProcStat(pid);
}

/**
 * Check whether a PID is live (present and not Z/X/x).
 * With `expectedStart`, requires a readable `/proc/<pid>/stat` with matching start time.
 * Without `expectedStart`, falls back to `kill(pid, 0)` when `/proc` is unavailable.
 */
export function isProcAlive(pid: number, expectedStart?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const stat = procStat(pid);
  if (stat) {
    if (!isActiveProcState(stat.state)) return false;
    return expectedStart === undefined ? true : stat.start === expectedStart;
  }
  if (expectedStart !== undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read `/proc/<pid>/cmdline` split on NUL bytes (trailing NULs stripped); null if missing or unreadable. */
export function readProcCmdline(pid: number): string[] | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '');
    return raw ? raw.split('\0') : [];
  } catch {
    return null;
  }
}

function procEnvEntries(pid: number): string[] | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); }
  catch { return null; }
}

/** Read one environment snapshot. An empty environment differs from an unreadable one. */
export function readProcEnviron(pid: number): Record<string, string> | null {
  const entries = procEnvEntries(pid);
  if (!entries) return null;
  const env: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    const at = entry.indexOf('=');
    if (at > 0) env[entry.slice(0, at)] ??= entry.slice(at + 1);
  }
  return env;
}

/** Look up one key in `/proc/<pid>/environ`; null if the process is gone, unreadable, or lacks the key. */
export function readProcEnvValue(pid: number, key: string): string | null {
  if (!key) return null;
  const prefix = `${key}=`;
  return procEnvEntries(pid)?.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/** Read `/proc/<pid>/comm` trimmed; null if missing or unreadable. */
export function readProcComm(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); }
  catch { return null; }
}

/** Read the owner UID of `/proc/<pid>`; null if missing or unreadable. */
export function readProcUid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return fs.statSync(`/proc/${pid}`).uid; }
  catch { return null; }
}

/** Read `/proc/sys/kernel/random/boot_id`. With `strict`, throws on unreadable boot_id. */
export function readBootId(options?: { strict?: boolean }): string | null {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch (error) {
    if (options?.strict) throw error;
    return null;
  }
}

/** Kernel boot time in Unix seconds from `/proc/stat` `btime`, or null off Linux. */
export function readBootTimeSec(): number | null {
  try {
    const boot = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1];
    return boot ? Number(boot) : null;
  } catch {
    return null;
  }
}

/** When `pid` started, in Unix seconds, from `/proc`; null if missing or off Linux. */
export function procStartTimeSec(pid: number): number | null {
  const stat = procStat(pid);
  if (!stat) return null;
  const boot = readBootTimeSec();
  return boot === null ? null : boot + Number(stat.start) / LINUX_USER_HZ;
}

/** Numeric PIDs currently listed under `/proc`. Throws if `/proc` cannot be read. */
export function listProcPids(): number[] {
  const pids: number[] = [];
  for (const name of fs.readdirSync('/proc')) {
    if (/^\d+$/.test(name)) pids.push(Number(name));
  }
  return pids;
}

/**
 * Direct child PIDs across `/proc/<pid>/task/<tid>/children` (bounded per thread, deduplicated).
 * Returns `null` when `/proc/<pid>/task` cannot be opened.
 */
export function readProcChildren(pid: number): ProcChildren | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const tasks = `/proc/${pid}/task`;
  let dir: fs.Dir;
  try { dir = fs.opendirSync(tasks); }
  catch { return null; }
  const buffer = Buffer.alloc(4096);
  let truncated = false;
  const seen = new Set<number>();
  const pids: number[] = [];
  try {
    for (let thread; (thread = dir.readSync()) !== null;) {
      let size: number;
      try {
        const fd = fs.openSync(`${tasks}/${thread.name}/children`, 'r');
        try { size = fs.readSync(fd, buffer, 0, buffer.length, null); }
        finally { fs.closeSync(fd); }
      } catch (error) {
        if (isMissingProc(error)) continue;
        truncated = true;
        break;
      }
      // Skip a possibly truncated final PID.
      const ids = buffer.toString('utf8', 0, size).trimStart().split(/\s+/);
      if (size === buffer.length) {
        ids.pop();
        truncated = true;
      }
      for (const raw of ids) {
        if (!raw) continue;
        const child = Number(raw);
        if (!Number.isSafeInteger(child) || child <= 0 || seen.has(child)) continue;
        seen.add(child);
        pids.push(child);
      }
      if (truncated) break;
    }
  } finally { dir.closeSync(); }
  return { pids, truncated };
}

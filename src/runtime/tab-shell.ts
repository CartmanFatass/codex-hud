import * as fs from 'node:fs';
import { join } from 'node:path';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';
import { isActiveProcState, isValidPid, listProcPids, procStat, readProcStat, type ProcStat } from '../utils/proc.js';
import { request } from './herdr-socket.js';
import { tabProcessStart } from './tab-owner.js';

type Stamp = { pane: string; pid: number; start: string; exe: string; inode: string };
type Receipt = { tab: string; launch: string; shells: Stamp[] };
const receiptName = 'tab-shells.json';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const STARTUP_SESSION_FILE = 'shell-session.json';
const MAX_STARTUP_MEMBERS = 64;
export type StartupMember = { pid: number; start: string };
export type StartupShellSession = {
  version: 1;
  launch: string;
  pane: string;
  session: number;
  session_start: string;
  members: StartupMember[];
};

export function startupSessionPath(task: string, launch: string): string {
  if (!uuid.test(launch)) throw Error('invalid startup session generation');
  return join(task, 'cli-invocations', launch, STARTUP_SESSION_FILE);
}

/** Capture active non-shell, non-worker-descendant members of the worker's own
 * pane shell session once at worker start. Exclusive link: never overwrites. */
export function recordStartupShellSessionAt(
  file: string,
  launch: string | undefined,
  pane: string | undefined,
  options: { mkdir?: boolean } = {}
): boolean {
  try {
    if (!file || !launch || !uuid.test(launch) || !pane) return false;
    const self = procStat(process.pid);
    if (!self || !isValidPid(self.session) || self.session === process.pid) return false;
    const leader = procStat(self.session);
    if (!leader || leader.session !== self.session || !isActiveProcState(leader.state)) return false;
    const stats = new Map<number, ProcStat>();
    for (const pid of listProcPids()) {
      const stat = procStat(pid);
      if (stat && stat.session === self.session && isActiveProcState(stat.state)) stats.set(pid, stat);
    }
    const isWorkerOrDescendant = (pid: number): boolean => {
      const seen = new Set<number>();
      for (let cur = pid; cur > 1 && !seen.has(cur); ) {
        if (cur === process.pid) return true;
        seen.add(cur);
        const st = stats.get(cur) ?? procStat(cur);
        if (!st) break;
        cur = st.ppid;
      }
      return false;
    };
    const members: StartupMember[] = [];
    for (const [pid, stat] of stats) {
      if (pid === self.session || isWorkerOrDescendant(pid)) continue;
      members.push({ pid, start: stat.start });
      if (members.length > MAX_STARTUP_MEMBERS) return false;
    }
    const snapshot: StartupShellSession = {
      version: 1,
      launch,
      pane,
      session: self.session,
      session_start: leader.start,
      members,
    };
    writeJsonPrivate(file, snapshot, { mkdir: options.mkdir ?? true, exclusive: true });
    return true;
  } catch {
    return false;
  }
}

export function recordStartupShellSession(
  task: string | undefined,
  launch: string | undefined,
  pane: string | undefined
): boolean {
  try {
    if (!task || !launch || !uuid.test(launch) || !pane) return false;
    return recordStartupShellSessionAt(startupSessionPath(fs.realpathSync(task), launch), launch, pane, { mkdir: true });
  } catch {
    return false;
  }
}

export function readStartupShellSession(task: string, launch: string | undefined): StartupShellSession | null {
  try {
    if (!launch || !uuid.test(launch)) return null;
    const raw = readJsonBounded(startupSessionPath(task, launch), 16384) as Partial<StartupShellSession>;
    if (raw?.version !== 1 || raw.launch !== launch || typeof raw.pane !== 'string' || !raw.pane ||
        !isValidPid(raw.session) || typeof raw.session_start !== 'string' || !/^\d+$/.test(raw.session_start) ||
        !Array.isArray(raw.members) || raw.members.length > MAX_STARTUP_MEMBERS)
      return null;
    const seen = new Set<number>();
    const members: StartupMember[] = [];
    for (const item of raw.members) {
      if (!isValidPid(item?.pid) || item.pid === raw.session || seen.has(item.pid) ||
          typeof item.start !== 'string' || !/^\d+$/.test(item.start))
        return null;
      seen.add(item.pid);
      members.push({ pid: item.pid, start: item.start });
    }
    return {
      version: 1,
      launch: raw.launch,
      pane: raw.pane,
      session: raw.session,
      session_start: raw.session_start,
      members,
    };
  } catch {
    return null;
  }
}

function shellImage(task: string, pane: string, tab: string, launch: string | undefined, pid: unknown): Stamp | null {
  if (!isValidPid(pid)) return null;
  const start = tabProcessStart(task, pane, tab, pid, launch);
  if (!start) return null;
  const link = `/proc/${pid}/exe`, exe = fs.readlinkSync(link), { dev, ino } = fs.statSync(link, { bigint: true });
  return procStat(pid)?.start === start ? { pane, pid, start, exe, inode: `${dev}:${ino}` } : null;
}

/** Capture only at pane creation, before agent start/pane run; never relearn a
 * shell's executable at reap time. Lack of a receipt disables tab close. */
export async function recordTabShells(dir: string, launch: string, tab: string, panes: string[]) {
  try {
    const task = fs.realpathSync(dir);
    const shells = await Promise.all(panes.map(async pane => {
      const info = (await request('pane.process_info', { pane_id: pane }))?.result?.process_info;
      return info?.pane_id === pane ? shellImage(task, pane, tab, launch, info.shell_pid) : null;
    }));
    if (shells.every(s => s !== null)) writeJsonPrivate(join(dir, receiptName), { tab, launch, shells }, { mkdir: false });
  } catch { /* Do not prevent the worker launch, but no fallback authorizes a later close. */ }
}

type ObservedShell = { pane: string; pid: number; group: number; foreground: { pid: number }[] };
export type IdleShellCheck =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };

const UNVERIFIED_SHELL = 'original shell identity or idle foreground unverified; not closing';

export function confirmIdleShells(
  task: string,
  tab: string,
  launch: string | undefined,
  observed: ObservedShell[],
  workerPane?: string
): IdleShellCheck {
  try {
    const receipt = readJsonBounded(join(task, receiptName), 65536) as Receipt;
    if (!launch || receipt?.launch !== launch || receipt.tab !== tab || !Array.isArray(receipt.shells) || receipt.shells.length !== observed.length)
      return { ok: false, retryable: false, reason: UNVERIFIED_SHELL };
    const sessions = new Map<number, { pane: string; pid: number; start: string }>();
    let foregroundBusy = false;
    for (const { pane, pid, group, foreground } of observed) {
      const saved = receipt.shells.find(s => s.pane === pane);
      const now = shellImage(task, pane, tab, launch, pid), stat = procStat(pid);
      if (!saved || !now || saved.pid !== pid || saved.start !== now.start || saved.exe !== now.exe || saved.inode !== now.inode ||
          stat?.start !== now.start || stat.session !== pid)
        return { ok: false, retryable: false, reason: UNVERIFIED_SHELL };
      if (stat.pgrp !== group || group !== pid || foreground.some(p => p.pid !== pid)) foregroundBusy = true;
      sessions.set(pid, { pane, pid, start: saved.start });
    }
    if (sessions.size !== observed.length) return { ok: false, retryable: false, reason: UNVERIFIED_SHELL };
    if (foregroundBusy) return { ok: false, retryable: true, reason: UNVERIFIED_SHELL };
    let snapshotLoaded = false;
    let exemptSession: number | null = null;
    let exemptMembers: Map<number, string> | null = null;
    // Foreground inventory alone omits suspended/background jobs in this pane.
    // Exempt only exact (PID, start) startup members recorded for the worker's
    // own pane shell session at worker start; split shells get no exemption.
    for (const pid of listProcPids()) {
      const stat = readProcStat(pid, { strict: true });
      if (!stat || sessions.has(pid) || !isActiveProcState(stat.state)) continue;
      const owner = sessions.get(stat.session);
      if (!owner) continue;
      if (!workerPane || owner.pane !== workerPane) {
        return { ok: false, retryable: true, reason: 'active process remains in non-worker shell session; not closing' };
      }
      if (!snapshotLoaded) {
        snapshotLoaded = true;
        const snapshot = readStartupShellSession(task, launch);
        if (snapshot && snapshot.pane === workerPane && snapshot.session === owner.pid && snapshot.session_start === owner.start) {
          exemptSession = snapshot.session;
          exemptMembers = new Map(snapshot.members.map(member => [member.pid, member.start]));
        }
      }
      if (!exemptMembers || stat.session !== exemptSession) {
        return { ok: false, retryable: true, reason: 'active process remains in shell session without startup snapshot; not closing' };
      }
      if (exemptMembers.get(pid) !== stat.start) {
        return { ok: false, retryable: true, reason: 'active unlisted process remains in shell session; not closing' };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, retryable: false, reason: UNVERIFIED_SHELL };
  }
}

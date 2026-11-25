import * as fs from 'node:fs';
import { join } from 'node:path';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';
import { isActiveProcState, isValidPid, listProcPids, procStat, readProcStat } from '../utils/proc.js';
import { request } from './herdr-socket.js';
import { tabProcessStart } from './tab-owner.js';

type Stamp = { pane: string; pid: number; start: string; exe: string; inode: string };
type Receipt = { tab: string; launch: string; shells: Stamp[] };
const receiptName = 'tab-shells.json';
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
export function confirmIdleShells(task: string, tab: string, launch: string | undefined, observed: ObservedShell[]) {
  try {
    const receipt = readJsonBounded(join(task, receiptName), 65536) as Receipt;
    if (!launch || receipt?.launch !== launch || receipt.tab !== tab || receipt.shells.length !== observed.length) return false;
    const sessions = new Set<number>();
    for (const { pane, pid, group, foreground } of observed) {
      const saved = receipt.shells.find(s => s.pane === pane);
      const now = shellImage(task, pane, tab, launch, pid), stat = procStat(pid);
      if (!saved || !now || saved.pid !== pid || saved.start !== now.start || saved.exe !== now.exe || saved.inode !== now.inode ||
          stat?.start !== now.start || stat.session !== pid || stat.pgrp !== group || group !== pid ||
          foreground.some(p => p.pid !== pid)) return false;
      sessions.add(pid);
    }
    // Foreground inventory alone omits suspended/background jobs in this pane.
    for (const pid of listProcPids()) {
      const stat = readProcStat(pid, { strict: true });
      if (stat && sessions.has(stat.session) && !sessions.has(pid) && isActiveProcState(stat.state)) return false;
    }
    return true;
  } catch { return false; }
}

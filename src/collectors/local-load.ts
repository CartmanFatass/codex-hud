import { isAbsolute, join } from 'node:path';
import { readFileBounded, readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

const SAMPLE = 'display/cpu-sample.v1.json';
const MAX_AGE_MS = 30_000;
const LOW_RAM_FRACTION = 0.10;

export interface MemoryUse {
  usedKiB: number;
  totalKiB: number;
}
export interface LocalLoad {
  scope: 'Linux' | 'WSL';
  cpu?: number;
  ram?: MemoryUse;
  swap?: MemoryUse;
}
interface Counters { busy: number; idle: number }
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function procText(root: string, name: string, limit: number, firstLine = false): string {
  try {
    const { bytes, truncated } = readFileBounded(join(root, name), limit);
    const raw = bytes.toString('utf8');
    // Only the first (aggregate) line of /proc/stat is needed, even on many-core machines.
    if (firstLine) return raw.slice(0, Math.max(0, raw.indexOf('\n')));
    return truncated ? '' : raw;
  } catch {
    return '';
  }
}

function counters(line: string): Counters | undefined {
  const fields = line.trimEnd().split(/\s+/);
  const ticks = fields.slice(1, 9);
  if (fields[0] !== 'cpu' || ticks.length !== 8 || !ticks.every((v) => /^\d+$/.test(v))) return;
  const [user, nice, system, idle, wait, irq, softirq, steal] = ticks.map(Number);
  // guest/guest_nice are already in user/nice; idle includes iowait.
  const result = { busy: user + nice + system + irq + softirq + steal, idle: idle + wait };
  if (count(result.busy + result.idle)) return result;
}

function sampleCpu(file: string, boot: string, current: Counters, at: number): number | undefined {
  let previous;
  try { previous = readJsonBounded(file, 256) as Partial<Counters & { boot: string; at: number }> | null; }
  catch { /* First call or unreadable sample. */ }
  // A later concurrent sample (or a clock change) cannot form a delta with this one.
  if (previous?.boot === boot && previous.at === at) return;
  try { writeJsonPrivate(file, { boot, at, ...current }); }
  catch { /* State is optional. */ }
  if (previous?.boot !== boot || !count(previous.at) || !(at > previous.at && at - previous.at <= MAX_AGE_MS) ||
      !count(previous.busy) || !count(previous.idle)) return;
  const busy = current.busy - previous.busy, idle = current.idle - previous.idle;
  if (busy >= 0 && idle >= 0 && busy + idle > 0) return Math.round(busy / (busy + idle) * 100);
}

/** Bounded proc reads, no sleeps, services or Windows host probes. Call before rendering. */
export function collectLocalLoad(home: string, now: number, env = process.env): LocalLoad | undefined {
  // An alternate root supports synthetic proc fixtures in subprocesses, including the Rust renderer.
  const root = env.HUD_STATUSLINE_PROC_ROOT ?? '/proc';
  if (process.platform !== 'linux' || !isAbsolute(root)) return;
  const release = procText(root, 'sys/kernel/osrelease', 256).trim();
  if (!release) return;
  const scope = /microsoft|wsl/i.test(release) || env.WSL_INTEROP ? 'WSL' : 'Linux';
  const boot = procText(root, 'sys/kernel/random/boot_id', 64).trim();
  const current = boot && counters(procText(root, 'stat', 512, true));
  const cpu = current ? sampleCpu(join(home, SAMPLE), boot, current, now) : undefined;
  const memory = procText(root, 'meminfo', 8192);
  const kib = (key: string) => {
    const raw = new RegExp(`^${key}:[ \\t]+(\\d+)[ \\t]+kB[ \\t]*$`, 'm').exec(memory)?.[1];
    const value = Number(raw);
    return count(value) ? value : undefined;
  };
  const total = kib('MemTotal'), available = kib('MemAvailable');
  let ram: MemoryUse | undefined, swap: MemoryUse | undefined;
  if (total && available !== undefined && available <= total) {
    ram = { usedKiB: total - available, totalKiB: total };
    if (available / total < LOW_RAM_FRACTION) {
      const swapTotal = kib('SwapTotal'), free = kib('SwapFree');
      if (swapTotal && free !== undefined && free < swapTotal) swap = { usedKiB: swapTotal - free, totalKiB: swapTotal };
    }
  }
  return cpu === undefined && !ram ? undefined : { scope, cpu, ram, swap };
}

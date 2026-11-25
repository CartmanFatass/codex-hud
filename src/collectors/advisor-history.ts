import * as fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadSettings, settingsPath } from '../settings.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { fileSignature } from '../utils/file-signature.js';

export const RECENT_ADVICE_MS = 24 * 60 * 60_000;
const TAIL_BYTES = 64 * 1024;
const MAX_ROWS = 5;

export type AdviceEvent = { at: number; session: string; project?: string } &
  ({ kind: 'advice'; skill: string; path?: string } | { kind: 'rule_hits'; rules: string[] });

function parseAdvice(line: string): AdviceEvent | undefined {
  try {
    const e = JSON.parse(line);
    if (e?.v !== 1 || (e.kind !== 'advice' && e.kind !== 'rule_hits') ||
        typeof e.session !== 'string' || typeof e.at !== 'string') return;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) return;
    const common = { at, session: e.session, project: typeof e.project === 'string' && isAbsolute(e.project) ? e.project : undefined };
    if (e.kind === 'advice' && typeof e.skill === 'string' && e.skill) {
      return { ...common, kind: 'advice', skill: e.skill, path: typeof e.path === 'string' && isAbsolute(e.path) ? e.path : undefined };
    }
    if (e.kind === 'rule_hits' && Array.isArray(e.rules) && e.rules.length &&
        e.rules.every((id: unknown) => typeof id === 'string' && /^R[0-9]+$/.test(id))) {
      return { ...common, kind: 'rule_hits', rules: e.rules };
    }
  } catch { /* A malformed line does not hide other events. */ }
}

const newestFirst = (a: AdviceEvent, b: AdviceEvent) => b.at - a.at;
const utcMonth = (at: number) => new Date(at).toISOString().slice(0, 7);

/** Home-only reader: stat the month(s) intersecting the window; parse only changed 64 KiB tails. */
export class AdvisorHistory {
  private cache = new Map<string, { stamp: string; events: AdviceEvent[] }>();
  private settings?: { file: string; stamp: string; enabled: boolean };
  constructor(private home: string) {}

  private enabled(): boolean {
    const env = { ...process.env, HUD_HOME: this.home };
    const file = settingsPath(env), stamp = fileSignature(file);
    if (stamp === null) return false; // The default is off.
    if (this.settings?.file === file && this.settings.stamp === stamp) return this.settings.enabled;
    try {
      const enabled = loadSettings(env).advisorShadow;
      this.settings = { file, stamp, enabled };
      return enabled;
    } catch { return false; }
  }

  read(now: number): AdviceEvent[] {
    if (!this.enabled()) return [];
    const since = now - RECENT_ADVICE_MS, month = utcMonth(now), previous = utcMonth(since);
    const months = month === previous ? [month] : [month, previous];
    for (const key of this.cache.keys()) if (!months.includes(key)) this.cache.delete(key);
    const recent: AdviceEvent[] = [];
    for (const key of months) {
      const events = this.readMonth(key);
      // Find the first non-future entry without scanning the cached tail on every refresh.
      let lo = 0, hi = events.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (events[mid].at > now) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < Math.min(lo + MAX_ROWS, events.length) && events[i].at >= since; i++) recent.push(events[i]);
    }
    return recent.sort(newestFirst).slice(0, MAX_ROWS);
  }

  private readMonth(month: string): AdviceEvent[] {
    const file = join(this.home, 'events', `${month}.jsonl`);
    try {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isFile()) {
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const hit = this.cache.get(month);
        if (hit?.stamp === stamp) return hit.events;
        const offset = Math.max(0, stat.size - TAIL_BYTES);
        const lines = readFileBounded(file, TAIL_BYTES, { offset }).bytes.toString('utf8').split('\n');
        lines.pop(); // Drop the empty suffix or a write still in progress.
        if (offset) lines.shift(); // The first line may start before the tail.
        const events = lines.reverse().flatMap((line) => parseAdvice(line) ?? []).sort(newestFirst);
        this.cache.set(month, { stamp, events });
        return events;
      }
    } catch { /* Unavailable month; retry on the next refresh. */ }
    this.cache.delete(month);
    return [];
  }
}

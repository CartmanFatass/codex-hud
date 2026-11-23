/** Passive display facts; neither session content nor job artifacts leave the collector. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { record } from '../statusline-parity/storage.js';
import { CLAUDE_QUOTA_FILE } from '../statusline-parity/quota-cache.js';
import { describePlace, type RolePlace } from '../roles/exhausted.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { jobRow } from './thin-jobs.js';

type Client = 'codex' | 'claude';
export interface Watermark { label?: string; remaining: number; resetsAt?: number }
export interface PlaceRadar { launches: number; launchFailed: number; ok: number; failed: number; quietEscalated: number; quota: number }
export interface RoleRadar {
  total: number; ok: number; failed: number; quietEscalated: number; avgMinutes: number | null;
  places?: Record<string, PlaceRadar>;
}
type PiSpend = { costUsd: number; tokens: number; sessions: number; sampled?: true };
export interface ControlRadar {
  quotas?: Partial<Record<Client, Watermark[]>>;
  piToday?: PiSpend;
  roleStats?: Record<string, RoleRadar>;
}

const at = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const dayOf = (ms: number) => new Date(ms).toDateString();
function candidates(root: string, match: (e: fs.Dirent) => boolean) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(match).flatMap((entry) => {
      const path = join(root, entry.name), stat = fs.lstatSync(path, { throwIfNoEntry: false });
      return stat && (entry.isDirectory() ? stat.isDirectory() : stat.isFile()) ? [{ path, stat }] : [];
    });
  } catch { return []; }
}
const newest = (a: { stat: fs.Stats; path: string }, b: typeof a) => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path);

type Signatures = Map<string, { signature: string; value: unknown }>;
type Cache = { previous?: Signatures; next: Signatures };
function read<T>(path: string, limit: number, tail: boolean, cache: Cache, parse: (text: string, cut: boolean) => T): T | undefined {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || (!tail && stat.size > limit)) return;
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const hit = cache.previous?.get(path);
    if (hit?.signature === signature) {
      cache.next.set(path, hit);
      return hit.value as T;
    }
    const offset = tail ? Math.max(0, stat.size - limit) : 0;
    const { bytes, truncated } = readFileBounded(path, limit, { offset });
    if ((!tail && truncated) || bytes.length < stat.size - offset) return;
    const value = parse(bytes.toString('utf8'), offset > 0);
    cache.next.set(path, { signature, value });
    return value;
  } catch { return; }
}
const json = (path: string, cache: Cache) => read(path, 65536, false, cache, (text) => {
  try { return record(JSON.parse(text)); } catch { return undefined; }
});

function quotaRadar(root: string, now: number, cache: Cache): ControlRadar['quotas'] {
  const files = candidates(root, (e) => e.isFile() && e.name.endsWith('.json') && e.name !== CLAUDE_QUOTA_FILE)
    .sort(newest).slice(0, 32).map(({ path }) => path);
  const quotas: NonNullable<ControlRadar['quotas']> = {};
  for (const client of ['codex', 'claude'] as const) {
    let latest = -Infinity;
    for (const path of client === 'codex' ? files : [join(root, CLAUDE_QUOTA_FILE)]) {
      const snapshot = json(path, cache), updated = at(snapshot?.updatedAt);
      if (!(updated > latest && updated <= now) || !Array.isArray(snapshot?.quota)) continue;
      // Versioned snapshots are Codex's; do not misattribute a reserved-name collision.
      if (client === 'claude' && snapshot.version !== undefined) continue;
      const windows = snapshot.quota.slice(0, 2).flatMap((raw): Watermark[] => {
        const { percent, label, resetsAt } = record(raw), reset = at(resetsAt);
        // A last-known reading is valid until its reset, or for 15 minutes with no reset evidence.
        if (!count(percent) || percent > 100 || (resetsAt === undefined ? now - updated > 900000 : !(reset > now))) return [];
        return [{ remaining: 100 - percent, ...(typeof label === 'string' && label ? { label: label.slice(0, 16) } : {}),
          ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) }];
      });
      if (windows.length) { latest = updated; quotas[client] = windows; }
    }
  }
  return Object.keys(quotas).length ? quotas : undefined;
}

function piUsage(text: string, cut: boolean, today: string) {
  let costUsd = 0, tokens = 0, found = false;
  const lines = text.split('\n');
  if (cut) lines.shift(); // The first line may begin in the middle of a record.
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    try {
      const entry = record(JSON.parse(line)), message = record(entry.message), timestamp = at(entry.timestamp);
      if (entry.type !== 'message' || message.role !== 'assistant' || (Number.isFinite(timestamp) && dayOf(timestamp) !== today)) continue;
      const { input, output, cost } = record(message.usage), total = record(cost).total;
      if (!count(input) || !count(output) || !count(total)) continue;
      tokens += input + output; costUsd += total; found = true;
    } catch { /* A writer can leave a partial last line. */ }
  }
  return { costUsd, tokens, found, cut };
}
function piRadar(root: string, today: string, cache: Cache): PiSpend | undefined {
  const dirs = candidates(root, (e) => e.isDirectory()).sort(newest);
  const files = dirs.slice(0, 16).flatMap(({ path }) => candidates(path, (e) => e.isFile() && e.name.endsWith('.jsonl')))
    .filter(({ stat }) => dayOf(stat.mtimeMs) === today).sort(newest);
  const sum: PiSpend = { costUsd: 0, tokens: 0, sessions: 0 };
  if (dirs.length > 16 || files.length > 64) sum.sampled = true;
  for (const { path } of files.slice(0, 64)) {
    const usage = read(path, 256 * 1024, true, cache, (text, cut) => piUsage(text, cut, today));
    if (!usage || usage.cut) sum.sampled = true;
    if (!usage?.found) continue;
    sum.costUsd += usage.costUsd; sum.tokens += usage.tokens; sum.sessions++;
  }
  return sum.sessions ? sum : undefined;
}

const placeName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 64) : null;
};
const fallbackPlace = (job: Record<string, unknown>): string | null => {
  const raw = record(job.place);
  if (raw.harness !== 'pi' && raw.harness !== 'cli' && raw.harness !== 'bro') return null;
  const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return placeName(describePlace({
    harness: raw.harness,
    agent: str(raw.agent) as RolePlace['agent'],
    tool: str(raw.tool) as RolePlace['tool'],
    provider: str(raw.provider) as RolePlace['provider'],
    model: str(raw.model),
  }, str(job.model) ?? null));
};

function roleRadar(hudHome: string, today: string): ControlRadar['roleStats'] {
  const groups = new Map<string, Omit<RoleRadar, 'places'> & { elapsed: number; timed: number; places: Map<string, PlaceRadar> }>();
  const jobCache = getJobIndexCache(hudHome);
  const jobs = jobCache.recentJobFamilies(jobCache.listJobDirsByMtime({ sortBy: 'birthtime' }).dirs, 200);
  for (const { id } of jobs) {
    const jobRes = jobCache.readJob(id);
    const job = jobRes.status === 'ok' ? jobRes.value : undefined;
    const created = at(job?.created_at);
    if (!job || dayOf(created) !== today) continue;
    const statusRes = jobCache.readStatus(id);
    const status = statusRes.status === 'ok' ? statusRes.value : undefined;
    const row = jobRow(job, status);
    if (!row.role) continue;
    const stats = groups.get(row.role) ?? { total: 0, ok: 0, failed: 0, quietEscalated: 0, avgMinutes: null, elapsed: 0, timed: 0, places: new Map() };
    groups.set(row.role, stats);
    const placeOf = (name: string) => {
      let entry = stats.places.get(name);
      if (!entry) {
        entry = { launches: 0, launchFailed: 0, ok: 0, failed: 0, quietEscalated: 0, quota: 0 };
        stats.places.set(name, entry);
      }
      return entry;
    };
    stats.total++;
    const quietAction = record(status?.quiet_decision).action;
    const quiet = typeof quietAction === 'string' && !!quietAction.trim();
    if (quiet) stats.quietEscalated++;
    if (row.display_state === 'done' || row.display_state === 'failed') {
      stats[row.display_state === 'done' ? 'ok' : 'failed']++;
      const start = at(status?.started_at ?? job.created_at), end = at(status?.settled_at ?? status?.ended_at);
      if (end >= start) { stats.elapsed += end - start; stats.timed++; }
    }
    const usedPlace = placeName(job.used_place);
    const hasAttempts = Array.isArray(job.attempts);
    if (hasAttempts) {
      for (const raw of (job.attempts as unknown[]).slice(0, 8)) {
        const attempt = record(raw), name = placeName(attempt.place);
        if (!name) continue;
        const entry = placeOf(name);
        entry.launches++;
        if (typeof attempt.reason === 'string' && attempt.reason.trim() && name !== usedPlace) entry.launchFailed++;
      }
    }
    const adopted = usedPlace ?? (hasAttempts ? null : fallbackPlace(job));
    if (adopted) {
      const entry = placeOf(adopted);
      if (!hasAttempts) entry.launches++;
      if (row.display_state === 'done') entry.ok++;
      else if (row.display_state === 'failed') entry.failed++;
      if (quiet) entry.quietEscalated++;
      if (job.exhaustion_marked === true) entry.quota++;
    }
  }
  return groups.size ? Object.fromEntries([...groups].map(([role, { elapsed, timed, places, ...stats }]) =>
    [role, { ...stats, avgMinutes: timed ? elapsed / timed / 60000 : null, ...(places.size ? { places: Object.fromEntries(places) } : {}) }])) : undefined;
}

let last: { home: string; pi: string; day: string; now: number; cache: Signatures; value: ControlRadar | undefined } | undefined;
export function collectControlRadar(hudHome: string, env: NodeJS.ProcessEnv, nowMs: number): ControlRadar | undefined {
  const day = dayOf(nowMs), pi = join(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), '.pi', 'agent'), 'sessions');
  const previous = last?.home === hudHome && last.pi === pi && last.day === day ? last : undefined;
  if (previous && nowMs >= previous.now && nowMs - previous.now < 5000) return previous.value;
  // Keep signatures only for this scan's candidates, including on homes with long histories.
  const cache: Cache = { previous: previous?.cache, next: new Map() };
  const quotas = quotaRadar(join(hudHome, 'display', 'state'), nowMs, cache);
  const piToday = piRadar(pi, day, cache), roleStats = roleRadar(hudHome, day);
  const value = quotas || piToday || roleStats ? { ...(quotas && { quotas }), ...(piToday && { piToday }), ...(roleStats && { roleStats }) } : undefined;
  last = { home: hudHome, pi, day, now: nowMs, cache: cache.next, value };
  return value;
}

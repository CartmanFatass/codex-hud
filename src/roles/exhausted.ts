/** Quota/rate-limit exhausted place marks under `$HUD_HOME/exhausted.json`. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { CliAgent } from './cli-kinds.js';

export const EXHAUSTED_TTL_MS = 60 * 60 * 1000;
const EXHAUSTED_FILE = 'exhausted.json';
const DAY_MS = 24 * EXHAUSTED_TTL_MS;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?=\b|\d)/gi;
const RELATIVE_RESET = new RegExp(
  String.raw`\b(?:in\s+|retry[- ]after\b\s*:?\s*)(${DURATION_PART.source}(?:\s*(?:,\s*|and\s+)?${DURATION_PART.source})*)`,
  'gi'
);
const ABSOLUTE_RESET =
  /\b(?:until|at|resets?(?:_at)?)[\s:=]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})|\d{10}(?:\d{3})?)\b/gi;
const UTC_RESET = /\b(?:until|at|resets?)[\s:=]+([01]?\d|2[0-3]):([0-5]\d)\s*UTC\b/gi;
const QUOTA_ERROR =
  /(?:\b(?:rate[_ -]?limit(?:ed|s)?|quota(?:[_ -]?(?:exceeded|exhausted|reached))?|resource_exhausted|too many requests|usage limit|limit reached|insufficient[_ ]quota|out of credits)\b|\b(?:http|status|code)?[:\s]*429\b)/i;

export interface RolePlace {
  harness: 'pi' | 'bro' | 'cli';
  pi_role?: string;
  split?: boolean;
  lens?: boolean;
  mcp?: boolean;
  tps?: boolean;
  ui_ext?: boolean;
  skills?: string[];
  pi_args?: string[];
  agent?: CliAgent;
  args?: string[];
  tool?: 'jev-ask' | 'jev-aistudio' | 'jev-flow';
  provider?: 'chatgpt' | 'gemini';
  effort?: string;
  kind?: 'image' | 'video';
  model?: string;
  thinking?: string;
}

export interface ExhaustedMark {
  until: string;
  reason: string;
  marked_at: string;
}

export function isQuotaFailure(text: string): boolean {
  // A directory name in a trust refusal may itself contain quota-related words.
  return !/^(?:grok|agy|claude) has not trusted /.test(text) && QUOTA_ERROR.test(text);
}

/** Cooldown duration, not an absolute timestamp. An expired hint is not a cooldown. */
export function parseQuotaResetMs(text: string, nowMs = Date.now()): number | null {
  const clamp = (ms: number) => Math.min(DAY_MS, Math.max(60_000, ms));
  for (const [, duration] of text.matchAll(RELATIVE_RESET)) {
    let ms = 0;
    for (const [, value, unit] of duration.matchAll(DURATION_PART)) {
      const kind = unit[0].toLowerCase();
      ms += Number(value) * (kind === 'h' ? EXHAUSTED_TTL_MS : kind === 'm' ? 60_000 : 1_000);
    }
    if (ms > 0) return clamp(ms);
  }
  for (const [, seconds] of text.matchAll(/\bretry[- ]after\s*:\s*(\d+)(?=[ \t]*(?:$|[\r\n,;)\]]|\.(?!\d)))/gi)) {
    if (Number(seconds) > 0) return clamp(Number(seconds) * 1000);
  }
  for (const [, stamp] of text.matchAll(ABSOLUTE_RESET)) {
    const reset = /^\d+$/.test(stamp) ? Number(stamp) * (stamp.length === 10 ? 1000 : 1) : Date.parse(stamp);
    if (reset > nowMs) return clamp(reset - nowMs);
  }
  for (const [, hour, minute] of text.matchAll(UTC_RESET)) {
    // A date-less clock time means the next occurrence in UTC.
    const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const ms = midnight + (Number(hour) * 60 + Number(minute)) * 60_000 - nowMs;
    return clamp(ms > 0 ? ms : ms + DAY_MS);
  }
  return null;
}

export function placeKey(
  place: Pick<RolePlace, 'harness' | 'agent' | 'tool' | 'provider' | 'model'>,
  resolvedModel?: string | null
): string {
  const model = place.model ?? resolvedModel ?? '';
  if (place.harness === 'pi') return `pi:${model}`;
  if (place.harness === 'cli') return `cli:${place.agent ?? ''}:${model}`;
  return `bro:${place.tool ?? ''}:${place.provider ?? ''}:${model}`;
}

export function describePlace(
  place: Pick<RolePlace, 'harness' | 'agent' | 'tool' | 'provider' | 'model'>,
  resolvedModel?: string | null
): string {
  const model = place.model ?? resolvedModel ?? null;
  const base =
    place.harness === 'pi'
      ? 'pi'
      : place.harness === 'cli'
        ? `cli/${place.agent ?? 'unknown'}`
        : `bro/${place.provider ?? place.tool ?? 'browser'}`;
  return model ? `${base} (${model})` : base;
}

function readMap(file: string, nowMs: number): Map<string, ExhaustedMark> {
  const marks = new Map<string, ExhaustedMark>();
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 65536) return marks;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; places?: unknown };
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.places || typeof parsed.places !== 'object') {
      return marks;
    }
    for (const [key, value] of Object.entries(parsed.places as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Partial<ExhaustedMark>;
      if (typeof entry.until !== 'string' || typeof entry.reason !== 'string') continue;
      const untilMs = Date.parse(entry.until);
      if (!Number.isFinite(untilMs) || untilMs <= nowMs) continue;
      marks.set(key, {
        until: entry.until,
        reason: entry.reason,
        marked_at: typeof entry.marked_at === 'string' ? entry.marked_at : entry.until,
      });
    }
  } catch {
    /* Missing or invalid exhausted state treats all places as available. */
  }
  return marks;
}

function assertExhaustedFile(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw new Error('exhausted.json is a symlink');
    if (!st.isFile()) throw new Error('exhausted.json is not a file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function writeExhausted(file: string, marks: Map<string, ExhaustedMark>): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify({ version: 1, places: Object.fromEntries(marks) }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    assertExhaustedFile(file);
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* Renamed or failed before creation. */
    }
  }
}

export function readExhausted(hudHome: string, nowMs = Date.now()): Map<string, ExhaustedMark> {
  return readMap(join(hudHome, EXHAUSTED_FILE), nowMs);
}

// Keep the read-modify-write synchronous so tool calls in one process cannot interleave it.
function updateExhausted(hudHome: string, nowMs: number, update: (marks: Map<string, ExhaustedMark>) => boolean): boolean {
  const file = join(hudHome, EXHAUSTED_FILE);
  assertExhaustedFile(file);
  const marks = readMap(file, nowMs);
  if (!update(marks)) return false;
  writeExhausted(file, marks);
  return true;
}

export function markExhausted(hudHome: string, key: string, reason: string, nowMs = Date.now()): ExhaustedMark {
  fs.mkdirSync(hudHome, { recursive: true, mode: 0o700 });
  const ttl = parseQuotaResetMs(reason, nowMs) ?? EXHAUSTED_TTL_MS;
  const entry: ExhaustedMark = {
    until: new Date(nowMs + ttl).toISOString(),
    reason: reason.replace(/[\r\n]+/g, ' ').slice(0, 300),
    marked_at: new Date(nowMs).toISOString(),
  };
  updateExhausted(hudHome, nowMs, (marks) => {
    marks.set(key, entry);
    return true;
  });
  return entry;
}

export function clearExhausted(hudHome: string, key: string, nowMs = Date.now()): boolean {
  return updateExhausted(hudHome, nowMs, (marks) => marks.delete(key));
}

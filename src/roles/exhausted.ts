/** Quota/rate-limit exhausted place marks under `$HUD_HOME/exhausted.json`. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { CliAgent } from './cli-kinds.js';

export const EXHAUSTED_TTL_MS = 60 * 60 * 1000;
const EXHAUSTED_FILE = 'exhausted.json';
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
  return QUOTA_ERROR.test(text);
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

export function readExhausted(hudHome: string, nowMs = Date.now()): Map<string, ExhaustedMark> {
  return readMap(join(hudHome, EXHAUSTED_FILE), nowMs);
}

export function markExhausted(hudHome: string, key: string, reason: string, nowMs = Date.now()): ExhaustedMark {
  fs.mkdirSync(hudHome, { recursive: true, mode: 0o700 });
  const file = join(hudHome, EXHAUSTED_FILE);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('exhausted.json is a symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const marks = readMap(file, nowMs);
  const entry: ExhaustedMark = {
    until: new Date(nowMs + EXHAUSTED_TTL_MS).toISOString(),
    reason: reason.replace(/[\r\n]+/g, ' ').slice(0, 300),
    marked_at: new Date(nowMs).toISOString(),
  };
  marks.set(key, entry);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify({ version: 1, places: Object.fromEntries(marks) }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* Renamed or failed before creation. */
    }
  }
  return entry;
}

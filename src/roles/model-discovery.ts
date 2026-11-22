/**
 * On-demand model-list discovery for pi, agy and grok, cached under `$HUD_HOME/display`.
 * Runs only when the Control plane opens or on its refresh key; never on the refresh tick.
 */
import { spawn } from 'node:child_process';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODEL_DISCOVERY_TIMEOUT_MS = 5000;
export const MODEL_DISCOVERY_MAX_BYTES = 256 * 1024;

export const MODEL_ID_MAX = 128;

type ModelSource = 'pi' | 'agy' | 'grok';
interface SourceStatus {
  fetchedAt?: number;
  failed: boolean;
}
export type PiModelFacts = [context: string, maxOut: string, thinking: boolean, images: boolean];
interface PiListing {
  ids: string[];
  facts?: Record<string, PiModelFacts>;
}
export interface ModelListCache {
  version: 1;
  fetchedAt: number;
  pi?: string[];
  /** Optional so the original v1 cache still works. Keyed by the full provider/model ID. */
  piFacts?: PiListing['facts'];
  cli?: Partial<Record<'agy' | 'grok', string[]>>;
  /** Separate success times let a failed source retain its list without borrowing another source's freshness. */
  status?: Partial<Record<ModelSource, SourceStatus>>;
}

function sourceList(cache: ModelListCache | null, source: ModelSource) {
  return source === 'pi' ? cache?.pi : cache?.cli?.[source];
}
export function modelSourceStatus(cache: ModelListCache | null, source: ModelSource): SourceStatus {
  return cache?.status?.[source] ?? { fetchedAt: sourceList(cache, source) === undefined ? undefined : cache?.fetchedAt, failed: false };
}

export interface DiscoverOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function modelListCachePath(hudHome: string): string {
  return join(hudHome, 'display', 'model-lists.json');
}

export function isModelToken(value: string): boolean {
  return (
    value.length <= MODEL_ID_MAX && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith(':') &&
    !value.endsWith('.')
  );
}

function uniqueTokens(items: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!isModelToken(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

const isTokenCount = (value: unknown): value is string => typeof value === 'string' && /^\d+(?:\.\d+)?[KM]?$/i.test(value);
const isYesNo = (value: string | undefined): value is string => /^(yes|no)$/i.test(value ?? '');

/** `pi --list-models`: IDs and optional facts from the same table. A model ID may itself contain slashes. */
export function parsePiModels(stdout: string): PiListing | null {
  const lines = stdout.replace(ANSI_CSI, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (/^No models available\.(?:$| Use \/login\b)/.test(lines[0] ?? '')) return { ids: [] };
  const header = lines.findIndex((line) => /^provider\s+model(?:\s+context\s+max-out\s+thinking\s+images)?$/i.test(line));
  if (header < 0) return null;
  const columns = lines[header]!.split(/\s+/).length;
  const ids = new Set<string>(), facts: Record<string, PiModelFacts> = {};
  for (const line of lines.slice(header + 1)) {
    if (/^[-=─]+$/.test(line)) continue;
    const parts = line.split(/\s+/), [provider, model, ctx, out, think, img] = parts;
    if (parts.length !== columns || !provider || !model || !isModelToken(provider) || provider.includes('/') || !isModelToken(model)) return null;
    const id = `${provider}/${model}`;
    if (!isModelToken(id)) return null;
    if (columns === 6) {
      if (!isTokenCount(ctx) || !isTokenCount(out) || !isYesNo(think) || !isYesNo(img)) return null;
      if (!ids.has(id)) facts[id] = [ctx, out, think.toLowerCase() === 'yes', img.toLowerCase() === 'yes'];
    }
    ids.add(id);
  }
  return { ids: [...ids], ...(columns === 6 && ids.size ? { facts } : {}) };
}

/** `agy models`: `<id>\t<Display Name>` (after optional status prose). */
export function parseAgyModels(stdout: string): string[] {
  const models: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(ANSI_CSI, '').trim();
    if (!line) continue;
    const cols = line.split(/\t|\s{2,}/);
    const id = cols[0]?.trim() ?? '';
    if (cols.length >= 2 && isModelToken(id)) models.push(id);
    else if (cols.length === 1 && !/\s/.test(id) && isModelToken(id)) models.push(id);
  }
  return uniqueTokens(models);
}

/** `grok models`: `Available models:` bullet lines `* id (default)` / `- id` (never account/login lines). */
export function parseGrokModels(stdout: string): string[] {
  const models: string[] = [];
  let inAvailable = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(ANSI_CSI, '').trim();
    if (!line) continue;
    if (/^available models:/i.test(line)) {
      inAvailable = true;
      continue;
    }
    const bullet = /^[*-•]\s+(\S+)(?:\s+\([^)]*\))?$/.exec(line);
    if (bullet && isModelToken(bullet[1]!)) {
      models.push(bullet[1]!);
      continue;
    }
    if (inAvailable) {
      const bare = /^(\S+)(?:\s+\([^)]*\))?$/.exec(line);
      if (bare && isModelToken(bare[1]!)) models.push(bare[1]!);
    }
  }
  return uniqueTokens(models);
}

function defaultReadJson(file: string): unknown {
  return readJsonBounded(file, 1024 * 1024);
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = uniqueTokens(value.filter((item): item is string => typeof item === 'string'));
  return value.length && !cleaned.length ? undefined : cleaned;
}

function cleanPiFacts(value: unknown, ids: string[] | undefined): ModelListCache['piFacts'] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ids?.length) return;
  const obj = value as Record<string, unknown>;
  const facts = ids.flatMap((id) => {
    const row = obj[id];
    return Array.isArray(row) && row.length === 4 && isTokenCount(row[0]) && isTokenCount(row[1]) &&
      typeof row[2] === 'boolean' && typeof row[3] === 'boolean' ? [[id, row as PiModelFacts] as const] : [];
  });
  return facts.length ? Object.fromEntries(facts) : undefined;
}

export function readModelListCache(
  hudHome: string,
  now = Date.now(),
  readJson: (file: string) => unknown = defaultReadJson,
  includeStale = false
): ModelListCache | null {
  try {
    const raw = readJson(modelListCachePath(hudHome));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1 || typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) return null;
    const pi = cleanList(obj.pi), piFacts = cleanPiFacts(obj.piFacts, pi);
    const status: NonNullable<ModelListCache['status']> = {};
    const rawStatus = obj.status as Record<string, Partial<SourceStatus>> | undefined;
    for (const source of ['pi', 'agy', 'grok'] as const) {
      const entry = rawStatus?.[source];
      if (typeof entry?.failed !== 'boolean') continue;
      status[source] = { failed: entry.failed, ...(Number.isFinite(entry.fetchedAt) ? { fetchedAt: entry.fetchedAt } : {}) };
    }
    const cliObj = obj.cli && typeof obj.cli === 'object' && !Array.isArray(obj.cli) ? (obj.cli as Record<string, unknown>) : {};
    const agy = cleanList(cliObj.agy);
    const grok = cleanList(cliObj.grok);
    const cli: Partial<Record<'agy' | 'grok', string[]>> = {
      ...(agy ? { agy } : {}),
      ...(grok ? { grok } : {}),
    };
    const cache: ModelListCache = {
      version: 1,
      fetchedAt: obj.fetchedAt,
      ...(pi ? { pi } : {}),
      ...(piFacts ? { piFacts } : {}),
      ...(Object.keys(cli).length ? { cli } : {}),
      ...(Object.keys(status).length ? { status } : {}),
    };
    const piStatus = modelSourceStatus(cache, 'pi');
    return !includeStale && (pi === undefined || piStatus.failed || piStatus.fetchedAt === undefined ||
      now - piStatus.fetchedAt >= MODEL_CACHE_TTL_MS) ? null : cache;
  } catch {
    return null;
  }
}

function assertRegularOrMissing(path: string, wantDir: boolean): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing symlink: ${path}`);
  if (wantDir ? !st.isDirectory() : !st.isFile()) throw new Error(`refusing non-${wantDir ? 'directory' : 'file'}: ${path}`);
}

export function writeModelListCache(hudHome: string, cache: ModelListCache): void {
  const file = modelListCachePath(hudHome);
  const dir = dirname(file);
  assertRegularOrMissing(dir, true);
  assertRegularOrMissing(file, false);
  writeJsonPrivate(file, cache, { beforeRename: () => assertRegularOrMissing(file, false) });
}

function runBoundedCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let failed = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const kill = () => {
      failed = true;
      try {
        child.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(null);
    };
    const abort = () => kill();
    const timer = setTimeout(kill, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => done(null));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failed || settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code, sig) => {
      if (failed || code !== 0 || sig) done(null);
      else done(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function discoverModelLists(
  hudHome: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  options: DiscoverOptions = {}
): Promise<ModelListCache | null> {
  const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MODEL_DISCOVERY_MAX_BYTES;
  const { signal } = options;
  const [piRaw, agyRaw, grokRaw] = await Promise.all([
    runBoundedCommand('pi', ['--list-models'], env, timeoutMs, maxBytes, signal),
    runBoundedCommand('agy', ['models'], env, timeoutMs, maxBytes, signal),
    runBoundedCommand('grok', ['models'], env, timeoutMs, maxBytes, signal),
  ]);
  if (signal?.aborted) return null;
  const previous = readModelListCache(hudHome, now, undefined, true);
  const cache: ModelListCache = { version: 1, fetchedAt: now, status: {}, cli: {} };
  const keep = (source: ModelSource, result: string[] | null) => {
    if (result !== null) {
      cache.status![source] = { fetchedAt: now, failed: false };
      return result;
    }
    cache.status![source] = { ...modelSourceStatus(previous, source), failed: true };
    return sourceList(previous, source);
  };
  const pi = piRaw === null ? null : parsePiModels(piRaw);
  cache.pi = keep('pi', pi?.ids ?? null);
  const piFacts = pi === null ? previous?.piFacts : pi.facts;
  if (piFacts) cache.piFacts = piFacts;
  // The CLI parsers only recognize nonempty listings; an unrecognized reply is not authoritative.
  const agy = agyRaw === null ? [] : parseAgyModels(agyRaw);
  const grok = grokRaw === null ? [] : parseGrokModels(grokRaw);
  cache.cli!.agy = keep('agy', agy.length ? agy : null);
  cache.cli!.grok = keep('grok', grok.length ? grok : null);
  try {
    writeModelListCache(hudHome, cache);
  } catch {
    /* Non-writable HUD_HOME falls back to catalog. */
  }
  return cache;
}

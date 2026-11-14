/**
 * On-demand model-list discovery for pi, agy and grok, cached under `$HUD_HOME/display`.
 * Runs only when the Control plane opens or on its refresh key; never on the refresh tick.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODEL_DISCOVERY_TIMEOUT_MS = 5000;
export const MODEL_DISCOVERY_MAX_BYTES = 256 * 1024;

export interface ModelListCache {
  version: 1;
  fetchedAt: number;
  pi?: string[];
  cli?: Partial<Record<'agy' | 'grok', string[]>>;
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
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) &&
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

/** `pi --list-models`: `provider  model  context  max-out  thinking  images` table -> `provider/model`. */
export function parsePiModels(stdout: string): string[] {
  const models: string[] = [];
  let sawHeader = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(ANSI_CSI, '').trim();
    if (!line || /^[-=─]+$/.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[0]!.toLowerCase() === 'provider' && parts[1]!.toLowerCase() === 'model') {
      sawHeader = true;
      continue;
    }
    if (sawHeader && parts.length >= 2 && isModelToken(parts[0]!) && isModelToken(parts[1]!)) {
      models.push(parts[1]!.startsWith(`${parts[0]!}/`) ? parts[1]! : `${parts[0]!}/${parts[1]!}`);
    } else if (!sawHeader && parts.length >= 4 && isModelToken(parts[0]!) && isModelToken(parts[1]!) && /^\d+(?:\.\d+)?[KMG]?$/i.test(parts[2]!)) {
      models.push(parts[1]!.startsWith(`${parts[0]!}/`) ? parts[1]! : `${parts[0]!}/${parts[1]!}`);
    } else if (!sawHeader && parts.length === 1 && parts[0]!.includes('/') && isModelToken(parts[0]!)) {
      models.push(parts[0]!);
    }
  }
  return uniqueTokens(models);
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
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile() || st.size > 1024 * 1024) throw new Error('unusable cache file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = uniqueTokens(value.filter((item): item is string => typeof item === 'string'));
  return cleaned.length ? cleaned : undefined;
}

export function readModelListCache(
  hudHome: string,
  now = Date.now(),
  readJson: (file: string) => unknown = defaultReadJson
): ModelListCache | null {
  try {
    const raw = readJson(modelListCachePath(hudHome));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1 || typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) return null;
    if (now - obj.fetchedAt >= MODEL_CACHE_TTL_MS) return null;
    const pi = cleanList(obj.pi);
    const cliObj = obj.cli && typeof obj.cli === 'object' && !Array.isArray(obj.cli) ? (obj.cli as Record<string, unknown>) : {};
    const agy = cleanList(cliObj.agy);
    const grok = cleanList(cliObj.grok);
    const cli: Partial<Record<'agy' | 'grok', string[]>> = {
      ...(agy ? { agy } : {}),
      ...(grok ? { grok } : {}),
    };
    return {
      version: 1,
      fetchedAt: obj.fetchedAt,
      ...(pi ? { pi } : {}),
      ...(Object.keys(cli).length ? { cli } : {}),
    };
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(cache, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assertRegularOrMissing(file, false);
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
  const pi = piRaw !== null ? parsePiModels(piRaw) : [];
  const agy = agyRaw !== null ? parseAgyModels(agyRaw) : [];
  const grok = grokRaw !== null ? parseGrokModels(grokRaw) : [];
  const cli: Partial<Record<'agy' | 'grok', string[]>> = {
    ...(agy.length ? { agy } : {}),
    ...(grok.length ? { grok } : {}),
  };
  const cache: ModelListCache = {
    version: 1,
    fetchedAt: now,
    ...(pi.length ? { pi } : {}),
    ...(Object.keys(cli).length ? { cli } : {}),
  };
  try {
    writeModelListCache(hudHome, cache);
  } catch {
    /* Non-writable HUD_HOME falls back to catalog. */
  }
  return cache;
}

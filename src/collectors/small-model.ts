/**
 * The one way the HUD asks a small, cheap model for text.
 *
 * Every feature that writes with a model (the agents brief, the main-session
 * recap, and what comes after them) sends its request through here, so they
 * share one backend, one queue and one budget:
 *
 * - one request is `{feature, system, prompt, thinking?, cacheKey?}` and its
 *   answer is text or a reason there is none;
 * - the backend is the `briefing` setting: `agy` or an
 *   OpenAI-compatible chat completions endpoint (`api`);
 * - one request is in flight at a time; the rest wait their turn, and the
 *   owner of a request can cancel it, waiting or running;
 * - a request that passes a `cacheKey` is answered from a cache of earlier
 *   answers to the same input (in memory and, when a directory is given, on
 *   disk), so the same input is never sent twice;
 * - an hourly cap on calls. A request past it is refused with a reason the
 *   owner shows, never silently dropped. Calls are logged (timestamps only)
 *   so the cap and "calls today" hold across panel restarts.
 *
 * Nothing here decides what is sent: each feature builds its own material
 * and has its own switch.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { t } from '../render/i18n.js';

export type ModelBackend = 'off' | 'agy' | 'api';
/** Thinking levels; agy and `api` take the subset they know. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/** Where `api` requests go. Empty fields fall back as `modelHttpRequest` says. */
export interface ModelApi {
  base: string;
  /** Nonempty is a global override, retained for existing configurations. */
  model: string;
  models?: Partial<Record<ApiModelTier, string>>;
  key: string;
  /**
   * The endpoint accepts `reasoning_effort`. Off by default: only fields
   * every compatible server accepts are sent unless the person says so.
   */
  reasoning?: boolean;
}

export interface ModelRequest {
  /** Who is asking; selects an API model route, but is never sent. */
  feature: string;
  system: string;
  prompt: string;
  /** Defaults to `low`, what every feature used before levels were a choice. */
  thinking?: ThinkingLevel;
  /**
   * Answer from the cache when the same input was answered before. The key
   * names what the input is about (an agent id, a rollout path); the cache is
   * keyed by a hash of it together with the whole request.
   */
  cacheKey?: string;
}

export type ModelResult =
  | { ok: true; text: string; cached?: boolean }
  | { ok: false; error: string; refused?: boolean; cancelled?: boolean; reason?: 'hourly-cap' };

export type ModelStatus = 'queued' | 'running' | 'settled';

export interface ModelHandle {
  /** Public lifecycle only: never exposes a prompt, endpoint or credential. */
  readonly status: ModelStatus;
  readonly generatedAt?: number;
  subscribe(listener: () => void): () => void;
  result: Promise<ModelResult>;
  /** Drop the request: a waiting one never runs, a running one is stopped. */
  cancel(): void;
}

export interface ModelUsage {
  /** Calls actually sent since local midnight, by any panel on this CODEX_HOME. */
  today: number;
  /** Calls in the last hour, which is what the cap counts. */
  lastHour: number;
  cap: number;
}

export const DEFAULT_THINKING: ThinkingLevel = 'low';
/** agy's model names carry their effort level; this one is `low`. */
export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-low';
const AGY_MODEL_FAMILY = 'gemini-3.8-flash';
/** Levels agy's model list has a `<family>-<level>` name for. */
const AGY_MODEL_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high'];
/** Levels agy's `--effort` flag accepts. */
const AGY_EFFORTS: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `reasoning_effort` values OpenAI-compatible servers know, by our level. */
const API_EFFORTS: Partial<Record<ThinkingLevel, string>> = {
  off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
};

const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_HOURLY_CAP = 60;
/** Cached answers kept; the oldest go first. */
const CACHE_LIMIT = 200;
/** Call timestamps kept: a day's worth, bounded however busy the day was. */
const CALL_LOG_LIMIT = 5000;
const OPENAI_BASE = 'https://api.openai.com/v1';
export type ApiModelTier = 'lite' | 'low' | 'medium';
export const DEFAULT_API_MODELS: Readonly<Record<ApiModelTier, string>> = {
  lite: 'gemini-3.5-flash-lite', low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium',
};

export function apiModelTier(feature: string): ApiModelTier {
  if (['labels', 'title', 'approval'].includes(feature)) return 'lite';
  if (['recap', 'cause'].includes(feature)) return 'medium';
  return 'low';
}

/** The program and arguments for one request. No shell is involved. */
export function modelCommand(backend: 'agy', request: Pick<ModelRequest, 'system' | 'prompt' | 'thinking'>,
  env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  const override = env.CODEX_HUD_BRIEF_MODEL?.trim();
  const thinking = request.thinking ?? DEFAULT_THINKING;
  // agy has no system prompt flag; the instructions lead the prompt instead.
  // Its default model's name carries the level, so a level it has a name
  // for picks that model; anything else goes to --effort. At `low` this is
  // exactly the command the brief has always run.
  let model = override || DEFAULT_AGY_MODEL;
  let effort: string | undefined;
  if (!override && AGY_MODEL_LEVELS.includes(thinking)) model = `${AGY_MODEL_FAMILY}-${thinking}`;
  else if (AGY_EFFORTS.includes(thinking) && (override || thinking !== DEFAULT_THINKING)) effort = thinking;
  return { file: 'agy', args: ['-p', `${request.system}\n\n${request.prompt}`, '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--output-format', 'text', '--print-timeout', '80s', '--disable-slash-commands'] };
}

/**
 * One chat completions request. The base may be given up to `/v1` or as the
 * full `/chat/completions` URL. The key falls back to CODEX_HUD_BRIEF_API_KEY,
 * then OPENAI_API_KEY only for the official OpenAI origin; custom endpoints
 * never receive the general OpenAI key. With none it goes without, for a local server. CODEX_HUD_BRIEF_MODEL overrides the model. Only the fields every
 * compatible server accepts are sent, plus `reasoning_effort` when the
 * endpoint is marked as taking it.
 */
export function modelHttpRequest(api: ModelApi, request: Pick<ModelRequest, 'feature' | 'system' | 'prompt' | 'thinking'>,
  env: NodeJS.ProcessEnv = process.env): { url: string; headers: Record<string, string>; body: string } | { error: string } {
  const base = (api.base.trim() || OPENAI_BASE).replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  let official = false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return { error: 'api: invalid endpoint' };
    official = parsed.origin === 'https://api.openai.com';
  } catch { return { error: 'api: invalid endpoint' }; }
  const tier = apiModelTier(request.feature);
  const model = env.CODEX_HUD_BRIEF_MODEL?.trim() || api.model.trim()
    || api.models?.[tier]?.trim() || DEFAULT_API_MODELS[tier];
  // An endpoint-specific HUD key is deliberate. Never leak OPENAI_API_KEY to a custom origin.
  const key = api.key.trim() || env.CODEX_HUD_BRIEF_API_KEY?.trim() || (official ? env.OPENAI_API_KEY?.trim() : '') || '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const effort = api.reasoning ? API_EFFORTS[request.thinking ?? DEFAULT_THINKING] : undefined;
  const body = JSON.stringify({ model, stream: false, ...(effort ? { reasoning_effort: effort } : {}), messages: [
    { role: 'system', content: request.system },
    { role: 'user', content: request.prompt },
  ] });
  return { url, headers, body };
}

/** The reply text of a chat completion; some servers send content as parts. */
export function completionText(json: unknown): string | null {
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('');
    return text || null;
  }
  return null;
}

/** Colour codes and runs of blank lines out; the text itself as written. */
export function cleanOutput(raw: string): string {
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.trimEnd())
    .filter((line, i, all) => line || (i > 0 && all[i - 1])).join('\n').trim();
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The cache key of a request: everything that shapes the answer, so a
 * changed prompt, instruction or level is a different question.
 */
export function requestDigest(request: ModelRequest, route?: { backend: ModelBackend; endpoint?: string; model?: string; reasoning?: boolean }): string {
  return createHash('sha256').update(JSON.stringify([request.feature, request.cacheKey ?? '', request.thinking ?? DEFAULT_THINKING,
    request.system, request.prompt, route ?? null])).digest('hex');
}

/** Calls within `windowMs` before `now`. */
export function callsWithin(calls: readonly number[], now: number, windowMs: number): number {
  let count = 0;
  for (const at of calls) if (at > now - windowMs && at <= now) count++;
  return count;
}

/** Calls since local midnight of `now`'s day. */
export function callsToday(calls: readonly number[], now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  let count = 0;
  for (const at of calls) if (at >= midnight.getTime() && at <= now) count++;
  return count;
}

/** Write a file whole or not at all, readable by its owner only. */
export function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Renamed, or the write itself failed. */ }
  }
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

interface Job {
  request: ModelRequest;
  backend: ModelBackend;
  command?: ReturnType<typeof modelCommand>;
  http?: ReturnType<typeof modelHttpRequest>;
  digest: string | null;
  resolve: (result: ModelResult) => void;
  settled: boolean;
  status: ModelStatus;
  generatedAt?: number;
  listeners: Set<() => void>;
  /** Stops a running job; set while it runs. */
  stop?: () => void;
}

export interface SmallModelOptions {
  /** Where the cache and call log live; null keeps both in memory only. */
  dir?: string | null;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  clock?: () => number;
}

export class SmallModel {
  private backend: ModelBackend = 'off';
  private api: ModelApi = { base: '', model: '', key: '' };
  private cap = DEFAULT_HOURLY_CAP;
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private cache = new Map<string, { text: string; at: number }>();
  private calls: number[] = [];
  private loaded = false;
  private readonly dir: string | null;
  private readonly clock: () => number;

  constructor(private readonly options: SmallModelOptions = {}) {
    this.dir = options.dir ?? null;
    this.clock = options.clock ?? Date.now;
  }

  configure(patch: { backend?: ModelBackend; api?: ModelApi; hourlyCap?: number }): void {
    const backend = patch.backend ?? this.backend;
    const api = patch.api ? { ...patch.api, models: patch.api.models ? { ...patch.api.models } : undefined } : this.api;
    if (backend !== this.backend || JSON.stringify(api) !== JSON.stringify(this.api)) this.cancelAll();
    this.backend = backend;
    this.api = api;
    if (patch.hourlyCap !== undefined && Number.isFinite(patch.hourlyCap) && patch.hourlyCap > 0) this.cap = Math.floor(patch.hourlyCap);
  }

  usage(now: number = this.clock()): ModelUsage {
    this.load();
    this.reloadCalls();
    return { today: callsToday(this.calls, now), lastHour: callsWithin(this.calls, now, HOUR_MS), cap: this.cap };
  }

  /** Queue a request. It starts at once when nothing else is in flight. */
  submit(request: ModelRequest): ModelHandle {
    // Resolve everything now, including environment overrides and credentials: queued work
    // must not silently change destinations when its settings or environment change.
    request = { ...request };
    const backend = this.backend;
    const env = { ...(this.options.env ?? process.env) };
    const http = backend === 'api' ? modelHttpRequest(this.api, request, env) : undefined;
    const command = backend === 'agy' ? modelCommand('agy', request, env) : undefined;
    const route = { backend, endpoint: http && !('error' in http) ? http.url : '',
      model: http && !('error' in http) ? JSON.parse(http.body).model as string : command?.args[command.args.indexOf('--model') + 1],
      reasoning: backend === 'api' && !!this.api.reasoning };
    const digest = request.cacheKey !== undefined ? requestDigest(request, route) : null;
    let job!: Job;
    const result = new Promise<ModelResult>(resolve => {
      job = { request, backend, http, command, digest, settled: false, status: 'queued', listeners: new Set(), resolve: value => {
        if (!job.settled) { job.settled = true; this.setStatus(job, 'settled'); resolve(value); }
      } };
    });
    this.load();
    const hit = digest ? this.cache.get(digest) : undefined;
    if (backend === 'off') {
      job.resolve({ ok: false, error: 'model backend off', refused: true });
    } else if (hit) {
      job.generatedAt = hit.at;
      job.resolve({ ok: true, text: hit.text, cached: true });
    } else {
      this.queue.push(job);
      this.pump();
    }
    return {
      result,
      get status() { return job.status; },
      get generatedAt() { return job.generatedAt; },
      subscribe: listener => { job.listeners.add(listener); return () => { job.listeners.delete(listener); }; },
      cancel: () => {
        if (job.settled) return;
        const at = this.queue.indexOf(job);
        if (at >= 0) this.queue.splice(at, 1);
        job.stop?.();
        job.resolve({ ok: false, error: 'cancelled', cancelled: true });
        // Abort is asynchronous. Keep the active slot until run() settles,
        // otherwise a replacement can overlap a fetch/subprocess still stopping.
      },
    };
  }

  /** Cancel everything, waiting and running: the panel is closing. */
  cancelAll(): void {
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) {
      job.stop?.();
      job.resolve({ ok: false, error: 'cancelled', cancelled: true });
    }
    this.queue.length = 0;
    // The active job releases its slot in pump() only after it has stopped.
  }

  private setStatus(job: Job, status: ModelStatus): void {
    if (job.status === status) return;
    job.status = status;
    for (const listener of job.listeners) {
      try { listener(); } catch { /* Observers must not strand a queue slot or its result. */ }
    }
  }

  private pump(): void {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift()!;
    this.active = job;
    this.setStatus(job, 'running');
    void this.run(job).then(outcome => {
      if (outcome.ok) job.generatedAt = this.clock();
      if (outcome.ok && job.request.cacheKey !== undefined && !job.settled) this.remember(job.digest!, outcome.text, job.generatedAt!);
      job.resolve(outcome);
      if (this.active === job) { this.active = null; this.pump(); }
    });
  }

  private async run(job: Job): Promise<ModelResult> {
    const backend = job.backend;
    if (backend === 'off') return { ok: false, error: 'model backend off', refused: true };
    const http = job.http;
    if (http && 'error' in http) return { ok: false, error: http.error };
    const now = this.clock();
    this.reloadCalls();
    if (callsWithin(this.calls, now, HOUR_MS) >= this.cap) {
      return { ok: false, error: t('Model call cap reached ({n} per hour)', { n: this.cap }), refused: true, reason: 'hourly-cap' };
    }
    this.recordCall(now);
    if (backend === 'api') return this.request(job, http as Exclude<typeof http, { error: string } | null | undefined>);
    return this.spawn(job, job.command!);
  }

  private spawn(job: Job, { file, args }: { file: string; args: string[] }): Promise<ModelResult> {
    return new Promise(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(file, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, error: `${file}: ${String(error)}` });
        return;
      }
      job.stop = () => child.kill();
      let out = '';
      let err = '';
      child.stdout?.on('data', (chunk: Buffer) => { if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { if (err.length < MAX_OUTPUT_BYTES) err += chunk.toString('utf8'); });
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      let settled = false;
      const done = (message: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = cleanOutput(out);
        resolve(message === null && text ? { ok: true, text } : { ok: false, error: message ?? `${file} returned nothing` });
      };
      child.on('error', error => done((error as NodeJS.ErrnoException).code === 'ENOENT' ? `${file} not found` : `${file}: ${error.message}`));
      child.on('close', (code, signal) => done(code === 0 ? null
        : signal ? `${file} stopped (${signal})` : `${file} exit ${code}: ${cleanOutput(err).split('\n').at(-1) ?? ''}`.trim()));
    });
  }

  private async request(job: Job, { url, headers, body }: { url: string; headers: Record<string, string>; body: string }): Promise<ModelResult> {
    const abort = new AbortController();
    job.stop = () => abort.abort();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    const secret = headers.authorization?.replace(/^Bearer /, '') ?? '';
    const redact = (message: string) => secret ? message.split(secret).join('[redacted]') : message;
    try {
      // Do not forward credentials or session material through endpoint redirects.
      const response = await (this.options.fetch ?? fetch)(url, { method: 'POST', headers, body, signal: abort.signal, redirect: 'error' });
      const raw = (await response.text()).slice(0, MAX_OUTPUT_BYTES);
      let json: unknown = null;
      try { json = JSON.parse(raw); } catch { /* reported below */ }
      if (!response.ok) {
        const detail = (json as { error?: { message?: unknown } } | null)?.error?.message;
        return { ok: false, error: `api HTTP ${response.status}${typeof detail === 'string' ? `: ${clip(redact(detail), 120)}` : ''}` };
      }
      const text = cleanOutput(completionText(json) ?? '');
      return text ? { ok: true, text } : { ok: false, error: json === null ? 'api: reply is not JSON' : 'api returned nothing' };
    } catch (error) {
      return { ok: false, error: abort.signal.aborted ? 'api stopped' : `api: ${clip(redact(String((error as Error)?.message ?? error)), 120)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private cacheFile(): string | null { return this.dir && path.join(this.dir, 'cache.json'); }
  private callsFile(): string | null { return this.dir && path.join(this.dir, 'calls.json'); }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.cacheFile();
    const raw = file ? readJson(file) : null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as { text?: unknown; at?: unknown } | null;
        if (/^[0-9a-f]{64}$/.test(key) && typeof entry?.text === 'string' && typeof entry.at === 'number') this.cache.set(key, { text: entry.text, at: entry.at });
      }
      this.trimCache();
    }
  }

  /** Other panels on the same CODEX_HOME spend from the same budget. */
  private reloadCalls(): void {
    const file = this.callsFile();
    if (!file) return;
    const raw = readJson(file);
    // The file is the log once it exists: this panel writes every call to it.
    if (Array.isArray(raw)) this.calls = raw.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)).sort((a, b) => a - b);
  }

  private recordCall(now: number): void {
    this.reloadCalls();
    this.calls = [...this.calls, now].filter(at => at > now - DAY_MS).slice(-CALL_LOG_LIMIT);
    const file = this.callsFile();
    if (!file) return;
    // The log is a convenience; a write that fails costs only the count.
    try { writePrivateFile(file, `${JSON.stringify(this.calls)}\n`); } catch { /* kept in memory */ }
  }

  private remember(digest: string, text: string, generatedAt: number): void {
    this.cache.delete(digest);
    this.cache.set(digest, { text, at: generatedAt });
    this.trimCache();
    const file = this.cacheFile();
    if (!file) return;
    try { writePrivateFile(file, `${JSON.stringify(Object.fromEntries(this.cache))}\n`); } catch { /* kept in memory */ }
  }

  private trimCache(): void {
    // Map order is insertion order: the oldest answers go first.
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }
}

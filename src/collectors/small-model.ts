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
import { performance } from 'node:perf_hooks';
import { t, type Language } from '../render/i18n.js';
import { wrongLanguage } from './reply-language.js';
import { ModelRuntimeStore } from './model-runtime-store.js';
import { boundedTelemetry, summarizeModelTelemetry, telemetryFeature, telemetryFailure, TELEMETRY_RECORD_LIMIT, type ModelTelemetryRecord, type ModelTelemetrySummary, type TelemetryFeature } from './model-telemetry.js';

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
  /** Optional allowlisted accounting group; never affects routing, payload or cache identity. */
  telemetryFeature?: TelemetryFeature;
  system: string;
  prompt: string;
  /** Defaults to `low`, what every feature used before levels were a choice. */
  thinking?: ThinkingLevel;
  /** Approvals/probes, visible progress, then background work; FIFO within a class. */
  priority?: ModelPriority;
  /** Bounded to 100–90000 ms; defaults to 90000. */
  timeoutMs?: number;
  /** Optional API output bound, from 1 through 8192 tokens. */
  maxOutputTokens?: number;
  /**
   * The language the reply must be in. A reply plainly in another (see
   * reply-language.ts) is a failure, `invalid-response`, and is never cached;
   * one cached before is dropped. Never sent, and no part of the cache identity.
   */
  language?: Language;
  /**
   * Answer from the cache when the same input was answered before. The key
   * names what the input is about (an agent id, a rollout path); the cache is
   * keyed by a hash of it together with the whole request.
   */
  cacheKey?: string;
}

export type ModelPriority = 'interactive' | 'visible' | 'background';
export type ModelFailureClassification = 'auth' | 'model-not-found' | 'rate-limit' | 'timeout' | 'network' | 'server' | 'invalid-response' | 'output-limit';
const FAILURE_LABELS: Record<ModelFailureClassification, string> = {
  auth: 'Authentication failed', 'model-not-found': 'Model not found', 'rate-limit': 'Rate limited',
  timeout: 'Request timed out', network: 'Connection failed', server: 'Service unavailable',
  'invalid-response': 'Invalid response', 'output-limit': 'Output limit reached',
};

export interface ModelDiagnostics {
  queued: number;
  running?: { feature: string; startedAt: number };
  lastSuccessAt?: number;
  lastFailure?: { classification?: ModelFailureClassification; reason?: 'hourly-cap' | 'runtime-unavailable'; at: number; feature: string };
}

export type ModelResult =
  | { ok: true; text: string; cached?: boolean }
  | { ok: false; error: string; refused?: boolean; cancelled?: boolean; reason?: 'hourly-cap' | 'runtime-unavailable'; classification?: ModelFailureClassification };

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
  /** Calls reserved since local midnight, shared by panels on this CODEX_HOME. */
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
const STARVATION_MS = 30_000;
const PRIORITY_BURST = 4;
const WAITING_FOR_PEER = Symbol('waiting-for-peer');
export const DEFAULT_HOURLY_CAP = 60;
/** Cached answers kept; the oldest go first. */
const CACHE_LIMIT = 200;
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
export function modelHttpRequest(api: ModelApi, request: Pick<ModelRequest, 'feature' | 'system' | 'prompt' | 'thinking' | 'maxOutputTokens'>,
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
  const maxTokens = outputTokens(request.maxOutputTokens);
  const body = JSON.stringify({ model, stream: false, ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}), ...(effort ? { reasoning_effort: effort } : {}), messages: [
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

/**
 * The cache key of a request: everything that shapes the answer, so a
 * changed prompt, instruction or level is a different question.
 */
export function requestDigest(request: ModelRequest, route?: { backend: ModelBackend; endpoint?: string; model?: string; reasoning?: boolean }): string {
  return createHash('sha256').update(JSON.stringify([request.feature, request.cacheKey ?? '', request.thinking ?? DEFAULT_THINKING,
    request.system, request.prompt, route ?? null, ...(outputTokens(request.maxOutputTokens) !== undefined ? [outputTokens(request.maxOutputTokens)] : [])])).digest('hex');
}

/** Whether a reply is one the request can take: in its language, when it names one. */
function acceptable(request: ModelRequest, text: string): boolean {
  return !request.language || !wrongLanguage(text, request.language);
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

function outputTokens(value?: number): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(8192, Math.floor(value))) : undefined;
}

function timeoutMs(request: ModelRequest): number {
  return Number.isFinite(request.timeoutMs) ? Math.max(100, Math.min(TIMEOUT_MS, Math.floor(request.timeoutMs!))) : TIMEOUT_MS;
}

function requestPriority(request: ModelRequest): number {
  const priority = request.priority ?? (['approval', 'probe'].includes(request.feature) ? 'interactive'
    : request.feature === 'progress' ? 'visible' : 'background');
  return { interactive: 0, visible: 1, background: 2 }[priority];
}

/** Safe categories only; backend messages are never used as diagnostics. */
function httpClassification(status: number, json: unknown): ModelFailureClassification {
  const error = (json as { error?: { code?: unknown; type?: unknown; message?: unknown } } | null)?.error;
  const marker = `${error?.code ?? ''} ${error?.type ?? ''} ${error?.message ?? ''}`;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 404 || /model[_ -]?(not[_ -]?found|unavailable)|unknown model|invalid model name|model.*does not exist/i.test(marker)) return 'model-not-found';
  if (status === 408 || status === 504) return 'timeout';
  return status >= 500 ? 'server' : 'invalid-response';
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
  queuedAt: number;
  order: number;
  retryAt?: number;
  startedAt?: number;
  dispatchedAt?: number;
  id: string;
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
  /** Safe lifecycle notification; callers can read diagnostics() and repaint. */
  onChange?: () => void;
}

export class SmallModel {
  private backend: ModelBackend = 'off';
  private api: ModelApi = { base: '', model: '', key: '' };
  private cap = DEFAULT_HOURLY_CAP;
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private cache = new Map<string, { text: string; at: number }>();
  private calls: number[] = [];
  private priorityBurst = 0;
  private nextOrder = 0;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private lastSuccessAt?: number;
  private lastFailure?: ModelDiagnostics['lastFailure'];
  private readonly store: ModelRuntimeStore | null;
  private readonly telemetryStore: ModelRuntimeStore | null;
  private readonly dir: string | null;
  private readonly clock: () => number;
  private telemetryRecords: ModelTelemetryRecord[] = [];
  private telemetryWrites: Promise<void> = Promise.resolve();
  private telemetrySaving = false;
  private readonly telemetryDirty = new Map<string, ModelTelemetryRecord>();
  private telemetryUnavailable = false;

  constructor(private readonly options: SmallModelOptions = {}) {
    this.dir = options.dir ?? null;
    this.clock = options.clock ?? Date.now;
    this.store = this.dir ? new ModelRuntimeStore(this.dir) : null;
    this.telemetryStore = this.dir ? new ModelRuntimeStore(path.join(this.dir, 'telemetry')) : null;
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
    this.reloadCalls();
    return { today: callsToday(this.calls, now), lastHour: callsWithin(this.calls, now, HOUR_MS), cap: this.cap };
  }

  diagnostics(): ModelDiagnostics {
    return { queued: this.queue.filter(job => !job.settled).length + (this.active?.status === 'queued' && !this.active.settled ? 1 : 0),
      ...(this.active?.startedAt !== undefined && !this.active.settled ? { running: { feature: this.active.request.feature, startedAt: this.active.startedAt } } : {}),
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}) };
  }

  /**
   * Local read-only disk sampling when dir is configured; never sends a request.
   * Shared settled records plus this instance's pending work, within 24h/1000
   * records. Other panels' in-flight work and pre-instrumentation calls are unknown.
   * Cache hits count local consumers, not provider calls. Durations exclude queue
   * time; they measure dispatch to public settlement (including cancellation).
   */
  telemetry(now: number = this.clock()): ModelTelemetrySummary {
    let shared: ModelTelemetryRecord[] = [];
    if (this.telemetryStore) {
      try { shared = this.telemetryStore.telemetry(); } catch { this.telemetryUnavailable = true; }
    }
    return summarizeModelTelemetry([...shared, ...this.telemetryRecords], now,
      !this.store ? 'memory' : this.telemetryUnavailable ? 'unavailable' : this.telemetrySaving ? 'pending' : 'shared');
  }

  /** Optional shutdown/test barrier; never sends model traffic or retries failures. */
  async flushTelemetry(): Promise<void> {
    do { await this.telemetryWrites; } while (this.telemetrySaving);
  }

  private recordTelemetry(job: Job, result?: ModelResult): void {
    const now = this.clock();
    const outcome = !result ? 'pending' : result.ok ? result.cached ? 'cache' : 'success'
      : result.cancelled ? 'cancelled' : result.reason === 'hourly-cap' ? 'limited'
      : result.refused ? 'refused' : 'failure';
    const record: ModelTelemetryRecord = { id: job.id, feature: telemetryFeature(job.request.telemetryFeature ?? job.request.feature), at: job.queuedAt,
      outcome, durationMs: result && job.dispatchedAt !== undefined && now >= job.dispatchedAt ? now - job.dispatchedAt : null,
      failure: result && !result.ok && !result.cancelled ? telemetryFailure(result.classification ?? result.reason) : null };
    this.telemetryRecords = boundedTelemetry([...this.telemetryRecords, record], now);
    // Accounting must never delay settlement, change request ordering or cause a retry.
    if (this.telemetryStore && result) {
      this.telemetryDirty.set(record.id, record);
      while (this.telemetryDirty.size > TELEMETRY_RECORD_LIMIT) this.telemetryDirty.delete(this.telemetryDirty.keys().next().value!);
      if (!this.telemetrySaving) {
        this.telemetrySaving = true;
        // Coalesce a burst into bounded batches; no unbounded promise chain.
        this.telemetryWrites = Promise.resolve().then(async () => {
          try {
            while (this.telemetryDirty.size) {
              const records = [...this.telemetryDirty.values()];
              this.telemetryDirty.clear();
              try { await this.telemetryStore!.recordTelemetryBatch(records, this.clock()); }
              catch { this.telemetryUnavailable = true; }
            }
          } finally { this.telemetrySaving = false; }
        });
      }
    }
  }

  private changed(): void {
    try { this.options.onChange?.(); } catch { /* Observers cannot strand work. */ }
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
      job = { request, backend, http, command, digest, id: randomUUID(), queuedAt: this.clock(), order: this.nextOrder++, settled: false, status: 'queued', listeners: new Set(), resolve: value => {
        if (!job.settled) { job.settled = true; this.recordTelemetry(job, value); this.setStatus(job, 'settled'); resolve(value); }
      } };
    });
    this.recordTelemetry(job);
    this.reloadCache();
    let hit = digest ? this.cache.get(digest) : undefined;
    // An answer cached in the wrong language is no answer: dropped, and asked again.
    if (hit && !acceptable(request, hit.text)) { this.cache.delete(digest!); hit = undefined; }
    if (backend === 'off') {
      job.resolve({ ok: false, error: 'model backend off', refused: true });
    } else if (hit) {
      job.generatedAt = hit.at;
      job.resolve({ ok: true, text: hit.text, cached: true });
    } else {
      this.queue.push(job);
      this.changed();
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
        this.pump();
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
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.changed();
    // The active job releases its slot in pump() only after it has stopped.
  }

  private setStatus(job: Job, status: ModelStatus): void {
    if (job.status === status) return;
    job.status = status;
    this.changed();
    for (const listener of job.listeners) {
      try { listener(); } catch { /* Observers must not strand a queue slot or its result. */ }
    }
  }

  private pump(): void {
    if (this.active) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (!this.queue.length) return;
    const readyAt = performance.now();
    const eligible = this.queue.map((job, index) => ({ job, index })).filter(({ job }) => (job.retryAt ?? 0) <= readyAt);
    if (!eligible.length) {
      const delay = Math.max(1, Math.min(...this.queue.map(job => job.retryAt!)) - readyAt);
      this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; this.pump(); }, delay);
      return;
    }
    // Bound overtaking by both age and dispatch count. A steady stream of
    // approvals cannot keep the oldest ready background summary queued forever.
    const oldest = eligible[0];
    let index = oldest.index;
    if (this.clock() - oldest.job.queuedAt < STARVATION_MS && this.priorityBurst < PRIORITY_BURST) {
      for (const candidate of eligible) {
        if (requestPriority(candidate.job.request) < requestPriority(this.queue[index].request)) index = candidate.index;
      }
    }
    this.priorityBurst = index === oldest.index ? 0 : this.priorityBurst + 1;
    const job = this.queue.splice(index, 1)[0];
    this.active = job;
    // Disk coordination can wait for another panel. It becomes running only
    // once this process has a reservation and is about to send.
    if (!this.store) this.markRunning(job);
    void this.run(job).catch((): ModelResult => ({ ok: false, error: 'model shared state unavailable', refused: true, reason: 'runtime-unavailable' })).then(outcome => {
      if (outcome === WAITING_FOR_PEER) {
        if (!job.settled) {
          job.retryAt = performance.now() + 35;
          this.queue.push(job);
          this.queue.sort((a, b) => a.order - b.order);
        }
        if (this.active === job) this.active = null;
        this.pump();
        return;
      }
      if (outcome.ok && job.generatedAt === undefined) job.generatedAt = this.clock();
      if (!job.settled) {
        if (outcome.ok) {
          this.lastSuccessAt = job.generatedAt;
          if (job.digest) this.remember(job.digest, outcome.text, job.generatedAt!);
        } else if (!outcome.cancelled) this.lastFailure = { classification: outcome.classification, reason: outcome.reason, at: this.clock(), feature: job.request.feature };
      }
      job.resolve(outcome);
      if (this.active === job) { this.active = null; this.changed(); this.pump(); }
    });
  }

  private markRunning(job: Job): void {
    job.startedAt = this.clock();
    this.setStatus(job, 'running');
  }

  private capResult(): ModelResult {
    return { ok: false, error: t('Model call cap reached ({n} per hour)', { n: this.cap }), refused: true, reason: 'hourly-cap' };
  }

  private async run(job: Job): Promise<ModelResult | typeof WAITING_FOR_PEER> {
    if (job.settled) return { ok: false, error: 'cancelled', cancelled: true };
    const backend = job.backend;
    if (backend === 'off') return { ok: false, error: 'model backend off', refused: true };
    const http = job.http;
    if (http && 'error' in http) return { ok: false, error: http.error, classification: 'invalid-response' };
    if (this.store) {
      const reservation = await this.store.reserve(job.digest, job.id, this.cap, this.clock, () => job.settled, text => acceptable(job.request, text));
      if (job.settled) {
        if (reservation.kind === 'reserved' && job.digest) await this.store.finish(job.digest, job.id);
        return { ok: false, error: 'cancelled', cancelled: true };
      }
      if (reservation.kind === 'cached') {
        job.generatedAt = reservation.entry.at;
        return { ok: true, text: reservation.entry.text, cached: true };
      }
      if (reservation.kind === 'refused') return this.capResult();
      // A peer's same-input request holds no local network slot. Keep this
      // handle queued and let approvals/progress run during its free wait.
      if (reservation.kind === 'waiting') return WAITING_FOR_PEER;
      this.markRunning(job);
      if (job.settled) {
        if (job.digest) await this.store.finish(job.digest, job.id);
        return { ok: false, error: 'cancelled', cancelled: true };
      }
    } else {
      // Keep the in-memory path synchronous up to dispatch for existing users.
      const now = this.clock();
      if (job.digest) {
        const hit = this.cache.get(job.digest);
        if (hit && acceptable(job.request, hit.text)) { job.generatedAt = hit.at; return { ok: true, text: hit.text, cached: true }; }
        if (hit) this.cache.delete(job.digest);
      }
      if (callsWithin(this.calls, now, HOUR_MS) >= this.cap) return this.capResult();
      this.calls.push(now);
    }
    let outcome: ModelResult;
    job.dispatchedAt = this.clock();
    try {
      outcome = await (backend === 'api'
        ? this.request(job, http as Exclude<typeof http, { error: string } | null | undefined>)
        : this.spawn(job, job.command!));
      // Written in another language than asked: a failure, never cached, never shown as if it obeyed.
      if (outcome.ok && !acceptable(job.request, outcome.text)) outcome = { ok: false, error: t('Reply not in the panel language'), classification: 'invalid-response' };
      if (outcome.ok) job.generatedAt = this.clock();
    } catch {
      outcome = { ok: false, error: 'model request failed', classification: 'network' };
    } finally {
      job.stop = undefined;
    }
    if (this.store && job.digest) {
      // Cancellation holds the claim until the underlying transport settles.
      await this.store.finish(job.digest, job.id, outcome.ok && !job.settled ? { text: outcome.text, at: job.generatedAt! } : undefined, () => !job.settled);
    }
    return outcome;
  }

  private spawn(job: Job, { file, args }: { file: string; args: string[] }): Promise<ModelResult> {
    return new Promise(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(file, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve({ ok: false, error: `${file}: connection failed`, classification: 'network' });
        return;
      }
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.kill();
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      job.stop = stop;
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => { if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString('utf8'); });
      child.stderr?.resume();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs(job.request));
      let settled = false;
      const done = (message: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        const text = cleanOutput(out);
        resolve(!timedOut && message === null && text ? { ok: true, text } : { ok: false, error: timedOut ? `${file} timed out` : message ?? `${file} returned nothing`, classification: timedOut ? 'timeout' : message === null ? 'invalid-response' : 'network' });
      };
      child.on('error', error => done((error as NodeJS.ErrnoException).code === 'ENOENT' ? `${file} not found` : `${file}: connection failed`));
      child.on('close', (code, signal) => done(code === 0 ? null
        : signal ? `${file} stopped (${signal})` : `${file} exit ${code}`));
    });
  }

  private async request(job: Job, { url, headers, body }: { url: string; headers: Record<string, string>; body: string }): Promise<ModelResult> {
    const abort = new AbortController();
    job.stop = () => abort.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs(job.request));
    try {
      // Do not forward credentials or session material through endpoint redirects.
      const response = await (this.options.fetch ?? fetch)(url, { method: 'POST', headers, body, signal: abort.signal, redirect: 'error' });
      const raw = (await response.text()).slice(0, MAX_OUTPUT_BYTES);
      if (timedOut) return { ok: false, error: 'api stopped', classification: 'timeout' };
      let json: unknown = null;
      try { json = JSON.parse(raw); } catch { /* reported below */ }
      if (!response.ok) {
        const classification = httpClassification(response.status, json);
        return { ok: false, error: `api HTTP ${response.status}: ${t(FAILURE_LABELS[classification])}`, classification };
      }
      const text = cleanOutput(completionText(json) ?? '');
      if (!text && (json as { choices?: Array<{ finish_reason?: unknown }> } | null)?.choices?.[0]?.finish_reason === 'length') {
        return { ok: false, error: 'api output limit reached', classification: 'output-limit' };
      }
      return text ? { ok: true, text } : { ok: false, error: json === null ? 'api: reply is not JSON' : 'api returned nothing', classification: 'invalid-response' };
    } catch {
      return { ok: false, error: abort.signal.aborted ? 'api stopped' : 'api: connection failed', classification: timedOut ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  private reloadCache(): void {
    if (!this.store) return;
    try { this.cache = this.store.cache(); } catch { /* Dispatch fails closed if shared state remains unavailable. */ }
  }

  private reloadCalls(): void {
    if (!this.store) return;
    try { this.calls = this.store.calls(); } catch { /* Last known usage only; dispatch still fails closed. */ }
  }

  private remember(digest: string, text: string, generatedAt: number): void {
    this.cache.delete(digest);
    this.cache.set(digest, { text, at: generatedAt });
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }
}

/**
 * The one way the HUD asks a small, cheap model for text.
 *
 * Every feature that writes with a model (the agents brief, the main-session
 * recap, and what comes after them) sends its request through here, so they
 * share one backend, one queue and one budget:
 *
 * - one request is `{feature, system, prompt, thinking?, cacheKey?}` and its
 *   answer is text or a reason there is none;
 * - one request is in flight at a time; the rest wait their turn, and the
 *   owner of a request can cancel it, waiting or running;
 * - a request that passes a `cacheKey` is answered from a cache of earlier
 *   answers to the same input (in memory and, when a directory is given, on
 *   disk), so the same input is never sent twice;
 * - an hourly cap on calls. A request past it is refused with a reason the
 *   owner shows, never silently dropped. Calls are logged (timestamps only)
 *   so the cap and "calls today" hold across panel restarts.
 *
 */
import { readHudCredentials } from '../jev/ask/config.js';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { t, type Language } from '../render/i18n.js';
import { wrongLanguage } from './reply-language.js';
import { ModelRuntimeStore } from './model-runtime-store.js';

export type ModelBackend = 'off' | 'api';
/** minimal/medium are advanced typed-only compatibility values, never inferred. */
export type ApiEffort = 'off' | 'none' | 'low' | 'high' | 'xhigh' | 'max' | 'minimal' | 'medium';
export const REASONING_TOKEN_ALLOWANCE = 512;
export const DEFAULT_API_EFFORTS = { lite: 'none', low: 'low', medium: 'high' } as const;
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/** Where `api` requests go. Empty fields fall back as `modelHttpRequest` says. */
export interface ModelApi {
  base: string;
  /** Nonempty is a global override, retained for existing configurations. */
  model: string;
  /** Ignored legacy input. Credentials come only from the HUD credential reader. */
  key?: string;
  /** F4-only explicit source keyEnv binding. null means accountless; never populated by settings. */
  sourceCredential?: string | null;
}

export interface ModelRequest {
  materialUnchanged?: true;
  /** Who is asking; selects an API model route, but is never sent. */
  feature: string;
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
  /** Local pure format predicate; exceptions fail closed. Never sent or persisted. */
  validateResponse?: (text: string) => boolean;
  /**
   * Answer from the cache when the same input was answered before. The key
   * names what the input is about (an agent id, a rollout path); the cache is
   * keyed by a hash of it together with the whole request.
   */
  cacheKey?: string;
}

export type ModelPriority = 'interactive' | 'visible' | 'background';
export type ModelFailureClassification =
  'auth' | 'model-not-found' | 'rate-limit' | 'timeout' | 'network' | 'server' | 'invalid-response' | 'output-limit';
const FAILURE_LABELS: Record<ModelFailureClassification, string> = {
  auth: 'Authentication failed',
  'model-not-found': 'Model not found',
  'rate-limit': 'Rate limited',
  timeout: 'Request timed out',
  network: 'Connection failed',
  server: 'Service unavailable',
  'invalid-response': 'Invalid response',
  'output-limit': 'Output limit reached',
};

export interface ModelDiagnostics {
  queued: number;
  running?: { feature: string; startedAt: number };
  lastSuccessAt?: number;
  lastFailure?: {
    classification?: ModelFailureClassification;
    reason?: 'hourly-cap' | 'runtime-unavailable';
    at: number;
    feature: string;
  };
}

export type ModelResult =
  | { ok: true; text: string; cached?: boolean }
  | {
      ok: false;
      error: string;
      refused?: boolean;
      cancelled?: boolean;
      unchanged?: true;
      reason?: 'hourly-cap' | 'runtime-unavailable';
      classification?: ModelFailureClassification;
    };

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
/** A tier's explicit effort wins. The legacy switch never invents unsupported values. */
export function apiEffort(_api: ModelApi, tier: ApiModelTier): ApiEffort {
  return DEFAULT_API_EFFORTS[tier];
}

const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const HOUR_MS = 3_600_000;
const STARVATION_MS = 30_000;
const PRIORITY_BURST = 4;
const WAITING_FOR_PEER = Symbol('waiting-for-peer');
export const DEFAULT_HOURLY_CAP = 60;
/** Cached answers kept; the oldest go first. */
const CACHE_LIMIT = 200;
const DEFAULT_API_BASE = 'https://api.mistral.ai/v1';
export type ApiModelTier = 'lite' | 'low' | 'medium';
export const DEFAULT_API_MODELS: Readonly<Record<ApiModelTier, string>> = {
  lite: 'deepseek-v4-1-flash-1017',
  low: 'deepseek-v4-1-flash-1017',
  medium: 'deepseek-v4-1-flash-1017',
};

export function apiModelTier(feature: string): ApiModelTier {
  if (['labels', 'title', 'approval'].includes(feature)) return 'lite';
  if (['recap', 'cause'].includes(feature)) return 'medium';
  return 'low';
}

/**
 * One chat completions request. The base may be given up to `/v1` or as the
 * full `/chat/completions` URL. Keys come only from the HUD credentials' origin-bound
 * OpenAI/Mistral key (environment overrides matching file names).
 * Custom endpoints never receive general provider keys. Without a key the feature is off.
 * CODEX_HUD_BRIEF_MODEL overrides
 * the model. Each tier explicitly controls its optional reasoning_effort.
 */
export function modelHttpRequest(
  api: ModelApi,
  request: Pick<ModelRequest, 'feature' | 'system' | 'prompt' | 'thinking' | 'maxOutputTokens'>,
  env: NodeJS.ProcessEnv = process.env
):
  | { url: string; headers: Record<string, string>; body: string; model: string; accountSelection?: string }
  | { error: string; accountSelection?: string; url?: string; model?: string } {
  const base = (api.base.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  let origin: string;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return { error: 'api: invalid endpoint' };
    origin = parsed.origin;
  } catch {
    return { error: 'api: invalid endpoint' };
  }
  const tier = apiModelTier(request.feature);
  const model = env.CODEX_HUD_BRIEF_MODEL?.trim() || api.model.trim() || DEFAULT_API_MODELS[tier];
  // General provider keys are bound to exact HTTPS origins, never a lookalike or custom port.
  let key = api.sourceCredential?.trim() || '';
  if (
    api.sourceCredential === undefined &&
    (origin === 'https://api.openai.com' || origin === 'https://api.mistral.ai')
  ) {
    try {
      const name = origin === 'https://api.mistral.ai' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY';
      key = env[name]?.trim() || '';
      if (!key) {
        const creds = readHudCredentials(env);
        key = (origin === 'https://api.mistral.ai' ? creds.mistralApiKey : creds.openaiApiKey)?.trim() || '';
      }
    } catch {
      return { error: 'api: credential file must be a regular file with mode 0600' };
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!key && api.sourceCredential === undefined)
    return {
      error: 'api: off (missing provider key in environment or $HUD_HOME/credentials.env)',
    };
  if (key) headers.authorization = `Bearer ${key}`;
  const configuredEffort = apiEffort(api, tier);
  const effort = configuredEffort === 'off' ? undefined : configuredEffort;
  const output = outputTokens(request.maxOutputTokens);
  const maxTokens =
    output === undefined ? undefined : output + (effort && effort !== 'none' ? REASONING_TOKEN_ALLOWANCE : 0);
  const body = JSON.stringify({
    model,
    stream: false,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ],
  });
  return { url, headers, body, model };
}

/** The reply text of a chat completion; some servers send content as parts. */
export function completionText(json: unknown): string | null {
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
    return text || null;
  }
  return null;
}

/** Colour codes and runs of blank lines out; the text itself as written. */
export function cleanOutput(raw: string): string {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join('\n')
    .trim();
}

/**
 * The cache key of a request: everything that shapes the answer, so a
 * changed prompt, instruction or level is a different question.
 */
export function requestDigest(
  request: ModelRequest,
  route?: { backend: ModelBackend; endpoint?: string; model?: string; reasoning?: boolean; effort?: ApiEffort }
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.feature,
        request.cacheKey ?? '',
        request.thinking ?? DEFAULT_THINKING,
        request.system,
        request.prompt,
        route ?? null,
        ...(outputTokens(request.maxOutputTokens) !== undefined ? [outputTokens(request.maxOutputTokens)] : []),
      ])
    )
    .digest('hex');
}

/** Whether a reply is one the request can take: in its language, when it names one. */
function acceptable(request: ModelRequest, text: string): boolean {
  return validFormat(request, text) && (!request.language || !wrongLanguage(text, request.language));
}
function validFormat(request: ModelRequest, text: string): boolean {
  try {
    return request.validateResponse ? request.validateResponse(text) === true : true;
  } catch {
    return false;
  }
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
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed, or the write itself failed. */
    }
  }
}

function outputTokens(value?: number): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(8192, Math.floor(value))) : undefined;
}

function timeoutMs(request: ModelRequest): number {
  return Number.isFinite(request.timeoutMs)
    ? Math.max(100, Math.min(TIMEOUT_MS, Math.floor(request.timeoutMs!)))
    : TIMEOUT_MS;
}

function requestPriority(request: ModelRequest): number {
  const priority =
    request.priority ??
    (['approval', 'probe'].includes(request.feature)
      ? 'interactive'
      : request.feature === 'progress'
        ? 'visible'
        : 'background');
  return { interactive: 0, visible: 1, background: 2 }[priority];
}

/** Safe categories only; backend messages are never used as diagnostics. */
function httpClassification(status: number, json: unknown): ModelFailureClassification {
  const error = (json as { error?: { code?: unknown; type?: unknown; message?: unknown } } | null)?.error;
  const marker = `${error?.code ?? ''} ${error?.type ?? ''} ${error?.message ?? ''}`;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (
    status === 404 ||
    /model[_ -]?(not[_ -]?found|unavailable)|unknown model|invalid model name|model.*does not exist/i.test(marker)
  )
    return 'model-not-found';
  if (status === 408 || status === 504) return 'timeout';
  return status >= 500 ? 'server' : 'invalid-response';
}

interface Job {
  request: ModelRequest;
  backend: ModelBackend;
  env?: NodeJS.ProcessEnv;
  store?: ModelRuntimeStore | null;
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
  private readonly dir: string | null;
  private readonly clock: () => number;

  constructor(private readonly options: SmallModelOptions = {}) {
    this.dir = options.dir ?? null;
    this.clock = options.clock ? () => options.clock!() : Date.now;
    this.store = this.dir ? new ModelRuntimeStore(this.dir) : null;
  }

  configure(patch: { backend?: ModelBackend; api?: ModelApi; hourlyCap?: number }): void {
    const backend = patch.backend ?? this.backend;
    const api = patch.api ?? this.api;
    const changed = backend !== this.backend || JSON.stringify(api) !== JSON.stringify(this.api);
    if (changed) this.cancelAll();
    this.backend = backend;
    this.api = api;
    if (patch.hourlyCap !== undefined && Number.isFinite(patch.hourlyCap) && patch.hourlyCap > 0)
      this.cap = Math.floor(patch.hourlyCap);
  }

  usage(now: number = this.clock()): ModelUsage {
    this.reloadCalls();
    return { today: callsToday(this.calls, now), lastHour: callsWithin(this.calls, now, HOUR_MS), cap: this.cap };
  }

  diagnostics(): ModelDiagnostics {
    return {
      queued:
        this.queue.filter((job) => !job.settled).length +
        (this.active?.status === 'queued' && !this.active.settled ? 1 : 0),
      ...(this.active?.startedAt !== undefined && !this.active.settled
        ? { running: { feature: this.active.request.feature, startedAt: this.active.startedAt } }
        : {}),
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}),
    };
  }

  private changed(): void {
    try {
      if (this.options.onChange) this.options.onChange!();
    } catch {
      /* Observers cannot strand work. */
    }
  }

  /** Queue a request. It starts at once when nothing else is in flight. */
  submit(request: ModelRequest): ModelHandle {
    const backend = this.backend;
    const env = { ...(this.options.env ?? process.env) };
    const http = backend === 'api' ? modelHttpRequest(this.api, request, env) : undefined;
    const digest =
      backend !== 'off' && request.cacheKey !== undefined
        ? requestDigest(request, {
            backend,
            endpoint: http?.url,
            model: http?.model,
            effort: apiEffort(this.api, apiModelTier(request.feature)),
          })
        : null;
    let job!: Job;
    const result = new Promise<ModelResult>((resolve) => {
      job = {
        request,
        env,
        store: this.store,
        backend,
        http,
        digest,
        id: randomUUID(),
        queuedAt: this.clock(),
        order: this.nextOrder++,
        settled: false,
        status: 'queued',
        listeners: new Set(),
        resolve: (value) => {
          if (!job.settled) {
            job.settled = true;
            this.setStatus(job, 'settled');
            resolve(value);
          }
        },
      };
    });
    let hit: { text: string; at: number } | undefined;
    this.reloadCache();
    hit = digest ? this.cache.get(digest) : undefined;
    if (hit && !acceptable(request, hit.text)) hit = undefined;
    if (backend === 'off') {
      job.resolve({ ok: false, error: 'model backend off', refused: true });
    } else if (http && 'error' in http) {
      job.resolve({ ok: false, error: http.error, refused: true });
    } else if (request.materialUnchanged) {
      job.resolve({ ok: false, error: 'unchanged', unchanged: true });
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
      get status() {
        return job.status;
      },
      get generatedAt() {
        return job.generatedAt;
      },
      subscribe: (listener) => {
        job.listeners.add(listener);
        return () => {
          job.listeners.delete(listener);
        };
      },
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
      try {
        listener();
      } catch {
        /* Observers must not strand a queue slot or its result. */
      }
    }
  }

  private pump(): void {
    if (this.active) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (!this.queue.length) return;
    const readyAt = performance.now();
    const eligible = this.queue
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => (job.retryAt ?? 0) <= readyAt);
    if (!eligible.length) {
      const delay = Math.max(1, Math.min(...this.queue.map((job) => job.retryAt!)) - readyAt);
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = undefined;
        this.pump();
      }, delay);
      return;
    }
    // Bound overtaking by both age and dispatch count. A steady stream of
    // approvals cannot keep the oldest ready background summary queued forever.
    const oldest = eligible[0];
    let index = oldest.index;
    if (this.clock() - oldest.job.queuedAt < STARVATION_MS && this.priorityBurst < PRIORITY_BURST) {
      for (const candidate of eligible) {
        if (requestPriority(candidate.job.request) < requestPriority(this.queue[index].request))
          index = candidate.index;
      }
    }
    this.priorityBurst = index === oldest.index ? 0 : this.priorityBurst + 1;
    const job = this.queue.splice(index, 1)[0];
    this.active = job;
    // Disk coordination can wait for another panel. It becomes running only
    // once this process has a reservation and is about to send.
    if (!this.store) this.markRunning(job);
    void this.run(job)
      .catch((): ModelResult => ({
        ok: false,
        error: 'model shared state unavailable',
        refused: true,
        reason: 'runtime-unavailable',
      }))
      .then(async (outcome) => {
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
            if (job.digest) {
              this.remember(job.digest, outcome.text, job.generatedAt!);
            }
          } else if (!outcome.cancelled)
            this.lastFailure = {
              classification: outcome.classification,
              reason: outcome.reason,
              at: this.clock(),
              feature: job.request.feature,
            };
        }
        job.resolve(outcome);
        if (this.active === job) {
          this.active = null;
          this.changed();
          this.pump();
        }
      });
  }

  private markRunning(job: Job): void {
    job.startedAt = this.clock();
    this.setStatus(job, 'running');
  }

  private capResult(): ModelResult {
    return {
      ok: false,
      error: t('Model call cap reached ({n} per hour)', { n: this.cap }),
      refused: true,
      reason: 'hourly-cap',
    };
  }

  private async run(job: Job): Promise<ModelResult | typeof WAITING_FOR_PEER> {
    if (job.settled) return { ok: false, error: 'cancelled', cancelled: true };
    const backend = job.backend;
    const store = job.store;
    if (backend === 'off') return { ok: false, error: 'model backend off', refused: true };
    const http = job.http;
    if (http && 'error' in http) return { ok: false, error: http.error, classification: 'invalid-response' };
    if (store) {
      const reservation = await store.reserve(
        job.digest,
        job.id,
        this.cap,
        this.clock,
        () => job.settled,
        (text) => acceptable(job.request, text)
      );
      if (job.settled) {
        if (reservation.kind === 'reserved' && job.digest) await store.finish(job.digest, job.id);
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
        if (job.digest) await store.finish(job.digest, job.id);
        return { ok: false, error: 'cancelled', cancelled: true };
      }
    } else {
      // Keep the in-memory path synchronous up to dispatch for existing users.
      const now = this.clock();
      if (job.digest) {
        const hit = this.cache.get(job.digest);
        if (hit && acceptable(job.request, hit.text)) {
          job.generatedAt = hit.at;
          return { ok: true, text: hit.text, cached: true };
        }
        if (hit) this.cache.delete(job.digest);
      }
      if (callsWithin(this.calls, now, HOUR_MS) >= this.cap) return this.capResult();
      this.calls.push(now);
    }
    let outcome: ModelResult;
    try {
      outcome = await this.request(job, http as Exclude<typeof http, { error: string } | null | undefined>);
      // Written in another language than asked: a failure, never cached, never shown as if it obeyed.
      if (outcome.ok && !acceptable(job.request, outcome.text))
        outcome = {
          ok: false,
          error: validFormat(job.request, outcome.text) ? t('Reply not in the panel language') : 'Invalid response',
          classification: 'invalid-response',
        };
      if (outcome.ok) job.generatedAt = this.clock();
    } catch {
      outcome = { ok: false, error: 'model request failed', classification: 'network' };
    } finally {
      job.stop = undefined;
    }
    if (store && job.digest) {
      // Cancellation holds the claim until the underlying transport settles.
      await store.finish(
        job.digest,
        job.id,
        outcome.ok && !job.settled ? { text: outcome.text, at: job.generatedAt! } : undefined,
        () => !job.settled
      );
    }
    return outcome;
  }

  private async request(
    job: Job,
    { url, headers, body }: { url: string; headers: Record<string, string>; body: string }
  ): Promise<ModelResult> {
    const abort = new AbortController();
    job.stop = () => abort.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs(job.request));
    try {
      // Do not forward credentials or session material through endpoint redirects.
      const response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
        redirect: 'error',
      });
      const raw = (await response.text()).slice(0, MAX_OUTPUT_BYTES);
      if (timedOut) return { ok: false, error: 'api stopped', classification: 'timeout' };
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* reported below */
      }
      if (!response.ok) {
        const classification = httpClassification(response.status, json);
        return {
          ok: false,
          error: `api HTTP ${response.status}: ${t(FAILURE_LABELS[classification])}`,
          classification,
        };
      }
      const content = completionText(json) ?? '';
      if (!validFormat(job.request, content))
        return { ok: false, error: 'Invalid response', classification: 'invalid-response' };
      const text = cleanOutput(content);
      if (
        !text &&
        (json as { choices?: Array<{ finish_reason?: unknown }> } | null)?.choices?.[0]?.finish_reason === 'length'
      ) {
        return { ok: false, error: 'api output limit reached', classification: 'output-limit' };
      }
      return text
        ? { ok: true, text }
        : {
            ok: false,
            error: json === null ? 'api: reply is not JSON' : 'api returned nothing',
            classification: 'invalid-response',
          };
    } catch {
      return {
        ok: false,
        error: abort.signal.aborted ? 'api stopped' : 'api: connection failed',
        classification: timedOut ? 'timeout' : 'network',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private reloadCache(): void {
    const store = this.store;
    if (!store) return;
    try {
      this.cache = store.cache();
    } catch {
      /* Dispatch fails closed if shared state remains unavailable. */
    }
  }

  private reloadCalls(): void {
    if (!this.store) return;
    try {
      this.calls = this.store.calls();
    } catch {
      /* Last known usage only; dispatch still fails closed. */
    }
  }

  private remember(digest: string, text: string, generatedAt: number): void {
    this.cache.delete(digest);
    this.cache.set(digest, { text, at: generatedAt });
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }
}

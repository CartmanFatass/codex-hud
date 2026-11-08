// One Jev runtime for a HUD home: browser jobs, agent instances, the J2 lease
// and operation records. No CLI launcher, role resolver, or workflow logic.
// A caller disconnect ends that read only. Close is idempotent and keeps results.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { Agent, type BrowserPort } from '../agent.js';
import { homedir } from 'node:os';
import { DEFAULT_CDP_URL, defaultJevTomlPath, loadJevConfig, readJevEnv, type JevConfig } from '../ask/config.js';
import { chromeStart } from '../ask/chrome.js';
import { loopbackJson } from '../cdp.js';
import { JevFailure } from '../ask/error.js';
import { tryAcquireBrowserLock, type HeldLease } from '../ask/lease.js';
import { assertStateDir } from '../ask/names.js';
import {
  LABEL_SLUG,
  askKey,
  assertCanSend,
  assertProvider,
  openForUpdate,
  persistClick,
  promptSha256,
  pyStrip,
  squashedSha256,
} from '../ask/records.js';
import { Browser } from '../browser.js';
import { decideProviderId, type DecisionProvider, type DecisionProviderId } from '../decide.js';
import { RESERVED_STATEMENT_NAMES, awaitStates, type JudgmentProvider, type PageObservation } from '../judge.js';
import { actionSpace, type PageState } from '../model.js';
import { OpenAIDecisionProvider } from '../providers/openai.js';
import { TypeSafeDecisionProvider } from '../providers/typesafe.js';
import { fakeBrowser, fakeProvider } from './fake.js';
import { errorBody, jevCall, serveLine } from './ipc.js';
import type {
  JevCreateRequest,
  JevDecisionId,
  JevExecutor,
  JevFollowUp,
  JevJob,
  JevJobInput,
  JevJobState,
  JevReadOptions,
  JevSession,
} from './types.js';

export const DEFAULT_GRACE_MS = 2_000;
/** A `readJob` wait longer than this is capped. The client deadline is this plus a margin. */
export const MAX_READ_WAIT_MS = 120_000;

/** Long-poll cap. A non-positive or non-finite wait returns the job as it is. */
export function cappedReadWaitMs(waitMs: number | undefined): number {
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0) return 0;
  return Math.min(waitMs, MAX_READ_WAIT_MS);
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const STATEMENT_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export class JevRuntimeError extends Error {
  readonly name = 'JevRuntimeError';
  constructor(
    readonly code: string,
    message: string,
    readonly variable?: string
  ) {
    super(message);
  }
}

export interface AskTarget {
  readonly id: 'chatgpt-pro' | 'aistudio';
  /** R4 adapters set this. The stub does not take the lease and does not click. */
  readonly sends: boolean;
  /**
   * Operation identity. ChatGPT Pro uses `askKey('chatgpt', …)`.
   * AI Studio has no key here: R4 must port the driver's scheme
   * (label plus a hash of model, thinking, conversation, and the normalised prompt).
   */
  operationKey?(input: { label: string; prompt: string }): string;
  click?(ctx: { stateDir: string; key: string }): Promise<void>;
}

export interface ResolvedDecision {
  id: DecisionProviderId;
  model: string;
  apiKey: string;
  /** OpenAI only. Kept off the job file. */
  baseUrl?: string;
}

export interface RuntimeOptions {
  hudHome: string;
  /** Tests pass a temporary directory. Production reads `state_dir` from the jev-ask config. */
  stateDir?: string;
  /** Tests pass this with `stateDir`. Production reads `cdp_url` from the same config. */
  cdpUrl?: string;
  graceMs?: number;
  /** Child entry sets this. An in-process runtime must leave it false. */
  exitProcess?: boolean;
  /** Test and opt-in process stand-in. Production leaves this unset. */
  fake?: boolean;
  now?: () => number;
  browserFactory?: (url: string) => Promise<BrowserPort> | BrowserPort;
  providerFactory?: (resolved: ResolvedDecision) => Promise<DecisionProvider> | DecisionProvider;
  askTargets?: Partial<Record<'chatgpt-pro' | 'aistudio', AskTarget>>;
  /** Tests inject the config. Production resolves TOML and this runtime's HUD config. */
  configLoader?: () => { stateDir: string; cdpUrl: string };
}

interface StoredJob {
  executor: 'jev';
  id: string;
  requestKey: string;
  fingerprint: string;
  session: JevSession;
  tag: JevJob['tag'];
  input: JevJobInput;
  decisionProfile: string | null;
  provider: { id: JevDecisionId; model: string } | null;
  state: JevJobState;
  closed: boolean;
  seq: number;
  result: unknown;
  error?: { code: string; message: string; variable?: string };
  createdAt: string;
  run: { startedAt: string; endedAt?: string } | null;
}

const pendingTarget = (id: 'chatgpt-pro' | 'aistudio'): AskTarget => ({ id, sends: false });

export class JevRuntime implements JevExecutor {
  readonly hudHome: string;
  stateDir = '';
  cdpUrl = DEFAULT_CDP_URL;
  readonly graceMs: number;
  private readonly jobsDir: string;
  private readonly socketPath: string;
  private readonly runtimeDir: string;
  private readonly options: RuntimeOptions;
  private readonly jobs = new Map<string, StoredJob>();
  private readonly byRequest = new Map<string, string>();
  private readonly agents = new Map<string, Agent>();
  private readonly browsers = new Set<BrowserPort>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly cleanups = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly followUps = new Set<string>();
  private readonly keys = new Map<string, Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly targets: Record<'chatgpt-pro' | 'aistudio', AskTarget>;
  private server?: Server;
  private runtimeLease?: HeldLease;
  private graceTimer?: NodeJS.Timeout;
  private writers = 0;
  private stopping = false;
  private started = false;
  private config?: JevConfig;
  private chromeStarting?: Promise<void>;

  constructor(options: RuntimeOptions) {
    if (!options.hudHome.startsWith('/')) throw new JevRuntimeError('invalid_request', 'HUD home must be absolute');
    this.options = options;
    this.hudHome = options.hudHome;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.runtimeDir = join(options.hudHome, 'jev-runtime');
    this.jobsDir = join(this.runtimeDir, 'jobs');
    this.socketPath = join(this.runtimeDir, 'runtime.sock');
    this.targets = {
      'chatgpt-pro': options.askTargets?.['chatgpt-pro'] ?? pendingTarget('chatgpt-pro'),
      aistudio: options.askTargets?.aistudio ?? pendingTarget('aistudio'),
    };
  }

  /** Load records, listen, and arm the idle grace timer. A live runtime is left untouched. */
  async start(): Promise<void> {
    if (this.started || this.stopping) return;
    this.bindState();
    mkdirSync(this.hudHome, { recursive: true, mode: 0o700 });
    chmodSync(this.hudHome, 0o700);
    mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    chmodSync(this.runtimeDir, 0o700);
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.jobsDir, 0o700);
    if (await this.socketLive()) throw new JevRuntimeError('already_running', 'already_running');
    let lease: HeldLease;
    try {
      lease = tryAcquireBrowserLock({
        stateDir: this.runtimeDir,
        lockFile: 'runtime.lock',
        jobId: 'runtime',
        phase: 'serve',
        holder: 'hud',
      });
    } catch (error) {
      if (error instanceof JevFailure && error.code === 'browser_busy') {
        throw new JevRuntimeError('already_running', 'already_running');
      }
      throw error;
    }
    try {
      if (await this.socketLive()) throw new JevRuntimeError('already_running', 'already_running');
      this.loadJobs();
      this.server = await serveLine(this.socketPath, (method, args, signal, socket) =>
        this.handle(method, args, signal, socket)
      );
      this.runtimeLease = lease;
      this.started = true;
      this.writeRuntimeFile();
      this.armGrace();
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    for (const abort of this.aborts.values()) abort.abort();
    for (const browser of this.browsers) await Promise.resolve(browser.close()).catch(() => undefined);
    this.browsers.clear();
    for (const agent of this.agents.values()) await agent.close().catch(() => undefined);
    this.agents.clear();
    await Promise.allSettled([...this.runs.values()]);
    let failure: unknown;
    try {
      for (const job of this.jobs.values()) {
        if (job.state !== 'queued' && job.state !== 'running') continue;
        job.state = 'interrupted';
        job.error = { code: 'interrupted', message: 'interrupted' };
        job.run = job.run ? { ...job.run, endedAt: this.stamp() } : { startedAt: this.stamp(), endedAt: this.stamp() };
        this.writeFile(job);
      }
    } catch (error) {
      failure = error;
    }
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = undefined;
    this.runtimeLease?.release();
    this.runtimeLease = undefined;
    if (failure) throw failure;
    if (this.options.exitProcess) process.exit(0);
  }

  /** The shared record directory. Missing means a typed error, never a new folder. */
  private bindState(): void {
    // Explicit test state never reads production configuration. Normal starts use
    // the same TOML as the CLI, overlaid by this HUD home's own `jev` section.
    this.config = this.options.stateDir
      ? loadJevConfig({
          configJson: { jev: { stateDir: this.options.stateDir, cdpUrl: this.options.cdpUrl } },
          capturedEnv: process.env,
        })
      : this.options.configLoader
        ? loadJevConfig({ configJson: { jev: this.options.configLoader() }, capturedEnv: process.env })
        : loadRuntimeConfig(this.hudHome);
    this.stateDir = this.config.stateDir;
    this.cdpUrl = this.config.cdpUrl || DEFAULT_CDP_URL;
    try {
      assertStateDir(this.stateDir);
    } catch (error) {
      if (error instanceof JevFailure) throw new JevRuntimeError(error.code, error.code);
      throw error;
    }
  }

  private async socketLive(): Promise<boolean> {
    try {
      await jevCall(this.socketPath, 'status', {}, AbortSignal.timeout(500), 500);
      return true;
    } catch {
      return false;
    }
  }

  retained(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' || job.state === 'running' || this.agents.has(job.id)) count += 1;
    }
    return count;
  }

  async createJob(request: JevCreateRequest): Promise<JevJob> {
    const parsed = parseCreate(request);
    return this.withKey(parsed.requestKey, async () => {
      const existing = this.byKey(parsed.requestKey);
      if (existing) {
        if (
          existing.session.namespace !== parsed.session.namespace ||
          existing.session.sessionId !== parsed.session.sessionId
        ) {
          throw new JevRuntimeError('association_conflict', 'association_conflict');
        }
        if (existing.fingerprint !== fingerprintOf(parsed.input)) {
          throw new JevRuntimeError('conflict', 'conflict');
        }
        return this.view(existing);
      }
      const resolved = this.resolveDecision(parsed.jevDecisions);
      const job: StoredJob = {
        executor: 'jev',
        id: `jev-${randomUUID()}`,
        requestKey: parsed.requestKey,
        fingerprint: fingerprintOf(parsed.input),
        session: parsed.session,
        tag: parsed.input.tag,
        input: parsed.input,
        decisionProfile: parsed.jevDecisions?.id ?? null,
        provider: { id: resolved.id, model: resolved.model },
        state: 'queued',
        closed: false,
        seq: 1,
        result: null,
        createdAt: this.stamp(),
        run: null,
      };
      this.save(job);
      const task = this.execute(job, resolved);
      this.runs.set(job.id, task);
      await Promise.resolve();
      return this.view(this.jobs.get(job.id) ?? job);
    });
  }

  async readJob(jobId: string, options: JevReadOptions = {}): Promise<JevJob> {
    const current = this.require(jobId);
    const waitMs = cappedReadWaitMs(options.waitMs);
    const after = options.afterSeq ?? -1;
    if (waitMs <= 0 || current.seq > after || terminal(current)) return this.view(current);
    return new Promise((resolve, reject) => {
      const finish = (ended: boolean) => {
        cleanup();
        const job = this.jobs.get(jobId);
        if (!job) {
          reject(new JevRuntimeError('not_found', 'not_found'));
          return;
        }
        resolve(ended ? { ...this.view(job), observationEnded: true } : this.view(job));
      };
      const onUpdate = () => {
        const job = this.jobs.get(jobId);
        if (job && (job.seq > after || terminal(job))) finish(false);
      };
      const timer = setTimeout(() => finish(false), waitMs);
      const onAbort = () => finish(true);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(onUpdate);
        options.signal?.removeEventListener('abort', onAbort);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(onUpdate);
      if (options.signal?.aborted) finish(true);
    });
  }

  async sendFollowUp(jobId: string, followUp: JevFollowUp): Promise<JevJob> {
    const job = this.require(jobId);
    if (!followUp || typeof followUp.key !== 'string' || !REQUEST_KEY.test(followUp.key)) {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    const token = `${jobId}:${followUp.key}`;
    if (this.followUps.has(token)) return this.view(job);
    const agent = this.agents.get(jobId);
    if (job.tag !== 'browse' || !agent || typeof followUp.text !== 'string' || !followUp.text.trim()) {
      return { ...this.view(job), followUp: { supported: false, code: 'unsupported' } };
    }
    this.followUps.add(token);
    agent.setGoal(followUp.text.trim());
    job.seq += 1;
    this.save(job);
    return this.view(job);
  }

  async closeJob(jobId: string): Promise<JevJob> {
    const job = this.require(jobId);
    if (job.closed && !this.cleanups.has(jobId)) return this.view(job);
    let cleanup = this.cleanups.get(jobId);
    if (!cleanup) {
      job.closed = true;
      if (job.run && !job.run.endedAt) job.run = { ...job.run, endedAt: this.stamp() };
      if (job.state === 'running' || job.state === 'queued') job.state = 'closed';
      this.save(job);
      cleanup = this.finishClose(job);
      this.cleanups.set(jobId, cleanup);
    }
    await cleanup;
    return this.view(this.jobs.get(jobId) ?? job);
  }

  private async handle(
    method: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    socket: { unref(): void }
  ): Promise<unknown> {
    if (method === 'readJob' || method === 'status') socket.unref();
    else this.writers += 1;
    try {
      if (method === 'status') return { pid: process.pid, retained: this.retained(), jobs: this.jobs.size };
      if (method === 'createJob') return await this.createJob(args as unknown as JevCreateRequest);
      if (method === 'readJob') {
        const jobId = typeof args.jobId === 'string' ? args.jobId : '';
        const waitMs = cappedReadWaitMs(typeof args.waitMs === 'number' ? args.waitMs : undefined);
        const afterSeq = typeof args.afterSeq === 'number' ? args.afterSeq : undefined;
        return await this.readJob(jobId, { waitMs, afterSeq, signal });
      }
      if (method === 'sendFollowUp') {
        return await this.sendFollowUp(String(args.jobId ?? ''), args.followUp as JevFollowUp);
      }
      if (method === 'closeJob') return await this.closeJob(String(args.jobId ?? ''));
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    } finally {
      if (method !== 'readJob' && method !== 'status') {
        this.writers -= 1;
        this.armGrace();
      }
    }
  }

  private async execute(job: StoredJob, resolved: ResolvedDecision): Promise<void> {
    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    this.markRunning(job);
    try {
      const provider = await this.providerFor(resolved);
      if (job.input.tag === 'ask') await this.runAsk(job);
      else if (job.input.tag === 'browse') await this.runBrowse(job, provider, abort.signal);
      else await this.runJudge(job, provider, abort.signal);
    } catch (error) {
      // Stop owns the terminal write. A signal must leave queued and running jobs interrupted.
      if (!job.closed && !this.stopping) this.fail(job, error);
    } finally {
      this.aborts.delete(job.id);
      const agent = this.agents.get(job.id);
      this.agents.delete(job.id);
      if (agent) await agent.close().catch(() => undefined);
      this.runs.delete(job.id);
      this.armGrace();
    }
  }

  private async runAsk(job: StoredJob): Promise<void> {
    if (job.input.tag !== 'ask') return;
    const target = this.targets[job.input.target];
    // AI Studio has no operation key in this runtime. R4 must port aistudio.py make_key
    // (hash of the prompt, model, thinking, and conversation) into aistudio_chat_state.json.
    const key =
      job.input.target === 'chatgpt-pro'
        ? (target.operationKey?.({ label: job.input.label, prompt: job.input.prompt }) ??
          askRecordKey('chatgpt-pro', job.input.label, job.input.prompt))
        : undefined;
    if (job.input.target !== 'chatgpt-pro' || !target.sends || !target.click || !key) {
      this.complete(job, {
        status: 'target_pending',
        target: job.input.target,
        ...(key ? { key } : {}),
      });
      return;
    }
    // Close during the click can leave the job result null. The operation record is authoritative.
    const opened = openForUpdate(this.stateDir, key, { jobId: job.id, phase: 'send', holder: 'hud' });
    try {
      assertProvider(opened.record, 'chatgpt');
      assertCanSend(opened.record, job.input.confirmResend === true);
      const stripped = pyStrip(job.input.prompt);
      persistClick(
        this.stateDir,
        key,
        {
          key,
          provider: 'chatgpt',
          prompt_sha256: promptSha256(stripped),
          squashed_sha256: squashedSha256(stripped),
        },
        opened.lease
      );
      await target.click({ stateDir: this.stateDir, key });
      this.complete(job, { status: 'clicked', key });
    } catch (error) {
      if (
        error instanceof JevFailure &&
        (error.code === 'already_attempted' || error.code === 'resend_needs_confirmation')
      ) {
        this.complete(job, { status: error.code, key });
        return;
      }
      throw error;
    } finally {
      opened.lease.release();
    }
  }

  private async runBrowse(job: StoredJob, provider: DecisionProvider, signal: AbortSignal): Promise<void> {
    if (job.input.tag !== 'browse') return;
    const browser = await this.openBrowser(job.input.url);
    try {
      const page = await browser.observe(false);
      if (signal.aborted || job.closed) return;
      const agent = new Agent(provider, null, initialAgent(browser, job.input.goal, page), {
        cacheKey: `hud-jev:${job.id}`,
      });
      this.agents.set(job.id, agent);
      for await (const snapshot of agent.run()) {
        if (signal.aborted || job.closed) return;
        job.result = { status: snapshot.status, steps: snapshot.history.length, goal: snapshot.goal };
        job.seq += 1;
        this.save(job);
      }
      if (!job.closed) {
        this.complete(job, {
          status: agent.state.status,
          steps: agent.state.history.length,
          goal: agent.state.goal,
        });
      }
    } finally {
      await this.closeBrowser(browser);
    }
  }

  private async runJudge(job: StoredJob, provider: DecisionProvider, signal: AbortSignal): Promise<void> {
    if (job.input.tag !== 'judge') return;
    if (!provider.judge) throw new JevRuntimeError('judge_unavailable', 'judge_unavailable');
    const judgeProvider: JudgmentProvider = { judge: provider.judge.bind(provider) };
    const browser = await this.openBrowser(job.input.url);
    try {
      if (signal.aborted || job.closed) return;
      const outcome = await awaitStates(job.input.statements, observeBrowser(browser), judgeProvider, {
        maxMs: 60_000,
        maxCalls: 4,
        maxLoadMs: 60_000,
        signal,
        cacheKey: `hud-jev:${job.id}`,
      });
      if (signal.aborted || job.closed) return;
      if (!job.closed) {
        this.complete(job, {
          statements: outcome.statements.map((statement) => ({
            name: statement.name,
            verdict: statement.verdict,
            ...(statement.probability !== undefined ? { probability: statement.probability } : {}),
            ...(statement.humanKind ? { humanKind: statement.humanKind } : {}),
          })),
          calls: outcome.calls,
          extendedMs: outcome.extendedMs,
        });
      }
    } finally {
      await this.closeBrowser(browser);
    }
  }

  private async finishClose(job: StoredJob): Promise<void> {
    this.aborts.get(job.id)?.abort();
    const agent = this.agents.get(job.id);
    if (agent) await agent.close().catch(() => undefined);
    const run = this.runs.get(job.id);
    if (run) await run.catch(() => undefined);
    this.armGrace();
  }

  private async openBrowser(url: string): Promise<BrowserPort> {
    const browser = this.options.browserFactory
      ? await this.options.browserFactory(url)
      : this.options.fake
        ? fakeBrowser(this.hudHome)
        : await this.openSharedBrowser(url);
    this.browsers.add(browser);
    return browser;
  }

  private async openSharedBrowser(url: string): Promise<BrowserPort> {
    const config = this.config;
    if (!config) throw new JevRuntimeError('browser_unavailable', 'browser_unavailable');
    // Concurrent jobs in this runtime join one start. Chrome itself is shared
    // with the CLI and is never stopped by runtime cleanup.
    if (!this.chromeStarting) {
      this.chromeStarting = (async () => {
        try {
          await chromeStart(config, 'headless', {
            reuseAnyMode: true,
            fetchVersion: (cdpUrl, remainingMs) =>
              loopbackJson(new URL('/json/version', cdpUrl).href, Math.min(1_000, remainingMs ?? 1_000)),
          });
        } catch {
          throw new JevRuntimeError('browser_unavailable', 'browser_unavailable');
        }
      })();
    }
    const starting = this.chromeStarting;
    try {
      await starting;
    } finally {
      if (this.chromeStarting === starting) this.chromeStarting = undefined;
    }
    return Browser.open(url, { cdpUrl: this.cdpUrl, timeoutMs: config.cdpTimeoutMs });
  }

  private async closeBrowser(browser: BrowserPort): Promise<void> {
    this.browsers.delete(browser);
    await Promise.resolve(browser.close()).catch(() => undefined);
  }

  private async providerFor(resolved: ResolvedDecision): Promise<DecisionProvider> {
    if (this.options.providerFactory) return this.options.providerFactory(resolved);
    if (this.options.fake) return fakeProvider();
    if (resolved.id === 'openai') {
      return new OpenAIDecisionProvider({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
    }
    return new TypeSafeDecisionProvider({ apiKey: resolved.apiKey, model: resolved.model });
  }

  private resolveDecision(profile: JevCreateRequest['jevDecisions']): ResolvedDecision {
    const explicit = profile?.provider;
    if (explicit !== undefined && explicit !== 'typesafe' && explicit !== 'openai') {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    const creds = readJevEnv(join(this.hudHome, 'jev.env'));
    const decision = decideProviderId(explicit, {
      typesafe: Boolean(creds.typesafeApiKey),
      openai: Boolean(creds.openaiApiKey),
    });
    if (!decision.ok)
      throw new JevRuntimeError('jev_credentials_missing', 'jev_credentials_missing', decision.variable);
    if (decision.provider === 'openai') {
      return {
        id: 'openai',
        model: 'gpt-6-luna',
        apiKey: creds.openaiApiKey ?? '',
        baseUrl: creds.openaiBaseUrl,
      };
    }
    return {
      id: 'typesafe',
      model: profile?.model || creds.typesafeModel || 'jev-latest',
      apiKey: creds.typesafeApiKey ?? '',
    };
  }

  private markRunning(job: StoredJob): void {
    if (job.closed) return;
    job.state = 'running';
    job.run = { startedAt: this.stamp() };
    job.seq += 1;
    this.save(job);
  }

  private complete(job: StoredJob, result: unknown): void {
    if (job.closed) return;
    job.state = 'completed';
    job.result = result;
    job.run = { startedAt: job.run?.startedAt ?? this.stamp(), endedAt: this.stamp() };
    job.seq += 1;
    this.save(job);
  }

  private fail(job: StoredJob, error: unknown): void {
    if (job.closed) return;
    const body = errorBody(error);
    job.state = 'failed';
    job.error = body;
    job.result = job.result ?? null;
    job.run = { startedAt: job.run?.startedAt ?? this.stamp(), endedAt: this.stamp() };
    job.seq += 1;
    this.save(job);
  }

  private loadJobs(): void {
    if (!existsSync(this.jobsDir)) return;
    for (const name of readdirSync(this.jobsDir)) {
      if (!name.endsWith('.json')) continue;
      const parsed = JSON.parse(readFileSync(join(this.jobsDir, name), 'utf8')) as StoredJob;
      if (parsed.state === 'queued' || parsed.state === 'running') {
        parsed.state = 'interrupted';
        parsed.error = { code: 'interrupted', message: 'interrupted' };
        parsed.run = parsed.run ? { ...parsed.run, endedAt: this.stamp() } : null;
        this.writeFile(parsed);
      }
      this.jobs.set(parsed.id, parsed);
      if (typeof parsed.requestKey === 'string') this.byRequest.set(parsed.requestKey, parsed.id);
    }
    this.writeIndex();
  }

  private save(job: StoredJob): void {
    this.jobs.set(job.id, job);
    this.byRequest.set(job.requestKey, job.id);
    this.writeFile(job);
    this.writeIndex();
    for (const waiter of this.waiters) waiter();
    this.armGrace();
  }

  private writeFile(job: StoredJob): void {
    const file = join(this.jobsDir, `${job.id}.json`);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const text = JSON.stringify(job);
    if (text.includes(this.secretHint(job))) throw new JevRuntimeError('internal', 'internal');
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }

  /** The credential string is not on the job. This only runs when a factory stashed one, which it must not. */
  private secretHint(job: StoredJob): string {
    const provider = job.provider as { apiKey?: string } | null;
    return provider?.apiKey && provider.apiKey.length > 8 ? provider.apiKey : '\u0000never';
  }

  /**
   * requestKey to job id, in memory and in request-keys.json.
   * A newer seq is not terminal; callers poll until the state is terminal.
   * Nothing is pruned. The design cut the 30-day auto-delete.
   */
  private writeIndex(): void {
    const file = join(this.runtimeDir, 'request-keys.json');
    const keys = [...this.byRequest.entries()].map(([requestKey, id]) => ({ requestKey, id }));
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ keys }), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }

  private writeRuntimeFile(): void {
    const file = join(this.hudHome, 'jev-runtime', 'runtime.json');
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: this.stamp() }) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  private armGrace(): void {
    if (this.stopping) return;
    if (this.retained() > 0 || this.writers > 0) {
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      this.server?.ref();
      return;
    }
    if (this.graceTimer) return;
    this.server?.unref();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      if (this.retained() > 0 || this.writers > 0) {
        this.armGrace();
        return;
      }
      for (const abort of this.aborts.values()) abort.abort();
      void this.stop();
    }, this.graceMs);
  }

  private async withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.keys.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.keys.set(
      key,
      previous.then(
        () => gate,
        () => gate
      )
    );
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private byKey(requestKey: string): StoredJob | undefined {
    const id = this.byRequest.get(requestKey);
    return id ? this.jobs.get(id) : undefined;
  }

  private require(jobId: string): StoredJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new JevRuntimeError('not_found', 'not_found');
    return job;
  }

  private view(job: StoredJob): JevJob {
    return {
      executor: 'jev',
      id: job.id,
      requestKey: job.requestKey,
      fingerprint: job.fingerprint,
      session: job.session,
      tag: job.tag,
      decisionProfile: job.decisionProfile,
      provider: job.provider,
      state: job.state,
      closed: job.closed,
      seq: job.seq,
      result: job.result,
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private stamp(): string {
    return new Date(this.options.now ? this.options.now() : Date.now()).toISOString();
  }
}

/** Explicit sources: HUD JSON overrides TOML; the loader itself never reads process.env. */
export function loadRuntimeConfig(hudHome: string): JevConfig {
  return loadJevConfig({
    tomlPath: process.env.JEV_ASK_CONFIG || defaultJevTomlPath(),
    configJsonPath: join(hudHome, 'config.json'),
    capturedEnv: process.env,
    home: homedir(),
  });
}

/** ChatGPT Pro key. AI Studio returns no key; R4 ports the driver's hash into its own record file. */
export function askRecordKey(target: 'chatgpt-pro', label: string, prompt: string): string;
export function askRecordKey(target: 'aistudio', label: string, prompt: string): undefined;
export function askRecordKey(target: 'chatgpt-pro' | 'aistudio', label: string, prompt: string): string | undefined {
  if (target === 'aistudio') return undefined;
  return askKey('chatgpt', label, pyStrip(prompt));
}

export function observeBrowser(browser: BrowserPort): { observe(): Promise<PageObservation> } {
  return {
    async observe() {
      const page = (await browser.observe(false)) as PageState & { readyState?: unknown };
      const stamped = typeof page.readyState === 'string' && page.readyState ? page.readyState : '';
      const evaluated = stamped ? '' : await evaluatedReadyState(browser);
      const readyState = stamped || evaluated || 'loading';
      // The judge sees the same element records the decide path builds from the observed actions.
      const [elements] = actionSpace(Array.isArray(page.actions) ? page.actions : []);
      const headings = await evaluatedHeadings(browser);
      return {
        page: { url: page.url, title: page.title ?? '', text: page.text.slice(0, 6000) },
        elements,
        // Headings and elements are request content only; the stability marker stays page-derived.
        facts: { readyState, marker: page.marker ?? page.fingerprint ?? page.url, url: page.url, headings },
        deltas: {},
      };
    },
  };
}

async function evaluatedReadyState(browser: BrowserPort): Promise<string> {
  const evaluate = (browser as BrowserPort & { evaluate?: (expression: string) => Promise<unknown> }).evaluate;
  if (typeof evaluate !== 'function') return '';
  try {
    const value = await evaluate.call(browser, 'document.readyState');
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

const HEADING_LIMIT = 12;
const HEADING_TEXT_LIMIT = 200;

interface ObservedHeading {
  level: 1 | 2 | 3;
  text: string;
}

/**
 * One evaluate call. Document order, visible headings only: an element with the
 * `hidden` attribute, a computed `display:none`/`visibility:hidden`, or no rendered
 * box (a `display:none` ancestor) is skipped. The expression bounds the result;
 * `boundedHeadings` repeats the bound so a page (or a test double) cannot widen the request.
 */
const HEADINGS_EXPRESSION = `(() => {
  const out = [];
  for (const node of document.querySelectorAll('h1, h2, h3')) {
    if (out.length >= ${HEADING_LIMIT}) break;
    if (node.hidden) continue;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (!node.getClientRects().length) continue;
    const text = (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${HEADING_TEXT_LIMIT});
    if (!text) continue;
    out.push({ level: Number(node.tagName.slice(1)), text });
  }
  return out;
})()`;

function boundedHeadings(value: unknown): ObservedHeading[] {
  if (!Array.isArray(value)) return [];
  const headings: ObservedHeading[] = [];
  for (const item of value) {
    if (headings.length >= HEADING_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as { level?: unknown; text?: unknown };
    if (record.level !== 1 && record.level !== 2 && record.level !== 3) continue;
    if (typeof record.text !== 'string') continue;
    const text = record.text.trim().slice(0, HEADING_TEXT_LIMIT);
    if (!text) continue;
    headings.push({ level: record.level, text });
  }
  return headings;
}

async function evaluatedHeadings(browser: BrowserPort): Promise<ObservedHeading[]> {
  const evaluate = (browser as BrowserPort & { evaluate?: (expression: string) => Promise<unknown> }).evaluate;
  if (typeof evaluate !== 'function') return [];
  try {
    return boundedHeadings(await evaluate.call(browser, HEADINGS_EXPRESSION));
  } catch {
    return [];
  }
}

function initialAgent(browser: BrowserPort, goal: string, page: PageState): Agent['state'] {
  return {
    browser,
    goal,
    page,
    decision: null,
    history: [],
    status: 'ready',
    plan: [goal],
    plan_index: 0,
    decisions: [],
    text_calls: [],
    elapsed_ms: 0,
    started_at: null,
    record: false,
  };
}

function terminal(job: StoredJob): boolean {
  return job.state === 'completed' || job.state === 'failed' || job.state === 'closed' || job.state === 'interrupted';
}

function fingerprintOf(input: JevJobInput): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function parseCreate(request: JevCreateRequest): JevCreateRequest {
  if (!request || typeof request.requestKey !== 'string' || !REQUEST_KEY.test(request.requestKey)) {
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  }
  const session = request.session;
  if (!session || !NAME.test(session.namespace ?? '') || !SESSION.test(session.sessionId ?? '')) {
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  }
  return {
    requestKey: request.requestKey,
    session: { namespace: session.namespace, sessionId: session.sessionId },
    jevDecisions: parseProfile(request.jevDecisions),
    input: parseInput(request.input),
  };
}

function parseProfile(profile: JevCreateRequest['jevDecisions']): JevCreateRequest['jevDecisions'] {
  if (profile === undefined || profile === null) return undefined;
  if (typeof profile !== 'object') throw new JevRuntimeError('invalid_request', 'invalid_request');
  if (profile.provider !== undefined && profile.provider !== 'typesafe' && profile.provider !== 'openai') {
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  }
  if (profile.id !== undefined && (typeof profile.id !== 'string' || !NAME.test(profile.id))) {
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  }
  if (profile.model !== undefined && profile.model !== null && typeof profile.model !== 'string') {
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  }
  return { id: profile.id, provider: profile.provider, model: profile.model };
}

function parseInput(input: JevJobInput): JevJobInput {
  if (!input || typeof input !== 'object') throw new JevRuntimeError('invalid_request', 'invalid_request');
  if (input.tag === 'ask') {
    if (input.target !== 'chatgpt-pro' && input.target !== 'aistudio') {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    if (typeof input.label !== 'string' || !LABEL_SLUG.test(input.label)) {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 65_536) {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    return {
      tag: 'ask',
      target: input.target,
      label: input.label,
      prompt: input.prompt,
      ...(input.confirmResend === true ? { confirmResend: true } : {}),
    };
  }
  if (input.tag === 'browse') {
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 8_000) {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    return { tag: 'browse', goal: input.goal.trim(), url: httpUrl(input.url) };
  }
  if (input.tag === 'judge') {
    if (!Array.isArray(input.statements) || input.statements.length < 1 || input.statements.length > 12) {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    const statements = input.statements.map((statement) => {
      if (
        !statement ||
        typeof statement.name !== 'string' ||
        !STATEMENT_NAME.test(statement.name) ||
        (RESERVED_STATEMENT_NAMES as readonly string[]).includes(statement.name)
      ) {
        throw new JevRuntimeError('invalid_request', 'invalid_request');
      }
      if (
        typeof statement.statement !== 'string' ||
        !statement.statement.trim() ||
        statement.statement.length > 2_000
      ) {
        throw new JevRuntimeError('invalid_request', 'invalid_request');
      }
      return { name: statement.name, statement: statement.statement.trim() };
    });
    return { tag: 'judge', url: httpUrl(input.url), statements };
  }
  throw new JevRuntimeError('invalid_request', 'invalid_request');
}

function httpUrl(value: unknown): string {
  if (typeof value !== 'string') throw new JevRuntimeError('invalid_request', 'invalid_request');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  }
  return url.toString();
}

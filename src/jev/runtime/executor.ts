// One Jev runtime for a HUD home: browser jobs, agent instances, the J2 lease
// and operation records. No CLI launcher, role resolver, or workflow logic.
// A caller disconnect ends that read only. Close is idempotent and keeps results.

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { Server } from 'node:net';
import { Agent, type BrowserPort } from '../agent.js';
import {
  assertJevLocations,
  loadJevConfig,
  readHudCredentials,
  readHudConfig,
  decisionFallback,
  decisionKeys,
  resolveDecisions,
  type JevConfig,
} from '../ask/config.js';
import { FailoverDecisionProvider, type DecisionCallRecord } from '../failover.js';
import { chromeStart, type ChromeVersion, type ChromeMode } from '../ask/chrome.js';
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
  pythonUniversalNewlines,
  readOperation,
} from '../ask/records.js';
import { Browser, type BrowserAcquisition } from '../browser.js';
import { decideProviderId, type DecisionProvider, type DecisionProviderId } from '../decide.js';
import { RESERVED_STATEMENT_NAMES, awaitStates, type JudgmentProvider, type PageObservation } from '../judge.js';
import { actionSpace, type PageState } from '../model.js';
import { OpenAIDecisionProvider } from '../providers/openai.js';
import { TypeSafeDecisionProvider } from '../providers/typesafe.js';
import { GeminiDecisionProvider } from '../providers/gemini.js';
import { fakeBrowser, fakeProvider } from './fake.js';
import { chatgptTarget, type OracleBrowser } from './chatgpt.js';
import { chatgptStore, runOracle, type OracleTarget } from './oracle.js';
import { aistudioTarget } from './aistudio.js';
import { loadStudioConfig, studioKey, studioStore, type StudioConfig } from './aistudio-state.js';
import { errorBody, jevCall, serveLine } from './ipc.js';
import { failureDiagnostic, type FailureDiagnostic, type ActionDecisionDiagnostic } from './diagnostic.js';
import { recoverableOracleResult } from './types.js';
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

/** One start/probe per endpoint in flight. Never launch an account endpoint with the default profile. */
export class RuntimeChrome {
  private readonly starting = new Map<string, Promise<void>>();
  private readonly modes = new Map<string, ChromeMode>();

  mode(cdpUrl: string): ChromeMode | undefined {
    try {
      return this.modes.get(new URL(cdpUrl).href);
    } catch {
      return undefined;
    }
  }

  constructor(
    private readonly start: typeof chromeStart = chromeStart,
    private readonly fetchVersion: (cdpUrl: string, remainingMs?: number) => Promise<ChromeVersion | null> = (
      cdpUrl,
      remainingMs
    ) => loopbackJson(new URL('/json/version', cdpUrl).href, Math.min(1_000, remainingMs ?? 1_000))
  ) {}

  async ensure(config: JevConfig, cdpUrl: string): Promise<void> {
    assertJevLocations(config);
    let endpoint: string;
    let account: boolean;
    try {
      endpoint = new URL(cdpUrl).href;
      account = endpoint !== new URL(config.cdpUrl).href;
    } catch {
      throw new JevRuntimeError('browser_unavailable', 'browser_unavailable');
    }
    let pending = this.starting.get(endpoint);
    if (!pending) {
      pending = (async () => {
        try {
          if (account) {
            const version = await this.fetchVersion(cdpUrl, config.cdpTimeoutMs);
            if (
              !version ||
              typeof version !== 'object' ||
              !('webSocketDebuggerUrl' in version) ||
              typeof version.webSocketDebuggerUrl !== 'string' ||
              !version.webSocketDebuggerUrl
            )
              throw new Error('account_unavailable');
          } else {
            const started = await this.start(config, 'headless', {
              reuseAnyMode: true,
              fetchVersion: this.fetchVersion,
            });
            this.modes.set(endpoint, started.mode);
          }
        } catch {
          throw new JevRuntimeError(
            'browser_unavailable',
            account ? 'browser_unavailable: account' : 'browser_unavailable'
          );
        }
      })();
      this.starting.set(endpoint, pending);
    }
    try {
      await pending;
    } finally {
      if (this.starting.get(endpoint) === pending) this.starting.delete(endpoint);
    }
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
  fallback?: ResolvedDecision;
}

export interface RuntimeOptions {
  hudHome: string;
  /** Tests pass a temporary directory. Production reads `stateDir` from the HUD config. */
  stateDir?: string;
  /** Internal test/child plumbing: all four locations are explicit or all come from JSON. */
  cdpUrl?: string;
  chrome?: string;
  profile?: string;
  graceMs?: number;
  /** Child entry sets this. An in-process runtime must leave it false. */
  exitProcess?: boolean;
  /** Test and opt-in process stand-in. Production leaves this unset. */
  fake?: boolean;
  now?: () => number;
  browserFactory?: (url: string) => Promise<BrowserPort> | BrowserPort;
  providerFactory?: (resolved: ResolvedDecision) => Promise<DecisionProvider> | DecisionProvider;
  askTargets?: Partial<Record<'chatgpt-pro' | 'aistudio', AskTarget>>;
  /** Synthetic target seam; production always constructs the owned adapters. */
  oracleTargets?: Partial<Record<'chatgpt-pro' | 'aistudio', OracleTarget>>;
  oracleReadTimeoutMs?: number;
  oracleNow?: () => number;
  oracleSleep?: (ms: number) => Promise<void>;
  studioConfigLoader?: () => StudioConfig;
  /** Tests inject a complete config. Production resolves only this runtime's HUD JSON config. */
  configLoader?: () => { stateDir: string; cdpUrl: string; chrome?: string; profile?: string };
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
  askStateDir?: string;
  /** Original primary binding, private and immutable across per-call fallback. */
  decisionBinding?: { provider: JevDecisionId; model: string };
  provider: { id: JevDecisionId; model: string } | null;
  decisionCalls?: DecisionCallRecord[];
  state: JevJobState;
  closed: boolean;
  seq: number;
  result: unknown;
  error?: { code: string; message: string; variable?: string };
  /** Private, finite diagnostic metadata; never raw thrown messages. */
  failureDiagnostic?: FailureDiagnostic;
  phase?: string;
  createdAt: string;
  run: { startedAt: string; endedAt?: string } | null;
}

const pendingTarget = (id: 'chatgpt-pro' | 'aistudio'): AskTarget => ({ id, sends: false });

export class JevRuntime implements JevExecutor {
  readonly hudHome: string;
  stateDir = '';
  cdpUrl = '';
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
  private readonly oracleCleanups = new Set<Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly followUps = new Set<string>();
  private readonly keys = new Map<string, Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly targets: Record<'chatgpt-pro' | 'aistudio', AskTarget>;
  private askConfig: Partial<ReturnType<typeof loadJevConfig>> = {};
  private server?: Server;
  private runtimeLease?: HeldLease;
  private graceTimer?: NodeJS.Timeout;
  private writers = 0;
  private stopping = false;
  private started = false;
  private config?: JevConfig;
  private readonly chrome = new RuntimeChrome();

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
      this.lifecycle('start');
      this.armGrace();
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async stop(reason = 'explicit'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.lifecycle('stop', reason);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    for (const abort of this.aborts.values()) abort.abort();
    for (const browser of this.browsers) await Promise.resolve(browser.close()).catch(() => undefined);
    this.browsers.clear();
    for (const agent of this.agents.values()) await agent.close().catch(() => undefined);
    this.agents.clear();
    await Promise.allSettled([...this.runs.values()]);
    // Job abortion schedules ownership cleanup. Drain it on every stop path,
    // including signals, not just idle. Each task has its own finite deadline.
    while (this.oracleCleanups.size) await Promise.allSettled([...this.oracleCleanups]);
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
    // this HUD home's own `jev` section. Explicit test plumbing never mixes with JSON.
    this.config = [this.options.stateDir, this.options.cdpUrl, this.options.chrome, this.options.profile].some(
      (value) => value !== undefined
    )
      ? loadJevConfig({
          configJson: {
            jev: {
              stateDir: this.options.stateDir,
              cdpUrl: this.options.cdpUrl,
              chrome: this.options.chrome,
              profile: this.options.profile,
            },
          },
          capturedEnv: process.env,
        })
      : this.options.configLoader
        ? loadJevConfig({ configJson: { jev: this.options.configLoader() }, capturedEnv: process.env })
        : loadRuntimeConfig(this.hudHome);
    // R4 reads ask defaults (model, effortWord, cdpTimeoutMs, providerRoot) from the same config.
    this.askConfig = this.config;
    this.stateDir = this.config.stateDir;
    this.cdpUrl = this.config.cdpUrl;
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
    let count = this.oracleCleanups.size;
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' || job.state === 'running' || this.agents.has(job.id)) count += 1;
    }
    return count;
  }

  async createJob(request: JevCreateRequest): Promise<JevJob> {
    const parsed = parseCreate(request);
    const requestFingerprint = fingerprintOf(parsed.input);
    return this.withKey(parsed.requestKey, async () => {
      const existing = this.byKey(parsed.requestKey);
      if (existing) {
        if (
          existing.session.namespace !== parsed.session.namespace ||
          existing.session.sessionId !== parsed.session.sessionId
        ) {
          throw new JevRuntimeError('association_conflict', 'association_conflict');
        }
        if (existing.fingerprint !== requestFingerprint) {
          throw new JevRuntimeError('conflict', 'conflict');
        }
        return this.view(existing);
      }
      const resolved = this.resolveDecision(parsed.jevDecisions);
      let askStateDir: string | undefined;
      if (
        parsed.input.tag === 'ask' &&
        parsed.input.target === 'chatgpt-pro' &&
        (!this.options.fake || this.options.oracleTargets?.['chatgpt-pro'])
      ) {
        parsed.input.model ??= this.askConfig.model ?? 'GPT-6';
        parsed.input.effortWord ??= this.askConfig.effortWord ?? 'Pro';
      }
      if (
        parsed.input.tag === 'ask' &&
        parsed.input.target === 'aistudio' &&
        (!this.options.fake || this.options.oracleTargets?.aistudio)
      ) {
        const config = this.studioConfig();
        parsed.input.model ??= config.model;
        parsed.input.thinking ??= config.thinking;
        parsed.input.conversation ??= 'new';
        askStateDir = config.stateDir;
      }
      const job: StoredJob = {
        executor: 'jev',
        id: `jev-${randomUUID()}`,
        requestKey: parsed.requestKey,
        fingerprint: requestFingerprint,
        session: parsed.session,
        tag: parsed.input.tag,
        input: parsed.input,
        decisionProfile: parsed.jevDecisions?.id ?? null,
        ...(askStateDir ? { askStateDir } : {}),
        decisionBinding: { provider: resolved.id, model: resolved.model },
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
    if (
      options.resume &&
      !this.stopping &&
      (current.state === 'interrupted' || (current.state === 'completed' && recoverableOracleResult(current.result))) &&
      current.input.tag === 'ask' &&
      !current.closed &&
      !this.runs.has(jobId)
    ) {
      const key =
        current.input.target === 'chatgpt-pro'
          ? askRecordKey('chatgpt-pro', current.input.label, current.input.prompt)
          : studioKey(
              current.input.label,
              current.input.prompt,
              current.input.model ?? '',
              current.input.thinking ?? '',
              current.input.conversation ?? 'new'
            );
      const record =
        current.input.target === 'chatgpt-pro'
          ? readOperation(this.stateDir, key)
          : await studioStore(current.askStateDir ?? this.studioConfig().stateDir, key).read();
      // Aggregate reads await flock. Revalidate admission after close/stop or another
      // resume may have completed while that read was pending.
      if (
        !current.closed &&
        !this.stopping &&
        (current.state === 'interrupted' ||
          (current.state === 'completed' && recoverableOracleResult(current.result))) &&
        !this.runs.has(jobId) &&
        (record?.send_attempted === true || record?.attempted_at)
      ) {
        let binding = current.decisionBinding;
        if (!binding) {
          const fallbackAudit = current.decisionCalls?.some(
            (call) => call.fallbackReason !== undefined || call.primary !== call.provider
          );
          if (fallbackAudit || !current.provider) {
            throw new JevRuntimeError(
              'decision_binding_missing',
              `job ${current.id}: decision_binding_missing; a new ask is required`
            );
          }
          // Pre-A0 receipts recorded their original primary in provider. Capture
          // that binding before a newly resumed call can update actual responder.
          binding = { provider: current.provider.id, model: current.provider.model };
        }
        const resolved = this.resolveDecision(binding);
        if (!current.decisionBinding) {
          current.decisionBinding = { provider: resolved.id, model: resolved.model };
          this.save(current);
        }
        const task = this.execute(current, resolved, true);
        this.runs.set(current.id, task);
      }
    }
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
    // Closing ends observation, not the persisted send. Keep the attempted key
    // and an honest recovery outcome even when close interrupted confirmation.
    if (job.state === 'closed' && job.input.tag === 'ask' && job.result === null) {
      const input = job.input;
      const key =
        input.target === 'chatgpt-pro'
          ? askRecordKey('chatgpt-pro', input.label, input.prompt)
          : studioKey(input.label, input.prompt, input.model ?? '', input.thinking ?? '', input.conversation ?? 'new');
      const record =
        input.target === 'chatgpt-pro'
          ? readOperation(this.stateDir, key)
          : await studioStore(job.askStateDir ?? this.studioConfig().stateDir, key).read();
      if (record?.send_attempted === true || record?.attempted_at) {
        job.result = { status: 'uncertain', key, recoverable: true, reason: 'observation_closed' };
        this.save(job);
      }
    }
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
      if (method === 'createJob') {
        // SAFETY: createJob validates every untrusted field through parseCreate before using it.
        const request = args as unknown as JevCreateRequest;
        return await this.createJob(request);
      }
      if (method === 'readJob') {
        const jobId = typeof args.jobId === 'string' ? args.jobId : '';
        const waitMs = cappedReadWaitMs(typeof args.waitMs === 'number' ? args.waitMs : undefined);
        const afterSeq = typeof args.afterSeq === 'number' ? args.afterSeq : undefined;
        return await this.readJob(jobId, { waitMs, afterSeq, signal, resume: args.resume === true });
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

  private async execute(job: StoredJob, resolved: ResolvedDecision, resumeOnly = false): Promise<void> {
    if (job.closed || this.stopping) return;
    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    this.markRunning(job);
    try {
      const provider = await this.providerFor(resolved, job);
      if (job.closed || this.stopping || abort.signal.aborted) return;
      if (job.input.tag === 'ask') await this.runAsk(job, provider, abort.signal, resumeOnly);
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

  private async runAsk(
    job: StoredJob,
    provider: DecisionProvider,
    signal: AbortSignal,
    resumeOnly = false
  ): Promise<void> {
    if (job.input.tag !== 'ask') return;
    if (job.input.target === 'aistudio' && (this.options.oracleTargets?.aistudio || !this.options.fake)) {
      const input = job.input;
      const config = this.studioConfig();
      const stateDir = job.askStateDir ?? config.stateDir;
      const model = input.model ?? config.model;
      const thinking = input.thinking ?? config.thinking;
      const key = studioKey(input.label, input.prompt, model, thinking, input.conversation ?? 'new');
      const cdp = { cdpUrl: config.cdpUrl ?? this.cdpUrl, timeoutMs: this.askConfig.cdpTimeoutMs };
      const target =
        this.options.oracleTargets?.aistudio ??
        aistudioTarget({
          config,
          model,
          thinking,
          open: async (url, acquisition) =>
            this.options.browserFactory
              ? ((await this.options.browserFactory(url)) as OracleBrowser)
              : this.openSharedBrowser(url, cdp.cdpUrl, acquisition),
          attach: (id, acquisition) => Browser.attach(id, { ...cdp, ...acquisition }),
          targets: () => Browser.targets(cdp),
          now: this.options.oracleNow,
          sleep: this.options.oracleSleep,
          readTimeoutMs: this.options.oracleReadTimeoutMs,
        });
      const result = await runOracle({
        stateDir,
        key,
        jobId: job.id,
        input,
        target,
        store: studioStore(stateDir, key, { signal }),
        provider,
        signal,
        resumeOnly,
        now: this.options.oracleNow,
        sleep: this.options.oracleSleep,
        readTimeoutMs: this.options.oracleReadTimeoutMs,
        phase: (phase) => this.oraclePhase(job, phase),
        diagnostic: (code, error) => this.oracleDiagnostic(job, code, error),
        retainCleanup: (task) => this.retainOracleCleanup(task),
        cleanup: (step, elapsedMs, code) => this.lifecycle('phase', `cleanup.${step}.${code}`, job.id, { elapsedMs }),
        timing: (step, elapsedMs) => this.lifecycle('phase', `collect.${step}`, job.id, { elapsedMs }),
        fields: {
          key,
          label: input.label,
          provider: 'aistudio',
          model,
          thinking,
          hud_association: job.session,
          prompt_sha256: promptSha256(pythonUniversalNewlines(input.prompt)),
          parent_conversation: null,
          conversation_url: input.conversation && input.conversation !== 'new' ? input.conversation : null,
        },
      });
      this.complete(job, result);
      return;
    }
    if (
      job.input.target === 'chatgpt-pro' &&
      (this.options.oracleTargets?.['chatgpt-pro'] || (!this.options.fake && !this.options.askTargets?.['chatgpt-pro']))
    ) {
      const input = { ...job.input, prompt: pyStrip(pythonUniversalNewlines(job.input.prompt)) };
      const key = askRecordKey('chatgpt-pro', input.label, input.prompt);
      const options = { cdpUrl: this.cdpUrl, timeoutMs: this.askConfig.cdpTimeoutMs };
      const target =
        this.options.oracleTargets?.['chatgpt-pro'] ??
        chatgptTarget({
          root: this.askConfig.providerRoot,
          diagnostic: (phase, verdict, calls, elapsedMs) =>
            this.lifecycle('phase', `${phase}.${verdict}`, job.id, { calls, elapsedMs }),
          decisionDiagnostic: (decision) => this.lifecycle('phase', 'decision', job.id, { decision }),
          model: this.askConfig.model,
          effortWord: this.askConfig.effortWord,
          open: async (url, acquisition) =>
            this.options.browserFactory
              ? ((await this.options.browserFactory(url)) as OracleBrowser)
              : this.openSharedBrowser(url, this.cdpUrl, acquisition),
          attach: (id, acquisition) => Browser.attach(id, { ...options, ...acquisition }),
          targets: () => Browser.targets(options),
          now: this.options.oracleNow,
          sleep: this.options.oracleSleep,
          readTimeoutMs: this.options.oracleReadTimeoutMs,
        });
      const result = await runOracle({
        stateDir: this.stateDir,
        key,
        jobId: job.id,
        input,
        target,
        store: chatgptStore(this.stateDir, key),
        provider,
        signal,
        resumeOnly,
        now: this.options.oracleNow,
        sleep: this.options.oracleSleep,
        readTimeoutMs: this.options.oracleReadTimeoutMs,
        phase: (phase) => this.oraclePhase(job, phase),
        diagnostic: (code, error) => this.oracleDiagnostic(job, code, error),
        retainCleanup: (task) => this.retainOracleCleanup(task),
        cleanup: (step, elapsedMs, code) => this.lifecycle('phase', `cleanup.${step}.${code}`, job.id, { elapsedMs }),
        fields: {
          key,
          provider: 'chatgpt',
          hud_association: job.session,
          prompt_sha256: promptSha256(input.prompt),
          squashed_sha256: squashedSha256(input.prompt),
          conversation: input.conversation ?? 'new',
          effort: input.effortWord ?? this.askConfig.effortWord ?? 'Pro',
          ...(input.attach
            ? {
                attachment: basename(input.attach),
                // Recovery observes the committed bytes; it never needs the original upload file.
                attachment_sha256: resumeOnly
                  ? readOperation(this.stateDir, key)?.attachment_sha256
                  : createHash('sha256').update(readFileSync(input.attach)).digest('hex'),
              }
            : {}),
        },
      });
      this.complete(job, result);
      return;
    }
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

  private studioConfig(): StudioConfig {
    return this.options.studioConfigLoader
      ? this.options.studioConfigLoader()
      : loadStudioConfig({ configJsonPath: join(this.hudHome, 'config.json') });
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

  private async openSharedBrowser(
    url: string,
    cdpUrl = this.cdpUrl,
    acquisition?: BrowserAcquisition
  ): Promise<Browser> {
    const config = this.config;
    if (!config) throw new JevRuntimeError('browser_unavailable', 'browser_unavailable');
    acquisition?.signal?.throwIfAborted();
    await this.chrome.ensure(config, cdpUrl);
    const browser = await Browser.open(url, { cdpUrl, timeoutMs: config.cdpTimeoutMs, ...acquisition });
    browser.mode = this.chrome.mode(cdpUrl);
    return browser;
  }

  private async closeBrowser(browser: BrowserPort): Promise<void> {
    this.browsers.delete(browser);
    await Promise.resolve(browser.close()).catch(() => undefined);
  }

  private async providerFor(resolved: ResolvedDecision, job: StoredJob): Promise<DecisionProvider> {
    const make = async (value: ResolvedDecision): Promise<DecisionProvider | undefined> => {
      if (!value.apiKey) return undefined;
      if (this.options.providerFactory) return this.options.providerFactory(value);
      if (this.options.fake) return { ...fakeProvider(), id: value.id, model: value.model };
      if (value.id === 'gemini') return new GeminiDecisionProvider({ apiKey: value.apiKey });
      return value.id === 'openai'
        ? new OpenAIDecisionProvider({ apiKey: value.apiKey, baseUrl: value.baseUrl })
        : new TypeSafeDecisionProvider({ apiKey: value.apiKey, model: value.model });
    };
    return new FailoverDecisionProvider(
      resolved.id,
      await make(resolved),
      resolved.fallback ? await make(resolved.fallback) : undefined,
      (entry) => {
        if (entry.outcome === 'answered') job.provider = { id: entry.provider, model: entry.model };
        job.decisionCalls = [...(job.decisionCalls ?? []), entry].slice(-100);
        job.seq += 1;
        this.save(job);
      }
    );
  }

  private resolveDecision(profile: JevCreateRequest['jevDecisions']): ResolvedDecision {
    const explicit = profile?.provider;
    if (explicit !== undefined && explicit !== 'gemini' && explicit !== 'typesafe' && explicit !== 'openai') {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
    const creds = readHudCredentials(process.env, this.hudHome);
    const config = resolveDecisions(readHudConfig(join(this.hudHome, 'config.json')));
    const primary = explicit ?? config.primary;
    const make = (id: DecisionProviderId, primaryModel?: string | null): ResolvedDecision =>
      id === 'gemini' ? { id, model: 'gemini-decision-1', apiKey: creds.geminiApiKey ?? '' } : id === 'openai'
        ? {
            id,
            model: 'gpt-6-luna',
            apiKey: creds.openaiApiKey ?? '',
            baseUrl: config.openai.baseUrl || creds.openaiBaseUrl,
          }
        : {
            id,
            model: primaryModel || config.typesafe.model || creds.typesafeModel || 'jev-latest',
            apiKey: creds.typesafeApiKey ?? '',
          };
    // A profile/stored model binds only its primary. Never carry a model name
    // across providers; fallback model/endpoint selection remains config-bound.
    const resolved = make(primary, profile?.model);
    const fallbackId = decisionFallback(config, creds, primary);
    if (fallbackId) {
      const fallback = make(fallbackId);
      if (fallback.apiKey) resolved.fallback = fallback;
    }
    if (!resolved.apiKey && !resolved.fallback) {
      const decision = decideProviderId(primary, decisionKeys(creds));
      throw new JevRuntimeError(
        'jev_credentials_missing',
        'jev_credentials_missing',
        !decision.ok ? decision.variable : undefined
      );
    }
    return resolved;
  }

  private markRunning(job: StoredJob): void {
    if (job.closed) return;
    job.state = 'running';
    delete job.error;
    delete job.failureDiagnostic;
    job.phase = 'execute';
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

  private oraclePhase(job: StoredJob, phase: string): void {
    job.phase = phase;
    this.lifecycle('phase', phase, job.id);
  }

  private oracleDiagnostic(job: StoredJob, code: string, error: unknown): void {
    job.failureDiagnostic = failureDiagnostic(error, job.phase ?? 'execute');
    this.lifecycle('phase', code, job.id, { diagnostic: job.failureDiagnostic });
  }

  private fail(job: StoredJob, error: unknown): void {
    if (job.closed) return;
    const body = errorBody(error);
    job.failureDiagnostic = failureDiagnostic(error, job.phase ?? 'execute');
    this.lifecycle('phase', `failed.${body.code}`, job.id, { diagnostic: job.failureDiagnostic });
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
      let parsed: StoredJob;
      try {
        parsed = JSON.parse(readFileSync(join(this.jobsDir, name), 'utf8')) as StoredJob;
      } catch (error) {
        // Do not silently replace a corrupt receipt, or infer permission to send from it.
        throw error;
      }
      if (parsed.state === 'queued' || parsed.state === 'running') {
        parsed.state = 'interrupted';
        parsed.error = { code: 'interrupted', message: 'interrupted' };
        parsed.run = parsed.run ? { ...parsed.run, endedAt: this.stamp() } : null;
        parsed.seq += 1;
        this.lifecycle('phase', 'interrupted', parsed.id);
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

  /** Bounded diagnostics: only lifecycle codes and synthetic/opaque job ids. */
  lifecycle(
    event: 'start' | 'stop' | 'phase' | 'exit',
    code = '',
    jobId = '',
    metrics?: {
      calls?: number;
      elapsedMs?: number;
      diagnostic?: FailureDiagnostic;
      decision?: ActionDecisionDiagnostic;
    }
  ): void {
    const safe = (value: string) => (/^[A-Za-z0-9_.:-]{0,100}$/.test(value) ? value : 'internal');
    try {
      const file = join(this.runtimeDir, 'child.err');
      // Keep the inode: the detached entry's stderr is already open with O_APPEND.
      if (existsSync(file) && statSync(file).size > 131_072) {
        const tail = readFileSync(file).subarray(-65_536).toString('utf8');
        writeFileSync(file, tail.slice(tail.indexOf('\n') + 1), { mode: 0o600 });
      }
      const version = createHash('sha256')
        .update(readFileSync(new URL('./executor.js', import.meta.url)))
        .digest('hex')
        .slice(0, 12);
      appendFileSync(
        file,
        JSON.stringify({
          at: this.stamp(),
          event,
          pid: process.pid,
          version,
          code: safe(code),
          job: safe(jobId),
          ...(metrics?.calls !== undefined ? { calls: metrics.calls } : {}),
          ...(metrics?.elapsedMs !== undefined ? { elapsedMs: Math.round(metrics.elapsedMs) } : {}),
          ...(metrics?.diagnostic ? { diagnostic: metrics.diagnostic } : {}),
          ...(metrics?.decision ? { decision: metrics.decision } : {}),
        }) + '\n',
        { mode: 0o600 }
      );
    } catch {
      // Diagnostics must never change send/close semantics.
    }
  }

  private writeRuntimeFile(): void {
    const file = join(this.hudHome, 'jev-runtime', 'runtime.json');
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: this.stamp() }) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  private retainOracleCleanup(task: Promise<void>): void {
    this.oracleCleanups.add(task);
    this.armGrace();
    const release = () => {
      this.oracleCleanups.delete(task);
      this.armGrace();
    };
    void task.then(release, release);
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
      void this.stop('idle');
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
      ...(job.decisionCalls ? { decisionCalls: job.decisionCalls } : {}),
      state: job.state,
      closed: job.closed,
      seq: job.seq,
      result: job.result,
      ...(job.tag === 'ask' ? { recoverable: recoverableOracleResult(job.result) } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private stamp(): string {
    return new Date(this.options.now ? this.options.now() : Date.now()).toISOString();
  }
}

/** HUD JSON only; legacy TOML and JEV_ASK_CONFIG are never consulted. */
export function loadRuntimeConfig(hudHome: string): JevConfig {
  return loadJevConfig({
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
  return askKey('chatgpt', label, pyStrip(pythonUniversalNewlines(prompt)));
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
  if (profile.provider !== undefined && profile.provider !== 'gemini' && profile.provider !== 'typesafe' && profile.provider !== 'openai') {
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
      ...parseAskOptions(input),
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

function parseAskOptions(input: Extract<JevJobInput, { tag: 'ask' }>): Partial<typeof input> {
  const options: Partial<typeof input> = {};
  for (const name of ['model', 'thinking', 'effortWord', 'conversation', 'attach'] as const) {
    const value = input[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 4096)
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    options[name] = value;
  }
  if (input.conversation && input.conversation !== 'new') {
    try {
      const url = new URL(httpUrl(input.conversation));
      if (
        url.username ||
        url.password ||
        url.hostname !== (input.target === 'chatgpt-pro' ? 'chatgpt.com' : 'aistudio.google.com')
      )
        throw new JevRuntimeError('invalid_request', 'invalid_request');
    } catch {
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    }
  }
  if (input.attach && (input.target !== 'chatgpt-pro' || !input.attach.startsWith('/')))
    throw new JevRuntimeError('unsupported_attachment', 'unsupported_attachment');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')
    throw new JevRuntimeError('invalid_request', 'invalid_request');
  if (input.dryRun) options.dryRun = true;
  if (input.maxWaitMs !== undefined) {
    if (!Number.isFinite(input.maxWaitMs) || input.maxWaitMs < 1 || input.maxWaitMs > 14_400_000)
      throw new JevRuntimeError('invalid_request', 'invalid_request');
    options.maxWaitMs = input.maxWaitMs;
  }
  return options;
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

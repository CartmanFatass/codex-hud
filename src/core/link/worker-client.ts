import { Worker } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { sessionRefKey } from '../identity.js';
import { existingHudHome } from './home.js';
import { DelegationFreshness } from './freshness.js';
import { validWorkerFatal, validLifecycles, resultWireUpperBound } from './worker-control.js';
import { validWorkerEnvelope } from './worker-envelope.js';
import { decodeView } from './worker-codec.js';
import {
  monotonicNow,
  ROOT_READ_BYTES,
  WORKER_PROTOCOL,
  WORKER_RESOURCE_LIMITS,
  WORKER_PAYLOAD_LIMIT,
  type RootReadCharge,
  type WorkerOperation,
  type WorkerOutput,
  type WorkerResult,
  type WorkerStartup,
  type WorkerStageTimes,
} from './worker-protocol.js';
import type { ReaderBudget } from '../interfaces/harness-adapter.js';
import type { DelegationViewModel } from './view-model.js';

interface Pending {
  scope: string | null;
  scopeEpoch: number;
  requestId: number;
  enqueuedAt: number;
  superseded: number;
}
export type WorkerBuildScope = Readonly<{ scope: string | null; epoch: number }>;
export interface LegacyGrant {
  readonly token: object;
  readonly requestId: number;
  readonly budget: ReaderBudget;
  readonly deadlineAt: number;
}
export interface WorkerPaintSample {
  requestId: number;
  scopeEpoch: number;
  outcome: 'delivered' | 'continued' | 'rejected' | 'failed' | 'worker_exit' | 'cancelled';
  superseded: number;
  serializationMs: number;
  ipcMs: number;
  decodeMs: number;
  renderMs: number | null;
  b9Ms: number;
  wiringMs: number;
  stages: WorkerStageTimes | null;
  readGrant: { key: string; kind: 'session' | 'native_topology'; waitMs: number } | null;
  eligibleBacklog: number;
  oldestEligibleWaitMs: number;
  operationMs: number;
  paintMs: number | null;
  queueMs: number;
  workerMs: number;
  rootMs: number;
  requestToCommitMs: number | null;
  commitToPaintLowerMs: number | null;
  commitToPaintUpperMs: number | null;
  bytesRead: number;
  payloadBytes: number;
  commits: { refKey: string; commitSeq: number }[];
  lifecycles: { refKey: string; reason: string }[];
  publication: boolean;
  changed: boolean;
  error: string | null;
  presentationReason?: 'hidden_settings' | 'hidden_activity' | 'hidden_observability';
  workerStatsUnknown?: boolean;
  outcomeAccountingComplete?: boolean;
}
interface ClientOptions {
  onResult?: () => void;
  onHealth?: (reason: string) => void;
  onSample?: (sample: WorkerPaintSample) => void;
}
interface TestOptions extends ClientOptions {
  testModule: string;
  testData?: unknown;
}

/** Main-thread transport owner only. No native reader, observation store or writer is imported here. */
export class DelegationWorkerClient {
  private worker: Worker | null = null;
  private incarnation = '';
  private ready = false;
  private exited = true;
  private closed = false;
  private replacements = 0;
  private quarantined = false;
  private quarantineTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalFatalRequest: number | null = null;
  private scope: string | null | undefined;
  private scopeEpoch = 0;
  private buildScope: WorkerBuildScope | null = null;
  private sequence = 0;
  private revision = -1;
  private forceFull = false;
  private active: WorkerOperation | null = null;
  private pending: Pending | null = null;
  private rootGrant: { grant: LegacyGrant; request: Pending; activatedAt: number; incarnation: string } | null = null;
  private incoming: WorkerResult | null = null;
  private receivedAt = 0;
  private decodedAt = 0;
  private base: DelegationViewModel | null = null;
  private freshness = new DelegationFreshness();
  private paintIdentities = new WeakMap<
    DelegationViewModel,
    { incarnation: string; scopeEpoch: number; revision: number }
  >();
  private history: WorkerPaintSample[] = [];
  private completed = 0;
  private error: string | null = 'observation_worker_initializing';
  private stickyFailure: string | null = null;
  private lastResources: WorkerResult['resources'] | null = null;
  private lastStats: WorkerResult['stats'] = null;
  private freshnessTimer: ReturnType<typeof setTimeout> | null = null;
  private freshnessDue = Infinity;
  private shutdownState: { dirty: boolean; lifecycleOutcomes: { refKey: string; reason: string }[] } | null = null;
  private closeDone: (() => void) | null = null;
  private startedAt = monotonicNow();
  private firstPaintAt: number | null = null;
  private closePromise: Promise<{ dirty: boolean; elapsedMs: number }> | null = null;
  private constructor(
    readonly home: string,
    readonly ambientHome: string | undefined,
    private readonly options: ClientOptions,
    private readonly test?: Pick<TestOptions, 'testModule' | 'testData'>
  ) {
    this.spawn();
  }
  static open(
    env: Readonly<Record<string, string | undefined>> = process.env,
    ambientHome?: string,
    options: ClientOptions = {}
  ): DelegationWorkerClient | null {
    const home = existingHudHome(env);
    if (!home) return null;
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major >= 24 || (major === 22 && minor >= 13))) {
      options.onHealth?.('observation_worker_runtime_unsupported');
      return null;
    }
    return new DelegationWorkerClient(home, ambientHome, options);
  }
  /** Explicit test constructor only; production open() accepts no bootstrap/config/environment test switch. */
  static forTesting(
    env: Readonly<Record<string, string | undefined>>,
    ambientHome: string,
    options: TestOptions
  ): DelegationWorkerClient {
    const home = existingHudHome(env);
    if (!home) throw new Error('test_worker_home_unavailable');
    return new DelegationWorkerClient(home, ambientHome, options, {
      testModule: options.testModule,
      testData: options.testData,
    });
  }
  private fail(reason: string, sticky = false) {
    this.error = reason;
    if (sticky) this.stickyFailure = reason;
    this.options.onHealth?.(reason);
  }
  private spawn() {
    if (this.closed || !this.exited) return;
    this.incarnation = randomUUID();
    this.quarantined = false;
    this.terminalFatalRequest = null;
    this.ready = false;
    this.exited = false;
    this.revision = -1;
    const incarnation = this.incarnation;
    const startup: WorkerStartup = {
      version: WORKER_PROTOCOL,
      incarnation,
      hudHome: this.home,
      ambientHome: this.ambientHome,
      ...this.test,
    };
    try {
      const worker = new Worker(new URL('./worker-entry.js', import.meta.url), {
        workerData: startup,
        resourceLimits: WORKER_RESOURCE_LIMITS,
      });
      this.worker = worker;
      worker.unref();
      worker.on('message', (message: WorkerOutput) => {
        if (incarnation === this.incarnation) this.message(message);
      });
      worker.on('error', (error) => this.fail(`observation_worker_error:${error.message}`));
      worker.on('exit', () => {
        if (incarnation !== this.incarnation) return;
        if (this.quarantineTimer) clearTimeout(this.quarantineTimer);
        this.quarantineTimer = null;
        this.exited = true;
        this.ready = false;
        this.worker = null;
        if (!this.closed) {
          this.fail('observation_worker_exited', true);
          if (this.incoming) this.consume('worker_exit', false);
          else if (this.active)
            this.record({
              requestId: this.active.requestId,
              scopeEpoch: this.active.scopeEpoch,
              outcome: 'worker_exit',
              superseded: this.active.superseded,
              serializationMs: 0,
              ipcMs: 0,
              decodeMs: 0,
              renderMs: null,
              b9Ms: 0,
              wiringMs: 0,
              stages: null,
              readGrant: null,
              eligibleBacklog: 0,
              oldestEligibleWaitMs: 0,
              operationMs: monotonicNow() - this.active.enqueuedAt,
              paintMs: null,
              queueMs: 0,
              workerMs: 0,
              rootMs: this.active.root.elapsedMs,
              requestToCommitMs: null,
              commitToPaintLowerMs: null,
              commitToPaintUpperMs: null,
              bytesRead: this.active.root.bytesRead,
              payloadBytes: 0,
              commits: [],
              lifecycles: [],
              publication: false,
              changed: false,
              error: 'observation_worker_exited',
              workerStatsUnknown: true,
              outcomeAccountingComplete: false,
            });
          this.active = null;
          // An admitted asynchronous root read remains occupied until its actual charges return.
          this.incoming = null;
        }
        this.closeDone?.();
      });
    } catch (error) {
      this.exited = true;
      this.worker = null;
      this.fail(error instanceof Error ? error.message : 'observation_worker_start_failed', true);
    }
  }
  /** Called only by the normal collection cadence, never by a resize/clock/result repaint. */
  beginCollection(scope: string | undefined): LegacyGrant | null {
    if (this.closed) return null;
    this.invalidateScope(scope);
    const nextScope = scope ?? null;
    if (this.exited && this.replacements < 1) {
      this.replacements++;
      this.spawn();
    }
    const request: Pending = {
      scope: nextScope,
      scopeEpoch: this.scopeEpoch,
      requestId: ++this.sequence,
      enqueuedAt: monotonicNow(),
      superseded: 0,
    };
    if (!this.ready || this.active || this.rootGrant || this.incoming || this.exited) {
      this.coalesce(request);
      return null;
    }
    if (this.pending) {
      this.coalesce(request);
      this.dispatchPending();
      return null;
    }
    const activatedAt = monotonicNow();
    const grant: LegacyGrant = Object.freeze({
      token: Object.freeze({}),
      requestId: request.requestId,
      budget: Object.freeze({ maxBytes: ROOT_READ_BYTES, maxRecords: 2000, budgetMs: 20 }),
      deadlineAt: activatedAt + 40,
    });
    this.rootGrant = { grant, request, activatedAt, incarnation: this.incarnation };
    return grant;
  }
  /** Scope invalidation never creates a reader opportunity or grants a new budget. */
  invalidateScope(scope: string | undefined): void {
    const nextScope = scope ?? null;
    if (nextScope === this.scope) return;
    this.scope = nextScope;
    this.scopeEpoch++;
    this.buildScope = Object.freeze({ scope: nextScope, epoch: this.scopeEpoch });
    this.base = null;
    this.revision = -1;
    this.freshness.current(null, Date.now());
    // Keep an admitted obsolete legacy slice occupied until its actual read charges return.
    // Invalidation creates no replacement opportunity and never reuses that token for a new scope.
    if (this.pending) this.pending = { ...this.pending, scope: nextScope, scopeEpoch: this.scopeEpoch };
  }
  collectionScope(): WorkerBuildScope | null {
    return this.buildScope;
  }
  scopeIsCurrent(scope: WorkerBuildScope | null): boolean {
    return scope !== null && scope === this.buildScope && !this.closed;
  }
  legacyGrantIsCurrent(grant: LegacyGrant): boolean {
    return (
      !this.closed &&
      !this.exited &&
      !this.quarantined &&
      this.rootGrant?.grant === grant &&
      this.rootGrant.request.scopeEpoch === this.scopeEpoch &&
      this.rootGrant.incarnation === this.incarnation
    );
  }
  requestedScope(): string | null | undefined {
    return this.scope;
  }
  private coalesce(request: Pending) {
    if (this.pending) {
      request.enqueuedAt = this.pending.enqueuedAt;
      request.superseded = this.pending.superseded + 1;
    }
    this.pending = request;
  }
  submitLegacy(grant: LegacyGrant, charge: RootReadCharge): boolean {
    const held = this.rootGrant;
    if (this.closed || !held || held.grant !== grant) return false;
    this.rootGrant = null;
    const root = {
      bytesRead: Math.max(0, charge.bytesRead),
      recordsRead: Math.max(0, charge.recordsRead),
      elapsedMs: Math.max(0, charge.elapsedMs),
      failed: charge.failed,
    };
    if (
      root.failed ||
      !Number.isSafeInteger(root.bytesRead) ||
      root.bytesRead > ROOT_READ_BYTES ||
      !Number.isSafeInteger(root.recordsRead) ||
      root.recordsRead > 2000 ||
      !Number.isFinite(root.elapsedMs)
    ) {
      root.bytesRead = ROOT_READ_BYTES;
      root.recordsRead = 2000;
      root.failed = true;
      root.elapsedMs = monotonicNow() - held.activatedAt;
      this.fail('legacy_collection_failed');
    }
    if (this.quarantined || this.exited || held.incarnation !== this.incarnation) {
      this.recordIncomplete(held.request, root, 'observation_worker_legacy_owner_exited', 'failed', {
        workerStatsUnknown: true,
      });
      this.dispatchPending();
      return false;
    }
    if (held.request.scopeEpoch !== this.scopeEpoch) {
      this.recordIncomplete(held.request, root, 'observation_worker_obsolete_legacy_scope', 'rejected');
      this.dispatchPending();
      return false;
    }
    this.dispatch(held.request, root, held.activatedAt, held.grant.deadlineAt);
    return true;
  }
  abandonLegacySlice(): void {
    const held = this.rootGrant;
    if (held)
      this.submitLegacy(held.grant, {
        bytesRead: ROOT_READ_BYTES,
        recordsRead: 2000,
        elapsedMs: monotonicNow() - held.activatedAt,
        failed: true,
      });
  }
  private dispatch(
    request: Pending,
    root: RootReadCharge,
    activatedAt = monotonicNow(),
    deadlineAt = activatedAt + 40
  ) {
    if (this.closed || !this.worker || !this.ready || this.active || this.incoming) {
      this.coalesce(request);
      return;
    }
    const operation: WorkerOperation = {
      type: 'collect',
      version: WORKER_PROTOCOL,
      incarnation: this.incarnation,
      ...request,
      fullView: this.forceFull,
      activatedAt,
      deadlineAt,
      root,
      budget: {
        maxBytes: ROOT_READ_BYTES,
        maxRecords: 2000,
        budgetMs: Math.max(0, Math.min(20, deadlineAt - monotonicNow())),
      },
    };
    this.active = operation;
    this.worker.postMessage(operation);
  }
  private dispatchPending() {
    if (!this.pending || this.closed || !this.ready || this.active || this.rootGrant || this.incoming) return;
    const request = this.pending;
    this.pending = null;
    if (request.scopeEpoch !== this.scopeEpoch) return;
    this.dispatch(request, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
  }
  private message(message: WorkerOutput) {
    if (!message || message.incarnation !== this.incarnation) return;
    if (message.type === 'closed') {
      if (
        typeof message.dirty !== 'boolean' ||
        typeof message.accountingComplete !== 'boolean' ||
        !validLifecycles(message.lifecycleOutcomes) ||
        !Number.isSafeInteger(message.lifecycleCount) ||
        message.lifecycleCount < message.lifecycleOutcomes.length ||
        (message.accountingComplete && message.lifecycleCount !== message.lifecycleOutcomes.length)
      ) {
        this.fail('observation_worker_invalid_close', true);
        return;
      }
      this.shutdownState = {
        dirty: Boolean(this.shutdownState?.dirty) || message.dirty || !message.accountingComplete,
        lifecycleOutcomes: message.lifecycleOutcomes,
      };
      return;
    }
    if (message.type === 'fatal') {
      const valid = validWorkerFatal(message);
      if (valid && message.requestId !== null && message.requestId === this.terminalFatalRequest) return;
      this.fail(valid ? message.error : 'observation_worker_invalid_fatal', true);
      this.quarantined = true;
      this.ready = false;
      this.forceFull = true;
      if (this.active) {
        const matched = valid && message.requestId === this.active.requestId;
        this.recordIncomplete(
          this.active,
          this.active.root,
          valid ? message.error : 'observation_worker_invalid_fatal',
          'failed',
          {
            commits: matched ? message.commits : [],
            lifecycles: matched ? message.lifecycles : [],
            changed: matched && message.commits.length > 0,
            publication: matched && message.commits.length > 0,
            workerStatsUnknown: true,
            outcomeAccountingComplete: matched && message.accountingComplete,
          }
        );
        this.terminalFatalRequest = this.active.requestId;
        this.active = null;
        this.incoming = null;
      }
      if (!this.quarantineTimer) {
        const worker = this.worker;
        this.quarantineTimer = setTimeout(() => {
          this.shutdownState = { dirty: true, lifecycleOutcomes: this.shutdownState?.lifecycleOutcomes ?? [] };
          this.fail('observation_worker_dirty_shutdown', true);
          worker?.unref();
          void worker?.terminate().catch(() => {});
        }, 2000);
        this.quarantineTimer.unref();
      }
      this.worker?.postMessage({ type: 'close', incarnation: this.incarnation });
      return;
    }
    if (this.quarantined) return;
    if (message.type === 'ready') {
      if (this.closed) {
        this.worker?.postMessage({ type: 'close', incarnation: this.incarnation });
        return;
      }
      if (
        !message.limits ||
        Object.entries(WORKER_RESOURCE_LIMITS).some(
          ([key, value]) => message.limits[key as keyof typeof WORKER_RESOURCE_LIMITS] !== value
        )
      ) {
        this.fail('observation_worker_limits', true);
        void this.worker?.terminate();
        return;
      }
      this.ready = true;
      this.error = null;
      this.dispatchPending();
      return;
    }
    if (this.closed || message.type !== 'result') return;
    if (message.requestId !== this.active?.requestId || this.incoming) {
      this.fail('observation_worker_result_identity', true);
      return;
    }
    this.receivedAt = monotonicNow();
    if (!validWorkerEnvelope(message)) {
      const active = this.active!;
      this.fail('observation_worker_invalid_envelope', true);
      this.forceFull = true;
      this.recordIncomplete(active, active.root, 'observation_worker_invalid_envelope_outcome_unknown', 'rejected');
      this.worker?.postMessage({ type: 'ack', incarnation: this.incarnation, requestId: active.requestId });
      this.active = null;
      this.dispatchPending();
      return;
    }
    this.incoming = message;
    this.lastResources = message.resources;
    this.lastStats = message.stats;
    let rejected = false;
    try {
      if (
        message.version !== WORKER_PROTOCOL ||
        message.codec !== 'v8-1' ||
        message.scopeEpoch !== this.scopeEpoch ||
        message.scope !== this.scope
      )
        throw new Error('observation_worker_obsolete_scope');
      if (resultWireUpperBound(message) > WORKER_PAYLOAD_LIMIT) throw new Error('worker_payload_limit');
      if (message.unchanged) {
        if (message.revision !== this.revision) throw new Error('observation_worker_missing_base');
      } else if (message.payload) {
        if (message.revision <= this.revision) throw new Error('observation_worker_revision');
        const view = decodeView(message.payload);
        this.revision = message.revision;
        this.forceFull = false;
        if (view || !message.error) this.base = view;
      } else throw new Error(message.error ?? 'observation_worker_missing_payload');
      if (message.error) this.fail(message.error);
      else this.error = null;
    } catch (error) {
      rejected = true;
      this.forceFull = true;
      message.error = error instanceof Error ? error.message : 'observation_worker_payload_failure';
      this.fail(message.error, true);
    }
    // Release the incoming encoding immediately; samples retain numbers/identities, never full result histories.
    this.decodedAt = monotonicNow();
    message.payload = null;
    if (rejected) {
      this.consume('rejected', false);
      return;
    }
    try {
      this.options.onResult?.();
    } catch {
      this.fail('observation_worker_paint_failed', true);
    }
  }
  current(nowMs = Date.now()): DelegationViewModel | null {
    const view = this.freshness.current(this.base, nowMs);
    if (view)
      this.paintIdentities.set(view, {
        incarnation: this.incarnation,
        scopeEpoch: this.scopeEpoch,
        revision: this.revision,
      });
    const due = this.freshness.nextDeadline();
    if (!this.closed && due !== this.freshnessDue) {
      if (this.freshnessTimer) clearTimeout(this.freshnessTimer);
      this.freshnessDue = due;
      this.freshnessTimer = Number.isFinite(due)
        ? setTimeout(
            () => {
              this.freshnessTimer = null;
              this.freshnessDue = Infinity;
              if (!this.closed) this.options.onResult?.();
            },
            Math.max(1, Math.min(2_147_483_647, due - Date.now()))
          )
        : null;
      this.freshnessTimer?.unref();
    }
    return view;
  }
  nextFreshnessAt(): number {
    return this.freshness.nextDeadline();
  }
  /** Must follow actual frame enqueue, including for unchanged result acknowledgements. */
  painted(view: DelegationViewModel | null): void {
    const proof = view ? this.paintIdentities.get(view) : null;
    if (
      view
        ? !proof ||
          proof.incarnation !== this.incarnation ||
          proof.scopeEpoch !== this.scopeEpoch ||
          proof.revision !== this.revision
        : this.base !== null
    )
      return;
    if (this.incoming && this.incoming.scopeEpoch !== this.scopeEpoch) {
      this.consume('rejected', false);
      return;
    }
    if (this.incoming)
      this.consume(
        this.incoming.error || this.incoming.trace.root.failed
          ? 'failed'
          : this.base?.pendingStatus ||
              this.base?.tree.continuation.some((entry) => ['unloaded', 'native_topology'].includes(entry.reason))
            ? 'continued'
            : 'delivered',
        true
      );
  }
  /** Deliberately hidden panel surfaces consume transport without claiming an observation paint. */
  consumeHidden(
    view: DelegationViewModel | null,
    scope: WorkerBuildScope | null,
    reason: 'settings' | 'activity' | 'observability'
  ): void {
    if (!['settings', 'activity', 'observability'].includes(reason) || !this.scopeIsCurrent(scope) || !this.incoming)
      return;
    const proof = view ? this.paintIdentities.get(view) : null;
    if (
      view
        ? !proof ||
          proof.incarnation !== this.incarnation ||
          proof.scopeEpoch !== this.scopeEpoch ||
          proof.revision !== this.revision
        : this.base !== null
    )
      return;
    if (this.incoming.scopeEpoch !== scope!.epoch) {
      this.consume('rejected', false, reason);
      return;
    }
    const failure = this.incoming.error || this.incoming.trace.root.failed;
    this.consume(failure ? 'failed' : 'continued', false, reason);
  }
  private consume(
    outcome: WorkerPaintSample['outcome'],
    paintOccurred = false,
    hidden?: 'settings' | 'activity' | 'observability'
  ) {
    const result = this.incoming;
    if (!result) return;
    const paintedAt = monotonicNow();
    const commit = result.trace.commits.at(-1);
    const visibleCommit =
      paintOccurred &&
      commit &&
      this.base?.tree.nodes.some((node) => {
        const stamp = node.observation?.statusProjection.observationStamp;
        return (
          stamp &&
          stamp.commitSeq >= commit.commitSeq &&
          stamp.seqDomain === commit.stamp.seqDomain &&
          stamp.sourceGeneration === commit.stamp.sourceGeneration &&
          stamp.runId === commit.stamp.runId &&
          stamp.bindingGeneration === commit.stamp.bindingGeneration &&
          createHash('sha256').update(sessionRefKey(stamp.ref)).digest('hex') === commit.refKey
        );
      });
    if (commit && !visibleCommit && outcome === 'delivered') outcome = 'continued';
    const sample: WorkerPaintSample = {
      requestId: result.requestId,
      scopeEpoch: result.scopeEpoch,
      outcome,
      superseded: result.trace.superseded,
      serializationMs: result.trace.encodedAt - result.trace.postedAt,
      ipcMs: this.receivedAt - result.trace.encodedAt,
      decodeMs: this.decodedAt - this.receivedAt,
      renderMs: paintOccurred ? paintedAt - this.decodedAt : null,
      b9Ms: result.stats?.b9Ms ?? 0,
      wiringMs: result.stats?.wiringMs ?? 0,
      stages: result.trace.stages,
      readGrant: result.stats?.readGrant ?? null,
      eligibleBacklog: result.stats?.eligibleBacklog ?? 0,
      oldestEligibleWaitMs: result.stats?.oldestEligibleWaitMs ?? 0,
      operationMs: paintedAt - result.trace.enqueuedAt,
      paintMs: paintOccurred ? paintedAt - result.trace.postedAt : null,
      queueMs: result.trace.startedAt - result.trace.activatedAt,
      workerMs: result.trace.collectedAt - result.trace.startedAt,
      rootMs: result.trace.root.elapsedMs,
      requestToCommitMs: commit ? commit.returnedAt - result.trace.enqueuedAt : null,
      commitToPaintLowerMs: visibleCommit && commit ? paintedAt - commit.returnedAt : null,
      commitToPaintUpperMs: visibleCommit && commit ? paintedAt - commit.beforeAt : null,
      bytesRead: (result.stats?.bytesRead ?? 0) + result.trace.root.bytesRead,
      payloadBytes: result.resources.payloadBytes,
      lifecycles: result.trace.lifecycles,
      commits: result.trace.commits.map(({ refKey, commitSeq }) => ({ refKey, commitSeq })),
      publication: result.publication.attempted,
      changed: result.publication.changed,
      error: result.error ?? (result.trace.root.failed ? 'legacy_collection_failed' : null),
      ...(hidden ? { presentationReason: `hidden_${hidden}` as const } : {}),
    };
    this.record(sample);
    if (
      outcome === 'delivered' &&
      this.firstPaintAt === null &&
      this.base &&
      this.base.pendingStatus === 0 &&
      this.base.tree.nodes.every(
        (node) =>
          node.identity.kind === 'delegationIntent' ||
          (node.loaded && !!node.observation?.statusProjection.observationStamp)
      )
    )
      this.firstPaintAt = paintedAt;
    if ((sample.paintMs ?? 0) >= 200 || sample.operationMs >= 1000 || (sample.commitToPaintLowerMs ?? 0) >= 200)
      this.fail('observation_worker_performance_unqualified', true);
    this.worker?.postMessage({ type: 'ack', incarnation: this.incarnation, requestId: result.requestId });
    this.incoming = null;
    this.active = null;
    this.dispatchPending();
  }
  private recordIncomplete(
    request: Pending | WorkerOperation,
    root: RootReadCharge,
    error: string,
    outcome: 'cancelled' | 'rejected' | 'failed' = 'cancelled',
    extras: Partial<
      Pick<
        WorkerPaintSample,
        'commits' | 'lifecycles' | 'changed' | 'publication' | 'workerStatsUnknown' | 'outcomeAccountingComplete'
      >
    > = {}
  ) {
    this.record({
      requestId: request.requestId,
      scopeEpoch: request.scopeEpoch,
      outcome,
      superseded: request.superseded,
      operationMs: monotonicNow() - request.enqueuedAt,
      paintMs: null,
      renderMs: null,
      serializationMs: 0,
      ipcMs: 0,
      decodeMs: 0,
      b9Ms: 0,
      wiringMs: 0,
      stages: null,
      readGrant: null,
      eligibleBacklog: 0,
      oldestEligibleWaitMs: 0,
      queueMs: 0,
      workerMs: 0,
      rootMs: root.elapsedMs,
      bytesRead: root.bytesRead,
      payloadBytes: 0,
      requestToCommitMs: null,
      commitToPaintLowerMs: null,
      commitToPaintUpperMs: null,
      commits: [],
      lifecycles: [],
      publication: false,
      changed: false,
      error,
      ...extras,
    });
  }
  private record(sample: WorkerPaintSample) {
    this.completed++;
    this.history.push(sample);
    this.options.onSample?.(sample);
    if (this.history.length > 1000) this.history.shift();
    if (
      this.history.length === 1000 &&
      (this.history.filter((s) => (s.paintMs ?? 0) >= 50).length > 10 ||
        this.history.filter((s) => s.operationMs >= 100).length > 10)
    )
      this.fail('observation_worker_rolling_window_failed', true);
  }
  diagnostics() {
    return {
      ready: this.ready,
      quarantined: this.quarantined,
      workers: this.exited ? 0 : 1,
      replacements: this.replacements,
      active: this.active || this.rootGrant ? 1 : 0,
      pending: this.pending ? 1 : 0,
      unconsumed: this.incoming ? 1 : 0,
      error: this.error,
      qualificationFailure: this.stickyFailure,
      performanceFailure:
        this.stickyFailure?.includes('performance') || this.stickyFailure?.includes('rolling_window')
          ? this.stickyFailure
          : null,
      resources: this.lastResources,
      stats: this.lastStats,
      firstConsistentPaintMs: this.firstPaintAt === null ? null : this.firstPaintAt - this.startedAt,
      lastSample: this.history.at(-1) ?? null,
      completed: this.completed,
      shutdown: this.shutdownState,
    };
  }
  samples(): readonly WorkerPaintSample[] {
    return this.history;
  }
  close(): Promise<{ dirty: boolean; elapsedMs: number }> {
    if (this.closePromise) return this.closePromise;
    const started = monotonicNow();
    this.closed = true;
    if (this.freshnessTimer) clearTimeout(this.freshnessTimer);
    if (this.pending)
      this.recordIncomplete(
        this.pending,
        { bytesRead: 0, recordsRead: 0, elapsedMs: 0 },
        'observation_pending_cancelled_on_close'
      );
    this.pending = null;
    if (this.rootGrant)
      this.recordIncomplete(
        this.rootGrant.request,
        {
          bytesRead: ROOT_READ_BYTES,
          recordsRead: 2000,
          elapsedMs: monotonicNow() - this.rootGrant.activatedAt,
          failed: true,
        },
        'observation_legacy_cancelled_on_close'
      );
    this.rootGrant = null;
    if (this.incoming) this.consume('cancelled', false);
    else if (this.active)
      this.recordIncomplete(
        this.active,
        this.active.root,
        'observation_active_cancelled_on_close_outcome_unknown',
        'cancelled',
        { workerStatsUnknown: true, outcomeAccountingComplete: false }
      );
    this.active = null;
    this.scopeEpoch++;
    this.closePromise = new Promise((resolve) => {
      if (this.exited || !this.worker) {
        resolve({ dirty: this.shutdownState?.dirty ?? false, elapsedMs: monotonicNow() - started });
        return;
      }
      let finished = false;
      const finish = (dirty: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.closeDone = null;
        resolve({ dirty, elapsedMs: monotonicNow() - started });
      };
      const timer = setTimeout(() => {
        this.fail('observation_worker_dirty_shutdown', true);
        this.worker?.unref();
        void this.worker?.terminate().catch(() => {});
        finish(true);
      }, 2000);
      this.closeDone = () => finish(this.shutdownState?.dirty ?? true);
      this.worker.postMessage({ type: 'close', incarnation: this.incarnation });
    });
    return this.closePromise;
  }
}

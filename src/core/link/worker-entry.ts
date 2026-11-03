import { parentPort, workerData, resourceLimits } from 'node:worker_threads';
import { getHeapStatistics, serialize } from 'node:v8';
import { HudDelegationCollector } from '../../collectors/delegation.js';
import { encodeView } from './worker-codec.js';
import { compactOutcomes, makeWorkerFatal, resultWireUpperBound } from './worker-control.js';
import {
  monotonicNow,
  WORKER_PROTOCOL,
  WORKER_RESOURCE_LIMITS,
  WORKER_EXTERNAL_LIMIT,
  WORKER_PAYLOAD_LIMIT,
  type WorkerStartup,
  type WorkerInput,
  type WorkerOperation,
  type WorkerResult,
} from './worker-protocol.js';
import type { LinkTickStats } from './tick.js';
import type { DelegationViewModel } from './view-model.js';

const port = parentPort;
if (!port) throw new Error('observation_worker_requires_parent');
const startup = workerData as WorkerStartup;
if (startup.version !== WORKER_PROTOCOL) throw new Error('observation_worker_protocol');
let runtime: HudDelegationCollector | null = null;
let scope: string | null | undefined;
let active = false,
  awaiting: number | null = null,
  closing = false,
  closed = false;
let lastView: DelegationViewModel | null | undefined;
let lastScope = -1,
  revision = 0;
const initialize = async () => {
  // This path is selected only by the explicit test constructor; production cannot configure it.
  if (startup.testModule) {
    const hooks = await import(startup.testModule);
    await hooks.install?.(startup.testData);
  }
  runtime = await HudDelegationCollector.open({ HUD_HOME: startup.hudHome }, startup.ambientHome, {
    publish: true,
    boundedWorker: true,
  });
  if (!runtime) throw new Error('observation_worker_home_unavailable');
  if (getHeapStatistics().heap_size_limit > 96 * 1024 * 1024) throw new Error('observation_worker_heap_guard');
  port.postMessage({
    type: 'ready',
    incarnation: startup.incarnation,
    limits: {
      maxOldGenerationSizeMb: resourceLimits.maxOldGenerationSizeMb ?? 0,
      maxYoungGenerationSizeMb: resourceLimits.maxYoungGenerationSizeMb ?? 0,
      stackSizeMb: resourceLimits.stackSizeMb ?? 0,
    },
  });
};
const initialized = initialize();
async function closeNow() {
  if (closed || active) return;
  closed = true;
  let cleanupIncomplete = false;
  try {
    await initialized;
    runtime?.close();
  } catch {
    cleanupIncomplete = true;
  }
  const outcomes = compactOutcomes([], runtime?.takeLifecycleOutcomes() ?? []);
  outcomes.accountingComplete &&= !cleanupIncomplete;
  runtime = null;
  const closedMessage = {
    type: 'closed' as const,
    incarnation: startup.incarnation,
    at: monotonicNow(),
    dirty: !outcomes.accountingComplete || outcomes.lifecycles.length > 0,
    lifecycleOutcomes: outcomes.lifecycles,
    accountingComplete: outcomes.accountingComplete,
    lifecycleCount: outcomes.lifecycleCount,
  };
  if (serialize(closedMessage).byteLength > WORKER_PAYLOAD_LIMIT) throw new Error('worker_control_invariant');
  port!.postMessage(closedMessage);
  port!.close();
}
async function collect(request: WorkerOperation) {
  if (active || awaiting !== null || closed || closing) throw new Error('observation_worker_backpressure');
  active = true;
  const startedAt = monotonicNow();
  let tickStats: Readonly<LinkTickStats> | null = null;
  let collectionMs = 0,
    publishMs = 0;
  let transitionLifecycles: { refKey: string; reason: string }[] = [];
  let transitionCommits: import('./worker-protocol.js').CommitTrace[] = [];
  let view: DelegationViewModel | null = null,
    error: string | null = null;
  let publication = { attempted: false, changed: false, error: null as string | null };
  try {
    await initialized;
    if (scope !== undefined && scope !== request.scope) {
      const settlement = await runtime!.settlePending();
      publication = { attempted: settlement.attempted, changed: false, error: settlement.error };
      if (!settlement.settled) throw new Error('scope_previous_publication_pending');
      const oldCommits = runtime!.takeCommitTraces();
      transitionCommits = oldCommits;
      publication.changed = oldCommits.length > 0;
      runtime!.close();
      transitionLifecycles = runtime!.takeLifecycleOutcomes();
      runtime = await HudDelegationCollector.open({ HUD_HOME: startup.hudHome }, startup.ambientHome, {
        publish: true,
        boundedWorker: true,
      });
      scope = request.scope;
      // A scope transition which settled an older publication cannot issue a second one.
      if (settlement.attempted) throw new Error('scope_transition_continued');
    }
    scope = request.scope;
    if (!runtime) throw new Error('observation_worker_unavailable');
    const remainingMs = Math.max(0, request.deadlineAt - monotonicNow());
    const collectionStarted = monotonicNow();
    view = await runtime.tick(request.scope ?? undefined, performance.now() + remainingMs, request.budget.maxBytes);
    tickStats = runtime.collector.stats();
    collectionMs = monotonicNow() - collectionStarted;
    const publishStarted = monotonicNow();
    await runtime.afterPaint((next) => {
      view = next;
    });
    publishMs = monotonicNow() - publishStarted;
    // refreshCommitted already accumulates its projection work into this operation's statistics.
    tickStats = runtime.collector.stats();
    view = runtime.collector.current();
    const published = runtime.publicationStats();
    publication = { attempted: published.attempted, changed: published.changed, error: published.error };
    error = publication.error ?? runtime.resources().blocked;
    if (error && view)
      view = {
        ...view,
        tree: {
          ...view.tree,
          coverage: {
            ...view.tree.coverage,
            state: 'partial',
            reason: error,
            gaps: [...new Set([...view.tree.coverage.gaps, error])],
          },
        },
      };
  } catch (caught) {
    runtime?.abandonCollection();
    error = caught instanceof Error ? caught.message : 'observation_worker_unavailable';
  }
  const collectedAt = monotonicNow();
  const commits = [...transitionCommits, ...(runtime?.takeCommitTraces() ?? [])];
  const usage = process.memoryUsage();
  const cpu = (
    process as typeof process & { threadCpuUsage?: () => { user: number; system: number } }
  ).threadCpuUsage?.();
  const residency = runtime?.resources() ?? { readers: 0, pinnedReaders: 0, evictions: 0, metadata: 0, blocked: null };
  const result: WorkerResult = {
    type: 'result',
    codec: 'v8-1',
    version: WORKER_PROTOCOL,
    incarnation: startup.incarnation,
    scope: request.scope,
    scopeEpoch: request.scopeEpoch,
    requestId: request.requestId,
    revision,
    unchanged: false,
    payload: null,
    ledgerObservedAt: runtime?.collector.publicationLedgerObservedAt() ?? null,
    stats: tickStats,
    trace: {
      enqueuedAt: request.enqueuedAt,
      activatedAt: request.activatedAt,
      startedAt,
      collectedAt,
      postedAt: monotonicNow(),
      encodedAt: 0,
      superseded: request.superseded,
      stages: {
        collectionMs,
        publishMs,
        ...(runtime?.operationStages() ?? {
          recoveryMs: 0,
          decodeMs: 0,
          headMs: 0,
          leaseMs: 0,
          prepareMs: 0,
          publishCallMs: 0,
        }),
      },
      root: request.root,
      commits,
      lifecycles: [...transitionLifecycles, ...(runtime?.takeLifecycleOutcomes() ?? [])],
    },
    resources: {
      ...residency,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      rss: usage.rss,
      payloadBytes: 0,
      cpuUser: cpu?.user ?? null,
      cpuSystem: cpu?.system ?? null,
    },
    publication,
    error,
  };
  try {
    if (!request.fullView && !error && view === lastView && request.scopeEpoch === lastScope) result.unchanged = true;
    else {
      if (usage.arrayBuffers + 8 * 1024 * 1024 > WORKER_EXTERNAL_LIMIT) throw new Error('external_buffer_reservation');
      result.payload = encodeView(view);
      result.resources.payloadBytes = result.payload.byteLength;
      result.revision = ++revision;
      lastView = view;
      lastScope = request.scopeEpoch;
    }
  } catch (caught) {
    result.error = caught instanceof Error ? caught.message : 'worker_payload_failure';
    result.payload = null;
    result.unchanged = false;
  }
  // The reserved header is part of the same 2 MiB result cap; unusually long identities fail explicitly.
  if (
    serialize({ ...result, payload: null }).byteLength + 64 > 8192 ||
    resultWireUpperBound(result) > WORKER_PAYLOAD_LIMIT
  ) {
    result.error = 'worker_metadata_limit';
    result.publication.error = result.error;
    result.stats = null;
    result.payload = null;
    result.unchanged = false;
    result.resources.payloadBytes = 0;
    lastView = undefined;
  }
  if (resultWireUpperBound(result) > WORKER_PAYLOAD_LIMIT) {
    const fatal = makeWorkerFatal(
      startup.incarnation,
      request.requestId,
      'worker_metadata_limit',
      result.trace.commits.map(({ refKey, commitSeq }) => ({ refKey, commitSeq })),
      result.trace.lifecycles
    );
    result.payload = null;
    lastView = undefined;
    active = false;
    closing = true;
    port!.postMessage(fatal);
    await closeNow();
    return;
  }
  const encodedUsage = process.memoryUsage();
  result.resources.arrayBuffers = Math.max(result.resources.arrayBuffers, encodedUsage.arrayBuffers);
  result.resources.external = Math.max(result.resources.external, encodedUsage.external);
  result.resources.heapUsed = Math.max(result.resources.heapUsed, encodedUsage.heapUsed);
  result.resources.rss = Math.max(result.resources.rss, encodedUsage.rss);
  result.trace.encodedAt = monotonicNow();
  active = false;
  awaiting = request.requestId;
  if (result.payload) port!.postMessage(result, [result.payload]);
  else port!.postMessage(result);
  if (closing) await closeNow();
}
port.on('message', (message: WorkerInput) => {
  if (!message || message.incarnation !== startup.incarnation) return;
  if (message.type === 'close') {
    closing = true;
    if (!active) void closeNow();
    return;
  }
  if (message.type === 'ack') {
    if (awaiting === message.requestId) awaiting = null;
    return;
  }
  if (message.type === 'collect') {
    if (
      message.version !== WORKER_PROTOCOL ||
      !Number.isSafeInteger(message.requestId) ||
      !Number.isSafeInteger(message.budget.maxBytes) ||
      !Number.isSafeInteger(message.budget.maxRecords) ||
      message.budget.maxRecords < 0 ||
      message.budget.maxRecords > 2000 ||
      !Number.isFinite(message.deadlineAt) ||
      !Number.isFinite(message.activatedAt) ||
      message.deadlineAt - message.activatedAt > 40 ||
      !Number.isFinite(message.budget.budgetMs) ||
      message.budget.budgetMs < 0 ||
      message.budget.budgetMs > 20 ||
      message.budget.maxBytes > 4 * 1024 * 1024 ||
      message.budget.maxBytes < 0 ||
      message.root.bytesRead + message.budget.maxBytes > 8 * 1024 * 1024
    )
      throw new Error('observation_worker_grant');
    void collect(message).catch((error: unknown) => {
      port!.postMessage(makeWorkerFatal(startup.incarnation, message.requestId, 'worker_failure', null, null));
      closing = true;
      active = false;
      void closeNow();
    });
  }
});
void initialized.catch((error: unknown) => {
  port.postMessage(makeWorkerFatal(startup.incarnation, null, 'worker_startup_failure'));
  closing = true;
  if (!active) void closeNow();
});

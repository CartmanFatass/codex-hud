import type { Ledger } from '../../../src/ledger/ledger.js';
import type { LedgerTransaction } from '../../../src/ledger/transaction.js';
import type { IntentAuthority } from '../../../src/ledger/types.js';
import {
  readDelegationIn,
  readDelegationEventsIn,
  type DelegationTarget,
  type DelegationRead,
} from '../../../src/ledger/delegation-read.js';
import { snapshotInTransaction, requestCancel, commitReconcile } from '../../../src/ledger/reconcile.js';
import { effectiveWaitMs, waitPage, authorizeControl } from '../../../src/core/lifecycle.js';
import { selectCurrentObservation, projectFreshness } from '../../../src/core/observation.js';
import { openObservationStore, type ObservationStore } from '../../../src/core/observation-store.js';
import { hintSubscription, waitForRun, type SubscribeWait } from '../../../src/core/wait/index.js';
import { performance } from 'node:perf_hooks';
import { LedgerBusyError } from '../../../src/ledger/transaction.js';
import { randomUUID } from 'node:crypto';
import { digest } from '../../../src/core/canonical.js';
import { isRunTerminal } from '../../../src/core/execution.js';
import { processState } from '../../../src/core/run/process.js';
import {
  requireParentControl,
  currentAuthority,
  linkOwner,
  readCapacity,
  type CapacityLimits,
} from '../../../src/ledger/intents.js';
import type { ReconcileEvidence } from '../../../src/core/types/execution.js';
import type { WaitRequest, WaitUntil } from '../../../src/core/types/lifecycle.js';
import type { SessionRef } from '../../../src/core/types/identity.js';
import type { ObservationProjection } from '../../../src/core/types/checkpoint.js';
import { readWakeState, wakeProjection, type WakeWaitObserver } from './wake-state.js';
import {
  adviceFor,
  emptyCacheConfig,
  type CacheAdvice,
  type CacheConfigErrorCode,
  type CacheConfigLoad,
} from '../../../src/core/cache-config.js';

/**
 * The `<HUD_HOME>/cache.json` snapshot loaded once at hud-mcp start, plus the
 * facts this process already verified. `adviceFor` does no I/O, so a change to
 * the file takes effect in the next session.
 */
export interface CacheAdviceSource {
  load: CacheConfigLoad;
  /** The caller's verified harness; never a tool argument. */
  harness: string;
  /** The target profile's declared model for the target role, else null. */
  model: (backend: string, role: string) => string | null;
}

/** `advice` as the tools carry it: the pure lookup plus the load failure, when there is one. */
export type CacheAdviceResult = CacheAdvice & { configError?: CacheConfigErrorCode };

/**
 * A pure lookup over the startup snapshot. An invalid file is not a reason to
 * refuse a tool call: every config-derived field stays null, warming stays off,
 * and `configError` carries the validator's detail code.
 */
export function cacheAdvice(source: CacheAdviceSource, backend: string, role: string): CacheAdviceResult {
  const query = { harness: source.harness, auth: 'unknown', model: source.model(backend, role) };
  if (!source.load.ok) return { ...adviceFor(emptyCacheConfig(), query), configError: source.load.detail };
  return { ...adviceFor(source.load.snapshot, query) };
}

/**
 * Add the cache lookup to a result at the point it is composed. An `advice`
 * object already present is merged, never replaced: B19 adds `advice.wake` in
 * these same files, and the cache fields must not drop a key this package does
 * not own. Only `advice` is touched; every other field and code is unchanged.
 */
export function withCacheAdvice<T extends object>(
  outcome: T,
  source: CacheAdviceSource,
  backend: string,
  role: string
): T & { advice: CacheAdviceResult } {
  const existing = (outcome as { advice?: unknown }).advice;
  const kept =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...outcome, advice: { ...kept, ...cacheAdvice(source, backend, role) } };
}

/** Empty advice for a process that was composed without a cache snapshot. */
const NO_CACHE_ADVICE: CacheAdviceSource = {
  load: { ok: true, snapshot: emptyCacheConfig(), path: '', origin: 'missing' },
  harness: 'unknown',
  model: () => null,
};

function requireCancel(tx: LedgerTransaction, link: DelegationRead['link'], authority: IntentAuthority): void {
  requireParentControl(link);
  const allowed = authorizeControl('cancel', link, linkOwner(tx, link), currentAuthority(tx, authority));
  if (!allowed.ok) throw new Error(allowed.reason);
}

export class ReadControlService {
  private readonly cache: CacheAdviceSource;
  private readonly wakes?: WakeWaitObserver;
  private stores = new Map<string, ObservationStore>();
  private opening = new Map<string, Promise<ObservationStore>>();
  constructor(
    private readonly ledger: Ledger,
    private readonly home: string,
    private readonly subscribe: SubscribeWait = hintSubscription(home),
    /** Trusted observation seam for controlled OS-visibility/race tests; never tool input. */
    private readonly probes: { supervisorState?: typeof processState } = {},
    private readonly limits: CapacityLimits = {},
    cacheOrWakes: CacheAdviceSource | WakeWaitObserver = NO_CACHE_ADVICE,
    wakes?: WakeWaitObserver
  ) {
    this.cache = 'load' in cacheOrWakes ? cacheOrWakes : NO_CACHE_ADVICE;
    this.wakes = 'opened' in cacheOrWakes ? cacheOrWakes : wakes;
  }
  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
  private async projection(ref: SessionRef): Promise<ObservationProjection | null> {
    let store = this.stores.get(ref.sourceId);
    if (!store) {
      try {
        let opening = this.opening.get(ref.sourceId);
        if (!opening) {
          opening = openObservationStore({ hudHome: this.home, sourceId: ref.sourceId, readOnly: true });
          this.opening.set(ref.sourceId, opening);
        }
        store = await opening;
        this.stores.set(ref.sourceId, store);
      } catch {
        return null;
      } finally {
        this.opening.delete(ref.sourceId);
      }
    }
    try {
      return store.readProjection(ref);
    } catch {
      return null;
    }
  }
  private async compose<T extends DelegationRead>(snapshot: T) {
    const run = snapshot.currentRun;
    const ref = run.targetSessionRef ?? (snapshot.isCurrent ? snapshot.link.childRef : null);
    const candidate = ref ? await this.projection(ref) : null;
    const selected = ref
      ? selectCurrentObservation(
          {
            asOfSeq: snapshot.asOfSeq,
            ref,
            runId: run.runId,
            bindingGeneration: run.expectedGeneration,
            sourceGeneration: candidate?.sourceGeneration ?? 0,
          },
          candidate ? { stamp: candidate.observationStamp, value: candidate } : null
        )
      : null;
    const observation = selected?.observation ?? null;
    const freshness = observation?.summary.statusProjection.freshness;
    const freshnessNow = freshness
      ? projectFreshness(freshness.sources, freshness.requiredSourceIds, Date.now())
      : null;
    return {
      ...snapshot,
      statusProjection: observation?.summary.statusProjection ?? null,
      observationStamp: observation?.observationStamp ?? null,
      continuity: observation?.continuity ?? null,
      notices: observation?.notices ?? [],
      seqDomain: observation?.seqDomain ?? null,
      freshnessNow,
      observationAvailability: observation ? (freshnessNow?.state === 'fresh' ? 'current' : 'stale') : 'unavailable',
      observationUnavailableReason:
        selected?.unavailableReason ?? (observation ? (freshnessNow?.reason ?? null) : 'observation_unavailable'),
      rejectedObservationStamp: selected?.rejectedObservationStamp ?? null,
    };
  }
  async status(target: DelegationTarget, authority: (tx: LedgerTransaction) => IntentAuthority) {
    const snapshot = await this.ledger.readSnapshot((tx) => {
      const snapshot = readDelegationIn(tx, target, authority(tx));
      const { active, limit, occupants } = readCapacity(tx, linkOwner(tx, snapshot.link), this.limits);
      return {
        ...snapshot,
        capacity: { active, limit, occupants },
        ...wakeProjection(
          readWakeState(tx, snapshot.link),
          this.home,
          snapshot.currentRun.runId,
          snapshot.asOfSeq ?? 0
        ),
      };
    });
    // Composed after the read, so an `advice` already projected into the snapshot
    // (B19's `wake`) is merged instead of replaced. The lookup itself does no I/O.
    return {
      ok: true,
      ...withCacheAdvice(await this.compose(snapshot), this.cache, snapshot.link.backend, snapshot.link.role),
    };
  }
  async wait(
    request: WaitRequest,
    authority: (tx: LedgerTransaction) => IntentAuthority,
    timeout: {
      clientToolTimeoutMs: number | null;
      responseMarginMs: number | null;
      verified: boolean;
      started?: number;
    },
    signal?: AbortSignal
  ) {
    const afterSeq = request.afterSeq ?? 0;
    const until = request.until ?? ['report', 'run_terminal', 'uncertain'];
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Array.isArray(until) ||
      until.some((v) => !['report', 'run_terminal', 'uncertain'].includes(v))
    )
      throw new Error('invalid');
    const requested = request.timeoutMs ?? 120000;
    // Owner amendment (B6 oracle-1): unknown client deadlines get a conservative short wait.
    // 5s is policy, not proof of any client's timeout; reserve 2s against explicit shorter config.
    const verifiedBudget = effectiveWaitMs(
      requested,
      timeout.clientToolTimeoutMs,
      timeout.responseMarginMs,
      timeout.verified
    );
    const elapsed = Math.max(0, performance.now() - (timeout.started ?? performance.now()));
    const configuredCap =
      timeout.clientToolTimeoutMs === null ? Infinity : Math.max(0, timeout.clientToolTimeoutMs - 2000);
    const base = timeout.verified ? verifiedBudget.effectiveWaitMs : Math.min(requested, 5000, configuredCap);
    const budget = { effectiveWaitMs: Math.max(0, Math.floor(base - elapsed)), reason: verifiedBudget.reason };
    const token = Symbol('delegate_wait');
    let opened = false;
    try {
      const result = await waitForRun({
        timeoutMs: budget.effectiveWaitMs,
        signal,
        subscribe: this.subscribe,
        read: async (runId?: string) =>
          this.ledger.readSnapshot((tx) => {
            const status = readDelegationIn(tx, runId ? { runId } : (request as DelegationTarget), authority(tx));
            if (!opened) {
              this.wakes?.opened(token, status.currentRun.runId, afterSeq, until);
              opened = true;
            }
            const highWaterSeq = status.asOfSeq!;
            const { events, validReportSeqs } = readDelegationEventsIn(
              tx,
              status.currentRun.runId,
              afterSeq,
              highWaterSeq
            );
            const page = waitPage(
              {
                runId: status.currentRun.runId,
                afterSeq,
                until: until as WaitUntil[],
                timeoutMs: budget.effectiveWaitMs,
              },
              { run: status.currentRun, highWaterSeq, events }
            );
            if (page.matched && !until.includes('run_terminal') && !until.includes('uncertain'))
              page.matched = page.events.some((e) => validReportSeqs.includes(e.seq));
            else if (until.includes('report')) {
              const withoutReport = waitPage(
                {
                  runId: page.runId,
                  afterSeq,
                  until: until.filter((v) => v !== 'report') as WaitUntil[],
                  timeoutMs: 0,
                },
                { run: page.current, highWaterSeq, events }
              );
              page.matched = withoutReport.matched || page.events.some((e) => validReportSeqs.includes(e.seq));
            }
            return { ...page, lifecycle: status };
          }),
      });
      const { lifecycle, ...page } = result;
      const status = await this.compose(lifecycle);
      signal?.throwIfAborted();
      this.wakes?.returned(token, page.events);
      return {
        ok: true,
        ...page,
        status,
        reason: budget.reason,
        timeoutVerified: timeout.verified,
      };
    } finally {
      this.wakes?.closed(token);
    }
  }
  async cancel(
    runId: string,
    graceMs: number,
    authority: IntentAuthority,
    budget = { deadline: performance.now() + 30, lockDeadline: performance.now() + 20 }
  ) {
    const remaining = () => {
      const left = Math.min(budget.deadline, budget.lockDeadline) - performance.now();
      if (left <= 0) throw new LedgerBusyError();
      return Math.min(20, left);
    };
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 60000) throw new Error('invalid_grace');
    for (let attempt = 0; attempt < 3; attempt++) {
      remaining();
      // No probes or external I/O occur inside either short transaction.
      const expected = await this.ledger.readSnapshot((tx) => {
        const status = readDelegationIn(tx, { runId }, authority);
        requireCancel(tx, status.link, authority);
        return snapshotInTransaction(tx, runId);
      });
      if (
        !isRunTerminal(expected.run) &&
        expected.run.state !== 'uncertain' &&
        expected.run.supervisor &&
        (this.probes.supervisorState ?? processState)(expected.run.supervisor) === 'dead'
      ) {
        const now = Date.now();
        const evidenceId = randomUUID();
        const fact: ReconcileEvidence = {
          evidenceId,
          runId,
          sourceId: expected.run.sourceId,
          bindingGeneration: expected.run.expectedGeneration,
          supervisor: expected.run.supervisor,
          validation: 'accepted',
          asOf: now,
          observedAt: now,
          fact: { kind: 'supervisor', state: 'dead' },
        };
        const reconciled = await commitReconcile(
          this.ledger,
          expected,
          [
            {
              record: {
                evidenceId,
                runId,
                linkId: expected.link.linkId,
                kind: 'group_check',
                producer: 'reconciler',
                fingerprint: digest(fact),
                payload: {},
                observedAt: now,
                validatedAt: now,
                validation: 'accepted',
              },
              facts: [fact],
            },
          ],
          now,
          (tx) => {
            const current = readDelegationIn(tx, { runId }, authority);
            requireCancel(tx, current.link, authority);
          },
          remaining(),
          this.home
        );
        void reconciled;
        continue;
      }
      const result = await requestCancel(this.ledger, expected, authority, Date.now(), graceMs, remaining());
      if (!result.committed) continue;
      // Acceptance is durable: a later read/authority failure must never turn it into busy/not accepted.
      let status: Awaited<ReturnType<ReadControlService['status']>> | null = null;
      try {
        status = await this.status({ runId }, () => authority);
      } catch {
        /* committed intent remains authoritative */
      }
      const unavailable = expected.run.mode === 'visible';
      return {
        ok: true,
        accepted: result.result.accepted,
        cancelRequestedAt: result.result.cancelRequestedAt,
        status,
        ...(unavailable && result.result.accepted
          ? { code: 'visible_scope_control_unavailable', cancellation: 'unconfirmed' }
          : {}),
      };
    }
    throw new Error('busy');
  }
}

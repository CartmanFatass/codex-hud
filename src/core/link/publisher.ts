import { createHash, randomUUID } from 'node:crypto';
import { COLLECT_RENEW_INTERVAL_MS, COLLECT_LEASE_TTL_MS } from '../collect-lease.js';
import { StatusWriter, type PreparedStatusReading, type WriterFacts } from '../status/writer.js';
import { STATUS_RULE_VERSION, type StatusSource } from '../status/merge.js';
import type { ObservationStore } from '../observation-store.js';
import type { ReaderResult } from '../interfaces/harness-adapter.js';
import type { CollectLease } from '../types/observation.js';
import type { SessionRef } from '../types/identity.js';
import type { ObservationProjection, ObservationRecovery } from '../types/checkpoint.js';
import type { ReaderCheckpoint } from '../types/observation.js';
import type { CodexCheckpoint } from '../../harness/codex/index.js';
import { canonicalJson } from '../canonical.js';
import { preparedCheckpointData } from '../checkpoint.js';
import { readerStatusSources, restoreNativeStatusMemory, type NativeStatusMemory } from './reader-status.js';

/** A live reader and its exact acquiring store share this lifecycle. No timer or write queue. */
export class SessionPublisher {
  private writer: StatusWriter | null = null;
  private lease: CollectLease | null = null;
  private renewedAt = 0;
  private prepared: PreparedStatusReading | null = null;
  private result: ReaderResult | null = null;
  private pending = false;
  private priorGeneration: number | null = null;
  private priorGaps = '[]';
  private prior: ObservationProjection | null = null;
  private sources: StatusSource[] | null = null;
  private nativeMemory: NativeStatusMemory | undefined;
  private context = '';
  private acceptedKey = '';
  private nextDeadline = Infinity;
  private lastNow = -Infinity;
  private retryAt = 0;
  private recoverableContinuity = false;
  // Only provenance plus one old accepted marker. Never a checkpoint or reader-memory side cache.
  private acceptedRecovery: { key: string; lastEvent: string | null } | null = null;
  private priorKey(prior: ObservationProjection): string {
    return createHash('sha256')
      .update(
        canonicalJson([
          prior.ref,
          prior.seqDomain,
          prior.commitSeq,
          prior.sourceGeneration,
          prior.checkpointIdentity,
          prior.observationStamp,
        ])
      )
      .digest('hex');
  }
  private acceptedMarker(checkpoint: ReaderCheckpoint): string | null | undefined {
    const cp = checkpoint as CodexCheckpoint;
    if (cp.ref.harness !== 'codex' || cp.codex?.rollout.version !== 3) return undefined;
    const events = cp.codex.rollout.state.cachedResult?.events;
    if (!Array.isArray(events)) return undefined;
    if (!events.length) return null;
    const event = events[events.length - 1];
    if (
      typeof event.kind !== 'string' ||
      event.kind.length > 128 ||
      typeof event.at !== 'number' ||
      !Number.isFinite(event.at)
    )
      return undefined;
    return JSON.stringify([event.kind, event.at]);
  }
  /** Consume the already verified, exact recovery selected before any new native read. No I/O. */
  acceptRecovery(prior: ObservationProjection, recovery: ObservationRecovery): boolean {
    this.acceptedRecovery = null;
    if (
      !this.prior ||
      this.priorKey(prior) !== this.priorKey(this.prior) ||
      canonicalJson(recovery.target) !==
        canonicalJson({
          ref: prior.ref,
          seqDomain: prior.seqDomain,
          commitSeq: prior.commitSeq,
          sourceGeneration: prior.sourceGeneration,
          checkpointIdentity: prior.checkpointIdentity,
        })
    )
      return false;
    const marker = this.acceptedMarker(recovery.checkpoint);
    if (marker !== undefined) this.acceptedRecovery = { key: this.priorKey(prior), lastEvent: marker };
    return true;
  }
  private restoredMemory(
    prior: ObservationProjection,
    target: WriterFacts['target'],
    observedAt: number,
    marker?: { key: string; lastEvent: string | null }
  ): NativeStatusMemory {
    const compatible =
      prior.sourceGeneration === target.sourceGeneration &&
      prior.summary.statusProjection.activity === 'working' &&
      prior.continuity.ruleVersion === STATUS_RULE_VERSION &&
      prior.observationStamp.runId === target.runId &&
      prior.observationStamp.bindingGeneration === target.bindingGeneration;
    const memory = restoreNativeStatusMemory(
      compatible ? prior.continuity.episodeAnchor : null,
      this.result?.checkpoint.sourceGeneration ?? prior.sourceGeneration,
      observedAt
    );
    if (compatible && marker?.key === this.priorKey(prior)) memory.lastEvent = marker.lastEvent;
    return memory;
  }
  constructor(
    readonly store: ObservationStore,
    readonly ref: SessionRef,
    readonly holder = `hud:${process.pid}:${randomUUID()}`
  ) {}

  /** No write on a refused contender; reacquisition always replaces the old reader lineage. */
  claim(nowMs: number): 'retained' | 'acquired' | 'follower' {
    if (this.lease && this.writer && nowMs >= this.lastNow && nowMs < this.lease.expires_at) {
      if (nowMs - this.renewedAt >= COLLECT_RENEW_INTERVAL_MS) {
        this.lease = this.writer.renew();
        this.renewedAt = this.lease.expires_at - COLLECT_LEASE_TTL_MS;
      }
      this.lastNow = nowMs;
      return 'retained';
    }
    if (!this.lease && nowMs < this.retryAt) return 'follower';
    this.forget();
    const current = this.store.readLease(this.ref);
    if (current && nowMs < current.expires_at) {
      this.retryAt = current.expires_at;
      return 'follower';
    }
    this.retryAt = 0;
    this.lease = this.store.acquire(this.ref, this.holder);
    this.writer = new StatusWriter(this.store, this.ref, this.lease);
    const prior = this.store.readProjection(this.ref);
    this.prior = prior;
    this.priorGeneration = prior?.sourceGeneration ?? null;
    this.priorGaps = JSON.stringify(prior?.summary.coverage.gaps ?? []);
    this.renewedAt = this.lease.expires_at - COLLECT_LEASE_TTL_MS;
    this.lastNow = nowMs;
    return 'acquired';
  }
  historyContinuity(): 'proven' | 'first_observation' {
    return this.nativeMemory?.resetContinuity ? 'first_observation' : 'proven';
  }
  historyGap(): boolean {
    return (
      !!this.result &&
      ((this.priorGeneration !== null && this.priorGeneration !== this.result.checkpoint.sourceGeneration) ||
        (this.result.checkpoint.parserState.gaps.length > 0 &&
          JSON.stringify(this.result.checkpoint.parserState.gaps) !== this.priorGaps))
    );
  }
  prepare(target: WriterFacts['target']): void {
    if (!this.writer || !this.result) return;
    const context = JSON.stringify([target.runId, target.bindingGeneration]);
    if (context !== this.context) {
      if (this.prepared) throw new TypeError('status_new_reading_required');
      this.nativeMemory = undefined;
    }
    if (!this.prepared) {
      if (!this.sources) {
        if (this.result.checkpoint.ref.harness === 'codex' && !this.nativeMemory) {
          const prior = this.prior;
          this.nativeMemory = prior
            ? this.restoredMemory(
                prior,
                target,
                this.result.observation.statusProjection.observedAt,
                this.acceptedRecovery ?? undefined
              )
            : restoreNativeStatusMemory(
                null,
                this.result.checkpoint.sourceGeneration,
                this.result.observation.statusProjection.observedAt
              );
          this.acceptedRecovery = null;
        }
        this.sources = readerStatusSources(this.result, target, this.nativeMemory);
      }
      this.prepared = this.writer.prepare(this.result, this.sources, target);
      this.context = context;
    }
  }
  matchesAcceptedRun(runId?: string, bindingGeneration?: number): boolean | null {
    if (!this.prior) return null;
    return (
      this.prior.observationStamp.runId === runId && this.prior.observationStamp.bindingGeneration === bindingGeneration
    );
  }
  matchesPreparedContext(target: WriterFacts['target']): boolean | null {
    if (!this.prepared) return null;
    return (
      this.context === JSON.stringify([target.runId, target.bindingGeneration]) &&
      this.result?.checkpoint.sourceGeneration === target.sourceGeneration
    );
  }
  deadline(): number {
    return this.nextDeadline;
  }
  valid(nowMs: number): boolean {
    return !!this.lease && nowMs >= this.lastNow && nowMs < this.lease.expires_at;
  }
  capture(result: ReaderResult): void {
    if (result.checkpoint.resetReason || result.checkpoint.sourceGeneration !== this.prior?.sourceGeneration)
      this.acceptedRecovery = null;
    this.result = result;
    this.prepared = null;
    this.sources = null;
    this.pending = true;
    this.recoverableContinuity = false;
  }
  hasPending(): boolean {
    return this.pending;
  }
  /** A store hint permits a selected follower to reconsider a released/changed lease. No I/O here. */
  observeStoreChange(): void {
    if (!this.lease) this.retryAt = 0;
  }
  /** Only a durably acknowledged exact boundary can surrender its resident reader state. */
  canEvictAcceptedReading(): boolean {
    const result = this.result,
      prior = this.prior;
    if (this.pending || !result || !prior || !this.prepared || !this.recoverableContinuity) return false;
    const cp = result.checkpoint,
      id = prior.checkpointIdentity;
    if (
      this.prepared.checkpoint.identity.contentIdentity !== id.contentIdentity ||
      cp.sourceGeneration !== id.sourceGeneration ||
      cp.readerVersion !== id.readerVersion ||
      cp.offset !== id.offset ||
      JSON.stringify(cp.fileId) !== JSON.stringify(id.fileId) ||
      JSON.stringify([prior.observationStamp.runId, prior.observationStamp.bindingGeneration]) !== this.context
    )
      return false;
    return true;
  }
  evictAcceptedReading(): boolean {
    if (!this.canEvictAcceptedReading()) return false;
    this.discardReading();
    this.context = '';
    return true;
  }
  discardReading(): void {
    this.acceptedRecovery = null;
    this.result = null;
    this.prepared = null;
    this.sources = null;
    this.nativeMemory = undefined;
    this.pending = false;
    this.recoverableContinuity = false;
  }
  hasReading(): boolean {
    return this.result !== null;
  }
  due(key: string, nowMs: number): boolean {
    return (
      this.result !== null &&
      (this.pending ||
        this.prepared === null ||
        this.acceptedKey !== key ||
        nowMs > this.nextDeadline ||
        nowMs < this.lastNow)
    );
  }
  publish(facts: WriterFacts, key: string, nowMs: number): ObservationProjection | null {
    if (!this.writer || !this.lease || !this.result) return null;
    if (nowMs - this.renewedAt >= COLLECT_RENEW_INTERVAL_MS) {
      this.lease = this.writer.renew();
      this.renewedAt = this.lease.expires_at - COLLECT_LEASE_TTL_MS;
    }
    this.prepare(facts.target);
    const publication = this.writer.publish(
      this.prepared!,
      { ...facts, history: { ...facts.history, continuity: this.historyContinuity() } },
      STATUS_RULE_VERSION,
      nowMs
    );
    this.pending = false;
    this.prior = publication.committed;
    this.acceptedRecovery = null;
    if (this.nativeMemory) this.nativeMemory.resetContinuity = false;
    this.recoverableContinuity = true;
    if (this.result?.checkpoint.ref.harness === 'codex') {
      // The frozen checkpoint captured by B12 preparation, not a speculative/current result.
      // Failure to prove equivalence pins the reading; it cannot undo a durable publication.
      this.recoverableContinuity = false;
      try {
        const captured = preparedCheckpointData(this.prepared!.checkpoint);
        if (canonicalJson(captured.identity) === canonicalJson(this.prior.checkpointIdentity)) {
          const marker = this.acceptedMarker(captured.checkpoint);
          const restored = this.restoredMemory(
            this.prior,
            facts.target,
            this.result.observation.statusProjection.observedAt,
            marker === undefined ? undefined : { key: this.priorKey(this.prior), lastEvent: marker }
          );
          const fields = (m: NativeStatusMemory) => [
            m.sourceGeneration,
            m.turnAt,
            m.resumedAt,
            m.known,
            m.initialized,
            m.resetContinuity,
            m.lastEvent,
          ];
          const live = this.nativeMemory;
          const cp = captured.checkpoint as CodexCheckpoint;
          const cached = cp.codex?.rollout.version === 3 ? cp.codex.rollout.state.cachedResult : null;
          const empty =
            this.result.observation.statusProjection.activity !== 'working' &&
            cached !== null &&
            cached?.activity?.state !== 'working' &&
            cached?.activity?.turnStartedAt == null &&
            Array.isArray(cached?.events) &&
            cached.events.length === 0 &&
            cached.pendingApproval === null &&
            live?.sourceGeneration === cp.sourceGeneration &&
            live.turnAt === null &&
            live.resumedAt === 0 &&
            live.lastEvent === null &&
            live.resetContinuity === false;
          this.recoverableContinuity =
            empty || (!!live && canonicalJson(fields(restored)) === canonicalJson(fields(live)));
        }
      } catch {
        /* An unprovable accepted state remains pinned. */
      }
    }
    this.priorGeneration = publication.committed.sourceGeneration;
    this.priorGaps = JSON.stringify(publication.committed.summary.coverage.gaps);
    this.acceptedKey = key;
    this.lastNow = nowMs;
    const sources = this.sources ?? [];
    this.nextDeadline = Math.min(
      Infinity,
      ...sources.flatMap((s) =>
        [s.deadlineAt, s.evidence.value.openTool?.deadlineAt].filter((at): at is number => at != null && at >= nowMs)
      ),
      ...(facts.sources ?? []).map((s) => s.deadlineAt).filter((at): at is number => at != null && at >= nowMs),
      ...(facts.ledgerFacts ?? []).map((f) => f.deadlineAt).filter((at): at is number => at != null && at >= nowMs)
    );
    return publication.committed;
  }
  forget(): void {
    this.acceptedRecovery = null;
    this.writer = null;
    this.lease = null;
    this.prepared = null;
    this.result = null;
    this.sources = null;
    this.nativeMemory = undefined;
    this.acceptedKey = '';
    this.pending = false;
    this.nextDeadline = Infinity;
  }
  close(): void {
    if (this.lease && this.valid(Date.now()))
      try {
        this.store.release(this.ref, this.lease);
      } catch {
        /* Already expired or fenced. */
      }
    this.forget();
  }
}

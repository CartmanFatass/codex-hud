import { randomUUID } from 'node:crypto';
import { COLLECT_RENEW_INTERVAL_MS } from '../collect-lease.js';
import { StatusWriter, type PreparedStatusReading, type WriterFacts } from '../status/writer.js';
import { STATUS_RULE_VERSION, type StatusSource } from '../status/merge.js';
import type { ObservationStore } from '../observation-store.js';
import type { ReaderResult } from '../interfaces/harness-adapter.js';
import type { CollectLease } from '../types/observation.js';
import type { SessionRef } from '../types/identity.js';
import type { ObservationProjection } from '../types/checkpoint.js';
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
        this.renewedAt = nowMs;
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
    this.renewedAt = this.lastNow = nowMs;
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
          const compatible =
            prior !== null &&
            prior.sourceGeneration === target.sourceGeneration &&
            prior.summary.statusProjection.activity === 'working' &&
            prior.continuity.ruleVersion === STATUS_RULE_VERSION &&
            prior.observationStamp.runId === target.runId &&
            prior.observationStamp.bindingGeneration === target.bindingGeneration;
          this.nativeMemory = restoreNativeStatusMemory(
            compatible ? prior!.continuity.episodeAnchor : null,
            this.result.checkpoint.sourceGeneration,
            this.result.observation.statusProjection.observedAt
          );
        }
        this.sources = readerStatusSources(this.result, target, this.nativeMemory);
      }
      this.prepared = this.writer.prepare(this.result, this.sources, target);
      this.context = context;
    }
  }
  deadline(): number {
    return this.nextDeadline;
  }
  valid(nowMs: number): boolean {
    return !!this.lease && nowMs >= this.lastNow && nowMs < this.lease.expires_at;
  }
  capture(result: ReaderResult): void {
    this.result = result;
    this.prepared = null;
    this.sources = null;
    this.pending = true;
  }
  hasPending(): boolean {
    return this.pending;
  }
  discardReading(): void {
    this.result = null;
    this.prepared = null;
    this.sources = null;
    this.nativeMemory = undefined;
    this.pending = false;
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
      this.renewedAt = nowMs;
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
    if (this.nativeMemory) this.nativeMemory.resetContinuity = false;
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
    if (this.lease)
      try {
        this.store.release(this.ref, this.lease);
      } catch {
        /* Already expired or fenced. */
      }
    this.forget();
  }
}

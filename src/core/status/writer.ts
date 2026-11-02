import {
  checkpointBoundary,
  checkpointFormat,
  witnessPreparedObservationBoundary,
  type ObservationBoundary,
} from '../checkpoint.js';
import { sessionRefKey, sameSessionRef } from '../identity.js';
import type { ReaderResult } from '../interfaces/harness-adapter.js';
import type { ObservationStore, PublishResult } from '../observation-store.js';
import type { ObservationProjection, PreparedCheckpoint } from '../types/checkpoint.js';
import type { SessionRef } from '../types/identity.js';
import type { CollectLease, ObservationNoticeState, ObservationStamp, ObservationView } from '../types/observation.js';
import { mergeStatus, type MergeInput, type MergeResult, type NoticeState, type StatusSource } from './merge.js';

declare class ReadingToken {
  private readonly capturedReading: void;
}
/** One detached ReaderResult boundary + immutable B12R preparation. Retain until a new reading is collected. */
export interface PreparedStatusReading extends ReadingToken {
  readonly checkpoint: PreparedCheckpoint;
}
interface CapturedReading {
  checkpoint: PreparedCheckpoint;
  boundary: ObservationBoundary;
  summary: ObservationView;
  sources: readonly StatusSource[];
  runId?: string;
  bindingGeneration?: number;
}
export type WriterFacts = Omit<MergeInput, 'boundary' | 'observationStamp' | 'noticeState' | 'sources'> & {
  /** Independent live/ledger observations only; transcript facts belong to the captured reading. */
  sources?: readonly StatusSource[];
};
export interface StatusPublication {
  publication: PublishResult;
  committed: ObservationProjection;
  merge: MergeResult;
  /** Only edges accepted in this publication, never old notices read from the projection. */
  notices: ObservationProjection['notices'];
}

/**
 * One collector owns this writer, its acquired store instance, lease and live reader lookup together.
 * No opening a second store, scheduling, collection, renewal timer or consumer-side publication.
 */
export class StatusWriter {
  readonly #readings = new WeakMap<PreparedStatusReading, CapturedReading>();
  #prior: ObservationProjection | null;
  #lease: CollectLease;
  readonly #ref: SessionRef;
  constructor(
    private readonly store: ObservationStore,
    ref: SessionRef,
    lease: CollectLease
  ) {
    this.#ref = structuredClone(ref);
    this.#lease = structuredClone(lease);
    this.#prior = store.readProjection(this.#ref);
  }

  /** Call at the existing collector's renewal opportunity; instance authority is rechecked by B12R. */
  renew(): CollectLease {
    this.#lease = this.store.renew(this.#ref, this.#lease);
    return structuredClone(this.#lease);
  }

  /** Every new ReaderResult is prepared, even at the same offset. Never infer identity from mtime/address. */
  prepare(
    result: ReaderResult,
    readerSources: readonly StatusSource[],
    target: MergeInput['target']
  ): PreparedStatusReading {
    const boundary = checkpointBoundary(result.checkpoint);
    if (
      target.nodeIdentity.kind !== 'session' ||
      !sameSessionRef(target.nodeIdentity.ref, this.#ref) ||
      target.sourceGeneration !== boundary.sourceGeneration ||
      !sameSessionRef(boundary.ref, this.#ref) ||
      result.observation.nodeIdentity.kind !== 'session' ||
      !sameSessionRef(result.observation.nodeIdentity.ref, this.#ref) ||
      (result.recoveryIndex !== undefined && result.recoveryIndex !== result.checkpoint.recoveryIndex)
    )
      throw new TypeError('status_reading_mismatch');
    if (
      readerSources.some(
        (s) =>
          s.evidence.origin !== 'transcript' ||
          !sameSessionRef(s.evidence.ref, boundary.ref) ||
          s.evidence.sourceGeneration !== boundary.sourceGeneration ||
          s.evidence.runId !== target.runId ||
          s.evidence.bindingGeneration !== target.bindingGeneration
      )
    )
      throw new TypeError('status_reader_source_mismatch');
    const nativeStamp = result.observation.statusProjection.observationStamp;
    if (
      (nativeStamp &&
        (nativeStamp.runId !== target.runId || nativeStamp.bindingGeneration !== target.bindingGeneration)) ||
      (result.observation.currentRun && result.observation.currentRun.runId !== target.runId)
    )
      throw new TypeError('status_reading_context_mismatch');
    const sources = structuredClone(readerSources);
    const summary = structuredClone(result.observation);
    const checkpoint = this.store.prepareCheckpoint({
      checkpoint: result.checkpoint,
      boundary,
      format: checkpointFormat(result.checkpoint),
      recoveryReferences: result.checkpoint.recoveryIndex?.delta.base
        ? [result.checkpoint.recoveryIndex.delta.base]
        : [],
    });
    const token = Object.freeze({ checkpoint }) as PreparedStatusReading;
    this.#readings.set(token, {
      checkpoint,
      boundary,
      summary,
      sources,
      runId: target.runId,
      bindingGeneration: target.bindingGeneration,
    });
    return token;
  }

  /** Reuse the captured reading for no-op or ledger-only changes; no re-prepare/decode of recovery. */
  publish(reading: PreparedStatusReading, facts: WriterFacts, ruleVersion: string, nowMs: number): StatusPublication {
    const captured = this.#readings.get(reading);
    if (!captured) throw new TypeError('status_reading_not_owned');
    const { target } = facts;
    if (
      target.nodeIdentity.kind !== 'session' ||
      !sameSessionRef(target.nodeIdentity.ref, this.#ref) ||
      target.sourceGeneration !== captured.boundary.sourceGeneration ||
      target.runId !== captured.runId ||
      target.bindingGeneration !== captured.bindingGeneration
    )
      throw new TypeError('status_reading_mismatch');
    if (facts.sources?.some((s) => s.evidence.origin === 'transcript'))
      throw new TypeError('status_transcript_requires_new_reading');
    const sources = [...captured.sources, ...(facts.sources ?? [])];
    const prior = this.#prior;
    const commitSeq = (prior?.commitSeq ?? 0) + 1;
    if (!Number.isSafeInteger(commitSeq)) throw new TypeError('observation_sequence_exhausted');
    const seqDomain = prior?.seqDomain ?? `observation:${sessionRefKey(this.#ref)}`;
    const stamp: ObservationStamp = {
      ref: this.#ref,
      seqDomain,
      commitSeq,
      sourceGeneration: target.sourceGeneration,
      inputLedgerSeq: facts.asOfSeq,
      ...(target.runId === undefined ? {} : { runId: target.runId }),
      ...(target.bindingGeneration === undefined ? {} : { bindingGeneration: target.bindingGeneration }),
    };
    // Missing legacy state intentionally supplies no baseline: acknowledge history silently once.
    const result = mergeStatus(
      { ...facts, sources, boundary: captured.boundary, observationStamp: stamp, noticeState: prior?.noticeState },
      prior?.continuity ?? null,
      ruleVersion,
      nowMs
    );
    const missingReportSeq = new Set([
      ...sources.filter((s) => s.evidence.value.report && s.evidence.seq === undefined).map((s) => s.id),
      ...(facts.ledgerFacts ?? []).filter((s) => s.value.report && s.seq === undefined).map((s) => s.id),
    ]);
    for (const sourceId of missingReportSeq)
      result.unavailableReasons.push({ sourceId, reason: 'report_seq_unavailable' });
    const edges = result.notices.filter((edge) => edge.kind !== 'report' || edge.sourceEventSeq !== undefined);
    result.notices = edges;
    let noticeSeq = prior?.noticeState?.noticeSeq ?? prior?.notices.at(-1)?.seq ?? 0;
    const newNotices = edges.map(({ nodeIdentity: _node, ...edge }) => {
      if (!Number.isSafeInteger(++noticeSeq)) throw new TypeError('observation_sequence_exhausted');
      return { ...edge, ref: this.#ref, seqDomain, seq: noticeSeq };
    });
    const notices = newNotices.length
      ? newNotices
      : prior?.observationStamp.runId === target.runId
        ? [...(prior?.notices ?? [])]
        : [];
    const noticeState = compactNoticeState(result.noticeState, noticeSeq, newNotices);
    const summary: ObservationView = {
      ...captured.summary,
      statusProjection: result.projection,
      conflict: result.conflict ?? null,
    };
    const candidate = {
      checkpoint: captured.checkpoint,
      previousCommitSeq: prior?.commitSeq ?? 0,
      boundary: witnessPreparedObservationBoundary(captured.checkpoint, summary, captured.boundary),
      commit: {
        ref: this.#ref,
        sourceGeneration: target.sourceGeneration,
        leaseGeneration: this.#lease.generation,
        seqDomain,
        commitSeq,
        observationStamp: stamp,
        summary,
        continuity: result.continuity,
        notices,
        noticeState,
      },
    };
    const publication = this.store.publishPrepared(candidate, this.#lease);
    // Update only after a successful fenced transaction; busy/CAS/lease failure leaves the baseline untouched.
    const committed: ObservationProjection = publication.changed
      ? { ...candidate.commit, checkpointIdentity: captured.checkpoint.identity }
      : prior!;
    this.#prior = structuredClone(committed);
    if (!publication.changed) {
      result.projection = structuredClone(committed.summary.statusProjection);
      result.continuity = structuredClone(committed.continuity);
    }
    return { publication, committed: structuredClone(committed), merge: result, notices: newNotices };
  }
}

/** Fixed count: <=3 current-episode stamps and <=3 event aliases + two scalar domain counters. */
function compactNoticeState(
  state: NoticeState,
  noticeSeq: number,
  edges: readonly { kind: string; inputStamp: string }[]
): ObservationNoticeState {
  const active = new Map<string, string>();
  for (const input of state.inputStamps) {
    const [identity, kind] = JSON.parse(input) as [string, string];
    if (identity !== state.identityKey) continue;
    if (
      (kind === 'pending' && state.pendingReason !== 'none') ||
      (kind === 'failed' && (state.lastTurnOutcome === 'failed' || state.runState === 'failed')) ||
      (kind === 'uncertain' && state.runState === 'uncertain')
    )
      active.set(kind, input);
  }
  // Stamp text is an identity, never an ordering key (event 100 can sort before event 99).
  for (const edge of edges) if (edge.kind !== 'report') active.set(edge.kind, edge.inputStamp);
  return {
    identityKey: state.identityKey,
    pendingReason: state.pendingReason,
    lastTurnOutcome: state.lastTurnOutcome,
    runState: state.runState,
    inputStamps: [...active.values()].sort(),
    eventStamps: (state.eventStamps ?? []).filter((input) => {
      const [identity, kind] = JSON.parse(input) as [string, string];
      return identity === state.identityKey && active.has(kind);
    }),
    reportSeq: state.reportSeq ?? null,
    noticeSeq,
  };
}

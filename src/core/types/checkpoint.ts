import type { ObservationBoundary } from '../checkpoint.js';
import type { SessionRef } from './identity.js';
import type { NoticeEvent, ObservationCommit, ReaderCheckpoint, ReaderContinuation } from './observation.js';
import type { ReaderBudget } from '../interfaces/harness-adapter.js';

/** Consult 5 G05/G10: reuse B12's captured boundary, with immutable identity fields. */
export type CheckpointBoundary = Readonly<Omit<ObservationBoundary, 'ref' | 'fileId'>> & {
  readonly ref: Readonly<SessionRef>;
  readonly fileId: Readonly<ObservationBoundary['fileId']>;
};

/** Consult 5 G05/G10: formats and legacy runtimes require explicit validation, not just deserialization. */
export interface CheckpointFormat {
  readonly name: string;
  readonly version: number;
  readonly runtime: string | null;
}

declare const checkpointContentIdentity: unique symbol;
/** Consult 5 G10: minted from validated immutable content, never a caller-reported hash. */
export type CheckpointContentIdentity = string & { readonly [checkpointContentIdentity]: true };

/**
 * Consult 5 G09/G10: a source-local immutable recovery-index reference, not a
 * mutable "latest map". Its identity and captured boundary participate in the
 * enclosing checkpoint's validated content identity.
 */
export interface RecoveryIndexReference {
  readonly indexId: string;
  readonly recoveryVersion: string;
  readonly contentIdentity: CheckpointContentIdentity;
  readonly boundary: CheckpointBoundary;
}

/** Consult 5 G10: identity covers inline content AND all recovery-index contents/boundaries. */
export type CheckpointIdentity = CheckpointBoundary & {
  readonly format: CheckpointFormat;
  readonly contentIdentity: CheckpointContentIdentity;
  readonly recoveryReferences: readonly RecoveryIndexReference[];
};

/**
 * Consult 5 G10: input to B12R's trusted preparation entry. It must detach from
 * mutable inputs and validate the compact checkpoint, format and every recovery
 * reference against this boundary before minting a prepared token.
 */
export interface CheckpointPreparation {
  readonly checkpoint: ReaderCheckpoint;
  readonly boundary: ObservationBoundary;
  readonly format: CheckpointFormat;
  readonly recoveryReferences: readonly RecoveryIndexReference[];
}

// A private class member is absent from object spread as well as external object
// literals. This is a type-only token; B12R supplies the trusted implementation.
declare class PreparedCheckpointToken {
  private readonly preparedCheckpoint: void;
}

/**
 * Consult 5 G10: opaque validation result, not a collect lease or cached publish
 * permission. No public constructor/factory is implemented by O5APPLY.
 */
export interface PreparedCheckpoint extends PreparedCheckpointToken {
  readonly identity: CheckpointIdentity;
}

/**
 * Consult 5 G10: one committed projection snapshot; it deliberately contains no
 * recovery body. Preserve its original observationStamp when combining ledger data.
 */
export type ObservationProjection = Readonly<Omit<ObservationCommit, 'checkpoint' | 'notices'>> & {
  readonly checkpointIdentity: CheckpointIdentity;
  readonly notices: readonly NoticeEvent[];
};

/** Consult 5 G10: recovery selects this exact commit and content, never a later "current" value. */
export type ObservationRecoveryTarget = Pick<
  ObservationProjection,
  'ref' | 'sourceGeneration' | 'seqDomain' | 'commitSeq' | 'checkpointIdentity'
>;

/** Consult 5 G10: collector-only recovery data and references for the selected committed snapshot. */
export interface ObservationRecovery {
  readonly target: ObservationRecoveryTarget;
  readonly checkpoint: ReaderCheckpoint;
  readonly recoveryReferences: readonly RecoveryIndexReference[];
}

/** Exact source-local metadata only. A null value deletes a key; values are JSON metadata. */
export interface RecoveryIndexEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: string | null;
}

/** Reader-produced changes since the immutable base; preparation validates and detaches them. */
export interface RecoveryIndexDelta {
  readonly recoveryVersion: string;
  readonly base: RecoveryIndexReference | null;
  readonly entries: readonly RecoveryIndexEntry[];
}

/**
 * B12M: statistics of one metered observation-store read, reported on every outcome (value, continuation, refusal,
 * stale, and a throw after partial work).
 *
 * - `bytesRead` is LOGICAL DECODED PAYLOAD: the sum of the UTF-8 byte lengths of the TEXT values this call
 *   materialized from SQLite into JavaScript (checkpoint body and identity, index lineage, entry keys and values).
 *   Size probes (`octet_length`), integers and equality checks evaluated inside SQLite count 0 bytes. It is NOT
 *   storage I/O: SQLite page, overflow-chain, WAL-frame, B-tree interior and OS page-cache reads are not observed and
 *   are not claimed.
 * - `recordsRead` counts logical records materialized: 1 per recovered checkpoint, 1 per looked-up value fetched,
 *   1 per page entry fetched. Probes and refused/stale results count 0.
 * - `elapsedMs` is the monotonic wall time spent inside the call on the grant's clock, probes, refusals and the read
 *   snapshot's COMMIT included.
 */
export interface RecoveryReadStats {
  readonly bytesRead: number;
  readonly recordsRead: number;
  readonly elapsedMs: number;
}

/**
 * B12M: the active collection grant (the remaining shared `ReaderBudget` and its cooperative deadline) that metered
 * recovery reads are admitted against and charged to. Every metered read charges its statistics to the grant exactly
 * once; `drain()` hands out what was charged since the previous drain, so several drainers (reader and collector)
 * never count the same work twice.
 */
export interface RecoveryReadGrant {
  /** Monotonic clock (ms) shared by the deadline and `elapsedMs`. */
  now(): number;
  /** Remaining allowance at this instant; `budgetMs` is the time left until the deadline (never negative). */
  remaining(): ReaderBudget;
  /** Adds work to the grant. The store calls this once per metered read. */
  charge(stats: RecoveryReadStats): void;
  /** Statistics charged since the previous drain; resets the undrained accumulator, not the remaining allowance. */
  drain(): RecoveryReadStats;
}

/** B12M: why a metered lookup did not fetch. `bytes`: the value does not fit the remaining bytes. */
export type RecoveryReadRefusalReason = 'bytes' | 'deadline';

/**
 * B12M: a metered lookup outcome. `stale`: the commit the lookup was created for (at recovery or commit ACK) is no
 * longer the current commit of its session; nothing was read from the replacing commit. A refusal never carries a
 * partial value.
 */
export type MeteredLookupResult<T> =
  | { readonly kind: 'value'; readonly value: T; readonly stats: RecoveryReadStats }
  | {
      readonly kind: 'refused';
      readonly reason: RecoveryReadRefusalReason;
      /** For `bytes`: the payload bytes this exact request needs. */
      readonly minimumBytes?: number;
      readonly stats: RecoveryReadStats;
    }
  | { readonly kind: 'stale'; readonly stats: RecoveryReadStats };

/**
 * B12M: a metered `readRecovery` outcome; never a partial read. `stale` is the legacy `null`: the selected target is
 * not the current commit. A continuation is the legacy continuation (`record_needs_larger_slice` with the actual
 * payload bytes the recovery needs, or `recovery_catching_up` when time or records are exhausted).
 */
export type MeteredRecoveryResult =
  | { readonly kind: 'recovered'; readonly recovery: ObservationRecovery; readonly stats: RecoveryReadStats }
  | { readonly kind: 'continuation'; readonly continuation: ReaderContinuation; readonly stats: RecoveryReadStats }
  | { readonly kind: 'stale'; readonly stats: RecoveryReadStats };

/** Collector-only, exact-key and bounded-page reads pinned to one immutable snapshot. */
export interface RecoveryIndexLookup {
  readonly reference: RecoveryIndexReference;
  get(namespace: string, key: string): string | undefined;
  page(namespace: string, after: string | null, limit: number): readonly RecoveryIndexEntry[];
  /**
   * B12M: metered exact-key read, admitted against and charged to `grant`, pinned to the commit this lookup was
   * created for. Store-created lookups always provide it; other implementations may omit it.
   */
  getMetered?(grant: RecoveryReadGrant, namespace: string, key: string): MeteredLookupResult<string | undefined>;
  /** B12M: metered bounded page; same admission, pinning and charging as `getMetered`. */
  pageMetered?(
    grant: RecoveryReadGrant,
    namespace: string,
    after: string | null,
    limit: number
  ): MeteredLookupResult<readonly RecoveryIndexEntry[]>;
}

/** Optional live handoff; never encoded into a durable checkpoint. */
export interface RecoveryIndexHandoff {
  readonly delta: RecoveryIndexDelta;
  readonly lookup?: RecoveryIndexLookup;
  /** Publication acknowledgement retires only the entries captured in this delta. */
  committed?(lookup: RecoveryIndexLookup): void;
}

import type { ObservationBoundary } from '../checkpoint.js';
import type { SessionRef } from './identity.js';
import type { NoticeEvent, ObservationCommit, ReaderCheckpoint } from './observation.js';

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

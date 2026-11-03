import type { ObservationBoundaryWitness, ObservationCandidate } from '../checkpoint.js';
import type { PublishResult } from '../observation-store.js';
import type {
  CheckpointPreparation,
  MeteredRecoveryResult,
  ObservationProjection,
  ObservationRecovery,
  ObservationRecoveryTarget,
  PreparedCheckpoint,
  RecoveryReadGrant,
} from '../types/checkpoint.js';
import type { SessionRef } from '../types/identity.js';
import type { CollectLease, ObservationCommit, ReaderContinuation } from '../types/observation.js';
import type { ReaderBudget } from './harness-adapter.js';

/**
 * Consult 5 G05/G10: use the existing candidate/witness contract. B16 captures
 * checkpointBoundary on one ReaderResult before its sole merge; B12R binds that
 * witness to prepared content identity without rescanning unchanged recovery.
 */
export type PreparedObservationCandidate = Readonly<Omit<ObservationCandidate, 'commit'>> & {
  readonly commit: Readonly<Omit<ObservationCommit, 'checkpoint'>>;
  readonly checkpoint: PreparedCheckpoint;
  readonly boundary: ObservationBoundaryWitness;
};

/** Consult 5 G10: future trusted preparation API; no runtime implementation is added here. */
export interface CheckpointPreparer {
  prepareCheckpoint(input: CheckpointPreparation): PreparedCheckpoint;
}

/**
 * Consult 5 G10/G11: B12R's future store API, separate from the currently
 * implemented ObservationStore. These declarations do not claim it already
 * implements preparation, cheap projection reads or bounded indexed recovery.
 */
export interface PreparedObservationStore {
  /** Recheck this instance's lease and previousCommitSeq in the single fenced publication transaction. */
  publishPrepared(candidate: PreparedObservationCandidate, lease: CollectLease): PublishResult;
  /** One committed snapshot; do not decode recovery or run a reader on this path. */
  readProjection(ref: SessionRef): ObservationProjection | null;
  /**
   * Collector-only bounded restoration of the exact target; never silently
   * substitute a newer commit. A continuation retains the supplied target.
   */
  readRecovery(
    target: ObservationRecoveryTarget,
    budget: ReaderBudget
  ): ObservationRecovery | ReaderContinuation | null;
  /**
   * B12M: the metered form of readRecovery. Size-probes before fetching, admits against the grant's remaining
   * bytes/records/deadline, and charges the grant exactly once on every outcome, including a throw after work.
   */
  readRecoveryMetered?(target: ObservationRecoveryTarget, grant: RecoveryReadGrant): MeteredRecoveryResult;
  /**
   * B12M: makes `grant` the one grant that lazy `get`/`page` calls on this store's lookups are admitted against and
   * charged to (none active: unmetered legacy behaviour). Refused with `recovery_grant_active` while another
   * activation is open. Returns the deactivator for exactly this activation (idempotent; a no-op after close).
   */
  activateRecoveryGrant?(grant: RecoveryReadGrant): () => void;
}

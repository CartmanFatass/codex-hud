import type { RecoveryIndexHandoff } from './checkpoint.js';
import type { SessionRef } from './identity.js';

export interface Coverage {
  state: 'complete' | 'partial' | 'catching_up';
  skipped: Record<string, number>;
  gaps: string[];
  remainingBytes?: number;
  loaded: boolean;
  reason?: string;
}

/** Consult 5 G11: recovery/index preparation progress is not a larger-record byte request. */
export type ReaderContinuation =
  | { kind: 'record_needs_larger_slice'; minimumBytes: number }
  | {
      kind: 'recovery_catching_up';
      coverage: Coverage & { state: 'catching_up' };
      minimumBytes?: never;
    };

export interface ReaderParserState {
  /** Schema-v1 compatibility field; durable checkpoints always contain []. Raw tails are live-reader-only. */
  pendingBytes: number[];
  /** Uncommitted byte count only; offset and summaries remain at the last complete record. */
  tailBytesSeen?: number;
  /** An incomplete fixed-EOF record keeps coverage partial even with empty pendingBytes. */
  tailAtEof?: boolean;
  discardingOversize: boolean;
  /** Durable next byte to discard; no oversized record body is retained. */
  discardOffset?: number | null;
  usageMessageIds: string[];
  compactBoundary: string | null;
  openToolWaits: { id: string; startedAt: number; lastActivityAt: number }[];
  rateBaseline: { outputTokens: number; measuredAt: number } | null;
  gaps: string[];
  skipped: Record<string, number>;
}

export interface ReaderCheckpoint {
  /** Optional live index handoff; preparation stores only its validated immutable reference. */
  recoveryIndex?: RecoveryIndexHandoff;
  schemaVersion: 1;
  readerVersion: string;
  ref: SessionRef;
  fileId: { dev: number; inode: number };
  offset: number;
  sourceGeneration: number;
  parserState: ReaderParserState;
  resetReason?: 'truncated' | 'file_changed' | 'compaction' | 'branch_changed';
}

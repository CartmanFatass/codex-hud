import type { RecoveryIndexHandoff } from './checkpoint.js';
import type { SessionRef } from './identity.js';
import type { Run, RunState } from './execution.js';
import type { Report, RunHandshake } from './lifecycle.js';

export type Metric<T> = {
  source: string;
  asOf: number;
} & ({ value: T; quality: 'reported' | 'estimated' } | { value: null; quality: 'unknown' });

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface Spent {
  tokens: Metric<TokenUsage>;
  costUsd: Metric<number>;
}

export interface ProjectOrigin {
  repoId: string;
  basis: 'declared';
  declaredAt: number;
}

export interface WorkspaceProvenance {
  cwdSource: string;
  cwdAsOf: number;
  gitCapturedAt: number | null;
  gitMissingReason: string | null;
}

export interface RunWorkspaceSnapshot extends WorkspaceProvenance {
  worktreeRoot: string | null;
  worktree?: string;
  gitCommonDir: string | null;
  repoId: string | null;
  identityKind: 'git-common-dir-v1';
  scope: 'local';
}

export interface WorkspaceContext extends RunWorkspaceSnapshot {
  cwd: string | null;
  projectOrigin: ProjectOrigin | null;
}

/** Future C-stage identity only; no browser storage or positive MVP capability. */
export interface JobRef {
  kind: 'jev';
  provider: string;
  account?: string;
  key: string;
}

export type DisplayNodeIdentity =
  { kind: 'session'; ref: SessionRef } | { kind: 'delegationIntent'; linkId: string } | { kind: 'job'; ref: JobRef };

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

export type Activity = 'working' | 'waiting_input' | 'idle' | 'exited' | 'unknown';
/** Consult 6 H12: the latest accepted blocked report is an independent needs_human source.
 * It grants no control authority and does not resolve another episode or terminate the run.
 */
export type PendingReason = 'none' | 'approval' | 'question' | 'needs_human';
/** Consult 6 H12: explicit outcomes survive independent pending/blocked classification. */
export type LastTurnOutcome = 'none' | 'completed' | 'failed' | 'interrupted';
export type Liveness = 'alive' | 'gone' | 'unknown';
export type EvidenceValidity = 'current' | 'stale' | 'unknown' | 'conflict';
export type EvidenceOrigin = 'registry' | 'transcript' | 'supervisor' | 'report' | 'job';

export interface EvidenceTimes {
  eventAt: number | null;
  observedAt: number;
  lastSuccessfulReadAt: number | null;
}

export type ObservationEvidence = EvidenceTimes & {
  seq?: number;
  evidenceId?: string;
  validity: EvidenceValidity;
  reason?: string;
  value: unknown;
} & (
    | {
        origin: EvidenceOrigin;
        ref: SessionRef;
        runId?: string;
        bindingGeneration?: number;
        sourceGeneration: number;
        nodeIdentity?: never;
      }
    | {
        origin: 'ledger';
        nodeIdentity: { kind: 'delegationIntent'; linkId: string };
        currentRunId: string;
        ref?: never;
        sourceGeneration?: never;
      }
  );

export interface RegistryObservation {
  server: string;
  occupant: SessionRef | null;
  completionSeq: number | null;
  sourceClockAt: number | null;
  activity: Activity;
  pendingReason: PendingReason;
}

export interface FreshnessSource {
  id: string;
  validity: EvidenceValidity;
  lastEvidenceAt: number | null;
  observedAt: number | null;
  lastSuccessfulReadAt: number | null;
  deadlineAt: number | null;
  error?: string;
  reason?: string;
  clockAnomaly?: boolean;
}

export interface Freshness {
  state: 'fresh' | 'stale' | 'unknown';
  sources: FreshnessSource[];
  requiredSourceIds: string[];
  staleSince: number | null;
  reason: string | null;
  clockAnomaly: boolean;
}

export interface ObservationStamp {
  seqDomain: string;
  commitSeq: number;
  inputLedgerSeq: number | null;
  ref: SessionRef;
  runId?: string;
  bindingGeneration?: number;
  sourceGeneration: number;
}

export type StateSinceBasis = 'event' | 'observed' | 'unknown';

export type StateContinuity = {
  ruleVersion: string;
  bindingGeneration?: number;
  episodeAnchor: string | null;
  stateKey: string;
  stateSince: number | null;
  stateSinceBasis: StateSinceBasis;
} & (
  | {
      nodeIdentity: Extract<DisplayNodeIdentity, { kind: 'session' | 'job' }>;
      runId?: string;
      sourceGeneration: number;
    }
  | {
      nodeIdentity: Extract<DisplayNodeIdentity, { kind: 'delegationIntent' }>;
      runId: string;
      ref?: never;
      sourceGeneration?: never;
    }
);

export interface StatusProjection {
  activity: Activity;
  pendingReason: PendingReason;
  lastTurnOutcome: LastTurnOutcome;
  liveness: Liveness;
  freshness: Freshness;
  stateKey: string;
  stateSince: number | null;
  stateSinceBasis: StateSinceBasis;
  isRunTerminal: boolean | null;
  asOfSeq: number | null;
  observationStamp: ObservationStamp | null;
  asOf: number | null;
  observedAt: number;
  lastEvidenceAt: number | null;
  lastKnownActivity?: Activity;
}

export interface NoticeEvent {
  seq: number;
  seqDomain: string;
  created_at: number;
  ref: SessionRef;
  runId?: string;
  kind: 'pending' | 'failed' | 'report' | 'uncertain';
  inputStamp: string;
  sourceEventSeq?: number;
}

export interface CollectLease {
  resource: string;
  holder: string;
  generation: number;
  expires_at: number;
}

export interface ObservationView {
  nodeIdentity: DisplayNodeIdentity;
  currentRun?: Run | null;
  linkId?: string;
  runHandshake?: RunHandshake;
  latestReportForRun?: Report | null;
  statusProjection: StatusProjection;
  conflict: { count: number; recordIds: string[]; since: number } | null;
  spent: Spent;
  workspace: WorkspaceContext | null;
  coverage: Coverage;
  loaded: boolean;
  depth: number;
  evidenceStamp: string;
  model?: Metric<string>;
  effort?: Metric<string>;
  context?: Metric<{ used: number; window: number; percent: number }>;
  /** Optional C-stage read projection, never an ownership key. */
  holderLabel?: string;
}

/** B16: bounded current-identity baseline, atomically published with its projection.
 * At most one episode stamp and one event alias per pending/failed/uncertain kind (six total).
 * reportSeq is only a ledger report.received cursor; noticeSeq is only this observation domain.
 */
export interface ObservationNoticeState {
  identityKey: string;
  pendingReason: PendingReason;
  lastTurnOutcome: LastTurnOutcome;
  runState: RunState | null;
  inputStamps: string[];
  eventStamps: string[];
  reportSeq: number | null;
  noticeSeq: number;
}

export interface ObservationCommit {
  ref: SessionRef;
  sourceGeneration: number;
  leaseGeneration: number;
  seqDomain: string;
  commitSeq: number;
  observationStamp: ObservationStamp;
  checkpoint: ReaderCheckpoint;
  summary: ObservationView;
  continuity: StateContinuity;
  notices: NoticeEvent[];
  noticeState?: ObservationNoticeState;
}

export interface RunExecutionProjection {
  isRunTerminal: boolean | null;
  execution: 'non_execution' | 'managed' | 'unmanaged';
  launchFailure: { stateKey: 'launch_failed'; reason: string | null } | null;
}

export interface ObservationTarget {
  asOfSeq: number | null;
  ref: SessionRef;
  runId?: string;
  bindingGeneration?: number;
  sourceGeneration: number;
}

export interface ObservationSelection<T> {
  asOfSeq: number | null;
  observation: T | null;
  observationStamp: ObservationStamp | null;
  rejectedObservationStamp: ObservationStamp | null;
  unavailableReason: string | null;
}

export interface CostTotal {
  value: number | null;
  knownCount: number;
  missingCount: number;
  coverage: 'complete' | 'partial';
  quality: Metric<number>['quality'];
  isLowerBound: boolean;
}

export interface TreeInputNode {
  identity: DisplayNodeIdentity;
  readBytes: number;
  children: { key: string; kind: 'current' | 'historical' | 'candidate' }[];
}

export interface TreePlanNode {
  identity: DisplayNodeIdentity;
  key: string;
  parentKey: string | null;
  depth: number;
  loaded: boolean;
}

export interface TreePlan {
  nodes: TreePlanNode[];
  readBytes: number;
  continuation: string[];
  confirmedSessionCount: number;
}

/** Small explicit execution facts; full status source selection belongs to B16. */
export type ProjectionRun = { state: RunState; reason?: string | null };

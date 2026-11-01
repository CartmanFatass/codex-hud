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

export interface ReaderParserState {
  /** UTF-8 bytes, including an incomplete code point; never a decoded partial string. */
  pendingBytes: number[];
  discardingOversize: boolean;
  usageMessageIds: string[];
  compactBoundary: string | null;
  openToolWaits: { id: string; startedAt: number; lastActivityAt: number }[];
  rateBaseline: { outputTokens: number; measuredAt: number } | null;
  gaps: string[];
  skipped: Record<string, number>;
}

export interface ReaderCheckpoint {
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
export type PendingReason = 'none' | 'approval' | 'question' | 'needs_human';
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
  runId?: string;
  bindingGeneration?: number;
  episodeAnchor: string | null;
  stateKey: string;
  stateSince: number | null;
  stateSinceBasis: StateSinceBasis;
} & (
  | {
      nodeIdentity: Extract<DisplayNodeIdentity, { kind: 'session' | 'job' }>;
      sourceGeneration: number;
    }
  | {
      // 待 ARCH 裁决: ledger-only intent has no fabricated source generation.
      nodeIdentity: Extract<DisplayNodeIdentity, { kind: 'delegationIntent' }>;
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

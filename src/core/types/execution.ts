import type { JsonObject, JsonValue } from '../canonical.js';
import type { ControlInitiator, Harness, OwnerKey, SessionRef, SourceId } from './identity.js';
import type { ProjectOrigin, RunWorkspaceSnapshot } from './observation.js';
import type { ProcessScope, ProcessStamp } from './supervision.js';

export type RunState = 'starting' | 'running' | 'cancelling' | 'uncertain' | 'ended' | 'failed' | 'cancelled';
export type RunMode = 'visible' | 'headless';
export type RunOperation = 'spawn' | 'resume' | 'handover';
export type LaunchPhase = 'reserved' | 'armed' | 'submitting' | 'submitted' | 'never_submitted';
export type OrphanPolicy = 'continue' | 'stop';
export type SupervisionStrategy = 'headless' | 'wrapper';
export type ExitSource = 'wait_status' | 'trusted_harness_result';

export interface Run {
  runId: string;
  linkId: string;
  runSeq: number;
  operation: RunOperation;
  targetSessionRef: SessionRef | null;
  sourceId: SourceId;
  harness: Harness;
  expectedGeneration: number;
  mode: RunMode;
  readonly launchCwd: string;
  workspaceSnapshot: RunWorkspaceSnapshot | null;
  readonly projectOrigin: ProjectOrigin | null;
  supervisionStrategy: SupervisionStrategy;
  scopeKind: 'pgid';
  scopeRef: ProcessScope | null;
  state: RunState;
  locator: JsonObject | null;
  launchTokenHash: string;
  launchDigest: string;
  launchPhase: LaunchPhase;
  launchCallId: string;
  launchCorrelationId: string;
  launchMessageId: string | null;
  supervisor: ProcessStamp | null;
  heartbeatAt: number | null;
  heartbeatSeq: number;
  heartbeatMonoMs: number | null;
  cancelRequestedAt: number | null;
  submissionFencedAt: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitSource: ExitSource | null;
  shellStatus: number | null;
  shellSignal: string | null;
  terminalEvidenceId: string | null;
  orphanPolicy: OrphanPolicy;
}

export interface AcceptedIntent {
  actor: ControlInitiator;
  operation: RunOperation;
  linkId: string;
  runId: string;
  requestKey: string;
  ownerKey: OwnerKey;
  paramsVersion: 1;
  paramsDigest: string;
}
export interface LedgerMetadata {
  readonly ledgerId: string;
}
export interface RunSlot {
  slotKey: string;
  sessionRef: SessionRef | null;
  runId: string;
  holder: string;
  acquiredAt: number;
}
export interface IdempotencyRecord {
  ownerKey: OwnerKey;
  readonly originOwnerKey: OwnerKey;
  requestKey: string;
  readonly paramsVersion: 1;
  readonly paramsDigest: string;
  readonly linkId: string | null;
  readonly runId: string | null;
  readonly outcome: JsonValue;
  readonly at: number;
}
export type EvidenceKind =
  | 'launch_receipt'
  | 'trusted_session'
  | 'transcript'
  | 'exit_receipt'
  | 'group_check'
  | 'never_submitted'
  | 'heartbeat'
  | 'conflict'
  | 'conflict_resolved'
  | 'scope_reconciled';
export type LedgerWriter = 'hud-mcp' | 'hud-run' | 'reconciler';
export type EvidenceValidation = 'pending' | 'accepted' | 'rejected';
export interface Evidence {
  evidenceId: string;
  runId: string | null;
  linkId: string | null;
  kind: EvidenceKind;
  producer: LedgerWriter;
  fingerprint: string;
  payload: JsonObject;
  observedAt: number;
  validatedAt: number | null;
  validation: EvidenceValidation;
}
/** Ledger event kinds deliberately remain open, unlike the evidence whitelist. */
export interface LedgerEvent {
  seq: number;
  linkId: string | null;
  runId: string | null;
  kind: string;
  payload: JsonObject;
  at: number;
}
export type ScopeLiveness = 'alive' | 'gone' | 'unknown';
export type HeartbeatQuality = 'fresh' | 'stale' | 'unknown';
export type ReconciliationCause =
  | 'supervisor_dead'
  | 'scope_unknown'
  | 'resume_ref_mismatch'
  | 'clock_anomaly'
  | 'supervisor_stale'
  | 'submission_unknown'
  | 'cancel_unconfirmed'
  | 'identity_conflict'
  | 'scope_conflict'
  | 'provisional_conflict'
  | 'launch_timeout'
  | 'unknown';

/** Validated facts supplied by a writer; this pure layer cannot validate OS facts. */
export type ReconcileFact =
  | { kind: 'scope'; state: ScopeLiveness; complete: boolean; harnessTerminated: boolean; launchersSealed: boolean }
  | { kind: 'heartbeat'; at: number; clockAnomaly?: boolean }
  | {
      kind: 'receipt' | 'scope_reconciled';
      complete: boolean;
      harnessTerminated: boolean;
      launchersSealed: boolean;
      nativeExit: { code: number | null; signal: string | null; source: ExitSource } | null;
    }
  | { kind: 'never_submitted'; permanentFence: boolean; launchersSealed: boolean; noExecution: boolean }
  | { kind: 'supervisor'; state: 'alive' | 'dead' | 'unknown' }
  | { kind: 'launch'; childStarted: boolean; originalExecutorValid: boolean; observedAt: number }
  | { kind: 'cancel'; chronology: 'before_exit' | 'after_exit' | 'unknown' }
  | { kind: 'cancel_channel'; valid: boolean }
  | { kind: 'conflict'; cause: ReconciliationCause };
export interface ReconcileEvidence {
  evidenceId: string;
  runId: string;
  sourceId: SourceId;
  bindingGeneration: number;
  supervisor: ProcessStamp | null;
  validation: EvidenceValidation;
  /** Validated fact time: scope.checked_at, receipt.ended_at, or composite proof asOf. */
  asOf: number | null;
  /** Discovery/import time, which must never decide factual precedence. */
  observedAt: number;
  fact: ReconcileFact;
}
export interface ReconcileDecision {
  row: string;
  state: RunState;
  releaseSlot: boolean;
  emitTransition: boolean;
  blockNewOperations: boolean;
  evidenceIds: string[];
  auditEvidenceIds: string[];
  cause: ReconciliationCause | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitSource: ExitSource | null;
}

import type { JsonObject } from '../canonical.js';
import type { Claim, ChildBinding, CallerId, ControlInitiator, OwnerKey, SessionRef } from './identity.js';
import type { LedgerEvent, OrphanPolicy, ReconciliationCause, Run, RunMode, TerminalNote } from './execution.js';
import type { ObservationStamp, StatusProjection } from './observation.js';

export type LinkState = 'pending' | 'claimed' | 'bound' | 'reported' | 'closed' | 'failed' | 'revoked' | 'handed_over';
export interface Link {
  linkId: string;
  state: LinkState;
  parentCaller: CallerId;
  parentContextId: string;
  parentContextGeneration: number;
  parentRef: SessionRef | null;
  childRef: SessionRef | null;
  currentOwner: boolean;
  backend: string;
  role: string;
  label: string | null;
  briefPath: string;
  taskDigest: string;
  reportPath: string | null;
  predecessor: string | null;
  routing: JsonObject | null;
  createdAt: number;
  claimedAt: number | null;
  boundAt: number | null;
  closedAt: number | null;
}
export type RunHandshakeState = 'pending' | 'claimed' | 'bound';
export interface RunHandshake {
  state: RunHandshakeState;
  reason: string | null;
}
export type ReportStatus = 'completed' | 'failed' | 'blocked' | 'interrupted';
export interface Report {
  reportId: string;
  runId: string;
  linkId: string;
  childBindingId: string;
  callerId: CallerId;
  callerContextId: string;
  contextGeneration: number;
  status: ReportStatus;
  summary: string;
  path: string | null;
  createdAt: number;
}
export interface CommittedReport {
  report: Report;
  seq: number;
}
export type ActionDescriptor = {
  linkId: string;
  runId: string;
  reason: string;
  subject: 'local_user';
  delivery: 'copy_only';
  hudHome: string;
  displayCommand: string;
} & ({ operation: 'resume'; expectedRun: string; mode: RunMode; requestKey: string } | { operation: 'reconcile' });
export interface Resumable {
  resumable: boolean;
  reason: string | null;
  subject: 'mcp' | 'local_user';
}
export interface Interaction {
  focus: boolean;
  input: boolean;
  resume: boolean;
}
export interface ParentOffline {
  since: number;
  seq: number;
  orphanPolicy: OrphanPolicy;
}
export interface Reconciliation {
  cause: ReconciliationCause;
  evidenceIds: string[];
  missing: string[];
  observedAt: number;
  allowedActions: ActionDescriptor[];
}
export interface LifecycleStatus {
  link: Link;
  currentRun: Run | null;
  /** Whitelisted terminal-event note for the returned run; never a reconciliation blocker. */
  terminalNote: TerminalNote;
  runHandshake: RunHandshake;
  latestReportForRun: Report | null;
  reconciliation: Reconciliation | null;
  interaction: Interaction;
  parentOffline: ParentOffline | null;
  resumable: Resumable;
  asOfSeq: number | null;
  observationStamp: ObservationStamp | null;
  statusProjection: StatusProjection;
}
export type WaitUntil = 'report' | 'run_terminal' | 'uncertain';
export type WaitRequest = {
  afterSeq?: number;
  until?: WaitUntil[];
  timeoutMs?: number;
} & ({ linkId: string; runId?: never } | { runId: string; linkId?: never });
export interface FixedWait {
  runId: string;
  afterSeq: number;
  until: WaitUntil[];
  timeoutMs: number;
}
export interface WaitPage {
  runId: string;
  events: LedgerEvent[];
  nextSeq: number;
  matched: boolean;
  timedOut: boolean;
  current: Run;
  hasMore: boolean;
  asOfSeq: number;
}

/**
 * Consult 5 G03: only an explicitly supplied MCP precondition enters params_digest.
 * Authorization and same-key replay precede the new-intent currentRun comparison;
 * omission preserves transaction-selected current-run semantics (B45-R2).
 */
export type McpResumeRequest = {
  linkId: string;
  request_key: string;
  mode: RunMode;
  prompt?: string;
  expectedRun?: string;
};

/** Consult 5 G03: the trusted local entry continues to require an explicit target. */
export type LocalResumeRequest = McpResumeRequest & { expectedRun: string };

export interface ResumePlan {
  actor: ControlInitiator;
  ownerKey: OwnerKey;
  link: Link;
  run: Run;
  claim: Claim;
  revokedClaim: Claim | null;
  revokedBinding: ChildBinding | null;
  runHandshake: RunHandshake;
}

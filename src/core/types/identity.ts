import type { ProcessStamp } from './supervision.js';

export type Harness = 'claude' | 'codex' | 'pi';
export type SourceId = string;
export type CallerId = string;
/** Both keys are serialized JSON TEXT, including nested serialized ref/key TEXT. */
export type OwnerKey = string;
export type ProcessKey = string;

export interface Source {
  sourceId: SourceId;
  harness: Harness;
  rootPath: string;
  label: string;
}

export interface SessionRef {
  harness: Harness;
  sourceId: SourceId;
  sessionId: string;
  threadId: string | null;
}

export type ControlInitiator =
  | { kind: 'mcp'; callerId: CallerId; contextId: string; contextGeneration: number }
  | { kind: 'local_user'; uid: number; invocationId: string; representedOwner: OwnerKey };

export type BoundBy = 'receipt' | 'trusted_session' | 'transcript';
export type InstanceKind = 'dedicated' | 'shared';

export interface Caller {
  callerId: CallerId;
  instanceKind: InstanceKind;
  harness: Harness | null;
  sourceId: SourceId | null;
  pid: number;
  procStart: string;
  ppid: number;
  parentProcStart: string;
  cwd: string;
  envPane: string | null;
  startedAt: number;
  lastSeenAt: number;
  retiredAt: number | null;
}

export type SessionProvenance =
  | { sessionRef: null; boundBy: null; bindingEvidenceId: null }
  | { sessionRef: SessionRef; boundBy: BoundBy; bindingEvidenceId: string };

export type CallerScope = SessionProvenance & {
  processKey: ProcessKey;
  generation: number;
  harness: Harness;
  sourceId: SourceId;
  pidDomain: string;
  harnessPid: number;
  harnessProcStart: string;
  createdAt: number;
  closedAt: number | null;
};

interface ContextBase {
  contextId: string;
  generation: number;
  callerId: CallerId;
  harness: Harness;
  sourceId: SourceId;
  selectionEvidenceId: string | null;
  createdAt: number;
  closedAt: number | null;
}
export type CallerContext = ContextBase &
  SessionProvenance &
  (
    | { kind: 'dedicated'; contextKey: 'stdio'; processKey: ProcessKey; procGeneration: number }
    | {
        kind: 'shared';
        contextKey: string;
        processKey: null;
        procGeneration: null;
        sessionRef: SessionRef;
        selectionEvidenceId: string;
      }
  );

export interface OwnerAlias {
  processKey: ProcessKey;
  generation: number;
  sessionRef: SessionRef;
  evidenceId: string;
  createdAt: number;
  closedAt: number | null;
}

export type ClaimState = 'issued' | 'armed' | 'redeemed' | 'revoked' | 'expired';
export interface Claim {
  runId: string;
  claimHash: string;
  sourceId: SourceId;
  expectedGeneration: number;
  supervisor: ProcessStamp | null;
  state: ClaimState;
  issuedAt: number;
  expiresAt: number;
  redeemedContextId: string | null;
  redeemedGeneration: number | null;
  redeemedSessionRef: SessionRef | null;
  redeemedAt: number | null;
}

export interface ClaimRunAnchor {
  runId: string;
  sourceId: SourceId;
  bindingGeneration: number;
  supervisor: ProcessStamp;
  launchCallId: string;
  launchCorrelationId: string;
}

export interface ChildBinding {
  bindingId: string;
  runId: string;
  sessionRef: SessionRef;
  bindingGeneration: number;
  callerId: CallerId;
  callerContextId: string;
  contextGeneration: number;
  boundBy: BoundBy;
  capabilities: 'mcp';
  evidenceId: string;
  isCurrent: boolean;
  createdAt: number;
  revokedAt: number | null;
}

/** A view over persisted run, binding and host evidence, never a new identity. */
export interface RunBinding {
  runId: string;
  sessionRef: SessionRef | null;
  bindingGeneration: number;
  supervisor: ProcessStamp | null;
  harness: ProcessStamp | null;
  occupantGeneration: number | null;
  childBinding: ChildBinding | null;
}

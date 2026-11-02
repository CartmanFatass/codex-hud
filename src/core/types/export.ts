import type { SessionRef } from './identity.js';
import type { RunOperation, RunState } from './execution.js';
import type { LinkState } from './lifecycle.js';
import type { ProjectOrigin, RunWorkspaceSnapshot, Coverage } from './observation.js';

export type { UniversalSnapshotV3, UniversalSnapshotNode } from '../interfaces/snapshot-v3.js';

export type OutboundPurpose =
  | 'brief'
  | 'recap'
  | 'progress'
  | 'digest'
  | 'label'
  | 'title'
  | 'cause'
  | 'changes'
  | 'approval'
  | 'probe'
  | 'jev_task'
  | 'routing';

export interface OutboundPolicy {
  schemaVersion: 1;
  sourceId: string;
  revision: number;
  grants: {
    purpose: OutboundPurpose;
    recipientId: string;
    decision: 'allow' | 'deny';
    grantedAt: number;
  }[];
}

export interface MaterialProvenance {
  sourceId: string;
  ref: SessionRef;
  origin: 'native' | 'delegated';
  field: string;
  recordFingerprint: string;
}

/** B17's typed boundary only; this slice does not build prompts, caches, or transports. */
export interface MaterialEnvelope {
  fragments: { text: string; provenance: MaterialProvenance[] }[];
  sources: string[];
  purpose: OutboundPurpose;
  recipientId: string;
  policyRevision: Record<string, number>;
  fingerprint: string;
  coverage: Coverage;
  cacheDomain: string;
}

export type VersionDomain = 'public_snapshot' | 'checkpoint' | 'ledger' | 'delegation_export' | 'scan';

export type ExportPaths = 'none' | 'local';
export type ExportScope = { kind: 'all' } | { kind: 'links'; linkIds: string[] };

export type BindingReasonCode =
  | 'identity_source_missing'
  | 'identity_unverified'
  | 'identity_conflict'
  | 'resume_ref_mismatch'
  | 'unsupported'
  | 'unavailable'
  | 'unknown';
export type HandshakeReasonCode =
  BindingReasonCode | 'claim_missing' | 'claim_revoked' | 'claim_expired' | 'claim_conflict' | 'stale_binding';
export type GitMissingReasonCode = 'not_git' | 'timeout' | 'unavailable' | 'unknown';
export type CwdSourceCode = 'launch' | 'registry' | 'transcript' | 'supervisor';

export interface ExportWorkspaceSnapshot {
  repoId: string | null;
  identityKind: 'git-common-dir-v1';
  scope: 'local';
  /** Only protocol source codes, otherwise null; never arbitrary diagnostic text. */
  cwdSource: CwdSourceCode | null;
  cwdAsOf: number;
  gitCapturedAt: number | null;
  gitMissingReason: GitMissingReasonCode | null;
}

export interface DelegationExportRecord {
  linkId: string;
  runId: string;
  runSeq: number;
  operation: RunOperation;
  linkState: LinkState | 'unknown';
  runState: RunState | 'unknown';
  isCurrentRun: boolean;
  currentOwner: boolean;
  predecessor: string | null;
  hasUnresolvedConflict: boolean;
  parentRef: SessionRef | null;
  childRef: SessionRef | null;
  relationshipConfirmed: boolean;
  bindingReason: BindingReasonCode | null;
  runHandshake: { state: 'pending' | 'claimed' | 'bound' | 'unknown'; reason: HandshakeReasonCode | null };
  cwdBasis: 'launch';
  cwdCapturedAt: number;
  workspaceSnapshot: ExportWorkspaceSnapshot | null;
  projectOrigin: ProjectOrigin | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface DelegationExportLocalRecord extends Omit<DelegationExportRecord, 'workspaceSnapshot'> {
  launchCwd: string;
  workspaceSnapshot: (ExportWorkspaceSnapshot & { worktreeRoot: string | null }) | null;
}

interface ExportEnvelope {
  format: 'hud-delegation-export';
  schemaVersion: 1;
  ledgerId: string;
  asOfSeq: number;
  exportedAt: number;
  scope: ExportScope;
  coverage: { state: 'complete'; recordCount: number };
}

export type DelegationExportV1 = ExportEnvelope &
  ({ paths: 'none'; records: DelegationExportRecord[] } | { paths: 'local'; records: DelegationExportLocalRecord[] });

/** Explicit ledger read projection. No raw row/table serialization is accepted. */
export interface ExportInputRecord extends Omit<
  DelegationExportRecord,
  'workspaceSnapshot' | 'bindingReason' | 'runHandshake'
> {
  bindingReason: string | null;
  runHandshake: { state: DelegationExportRecord['runHandshake']['state']; reason: string | null };
  launchCwd: string;
  workspaceSnapshot: RunWorkspaceSnapshot | null;
}

export interface ExportInputSnapshot {
  ledgerId: string;
  asOfSeq: number;
  exportedAt: number;
  scope: ExportScope;
  paths: ExportPaths;
  records: readonly ExportInputRecord[];
}

export type ExportResult<T> = { ok: true; value: T } | { ok: false; reason: string };

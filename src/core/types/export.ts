import type { SessionRef } from './identity.js';
import type { RunState } from './execution.js';
import type { LinkState } from './lifecycle.js';
import type {
  ObservationStamp,
  ObservationView,
  ProjectOrigin,
  RunWorkspaceSnapshot,
  Coverage,
  NoticeEvent,
} from './observation.js';

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

export interface UniversalSnapshotV3 {
  version: 3;
  universal: {
    rootRef: SessionRef;
    sourceId: string;
    asOfSeq: number | null;
    observationStamp: ObservationStamp | null;
    asOf: number | null;
    observedAt: number;
    coverage: Coverage;
    tree: {
      nodes: ObservationView[];
      counts: { confirmedSessions: number; delegationIntents: number; jobs: number };
      continuation?: string[];
    };
    notices: NoticeEvent[];
  };
}

export type ExportPaths = 'none' | 'local';
export type ExportScope = { kind: 'all' } | { kind: 'links'; linkIds: string[] };

export interface ExportWorkspaceSnapshot {
  repoId: string | null;
  identityKind: 'git-common-dir-v1';
  scope: 'local';
  /** Only protocol source codes, otherwise null; never arbitrary diagnostic text. */
  cwdSource: string | null;
  cwdAsOf: number;
  gitCapturedAt: number | null;
  gitMissingReason: string | null;
}

export interface DelegationExportRecord {
  linkId: string;
  runId: string;
  runSeq: number;
  linkState: LinkState | 'unknown';
  runState: RunState | 'unknown';
  isCurrentRun: boolean;
  currentOwner: boolean;
  predecessor: string | null;
  hasUnresolvedConflict: boolean;
  parentRef: SessionRef | null;
  childRef: SessionRef | null;
  relationshipConfirmed: boolean;
  bindingReason: string | null;
  runHandshake: { state: 'pending' | 'claimed' | 'bound' | 'unknown'; reason: string | null };
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
export interface ExportInputRecord extends Omit<DelegationExportRecord, 'workspaceSnapshot'> {
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

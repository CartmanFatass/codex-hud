import type { LinkLedgerRead } from '../link-ledger-read.js';
import type { SessionEvidence } from '../interfaces/session-evidence.js';
import type { LedgerReadRun } from '../ledger-read.js';
import type { SessionRef } from '../types/identity.js';
import type { Link, ParentOffline } from '../types/lifecycle.js';
import type {
  Coverage,
  DisplayNodeIdentity,
  ObservationStamp,
  ObservationView,
  RunExecutionProjection,
} from '../types/observation.js';
import type { ReaderResult } from '../interfaces/harness-adapter.js';
import type { LocatorCheck } from '../types/capabilities.js';
import type { JsonObject } from '../canonical.js';
import type { AgentTaskKind } from '../../types.js';

/** Display metadata from an already charged native listing; never identity or binding evidence. */
export interface NativeMetadata {
  title: string | null;
  kind: AgentTaskKind | null;
  /** Exact Codex picker label from the native session header, when known. */
  pickerLabel?: string | null;
}

export type LinkConflict = NonNullable<ObservationView['conflict']>;

/** B10 collection boundary: actual I/O, including signatures/recovery/native listing, charged once per tick. */
export interface CollectedLinkSession {
  evidence: SessionEvidence;
  /** Publication-mode raw anchors may be read, but their unpublished summary is never a display/history value. */
  committedOnly?: boolean;
  lastCommitted?: ObservationView | null;
  /** Process-local sample attached only after the same checkpoint was committed. */
  committedRate?: { rate: NonNullable<ReaderResult['outputRate']>; stamp: ObservationStamp };
  committedAction?: { action: import('../interfaces/session-evidence.js').NativeAction; stamp: ObservationStamp };
  committedProgress?: { progress: NonNullable<SessionEvidence['progress']>; stamp: ObservationStamp };
  sourceGeneration: number;
  /** False for retained anchors from a reset/unknown reading lineage. */
  linkEvidenceCurrent: boolean;
  bytesRead: number;
  recordsRead: number;
  loaded: boolean;
  /** Absent is unknown. Each listing has its own charged collection boundary. */
  topology?: {
    ref: SessionRef;
    sourceGeneration: number;
    children: readonly SessionRef[];
    nativeMetadata?: Readonly<Record<string, NativeMetadata>>;
    loaded: boolean;
    bytesRead: number;
    recordsRead: number;
    coverage: Coverage;
  };
}

/** Metadata from existing observation/discovery only; never a request to open this session. */
export interface LinkCandidateHint {
  ref: SessionRef;
  linkId: string | null;
  kind: 'registry' | 'env' | 'command' | 'label' | 'fork' | 'transcript';
  recordId: string;
  asOf: number | null;
  observedAt: number;
}

export interface LinkCandidate extends LinkCandidateHint {
  reason: string;
}

export interface CollectedLinkHost {
  runId: string;
  bindingGeneration: number;
  /** Exact managed locator which was checked, not a lookup by pane text alone. */
  locator: JsonObject;
  check: LocatorCheck;
  state: JsonObject | null;
}

export interface LinkHostProjection {
  locator: JsonObject | null;
  state: LocatorCheck['state'];
  occupantMatches: boolean | null;
  checkedAt: number | null;
  /** Current host state is absent unless this exact locator/occupant was verified. */
  currentState: JsonObject | null;
}

export interface LinkRelationProjection {
  link: Link;
  currentRun: LedgerReadRun | null;
  parentKey: string | null;
  childKey: string;
  attribution: 'confirmed' | 'intent' | 'history' | 'conflict';
  verification: 'not_observed' | 'corroborated' | 'conflict';
  conflict: LinkConflict | null;
  parentOffline: ParentOffline | null;
  host: LinkHostProjection;
}

export interface LinkTreeNode {
  identity: DisplayNodeIdentity;
  key: string;
  parentKey: string | null;
  edge: 'delegated' | 'native' | 'intent' | null;
  /** Additive transport; populated iff the projected edge is native. */
  native?: NativeMetadata | null;
  depth: number;
  crossHarnessDepth: number;
  loaded: boolean;
  coverage: Coverage;
  observation: ObservationView | null;
  /** Process-local value, present only for this node's exact committed observation stamp. */
  committedRate?: NonNullable<ReaderResult['outputRate']>;
  committedAction?: import('../interfaces/session-evidence.js').NativeAction;
  committedProgress?: NonNullable<SessionEvidence['progress']>;
  /** Preserved for Inspector/history even if its stamp cannot describe the current run. */
  lastObservation: ObservationView | null;
  currentRun: LedgerReadRun | null;
  execution: RunExecutionProjection;
  conflict: LinkConflict | null;
  links: string[];
  host: LinkHostProjection | null;
  parent: {
    identity: DisplayNodeIdentity;
    harness: SessionRef['harness'] | null;
    name: string | null;
    liveness: ObservationView['statusProjection']['liveness'];
    paneLabel: string | null;
  } | null;
}

export interface LinkContinuation {
  key: string;
  identity: DisplayNodeIdentity;
  reason: 'nodes' | 'depth' | 'bytes' | 'unloaded' | 'native_topology';
}

export interface LinkTreeProjection {
  ledger: { state: LinkLedgerRead['state']; ledgerId: string | null; asOfSeq: number | null; reason: string | null };
  nodes: LinkTreeNode[];
  relations: LinkRelationProjection[];
  candidates: LinkCandidate[];
  selectionMap: Record<string, string>;
  continuation: LinkContinuation[];
  truncation: { candidates: number; conflictRecords: number; continuation: number };
  counts: {
    confirmedSessions: number;
    delegationIntents: number;
    jobs: number;
    knownUnloaded: number;
    omitted: number;
    unknownDescendants: boolean;
  };
  io: { bytesRead: number | null; recordsRead: number | null; remainingBytes: number; exceeded: boolean };
  coverage: Coverage;
}

export interface LinkTreeInput {
  ledger: LinkLedgerRead;
  roots: readonly DisplayNodeIdentity[];
  sessions: readonly CollectedLinkSession[];
  candidates?: readonly LinkCandidateHint[];
  hosts?: readonly CollectedLinkHost[];
  /** Caller-retained mappings are composed across successive binds. */
  selectionMap?: Readonly<Record<string, string>>;
  nowMs: number;
  budget?: { maxNodes?: number; maxBytes?: number; maxCrossHarnessDepth?: number };
}

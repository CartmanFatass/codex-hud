import type { capacityProjection } from '../capacity.js';
import type { Report, ActionDescriptor, ParentOffline } from '../types/lifecycle.js';
import type { StatusProjection } from '../types/observation.js';
import type { LinkTreeProjection } from './types.js';
import type { LoadedLimits } from './limits.js';
import type { wakeProjection } from '../wake/projection.js';
import type { ReaderResult } from '../interfaces/harness-adapter.js';

/** Rendering boundary shared by the compact bar and panel. No I/O or mutable collector handles. */
export interface DelegationViewModel {
  tree: LinkTreeProjection;
  nativeCalls?: { count: number; unavailable: string | null };
  /** Null when the ledger is degraded; never claim zero occupancy from an unreadable ledger. */
  capacity: ReturnType<typeof capacityProjection> | null;
  limits: LoadedLimits;
  /** Node-keyed additions; conflicts outside the tree remain in tree.relations. */
  details: Readonly<Record<string, DelegationNodeDetails>>;
  /** Bounded immediate merges still awaiting a later tick. */
  pendingStatus: number;
}
export interface NativeCallDisplay {
  relation: import('../../managed/relations.js').DirectRelation;
  snapshot: unknown;
  latestEvent: import('../../managed/host.js').HostMessage | null;
  unavailable: string | null;
}
export interface JevCallDisplay {
  relation: import('../../managed/jev-host.js').JevRelation;
  snapshot: unknown;
  unavailable: string | null;
  observationSource?: 'run_yield' | 'snapshot' | 'command';
  receivedAt?: number;
}
export interface DelegationNodeDetails {
  jevCall?: JevCallDisplay;
  nativeCall?: NativeCallDisplay;
  action?: import('../interfaces/session-evidence.js').NativeAction;
  progress?: import('../interfaces/session-evidence.js').SessionEvidence['progress'];
  outputRate?: NonNullable<ReaderResult['outputRate']>;
  status: StatusProjection | null;
  statusSource: 'committed' | 'ledger' | 'unavailable';
  latestReportForRun: Report | null;
  reportHistory: readonly Report[];
  parentOffline: ParentOffline | null;
  wake: (ReturnType<typeof wakeProjection>['wake'] & { attempts: number | null }) | null;
  wakeUnavailableReason?: string | null;
  observationUnavailableReason?: string | null;
  reconcile: ActionDescriptor | null;
  resumable: { resumable: false; reason: 'capability_unverified'; subject: 'local_user' } | null;
}
export type HudDelegationData = { delegation?: DelegationViewModel | null };

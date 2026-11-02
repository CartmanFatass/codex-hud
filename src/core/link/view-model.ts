import type { capacityProjection } from '../capacity.js';
import type { Report, ActionDescriptor, ParentOffline } from '../types/lifecycle.js';
import type { StatusProjection } from '../types/observation.js';
import type { LinkTreeProjection } from './types.js';
import type { LoadedLimits } from './limits.js';
import type { wakeProjection } from '../wake/projection.js';

/** Rendering boundary shared by the compact bar and panel. No I/O or mutable collector handles. */
export interface DelegationViewModel {
  tree: LinkTreeProjection;
  /** Null when the ledger is degraded; never claim zero occupancy from an unreadable ledger. */
  capacity: ReturnType<typeof capacityProjection> | null;
  limits: LoadedLimits;
  /** Node-keyed additions; conflicts outside the tree remain in tree.relations. */
  details: Readonly<Record<string, DelegationNodeDetails>>;
  /** Bounded immediate merges still awaiting a later tick. */
  pendingStatus: number;
}
export interface DelegationNodeDetails {
  status: StatusProjection | null;
  statusSource: 'committed' | 'ledger' | 'unavailable';
  latestReportForRun: Report | null;
  reportHistory: readonly Report[];
  parentOffline: ParentOffline | null;
  wake: (ReturnType<typeof wakeProjection>['wake'] & { attempts: number }) | null;
  reconcile: ActionDescriptor | null;
  resumable: { resumable: false; reason: 'capability_unverified'; subject: 'local_user' };
}
export type HudDelegationData = { delegation?: DelegationViewModel | null };

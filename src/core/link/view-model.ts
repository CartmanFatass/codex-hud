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

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Native field names/values only; no idle=>done, timeout=>failure or task status mapping. */
export function nativeCallLabel(call: NativeCallDisplay): string {
  if (call.unavailable) return `native source unavailable: ${call.unavailable}`;
  const snapshot = record(call.snapshot);
  const state = record(snapshot.state);
  const thread = record(snapshot.thread);
  const fields: string[] = [];
  if (thread.status !== undefined) fields.push(`thread.status=${JSON.stringify(thread.status)}`);
  for (const key of ['isStreaming', 'isCompacting', 'pendingMessageCount'])
    if (state[key] !== undefined) fields.push(`cached get_state.${key}=${JSON.stringify(state[key])}`);
  if (snapshot.connected !== undefined) fields.push(`connected=${JSON.stringify(snapshot.connected)}`);
  if (snapshot.disconnected !== undefined) fields.push(`disconnected=${JSON.stringify(snapshot.disconnected)}`);
  if (call.latestEvent)
    fields.push(
      `event=${call.latestEvent.event?.type === 'native_event' || call.latestEvent.event?.type === 'native_result' ? call.latestEvent.event.kind : (call.latestEvent.event?.type ?? call.latestEvent.request?.kind ?? 'native')}`
    );
  return fields.join(' · ') || 'native status unavailable';
}

/** Supplemental native calls must not replace the pre-ledger native UI/collection. */
export function nativeCallsOnly(view: DelegationViewModel | null | undefined): boolean {
  return !!view?.nativeCalls && view.tree.ledger.reason === 'legacy_ledger_not_used';
}

/** Agent.snapshot fields are displayed literally, including future upstream fields. */
export function jevCallLabel(call: JevCallDisplay): string {
  if (call.unavailable) return `Jev snapshot unavailable: ${call.unavailable}`;
  const encoded = JSON.stringify(call.snapshot) ?? 'null';
  const source = call.observationSource
    ? `Agent.${call.observationSource} (receivedAt=${call.receivedAt}; previously received output)`
    : 'Agent.snapshot';
  return `${source}=${encoded.length > 2048 ? encoded.slice(0, 2048) + '…' : encoded}`;
}

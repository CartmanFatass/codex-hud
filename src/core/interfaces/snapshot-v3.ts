import type { HudSnapshot } from '../../snapshot.js';
import type { SessionRef, SourceId } from '../types/identity.js';
import type { ActionDescriptor, LifecycleStatus } from '../types/lifecycle.js';
import type { Coverage, NoticeEvent, ObservationStamp, ObservationView } from '../types/observation.js';
import type { SurfaceLocator } from './session-binding.js';

/** Contract 07 draft only. Explicit separate outlet; never written over a v2 snapshot. All new times are ms epoch. */
export interface UniversalSnapshotV3 {
  version: 3;
  universal: {
    rootRef: SessionRef | null;
    sourceId: SourceId;
    asOfSeq: number | null;
    observationStamp: ObservationStamp | null;
    asOf: number | null;
    observedAt: number;
    coverage: Coverage;
    tree: {
      nodes: UniversalSnapshotNode[];
      counts: { confirmedSessions: number; delegationIntents: number; jobs: number };
      continuation?: string[];
    };
    notices: NoticeEvent[];
  };
}

export interface UniversalSnapshotNode extends ObservationView {
  parent: ObservationView['nodeIdentity'] | null;
  links: LifecycleStatus[];
  candidates: { ref: SessionRef; reason: string }[];
  host: SurfaceLocator | null;
  actions: ActionDescriptor[];
}

/** Old fields retain their exact v2 types; choosing this draft requires a distinct v3 output. */
export type HudSnapshotV3Draft = Omit<HudSnapshot, 'version'> & UniversalSnapshotV3;

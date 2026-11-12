import type { SessionRef } from '../types/identity.js';
import type { JobRef } from '../types/observation.js';

export interface SimulationJobParent {
  ledgerId: string;
  ref: SessionRef;
}
export interface SimulationJob {
  key: string;
  ref: JobRef;
  parentContext?: SimulationJobParent;
  state: 'queued' | 'sent' | 'uncertain' | 'needs_human' | 'answered' | 'failed';
  revision: number;
  browser: string;
  dispatches: number;
  generation: number | null;
  reconciled: boolean;
  answer: string | null;
  lease: { key: string; generation: number } | null;
  holderLabel?: string;
}
export interface SimulationJobDisplay extends SimulationJob {
  provenance: 'SIMULATED';
  availability: 'available' | 'last_known';
  storeId: string;
  storeRevision: number;
  reason: string | null;
}
export interface SimulationJobsStatus {
  provenance: 'SIMULATED';
  availability: 'available' | 'unavailable';
  storeId: string | null;
  revision: number | null;
  lastKnownRevision: number | null;
  reason: string | null;
}

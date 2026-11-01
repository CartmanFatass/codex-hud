import type { SessionRef } from '../types/identity.js';
import type { ObservationEvidence, RegistryObservation } from '../types/observation.js';
import type { SessionBinding, SurfaceLocator } from './session-binding.js';

/** Contract 06 T-06-6: preserve source generation, validity and both observation clocks. */
export type RegistryEvidence = Extract<ObservationEvidence, { ref: SessionRef }> & {
  origin: 'registry';
  value: RegistryObservation;
};

/** Concept §6.9/§6.12: cached observations, never an authorization identity. */
export interface RegistryRecord {
  locator: SurfaceLocator | null;
  binding: SessionBinding | null;
  evidence: RegistryEvidence;
}

export interface RegistryProvider {
  /** Concept §6.9/§6.12: an unavailable optional provider supplies an empty list. */
  list(): Promise<readonly RegistryRecord[]>;
  /** Concept §6.12: absence is null; transport failures must not imply an exited run. */
  get(locator: SurfaceLocator): Promise<RegistryRecord | null>;
  /** Concept §6.12, contract 05 I-05-4: unknown/stale occupants never become a session binding. */
  sessionOf(locator: SurfaceLocator): Promise<SessionRef | null>;
}

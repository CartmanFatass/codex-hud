import type { ObservationBoundaryWitness, ObservationCandidate } from '../checkpoint.js';
import type { PreparedCheckpoint } from '../types/checkpoint.js';
import type { ObservationCommit } from '../types/observation.js';

export type PreparedObservationCandidate = Readonly<Omit<ObservationCandidate, 'commit'>> & {
  readonly commit: Readonly<Omit<ObservationCommit, 'checkpoint'>>;
  readonly checkpoint: PreparedCheckpoint;
  readonly boundary: ObservationBoundaryWitness;
};

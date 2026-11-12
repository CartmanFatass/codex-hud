import type { Coverage } from './types/observation.js';

export class ObservationStoreError extends Error {
  readonly coverage?: Coverage;
  constructor(readonly code: string) {
    super(code);
    this.name = 'ObservationStoreError';
    if (code === 'checkpoint_state_oversize')
      this.coverage = {
        state: 'partial',
        loaded: true,
        skipped: {},
        gaps: [code],
        reason: code,
      };
  }
}

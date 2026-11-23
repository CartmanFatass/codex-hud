/** Observed flow and failure facts used by diagnostics. */
import type { OwnerWorker } from '../collectors/workboard-types.js';
export const activeFlow = (w: OwnerWorker) => w.flow?.state === 'queued' || w.flow?.state === 'running';

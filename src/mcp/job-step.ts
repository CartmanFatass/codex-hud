import type { Tick } from '../workflows/engine.js';
import type { Step } from '../workflows/graph.js';
import type { Job } from './job-contracts.js';
import { readCachedStatus } from './store/job-store.js';

/** A job step ends at dispatch. The adapter looks up its keyed/reserved receipt
 * every tick (including recovery); JOB.place precedes any input to a worker.
 * The driver commits the running cursor before invoking the effect. */
export function tickJob<T>(step: Extract<Step, { kind: 'job' }>, receipt: Job | null,
  output: (ref: string) => T[], dispatch: (from: T[]) => Promise<void>): Tick {
  if (receipt?.dispatch_exit_code != null && receipt.dispatch_exit_code !== 0)
    return { state: 'failed', reason: receipt.stderr_tail || 'target dispatch failed' };
  if (receipt?.place) {
    if (receipt.dispatch_exit_code === null) {
      const status = readCachedStatus(receipt.job).status;
      if (!status || status.reason === 'scouting') return { state: 'failed', reason: 'target dispatch interrupted before worker status' };
    }
    return { state: 'done' };
  }
  return { state: 'running', effect: async () => { await dispatch(step.from.flatMap(output)); return 0; } };
}

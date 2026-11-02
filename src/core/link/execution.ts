import type { LedgerEvent } from '../types/execution.js';
import type { RunExecutionProjection } from '../types/observation.js';
import type { LedgerReadRun } from '../ledger-read.js';
import { runExecutionProjection } from '../observation.js';
import { terminalNote, terminationProjection } from './terminal.js';

/** Same latest state-event rule as readDelegationIn; never infer a cause from heartbeat age. */
export function reconciliationOf(events: readonly LedgerEvent[], runId: string) {
  const event = events
    .filter((e) => e.runId === runId && ['run.state', 'run.terminal', 'run.reconciliation'].includes(e.kind))
    .reduce<LedgerEvent | null>((last, next) => (!last || next.seq > last.seq ? next : last), null);
  const causes = [
    'supervisor_dead',
    'scope_unknown',
    'resume_ref_mismatch',
    'clock_anomaly',
    'supervisor_stale',
    'submission_unknown',
    'cancel_unconfirmed',
    'identity_conflict',
    'scope_conflict',
    'provisional_conflict',
    'launch_timeout',
    'unknown',
  ] as const;
  const cause = causes.find((cause) => cause === event?.payload.cause);
  return cause ? { cause, missing: [cause] } : null;
}

export function linkExecution(run: LedgerReadRun | null, events: readonly LedgerEvent[]): RunExecutionProjection {
  if (!run) return runExecutionProjection(null);
  const terminal = events
    .filter((e) => e.runId === run.runId && e.linkId === run.linkId && e.kind === 'run.terminal')
    .reduce<LedgerEvent | null>((last, next) => (!last || next.seq > last.seq ? next : last), null);
  const state = events
    .filter((e) => e.runId === run.runId && ['run.state', 'run.terminal', 'run.reconciliation'].includes(e.kind))
    .reduce<LedgerEvent | null>((last, next) => (!last || next.seq > last.seq ? next : last), null);
  return {
    ...runExecutionProjection({
      ...run,
      reason: typeof state?.payload.reason === 'string' ? state.payload.reason : null,
    }),
    terminal: terminal
      ? {
          note: terminalNote(terminal.payload.terminalNote),
          termination: terminationProjection(terminal.payload.termination),
        }
      : null,
    reconciliation: reconciliationOf(events, run.runId),
  };
}

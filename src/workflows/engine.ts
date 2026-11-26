import type { Graph, Step } from './graph.js';
import { failureReason, failuresByReason, settlement, type FailureWindow } from './policy.js';

export interface Cursor { state: 'waiting' | 'ready' | 'running' | 'asking' | 'done' | 'failed' | 'skipped' | 'cancelled'; answer?: string; reason?: string; admitted?: true }
export interface Run extends FailureWindow {
  flow: string; state: 'proposed' | 'working' | 'paused' | 'stopped' | 'completed' | 'failed'; epoch: number; reason?: string;
  handback?: { step: string; choices: string[] };
  steps: Record<string, Cursor>; notices: Record<string, string>;
}
export function pauseRun(run: Pick<Run, 'state' | 'reason' | 'handback'>, step: string, reason: string) {
  run.state = 'paused'; run.reason = reason;
  run.handback = { step, choices: ['resume','retry_failed','stop'] };
}
export type Control = 'resume' | 'pause' | 'retry_failed' | 'stop';
export function controlRun(run: Omit<Run, 'steps'> & { steps?: Run['steps'] }, action: Control, retryable: boolean) {
  if (action === 'stop' && run.state !== 'completed') {
    run.state = 'stopped'; delete run.handback;
    for (const c of Object.values(run.steps ?? {})) if (c.state === 'waiting' || c.state === 'ready') c.state = 'cancelled';
  } else if (action === 'pause' && run.state === 'working') {
    const step = Object.entries(run.steps ?? {}).find(([, c]) => c.state === 'running')?.[0];
    pauseRun(run, step ?? Object.keys(run.steps ?? {})[0] ?? 'run', 'paused by caller');
  } else if ((action === 'resume' && run.state === 'paused') || (action === 'retry_failed' && retryable)) {
    for (const c of Object.values(run.steps ?? {})) if (c.state === 'failed') c.state = action === 'resume' ? 'skipped' : 'waiting';
    run.epoch++; run.streak = run.settled = run.failures = 0; run.state = 'working'; delete run.reason; delete run.handback;
  } else return;
  return action;
}
export interface Tick { state: 'running' | 'done' | 'failed' | 'cancelled'; reason?: string; changed?: boolean; recheckMs?: number; effect?: () => Promise<number> }

export const canRepairSealedStep = (attempts: number) => attempts < 2;
/** A sealed effect can contain its own transaction and repair loop. The durable
 * admission is consumed even if the driver dies without an outcome. */
export function sealedEffect(cursor: Cursor, effect: () => Promise<number>): Tick {
  if (cursor.admitted) throw Error('Sealed step already admitted; not replayed');
  cursor.admitted = true;
  return { state: 'running', effect };
}
/** Standalone sealed runs put the result, cursor and outbox in the same atomic header. */
export function settleSealedRun(run: Run, step: string, state: 'completed' | 'failed' | 'stopped', notice?: string) {
  run.state = state;
  run.steps[step].state = state === 'completed' ? 'done' : state === 'stopped' ? 'cancelled' : 'failed';
  if (notice !== undefined) run.notices[`end-${run.epoch}`] = notice;
}
/** One deterministic pass under flow-state. Step adapters can inspect receipts or stage
 * one admission. The caller commits this cursor BEFORE performing the returned effect. */
export function advance(graph: Pick<Graph, 'steps' | 'policy'>, run: Run, tick: (id: string, step: Step) => Tick): { changed: boolean; effect?: () => Promise<number>; recheckMs?: number } {
  let changed = false, recheckMs: number | undefined;
  for (const [id, step] of Object.entries(graph.steps)) {
    const cursor = run.steps[id];
    if (cursor.state === 'waiting' && run.state === 'working') {
      if (!step.needs.every(n => ['done','skipped'].includes(run.steps[n].state) || (graph.steps[n].optional && run.steps[n].state === 'failed'))) continue;
      cursor.state = step.when && run.steps[step.when.step].answer !== step.when.is ? 'skipped' : 'ready'; changed = true;
    }
    if (cursor.state === 'ready' && run.state === 'working') { cursor.state = 'running'; changed = true; }
    // Paused/stopped runs can reconcile already-admitted work, but cannot start another step.
    if (cursor.state !== 'running') continue;
    const result = tick(id, step);
    changed ||= !!result.changed || result.state !== cursor.state;
    if (result.recheckMs !== undefined) recheckMs = Math.min(recheckMs ?? result.recheckMs, result.recheckMs);
    cursor.state = result.state;
    if (result.state === 'done' && step.kind !== 'batch' && run.state === 'working') settlement(run, graph.policy.breaker);
    if (result.state === 'failed') {
      cursor.reason = failureReason(result.reason || 'failed');
      if (run.state === 'working') {
        const groups = failuresByReason(Object.entries(run.steps).map(([item, c]) => ({ item, ...c })));
        const action = settlement(run, step.optional ? 'none' : graph.policy.breaker, cursor.reason, groups.find(g => g.reason === cursor.reason)?.count, false, !step.optional);
        if (action === 'pause') {
          pauseRun(run, id, cursor.reason);
          run.notices[`pause-${run.epoch}`] = `${run.flow} paused at ${id}: ${cursor.reason}`;
        } else if (action === 'failure') run.notices[`failure-${run.epoch}-${id}`] = `${run.flow} ${id}: ${cursor.reason}`;
      }
    }
    if (result.effect) return { changed: true, effect: result.effect };
  }
  if (run.state === 'working' && Object.values(run.steps).every(c => ['done','failed','skipped','cancelled'].includes(c.state))) {
    run.state = 'completed'; changed = true;
  }
  return { changed, ...(recheckMs !== undefined && { recheckMs }) };
}

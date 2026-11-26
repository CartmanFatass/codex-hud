import type { Breaker } from './graph.js';

export interface FailureWindow { settled: number; streak: number; failures: number }
export interface FailureEvidence { state: string; reason?: string; job?: string; item: number | string }
export function settleBatchItem(
  run: FailureWindow & { state: string }, item: { state: string; reason?: string }, evidence: () => FailureEvidence[], breaker: Breaker, pilot: boolean, failure?: string,
) {
  item.state = failure ? 'failed' : 'done';
  item.reason = failure ? failureReason(failure) : undefined;
  const groups = failure ? failuresByReason(evidence()) : undefined;
  const action = run.state === 'working' ? settlement(run, breaker, item.reason, groups?.find(g => g.reason === item.reason)?.count, pilot) : undefined;
  return { action, groups };
}
export const failureReason = (reason: string) => reason.slice(0, 300);
export function failuresByReason(records: Iterable<FailureEvidence>) {
  const groups = new Map<string, { reason: string; count: number; example: string }>();
  for (const i of records) if (i.state === 'failed') {
    const reason = i.reason ?? 'failed';
    const group = groups.get(reason) ?? { reason, count: 0, example: i.job ?? `item ${i.item}` };
    group.count++; groups.set(reason, group);
  }
  return [...groups.values()];
}
/** Called in settlement order, under the run lock, only while accepting work. A breaker
 * wake replaces the first-of-reason wake for the same event. Controls reset the window. */
export function settlement(window: FailureWindow, breaker: Breaker, reason?: string, reasonCount = 0, pilot = false, required = false) {
  window.settled++; window.streak = reason ? window.streak + 1 : 0;
  if (!reason) return;
  window.failures++;
  if (required || breaker === 'first' || (breaker === 'rate' && (pilot || window.streak >= 2 || (window.failures >= 2 && window.failures * 5 >= window.settled)))) return 'pause';
  if (reasonCount === 1) return 'failure';
}

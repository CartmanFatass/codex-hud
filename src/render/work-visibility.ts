/** Fixed Home lifetimes; show-all reveals expired items in place. No source mutation. */
import type { DecisionRecord, OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import { callTime } from '../collectors/workboard.js';
import type { MonitorData, MonitorState } from './monitor.js';

const HOME_MS = { done: 10 * 60000, failed: 30 * 60000, decision: 30 * 60000, departure: 2 * 60 * 60000 };
const jobTime = (w: OwnerWorker) => w.settledAt ?? w.startedAt ?? 0;
export function currentWorker(w: OwnerWorker, now: number): boolean {
  if (w.homeNeedsHuman || w.settledAt === null) return true;
  const failed = w.work?.failed || ['failed', 'error', 'stopped'].includes(w.state);
  return now - w.settledAt < (failed ? HOME_MS.failed : HOME_MS.done);
}
export function currentDecision(d: DecisionRecord, now: number): boolean {
  const at = callTime(d);
  return at !== null && now - at < (d.departure ? HOME_MS.departure : HOME_MS.decision);
}
export function visibleWorkboard(
  _input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  now: number
): WorkboardSnapshot {
  const all = state.tree.showAll;
  const workers = board.workers.filter((w) => all || currentWorker(w, now));
  const decisions = board.decisions.filter((d) => all || currentDecision(d, now));
  const workerIds = new Set(workers.map((w) => w.id)), decisionIds = new Set(decisions.map((d) => d.id));
  const lanes = board.lanes.map((lane) => ({
    ...lane,
    workers: lane.workers.filter((w) => workerIds.has(w.id)).sort((a, b) => all ? jobTime(b) - jobTime(a) : 0),
    decisions: lane.decisions.filter((d) => decisionIds.has(d.id)),
  })).filter((lane) => lane.workers.length || lane.decisions.length);
  if (all) lanes.sort((a, b) => Math.max(0, ...b.workers.map(jobTime)) - Math.max(0, ...a.workers.map(jobTime)));
  return { ...board, lanes, workers, decisions };
}

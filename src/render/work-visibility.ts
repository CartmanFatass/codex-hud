/** Home lifetimes: a settled card folds, then hides (Settings); decisions are fixed. Show-all reveals hidden items in place. No source mutation. */
import type { DecisionRecord, OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import { callTime } from '../collectors/workboard.js';
import type { MonitorData, MonitorState } from './monitor.js';

const HOME_MS = { failed: 30 * 60000, decision: 30 * 60000, departure: 2 * 60 * 60000 };
export type CardTimes = Pick<MonitorState, 'cardFoldMinutes' | 'cardHideMinutes'>;
/** Fold and hide times in ms; a hide time before the fold time is the fold time. */
function cardTimes(times?: CardTimes) {
  const fold = (times?.cardFoldMinutes ?? 5) * 60000;
  return { fold, hide: Math.max(fold, (times?.cardHideMinutes ?? 15) * 60000) };
}
/** A settled card past its fold time, not asking the owner: one row until Enter opens it. */
export const foldedWorker = (w: OwnerWorker, now: number, times?: CardTimes): boolean =>
  w.settledAt !== null && !w.homeNeedsHuman && w.homeRank !== 100 && now - w.settledAt >= cardTimes(times).fold;
const jobTime = (w: OwnerWorker) => w.settledAt ?? w.startedAt ?? 0;
export function currentWorker(w: OwnerWorker, now: number, times?: CardTimes): boolean {
  if (w.homeRank === 100) return true;
  if (w.homeFolded) return false;
  if (w.homeNeedsHuman || w.settledAt === null) return true;
  const failed = w.work?.failed || ['failed', 'error', 'stopped'].includes(w.state);
  const { hide } = cardTimes(times);
  return now - w.settledAt < (failed ? Math.max(hide, HOME_MS.failed) : hide);
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
  const workers = board.workers.filter((w) => all || currentWorker(w, now, state));
  const decisions = board.decisions.filter((d) => all || currentDecision(d, now));
  const workerIds = new Set(workers.map((w) => w.id)), decisionIds = new Set(decisions.map((d) => d.id));
  const lanes = board.lanes.map((lane) => ({
    ...lane,
    workers: lane.workers.filter((w) => workerIds.has(w.id)).sort((a, b) => all && lane.identity.kind !== 'native' && a.homeRank === undefined ? jobTime(b) - jobTime(a) : 0),
    decisions: lane.decisions.filter((d) => decisionIds.has(d.id)),
  })).filter((lane) => lane.workers.length || lane.decisions.length);
  if (all && !board.workers.some((w) => w.homeRank !== undefined)) lanes.sort((a, b) => Math.max(0, ...b.workers.map(jobTime)) - Math.max(0, ...a.workers.map(jobTime)));
  return { ...board, lanes, workers, decisions };
}

/** Home lifetimes: a settled card folds, then hides (Settings). Show-all reveals hidden cards in place. */
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorState } from './monitor.js';

const FAILED_HIDE_MS = 30 * 60000;
export const activeFlow = (w: OwnerWorker) => w.flow?.state === 'queued' || w.flow?.state === 'running';
export const unattendedFailure = (w: OwnerWorker) => !w.superseded && !w.failureObserved &&
  (w.work?.failed || ['failed', 'error', 'stopped'].includes(w.state));
export type CardTimes = Pick<MonitorState['prefs'], 'cardFoldMinutes' | 'cardHideMinutes'>;
/** Fold and hide times in ms; a hide time before the fold time is the fold time. */
function cardTimes(times?: CardTimes) {
  const fold = (times?.cardFoldMinutes ?? 5) * 60000;
  return { fold, hide: Math.max(fold, (times?.cardHideMinutes ?? 15) * 60000) };
}
const settledTime = (w: OwnerWorker) => Math.max(w.settledAt ?? 0, w.flow?.updatedAt ?? 0);
/** A settled card past its fold time, not asking the owner: one row until Enter opens it. */
export const foldedWorker = (w: OwnerWorker, now: number, times?: CardTimes): boolean =>
  !activeFlow(w) && w.settledAt !== null && !w.homeNeedsHuman && w.homeRank !== 100 && now - settledTime(w) >= cardTimes(times).fold;
const jobTime = (w: OwnerWorker) => (w.settledAt !== null ? settledTime(w) : w.startedAt ?? 0);
export function currentWorker(w: OwnerWorker, now: number, times?: CardTimes): boolean {
  if (w.superseded) return false;
  if (w.homeNeedsHuman || w.settledAt === null || activeFlow(w)) return true;
  const doneAt = settledTime(w);
  if (unattendedFailure(w) || w.flow?.state === 'failed') return !!w.work?.request || now - doneAt < FAILED_HIDE_MS;
  if (w.failureObserved) return now - doneAt < cardTimes(times).hide;
  if (w.homeRank === 100) return true;
  if (w.homeFolded) return false;
  return now - doneAt < cardTimes(times).hide;
}
/** With a `/` filter's `match`, the cards that match stay however old they are. */
export function visibleWorkboard(
  _input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  now: number,
  match?: (worker: OwnerWorker) => boolean
): WorkboardSnapshot {
  const all = state.home.showAll || !!match;
  const workers = board.workers.filter((w) => (match ? match(w) : all || currentWorker(w, now, state.prefs)));
  const workerIds = new Set(workers.map((w) => w.id));
  const lanes = board.lanes.map((lane) => ({
    ...lane,
    workers: lane.workers.filter((w) => workerIds.has(w.id)).sort((a, b) => all && lane.identity.kind !== 'native' && a.homeRank === undefined ? jobTime(b) - jobTime(a) : 0),
  })).filter((lane) => lane.workers.length);
  if (all && !board.workers.some((w) => w.homeRank !== undefined)) lanes.sort((a, b) => Math.max(0, ...b.workers.map(jobTime)) - Math.max(0, ...a.workers.map(jobTime)));
  return { ...board, lanes, workers };
}

/** Home lifetimes: a settled card folds, then hides (Settings). Show-all reveals hidden cards in place. */
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorState } from './monitor.js';

const FAILED_HIDE_MS = 30 * 60000;
const FAILED_STALE_MS = 24 * 3600000;
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
  const failed = w.work?.failed || ['failed', 'error', 'stopped'].includes(w.state);
  // A failure that nobody acted on for a day is history, not attention, even when ranked protected (owner, 2026-11-21).
  if (failed && w.settledAt !== null && !w.homeNeedsHuman && !w.work?.request && now - w.settledAt >= FAILED_STALE_MS) return false;
  if (w.homeRank === 100) return true;
  if (w.homeFolded) return false;
  if (w.homeNeedsHuman || w.settledAt === null) return true;
  const { hide } = cardTimes(times);
  return now - w.settledAt < (failed ? Math.max(hide, FAILED_HIDE_MS) : hide);
}
/** With a `/` filter's `match`, the cards that match stay however old they are. */
export function visibleWorkboard(
  _input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  now: number,
  match?: (worker: OwnerWorker) => boolean
): WorkboardSnapshot {
  const all = state.tree.showAll || !!match;
  const workers = board.workers.filter((w) => (match ? match(w) : all || currentWorker(w, now, state)));
  const workerIds = new Set(workers.map((w) => w.id));
  const lanes = board.lanes.map((lane) => ({
    ...lane,
    workers: lane.workers.filter((w) => workerIds.has(w.id)).sort((a, b) => all && lane.identity.kind !== 'native' && a.homeRank === undefined ? jobTime(b) - jobTime(a) : 0),
  })).filter((lane) => lane.workers.length);
  if (all && !board.workers.some((w) => w.homeRank !== undefined)) lanes.sort((a, b) => Math.max(0, ...b.workers.map(jobTime)) - Math.max(0, ...a.workers.map(jobTime)));
  return { ...board, lanes, workers };
}

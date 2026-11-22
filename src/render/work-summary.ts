/** Statusline/footer Work counts from the same passive jobs as the panel. */
import type { OwnerWorker, WorkLane } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { truncateAnsi } from './colors.js';
import { NOTICE_MS, type BarWorker } from './layout/bar-fields.js';
const wordOf = (worker: OwnerWorker, now: number): string => {
  const state = projectWorkCard(worker, now).state;
  return worker.work?.failed
    ? 'failed'
    : state === 'needs-you'
      ? 'needs you'
      : state === 'stalled'
        ? 'stalled'
        : state === 'awaiting-acceptance' && !worker.parentJobId
          ? 'report ready'
          : state === 'in-progress'
            ? 'running'
            : '';
};
/** What the bar's worker zone takes from the jobs: a census of the live workers and the settled ones of the last three minutes. */
export interface WorkSignals {
  workers: BarWorker[];
}
export function workSignals(lanes: readonly WorkLane[], now: number): WorkSignals {
  const workers: BarWorker[] = [];
  for (const lane of lanes)
    for (const worker of lane.workers) {
      const live = worker.settledAt === null && worker.state !== 'queued';
      // A settled worker keeps its place for NOTICE_MS; a sonic child's report goes to its parent, unless it failed.
      const settled =
        worker.settledAt !== null &&
        now - worker.settledAt < NOTICE_MS &&
        (!worker.parentJobId || worker.work?.failed === true);
      if (!live && !settled) continue;
      const state: BarWorker['state'] = live
        ? wordOf(worker, now) === 'needs you'
          ? 'asking'
          : 'working'
        : worker.work?.failed
          ? 'failed'
          : 'done';
      workers.push({
        role: worker.role || 'job',
        ...(worker.model ? { model: worker.model } : {}),
        ...(worker.provider ? { provider: worker.provider } : {}),
        ...(worker.effort ? { effort: worker.effort } : {}),
        state,
        ...(settled && !worker.parentJobId && worker.reportUnread === true ? { unread: true as const } : {}),
        startedAt: worker.startedAt ?? worker.settledAt ?? now,
        ...(worker.settledAt !== null && settled ? { settledAt: worker.settledAt } : {}),
      });
    }
  return { workers };
}
export function renderWorkSummary(lanes: readonly WorkLane[], width: number, now: number): string {
  const counts = new Map<string, number>();
  for (const worker of lanes.flatMap((l) => l.workers)) {
    const word = wordOf(worker, now);
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = ['needs you', 'stalled', 'failed', 'report ready', 'running'].flatMap((word) =>
    counts.has(word) ? [`${counts.get(word)} ${word}`] : []
  );
  return parts.length ? truncateAnsi('Work: ' + parts.join(' · '), width) : '';
}

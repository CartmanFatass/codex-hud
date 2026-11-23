/** Statusline/footer Work counts from the same passive jobs as the panel. */
import type { OwnerWorker, WorkLane } from '../collectors/workboard-types.js';
import type { WorkSummaryScope } from '../collectors/work-summary-snapshot.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { truncateAnsi } from './colors.js';
import type { BarWorker } from './layout/bar-fields.js';
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
/** What the bar's worker zone takes from the jobs: a census of the workers running now, by role. */
export interface WorkSignals {
  workers: BarWorker[];
}
export function workSignals(lanes: readonly WorkLane[], now: number): WorkSignals {
  const workers: BarWorker[] = [];
  for (const lane of lanes)
    for (const worker of lane.workers) {
      // Settled and queued workers are not counted; one asking the owner is still live.
      if (worker.settledAt !== null || worker.state === 'queued') continue;
      workers.push({ role: worker.role || 'job', state: wordOf(worker, now) === 'needs you' ? 'asking' : 'working' });
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
export function workSignalsFromSummary(scope: WorkSummaryScope): WorkSignals {
  const workers: BarWorker[] = [];
  for (const [role, counts] of Object.entries(scope.roles)) {
    const asking = Math.min(counts.asking, counts.running);
    for (let i = 0; i < asking; i++) workers.push({ role, state: 'asking' });
    for (let i = 0; i < counts.running - asking; i++) workers.push({ role, state: 'working' });
  }
  return { workers };
}

/** Statusline/footer Work counts from the same passive jobs as the panel. */
import type { WorkLane } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { truncateAnsi } from './colors.js';
export function renderWorkSummary(lanes: readonly WorkLane[], width: number, now: number): string {
  const counts = new Map<string, number>();
  for (const worker of lanes.flatMap((l) => l.workers)) {
    const card = projectWorkCard(worker, now);
    const word = worker.work?.failed
      ? 'failed'
      : card.state === 'needs-you'
        ? 'needs you'
        : card.state === 'stalled'
          ? 'stalled'
          : card.state === 'awaiting-acceptance'
            ? 'report ready'
            : card.state === 'in-progress'
              ? 'running'
              : '';
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = ['needs you', 'stalled', 'failed', 'report ready', 'running'].flatMap((word) =>
    counts.has(word) ? [`${counts.get(word)} ${word}`] : []
  );
  return parts.length ? truncateAnsi('Work: ' + parts.join(' · '), width) : '';
}

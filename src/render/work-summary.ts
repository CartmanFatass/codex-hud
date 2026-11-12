/** Statusline/footer Work counts from the same passive jobs as the panel. */
import type { OwnerWorker, WorkLane } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { truncateAnsi } from './colors.js';
import { agentEvent, NOTICE_MS, type BarEvent } from './layout/bar-fields.js';
const wordOf = (worker: OwnerWorker, now: number): string => {
  const state = projectWorkCard(worker, now).state;
  return worker.work?.failed
    ? 'failed'
    : state === 'needs-you'
      ? 'needs you'
      : state === 'stalled'
        ? 'stalled'
        : state === 'awaiting-acceptance'
          ? 'report ready'
          : state === 'in-progress'
            ? 'running'
            : '';
};
/** What the bar's notice zone takes from the jobs: a question waiting for the person, and what each job just did. */
export interface WorkSignals {
  needs: string[];
  events: BarEvent[];
}
export function workSignals(lanes: readonly WorkLane[], now: number): WorkSignals {
  const workers = lanes.flatMap((l) => l.workers);
  const asking = workers.filter((worker) => wordOf(worker, now) === 'needs you').length;
  const events: BarEvent[] = [];
  for (const worker of workers) {
    const who = { id: worker.id, name: worker.role || 'job', detail: worker.task };
    if (worker.startedAt !== null && now - worker.startedAt < NOTICE_MS)
      events.push(agentEvent('started', who, worker.startedAt));
    if (worker.settledAt !== null && now - worker.settledAt < NOTICE_MS)
      events.push(agentEvent(worker.work?.failed ? 'failed' : 'done', who, worker.settledAt));
  }
  return { needs: asking ? [`Work: ${asking} needs you`] : [], events };
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

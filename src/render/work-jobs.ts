/** One row per retained HUD job, including queued, settled and Sonic child jobs. */
import { targetKey, type OwnerWorker } from '../collectors/workboard-types.js';
import type { MonitorRow } from './monitor.js';
import type { JobTarget } from './monitor-state.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { boardRow } from './workboard-rows.js';
import { t } from './i18n.js';

export const jobTarget = (w: OwnerWorker): JobTarget => ({ kind: 'worker', laneId: w.laneId, workerId: w.id });
export const isHudJob = (w: OwnerWorker) => w.id.startsWith('thin-job:');

export function jobRows(workers: readonly OwnerWorker[], width: number): MonitorRow[] {
  return workers.map((w) => {
    const item = targetKey(jobTarget(w));
    const id = monitorText(w.displayId || w.id.slice(-8));
    const rawTitle = monitorText(w.ticketTitle || w.briefTitle || w.task).replace(/\s+/g, ' ').trim();
    const title = w.displayId && rawTitle.startsWith(id) ? rawTitle.slice(id.length).replace(/^[\s:–—-]+/, '') : rawTitle;
    const role = monitorText(w.role ?? '');
    const status = w.homeNeedsHuman ? t('waiting for main') : t(w.state);
    const suffix = [role, status].filter(Boolean).join(' · ');
    const tail = [suffix, status].find((s) => visualLength(id + s) + 7 <= width) ?? '';
    return { item, text: pair(id + (title ? `  ${title}` : ''), theme.board.muted(tail), width) };
  });
}

export function jobsRows(workers: readonly OwnerWorker[], width: number, known: boolean): MonitorRow[] {
  const rows = jobRows(workers.filter(isHudJob), width);
  return rows.length ? rows : [boardRow(fit(theme.board.muted(t(known ? 'No jobs' : 'No jobs observed')), width))];
}

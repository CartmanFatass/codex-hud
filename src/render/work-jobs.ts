/** One row per retained HUD job, including queued, settled and Sonic child jobs, under one row per fixed batch. */
import { targetKey, type OwnerWorker, type WorkBatch } from '../collectors/workboard-types.js';
import type { MonitorRow } from './monitor.js';
import type { JobTarget } from './monitor-state.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { fit, flowLines, monitorText, pair } from './monitor-text.js';
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

export const batchStateWord = (b: { state: WorkBatch['state']; totals: { running: number } }) =>
  b.state === 'completed' ? 'done' : b.state === 'stopped' && b.totals.running ? 'stopping' : b.state;

/** The whole batch on one row, the least urgent count and then the role dropped when narrow; why it paused goes under it. */
export function batchRows(batches: readonly WorkBatch[], width: number): MonitorRow[] {
  return batches.flatMap((batch) => {
    const { done, failed, running, waiting, cancelled } = batch.totals;
    const state = t(batchStateWord(batch));
    let left = `${batch.flow.slice(0, 8)}  ${t('Batch')}`;
    for (const part of [t('{done}/{total} done', { done, total: batch.count }), failed && t('{n} failed', { n: failed }),
      running && t('{n} running', { n: running }), waiting && t('batch: {n} waiting', { n: waiting }), cancelled && t('{n} cancelled', { n: cancelled })]) {
      if (!part) continue;
      if (visualLength(`${left} · ${part}  ${state}`) > width) break;
      left += ` · ${part}`;
    }
    const full = `${monitorText(batch.role)} · ${state}`;
    const ink = batch.state === 'paused' ? theme.board.attention : theme.board.muted;
    const row: MonitorRow = { item: `batch:${batch.flow}`, batch, text: pair(left, ink(visualLength(`${left}  ${full}`) <= width ? full : state), width) };
    // A pause the caller asked for needs no reason; the engine's own two are translated, any other is shown as written.
    const reason = batch.state === 'paused' && batch.reason !== 'paused by caller' ? monitorText(batch.reason ?? '').replace(/\s+/g, ' ').trim() : '';
    const room = Math.max(1, width - 4), lines = reason ? flowLines(t(reason), room) : [];
    if (lines.length > 2) lines.push(truncateAnsi(lines.splice(1).join(' '), room));
    return [row, ...lines.map((line) => boardRow(fit(`    ${theme.board.muted(line)}`, width)))];
  });
}

export function jobsRows(workers: readonly OwnerWorker[], width: number, known: boolean, batches: readonly WorkBatch[] = []): MonitorRow[] {
  const rows = [...batchRows(batches, width), ...jobRows(workers.filter(isHudJob), width)];
  return rows.length ? rows : [boardRow(fit(theme.board.muted(t(known ? 'No jobs' : 'No jobs observed')), width))];
}

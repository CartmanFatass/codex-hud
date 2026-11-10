/** The same local Work facts in source-only and existing native/job Inspectors. */
import type { OwnerWorker } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { workCardDetail, workRequestDetail, workPhaseText, workStateWord } from './work-card.js';
import { flowLines, monitorText } from './monitor-text.js';
import { section } from './workboard-rows.js';
import { t } from './i18n.js';

export function workInspectorRows(
  worker: OwnerWorker,
  state: MonitorState,
  width: number,
  now: number,
  heading = true,
  progress?: import('../collectors/job-progress.js').JobProgressDisplay
): MonitorRow[] {
  const rows: MonitorRow[] = heading ? [section(t('Work details'), width)] : [];
  const add = (label: string, value: string) => {
    for (const text of flowLines(`${t(label)}: ${monitorText(value)}`, width)) rows.push({ text });
  };
  const card = projectWorkCard(worker, now, state.cardStallMinutes);
  add('Work state', workStateWord(card));
  if (progress?.reason) add('Job sentence', t(progress.reason));
  if (progress?.note) {
    const note = progress.note;
    add('Job sentence', note.line || t('Empty assessment'));
    if (note.attention) add('Model assessment', t('needs you'));
    add('Generated at', new Date(note.generatedAt).toISOString());
    for (const basis of note.basisEvidence) {
      add('Basis', `${basis.id}: ${basis.locator}${basis.truncated ? ' [' + t('truncated') + ']' : ''}`);
      add('Evidence', basis.text);
    }
    for (const gap of note.coverage) add('Coverage', gap);
  }
  add('State', worker.state);
  for (const phase of card.phases) add('Observed phase', workPhaseText(phase));
  const detail =
    worker.work?.requestInfo && card.reason === 'Decision requested; inspect the job'
      ? workRequestDetail(card, true)
      : workCardDetail(card);
  for (const line of detail.split('\n').filter(Boolean)) add('Work details', line);
  if (worker.work?.activityAt !== null && worker.work?.activityAt !== undefined)
    add('Last activity', new Date(worker.work.activityAt).toISOString());
  if (worker.work) add('Time basis', worker.work.activityBasis);
  const evidence = [
    ...worker.evidence,
    ...(worker.work?.phaseEvidence ?? []),
    ...(worker.work?.requestInfo?.evidence ? [worker.work.requestInfo.evidence] : []),
  ];
  const seen = new Set<string>();
  for (const item of evidence) {
    const key = JSON.stringify([item.sourceId, item.relativePath, item.revision]);
    if (seen.has(key)) continue;
    seen.add(key);
    add('Source', item.relativePath + (item.section ? ' #' + item.section : ''));
    add('Time basis', item.timeBasis);
    if (item.at !== null && Number.isFinite(item.at)) add('Evidence time', new Date(item.at).toISOString());
  }
  return rows;
}

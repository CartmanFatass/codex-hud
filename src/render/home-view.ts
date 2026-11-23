/** Current-project handoff. A job waiting for main is not an owner request. */
import type { ProjectItem, ProjectSnapshot } from '../collectors/project-board.js';
import type { MonitorRow } from './monitor.js';
import { theme } from './colors.js';
import { fit, flowLines, monitorText } from './monitor-text.js';
import { boardRow, mark, section } from './workboard-rows.js';
import { t } from './i18n.js';

export interface PaneLoad { running: number; queued: number }

export function homeRows(
  waiting: readonly ProjectItem[], handoff: Pick<ProjectSnapshot, 'summary' | 'next'> | undefined,
  load: PaneLoad | undefined, width: number,
): MonitorRow[] {
  const prose = (body: string, prefix = '  ') => flowLines(monitorText(body), Math.max(1, width - 2))
    .map((line, i) => boardRow(fit((i ? '  ' : prefix) + line, width)));
  return [
    section(t('Waiting'), width),
    ...(waiting.length ? waiting.flatMap((item) => prose(item.value, theme.board.attention('? ')))
      : handoff ? [boardRow(theme.board.muted(t('Nothing needs you')))] : [boardRow(t('Loading…'))]),
    ...(handoff?.summary ? [section(t('Now'), width), ...prose(handoff.summary)] : []),
    ...(handoff?.next.length ? [section(t('Next'), width), ...handoff.next.flatMap((item) => prose(item.value, `${mark('•', '-')} `))] : []),
    ...(load ? [boardRow(theme.board.muted(t('This pane · {running} running · {queued} queued', { ...load })))] : []),
  ];
}

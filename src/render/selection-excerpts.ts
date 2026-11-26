import type { SelectionExcerpt } from '../roles/selection-excerpts.js';
import { theme } from './colors.js';
import { t } from './i18n.js';
import type { MonitorRow } from './monitor.js';
import { fit, monitorText, wrapped } from './monitor-text.js';
import { boardRow, mark, section } from './workboard-rows.js';

export const excerptItem = (excerpt: SelectionExcerpt) => `project:excerpt:${excerpt.id}`;

/** Inspector keeps the full evidence; Execution gives each pair a compact, keyboard-selectable card. */
export function selectionExcerptRows(records: readonly SelectionExcerpt[], width: number, compact = false, cursor?: string): MonitorRow[] {
  if (!records.length) return [];
  const row = (text: string) => boardRow(fit(text, width));
  const rows = [row(''), section(t('Selections'), width)];
  const prose = (label: string, text: string) => {
    rows.push(row(`  ${theme.board.muted(t(label))}`));
    let shown = 0;
    for (const raw of text.split(/\r?\n/)) {
      for (const line of wrapped(raw, Math.max(1, width - 4))) {
        if (compact && shown === 3) {
          rows.push(row(`    ${theme.board.muted('…')}`));
          return;
        }
        rows.push(row(`    ${theme.board.body(line)}`));
        shown++;
      }
    }
  };
  for (const [i, excerpt] of records.entries()) {
    if (i) rows.push(row(''));
    const start = rows.length, item = excerptItem(excerpt);
    const status = t(excerpt.advisor?.ended ? 'Advisor ended' : excerpt.answer ? 'answered' : excerpt.delivery);
    const target = compact ? ` · ${monitorText(excerpt.role)} ${monitorText(excerpt.target)}` : '';
    const marker = item === cursor ? `${theme.board.active(mark('▸', '>'))} ` : '  ';
    rows.push(row(marker + theme.board.title((excerpt.advisor ? `${t('Selection advisor')} · ` : '') + status + target)));
    const from = [excerpt.source.job, excerpt.source.pane].filter(Boolean).join(' · ');
    if (from) rows.push(row(`  ${theme.board.muted(t('Source: {source}', { source: monitorText(from) }))}`));
    prose('Excerpt', excerpt.excerpt);
    if (excerpt.question) prose('Question', excerpt.question);
    if (excerpt.note) prose('Note', excerpt.note);
    if (excerpt.answer) prose('Answer', excerpt.answer.text);
    if (compact) for (let i = start; i < rows.length; i++) {
      rows[i].item = item;
      if (excerpt.advisor) rows[i].selectionAdvisor = excerpt.id;
    }
  }
  return rows;
}

import type { ObjectiveEvidence } from '../collectors/objectives.js';
import type { ObjectiveDetail } from './monitor-state.js';
import type { MonitorRow } from './monitor.js';
import { theme, visualLength } from './colors.js';
import { wrapped } from './monitor-text.js';
import { boardRow, kvRows, section } from './workboard-rows.js';
import { t } from './i18n.js';

export function objectiveDetailRows(detail: ObjectiveDetail, width: number): MonitorRow[] {
  const { root, objective } = detail.target;
  const rows = [
    ...kvRows('ID', objective.id, width),
    ...kvRows('Title', objective.title, width),
    ...kvRows('State', t(objective.state), width),
    ...(objective.next ? kvRows('Next', objective.next, width) : []),
    ...(objective.result ? kvRows('Result', objective.result, width) : []),
    section(t('Evidence'), width),
  ];
  const entries: ObjectiveEvidence[] = detail.evidence ?? objective.evidence.map((text) => ({ text }));
  if (!entries.length) rows.push(boardRow('  ' + theme.board.muted(t('none'))));
  for (const [i, { text, file, commit, status }] of entries.entries()) {
    const prefix = status ? `  ${theme.board.muted(t(status))} · ` : '  ';
    rows.push(...wrapped(text, Math.max(1, width - visualLength(prefix))).map((line, j) => ({
      text: (j ? ' '.repeat(visualLength(prefix)) : prefix) + line, item: `objective:evidence:${i}`,
      ...(file && { files: [file] }), ...(commit && { commit: { cwd: root, hash: commit } }),
    })));
  }
  return rows;
}

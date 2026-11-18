import type { DiffStatSummary } from '../collectors/diff-stat.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import type { MonitorRow } from './monitor.js';
import { fit, monitorText, pair, squeeze } from './monitor-text.js';
import { mark } from './workboard-rows.js';

export function diffStatRows(diff: DiffStatSummary | undefined, width: number): MonitorRow[] {
  if (!diff?.files.length) return [];
  const rows = diff.files.map((f): MonitorRow => {
    let right = theme.board.muted(t('bin'));
    if (f.added !== null && f.deleted !== null) {
      const total = f.added + f.deleted, a = total ? Math.round(5 * f.added / total) : 0;
      const bar = total ? theme.board.success(mark('█', '+').repeat(a)) + theme.board.danger(mark('░', '-').repeat(5 - a))
        : theme.board.muted(mark('·', '.').repeat(5));
      right = `${theme.board.success(`+${f.added}`)} ${theme.board.danger(`-${f.deleted}`)}  ${bar}`;
    }
    const left = '  ' + theme.board.identifier(squeeze(monitorText(f.path), Math.max(0, width - 3 - visualLength(right))));
    return { text: fit(pair(left, right, width), width), item: 'diff:' + f.absPath, files: [f.absPath] };
  });
  const more = diff.totalFiles - diff.files.length;
  if (more > 0) rows.push({ text: fit('  ' + theme.board.muted(t('+{n} more files', { n: more })), width) });
  return rows;
}

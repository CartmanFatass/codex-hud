/** Repository/worktree summary for the retained Changes page. */
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { theme } from './colors.js';
import { t } from './i18n.js';
import { monitorText } from './monitor-text.js';
import { section, kvRows, itemRow } from './workboard-rows.js';
export function changesRows(input: MonitorData, _state: MonitorState, width: number, now: number): MonitorRow[] {
  const snapshot = input.worktrees;
  const rows: MonitorRow[] = [];
  if (snapshot?.error) rows.push({ text: theme.warning(t('No readable repository')) });
  if (snapshot?.truncated) rows.push({ text: theme.warning(t('Worktree list limited')) });
  const current = snapshot?.entries
    .filter((entry) => snapshot.sourcePath === entry.path || snapshot.sourcePath?.startsWith(entry.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (current) {
    rows.push(...kvRows('branch', current.branch ?? t(current.bare ? 'bare' : 'detached'), width));
    rows.push(...kvRows('HEAD', current.head ?? t('unknown'), width));
    if (current.status && now - (current.observedAt ?? 0) <= 30_000) {
      const status = current.status;
      for (const key of ['ahead', 'behind', 'staged', 'unstaged', 'untracked'] as const)
        rows.push(...kvRows(key, String(status[key] ?? '?'), width));
    } else rows.push({ text: theme.warning(t('Git incomplete')) });
  }
  rows.push({ text: '' }, section(t('Worktrees'), width, String(snapshot?.entries.length ?? 0)));
  for (const entry of snapshot?.entries ?? []) {
    const dirty = entry.status && now - (entry.observedAt ?? 0) <= 30_000 ? entry.status.changed > 0 : null;
    const label = `${monitorText(entry.branch ?? t(entry.bare ? 'bare' : 'detached'))} · ${t(dirty === null ? 'unknown' : dirty ? 'dirty' : 'clean')}`;
    rows.push(itemRow('', monitorText(entry.path), label, width));
  }
  return rows;
}

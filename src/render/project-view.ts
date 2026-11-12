/** Pure Project rows, using the same kit as Home and the Inspector. */
import type { ProjectSnapshot, ProjectItem } from '../collectors/project-board.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { basename } from 'node:path';
import { boardRow, itemRow, section, mark, minuteAge, kvRows } from './workboard-rows.js';
import { monitorText, fit } from './monitor-text.js';
import { theme } from './colors.js';
import { t } from './i18n.js';
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number
): MonitorRow[] {
  if (!data) return [];
  const rows: MonitorRow[] = [boardRow('')], folded = state.projectFolded ?? new Set(['control', 'agents']);
  const header = (id: string, label: string, right = '') => {
    rows.push({
      ...section(`${folded.has(id) ? mark('▸', '>') + ' ' : ''}${t(label)}`, width, right),
      item: `project:fold:${id}`,
    });
    return !folded.has(id);
  };
  const item = (r: ProjectItem, i: number, glyph = '') => {
    const left = `${r.label ? fit(t(r.label), 10) + ' ' : ''}${monitorText(r.value)}`;
    const right = width < 56 ? '' : r.at !== undefined ? minuteAge(r.at, now)
      : r.path ? monitorText(basename(r.path)) : '';
    rows.push({
      ...itemRow(glyph, left, right, width),
      ...(r.path ? { item: `project:file:${r.path}:${i}`, files: [r.path] } : {}),
    });
  };
  if (data.waiting.length) {
    if (header('waiting', 'Waiting for you', String(data.waiting.length)))
      data.waiting.forEach((r, i) => item(r, i, theme.board.attention('?')));
    rows.push(boardRow(''));
  }
  if (header('tree', 'Working tree')) {
    if (data.git) item({ label: 'branch', value: [
      data.git.branch, t('{n} changed', { n: data.git.changed }),
      data.git.ahead === null ? '' : `${data.git.ahead} ${t('ahead')}`,
      data.git.behind ? `${data.git.behind} ${t('behind')}` : '',
    ].filter(Boolean).join(' · ') }, 0);
    data.editing.forEach((r, i) => item(r, i, theme.board.active(mark('◉', '@'))));
    if (data.last) item({ label: 'last', value: data.last.text, at: data.last.at }, 0);
  }
  rows.push(boardRow(''));
  if (header('docs', 'Docs')) data.docs.forEach((r, i) => item(r, i));
  rows.push(boardRow(''));
  if (header('control', 'Control plane', `${data.roleCount} ${t('roles')} · ${data.agents.length} ${t('agents')}`)) {
    data.control.forEach((r, i) => item(r.label === 'convention'
      ? { ...r, value: t(r.value) + ' · ' + basename(r.path!) } : r, i));
    if (header('agents', 'agents', String(data.agents.length))) data.agents.forEach((r, i) => item(r, i));
    rows.push(...kvRows('keys', data.keys.map(([name, present]) =>
      `${name} ${mark(present ? '✓' : '−', present ? '+' : '-')}`).join('  '), width));
    item({ label: 'browser', value: mark(data.browser ? '✓' : '−', data.browser ? '+' : '-') }, 0);
  }
  return rows;
}

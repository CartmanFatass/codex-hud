/** Read-only evidence and model activity; exporting requires a separate explicit action. */
import { t } from './i18n.js';
import { colors, theme, visualLength, truncateAnsi } from './colors.js';
import { flowLines, monitorText } from './monitor-text.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';

export type ObservabilityTab = 'sources' | 'calls' | 'export';
export interface ObservabilityState { tab: ObservabilityTab; scroll: number; message?: string }
export interface ObservabilityControl { kind: 'back' | 'save' | ObservabilityTab; x: number; y: number; width: number }
export interface ObservabilityFrame {
  lines: string[]; controls: ObservabilityControl[]; state: ObservabilityState; count: number; total: number;
}
const TABS: ObservabilityTab[] = ['sources', 'calls', 'export'];
const LABELS: Record<ObservabilityTab, string> = { sources: 'Sources', calls: 'Model calls', export: 'Export' };
export const initialObservabilityState = (): ObservabilityState => ({ tab: 'sources', scroll: 0 });

export function renderObservabilityPage(
  state: ObservabilityState, content: { sources: string[]; calls: string[]; preview?: string }, width: number, height: number,
): ObservabilityFrame {
  width = Math.max(1, width); height = Math.max(1, height);
  const controls: ObservabilityControl[] = [];
  const fit = (line: string) => { const cut = truncateAnsi(line, width); return cut + ' '.repeat(Math.max(0, width - visualLength(cut))); };
  const back = truncateAnsi(t('[Back]'), width);
  controls.push({ kind: 'back', x: 0, y: 0, width: visualLength(back) });
  const lines = [fit(`${colors.dim(back)} ${theme.strong(t('HUD evidence'))}`)];
  if (height > 1) {
    let row = '';
    const each = Math.max(1, Math.floor((width - 2) / 3));
    for (const tab of TABS) {
      const x = visualLength(row);
      if (x >= width) break;
      const label = truncateAnsi(`[${t(LABELS[tab])}]`, Math.min(each, width - x));
      controls.push({ kind: tab, x, y: 1, width: visualLength(label) });
      row += (tab === state.tab ? theme.accent(label) : label) + ' ';
    }
    lines.push(fit(row));
  }
  if (state.tab === 'export' && height > 3) {
    const save = truncateAnsi(t('[Save report]'), width);
    if (content.preview) controls.push({ kind: 'save', x: 0, y: lines.length, width: visualLength(save) });
    lines.push(fit(content.preview ? theme.accent(save) : t('No export preview')));
  }
  const body = state.tab === 'sources' ? content.sources : state.tab === 'calls' ? content.calls
    : [t('Preview: exact report contents'), ...(content.preview?.split('\n') ?? [])];
  // Preview is plain JSON; evidence sources have already sanitized their external fields.
  const rows = body.flatMap(line => flowLines(line, width));
  const count = Math.max(0, height - lines.length - 1);
  const scroll = Math.min(Math.max(0, state.scroll), Math.max(0, rows.length - count));
  for (const line of rows.slice(scroll, scroll + count)) lines.push(fit(line));
  while (lines.length < height - 1) lines.push(fit(''));
  if (lines.length < height) lines.push(fit(state.message ? monitorText(state.message)
    : t('Rows {from}–{to}/{total}', { from: rows.length ? scroll + 1 : 0, to: Math.min(rows.length, scroll + count), total: rows.length })));
  return { lines, controls, state: { ...state, scroll }, count, total: rows.length };
}

export function handleObservabilityInput(state: ObservabilityState, input: WorkbenchInput, frame: ObservabilityFrame):
  { state: ObservabilityState; action?: 'close' | 'preview' | 'save' } {
  const change = (tab: ObservabilityTab) => ({ state: { tab, scroll: 0 }, action: tab === 'export' ? 'preview' as const : undefined });
  if (input.type === 'mouse' && input.button === 'left') {
    const hit = frame.controls.find(c => input.y === c.y && input.x >= c.x && input.x < c.x + c.width);
    if (hit?.kind === 'back') return { state, action: 'close' };
    if (hit?.kind === 'save') return { state, action: 'save' };
    if (hit) return change(hit.kind as ObservabilityTab);
  }
  const key = input.type === 'key' ? input.key : input.type === 'mouse'
    ? input.button === 'wheel-down' ? 'down' : input.button === 'wheel-up' ? 'up' : '' : '';
  if (key === 'escape' || key === 'close') return { state, action: 'close' };
  if (['tab', 'right', 'shift-tab', 'left'].includes(key)) {
    const step = key === 'left' || key === 'shift-tab' ? -1 : 1;
    return change(TABS[(TABS.indexOf(state.tab) + step + TABS.length) % TABS.length]);
  }
  if (state.tab === 'export' && input.type === 'key' && (input.raw === 's' || key === 'sort')) return { state, action: 'save' };
  const max = Math.max(0, frame.total - frame.count);
  const delta = key === 'down' ? 1 : key === 'up' ? -1 : key === 'page-down' ? Math.max(1, frame.count)
    : key === 'page-up' ? -Math.max(1, frame.count) : 0;
  return { state: { ...state, scroll: key === 'home' ? 0 : key === 'end' ? max : Math.max(0, Math.min(max, state.scroll + delta)) } };
}

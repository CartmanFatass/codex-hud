/** Shared cell-exact rows. No I/O. */
import { targetKey, type WorkTarget } from '../collectors/workboard-types.js';
import type { MonitorRow } from './monitor.js';
import { theme, visualLength } from './colors.js';
import { displayConfig } from './hud-config.js';
import { pair, monitorText, fit, flowLines } from './monitor-text.js';
import { ageText } from './work-card.js';
import { t } from './i18n.js';
export const asciiBoard = () => displayConfig().icons === 'text';
export const mark = (unicode: string, ascii: string) => (asciiBoard() ? ascii : unicode);
export const boardCursor = (text: string) =>
  theme.board.selected(text.replace(/\x1b\[48;[0-9;]+m|\x1b\[38;2;25;21;13m/g, ''));
export function minuteAge(at: number | null, now: number): string {
  return at === null ? '' : ageText(Math.max(0, Math.floor((now - at) / 60000)));
}
export function boardRow(text: string, target?: WorkTarget): MonitorRow {
  const key = target ? targetKey(target) : undefined;
  return { text, ...(key ? { item: key, key } : {}) };
}
/** Source prose remains available below its display translation. */
export function originalRows(source: string | undefined, item: string, open: boolean, width: number): MonitorRow[] {
  if (!source) return [];
  return [{ item, text: fit('  ' + theme.board.muted(`${open ? mark('▾', 'v') : mark('▸', '>')} ${t('Original')}`), width) },
    ...(open ? source.split(/\r?\n/).flatMap(p => flowLines(monitorText(p), Math.max(1, width - 4)).map(line => ({ item, text: fit('    ' + theme.board.muted(line), width) }))) : [])];
}
export function section(text: string, width: number, right: string | boolean = ''): MonitorRow {
  const tail = typeof right === 'string' ? right : '';
  const left = `${text} ${theme.board.frame(mark('─', '-').repeat(Math.max(0, width - visualLength(text) - visualLength(tail) - (tail ? 2 : 1))))}`;
  return boardRow(tail ? pair(left, theme.board.muted(tail), width) : fit(left, width));
}
export function kvRows(
  label: string,
  value: string,
  width: number,
  ink = (s: string) => s,
  column = width < 56 ? 9 : 10
): MonitorRow[] {
  return flowLines(monitorText(value), Math.max(1, width - column - 1)).map((line, i) =>
    boardRow(
      fit(
        `${theme.board.muted(fit(i ? '' : t(label), column))} ${ink(line)}`,
        width
      )
    )
  );
}
/** `parts` flowed into rows of at most `width`, two spaces between them and two in front. */
export function pack(parts: string[], width: number, max = Infinity): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    if (line && visualLength(line + '  ' + part) > width) { lines.push(line); line = ''; }
    line += '  ' + part;
  }
  if (line) lines.push(line);
  return lines.slice(0, max);
}
export const itemRow = (glyph: string, left: string, right: string, width: number): MonitorRow =>
  boardRow(pair(`${glyph || ' '} ${left}`, theme.board.muted(right), width));
export const subTopRow = (crumb: string, right: string, width: number): string =>
  theme.board.title(pair(`${mark('‹', '<')} ${crumb}`, right, width));
export function footHints(hints: string, room: number): string {
  const parts = hints.split('  ');
  while (parts.length && visualLength(parts.join('  ')) > room) parts.pop();
  return parts.join('  ');
}
// A normal footer supplies the row's hints in priority order. A modal owns the keys
// and supplies its own hints.
export type FooterHints = readonly string[] | { modal: readonly string[] };
export function footerLayout(hints: FooterHints, width: number, left = '') {
  const keys = 'modal' in hints ? hints.modal : hints;
  const localize = (key: string) => {
    const label = t(key);
    return { key, label, width: visualLength(label) };
  };
  const parts = keys.map(localize);
  const help = 'modal' in hints ? undefined : localize('? help');
  const room = Math.max(help?.width ?? 0, width - (left ? visualLength(left) + 2 : 0));
  // Include a trailing gap in the budget for each hint, then remove the last gap.
  let cells = parts.reduce((n, part) => n + part.width + 2, help ? help.width + 2 : 0);
  while (parts.length && cells - 2 > room) cells -= parts.pop()!.width + 2;
  if (help && help.width > width) return [];
  if (help) parts.push(help);
  let x = width - cells + 2;
  return parts.map((hint) => {
    const at = x;
    x += hint.width + 2;
    return { ...hint, x: at };
  });
}
export function footRow(left: string, hints: FooterHints, width: number): string {
  const right = footerLayout(hints, width, left).map(({ label }) => label).join('  ');
  return fit(pair(left, theme.board.muted(right), width), width);
}
export function homeDoneCount(done: number, width: number): string {
  return done ? theme.board.success(`${mark('✓', '+')} ${width < 56 ? done : t('{n} done today', { n: done })}`) : '';
}

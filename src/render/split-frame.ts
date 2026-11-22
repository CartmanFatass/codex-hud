/**
 * The Split layout (spec §2.2 "Panel layouts", `docs/design/panel-v8/` option 2): a list on top, a preview of the cursor row below.
 * A scene is what one view (Home, the hub, a page) says about itself; this file lays a scene out in the frame, gives way from
 * the preview's bottom first (blank rows, then the preview, never the list), scrolls each part by itself and paints the cursor.
 * The list may be capped at a chosen share of the rows (`splitRatio`), and shrinks to three rows around the cursor while the keys
 * are in the preview; a preview with more rows than fit shows a scrollbar in its last cell.
 */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import type { MonitorFrame, MonitorRow } from './monitor.js';
import type { ClassicSplitNav, SplitNav } from './monitor-state.js';
import { boardCursor, footRow, mark, section, type FooterHints } from './workboard-rows.js';
import { stripAnsi, theme, truncateAnsi, visualLength } from './colors.js';
import { fit } from './monitor-text.js';
import { t } from './i18n.js';
import { filterHints } from './filter.js';

export interface SplitScene {
  nav: ClassicSplitNav;
  /** Every row of an entry carries the entry's `item` (a reason row too); header and blank rows carry none. */
  list: MonitorRow[];
  /** The entry under the cursor: its rows are the band. */
  cursor?: string;
  /** The preview's rule: what it previews, and what the entry says about itself. */
  rule: { label: string; right?: string };
  preview: MonitorRow[];
  /** While the keys are in the preview: the row under its cursor. */
  sub?: string;
  /** A picker in the preview can give its space to the picker without changing the saved list focus. */
  compact?: boolean;
  /** Outside it: the preview row `y` and `n` act on (the next to-try slice), painted as the cursor is. */
  act?: string;
  /** What the preview's scroll belongs to: another page or entry starts it at the top. */
  scope: string;
  hints: FooterHints;
  /** The footer's left side (Home: what was done today). */
  left?: string;
}
const MIN_PREVIEW = 3, COMPACT = 3;
/** The first `n` cells of a row (padded): a longer row loses its last cells, with no `…`. */
const cells = (row: string, n: number) => fit(visualLength(row) <= n ? row : truncateAnsi(row + ' ', n + 1, ''), n);
const blank = (r: MonitorRow) => !r.item && !stripAnsi(r.text).trim();
export const splitItems = (rows: readonly MonitorRow[] = []): string[] => [...new Set(rows.flatMap((r) => (r.item ? [r.item] : [])))];
/** The entry's rows are one band; in the preview only its first row is, as in Classic. */
const first = (rows: readonly MonitorRow[], item: string | undefined) => (item ? rows.findIndex((r) => r.item === item) : -1);
/** Keep the keys in the preview only while it has the row they are on. */
export const splitSubValid = (split: SplitNav, preview: readonly MonitorRow[]): string | undefined =>
  split.focus === 'preview' && preview.some((r) => r.item && r.item === split.previewCursor) ? split.previewCursor : undefined;

/** How the body's rows divide: whether blank rows stay, the list's rows and the room each part gets. */
function rooms(scene: SplitScene, ratio: number | undefined, focus: SplitNav['focus'], body: number) {
  // Blank rows give way first; then the preview, from its bottom, down to three rows; then the list scrolls with its cursor.
  const gaps = body - (scene.list.length + 3) >= MIN_PREVIEW;
  const list = gaps ? scene.list : scene.list.filter((r) => !blank(r));
  const lead = gaps ? 1 : 0, rest = body - lead - (gaps ? 1 : 0) - 1;
  // The list is as tall as it needs, at most the chosen share; in the preview it gives its rows up (Esc restores the share).
  const compact = scene.compact || focus === 'preview', share = Math.min(ratio ? Math.round(rest * ratio) : Infinity, compact ? COMPACT : Infinity);
  const listRoom = Math.max(0, Math.min(list.length, rest - MIN_PREVIEW, share));
  return { gaps, list, lead, compact, listRoom, previewRoom: Math.max(0, rest - listRoom) };
}
/** The preview has more rows than its room: it scrolls, and its last cell is the scrollbar, so the caller lays it out one cell narrower. */
export const splitPreviewRoom = (scene: SplitScene, ratio: number | undefined, focus: SplitNav['focus'], height: number, notes: number) =>
  rooms(scene, ratio, focus, Math.max(0, height - 2 - notes)).previewRoom;

export function paintSplit(
  frame: MonitorFrame, scene: SplitScene, board: WorkboardSnapshot,
  targets: ReadonlyMap<string, WorkTarget>, selected: WorkTarget | undefined, width: number, height: number, notes: string[],
): ClassicSplitNav {
  // A notice or an error sits on the rows under the tab row, as it does in Classic.
  const state = frame.state, top = 1 + notes.length, body = Math.max(0, height - 1 - top);
  notes.forEach((text, i) => { if (1 + i < height - 1) frame.lines[1 + i] = fit(text, width); });
  const { nav } = scene, { split } = nav;
  const { gaps, list, lead, compact, listRoom, previewRoom } = rooms(scene, state.prefs.splitRatio, split.focus, body);
  const at = first(list, scene.cursor), last = at < 0 ? -1 : list.map((r) => r.item).lastIndexOf(scene.cursor);
  let listAt = Math.max(0, Math.min(list.length - listRoom, split.listScroll));
  if (compact && at >= 0) listAt = Math.max(0, Math.min(list.length - listRoom, at - Math.floor((listRoom - (last - at + 1)) / 2)));
  if (at >= 0 && at < listAt) listAt = at;
  if (last >= listAt + listRoom) listAt = last - listRoom + 1;
  const reveal = first(scene.preview, scene.sub), marker = `${scene.scope}|${scene.sub}`;
  let previewAt = Math.max(0, Math.min(scene.preview.length - previewRoom, split.previewScroll));
  const revealChanged = reveal >= 0 && nav.revealed !== marker;
  // The row the keys moved to comes into view once; the scroll keys then move the window as they like.
  if (revealChanged) {
    if (reveal < previewAt) previewAt = reveal;
    else if (reveal >= previewAt + previewRoom) previewAt = reveal - previewRoom + 1;
  }
  // `edge` takes the row's last cell (the scrollbar): no column is added.
  const put = (y: number, row: MonitorRow, banded: boolean, edge = '') => {
    const raw = row.paint?.() ?? row.text, text = edge ? cells(raw, width - 1) + edge : fit(raw, width);
    frame.lines[y] = banded ? boardCursor(text) : text;
    for (const control of row.controls ?? []) {
      const span = Math.min(control.width, width - (edge ? 1 : 0) - control.x);
      if (span > 0) frame.controls.push({ ...control, y, width: span });
    }
  };
  const listTop = top + lead;
  for (let i = 0; i < listRoom; i++) {
    const row = list[listAt + i];
    if (row) put(listTop + i, row, !!scene.cursor && row.item === scene.cursor);
  }
  const ruleAt = listTop + listRoom + (gaps ? 1 : 0), previewTop = ruleAt + 1;
  if (ruleAt < height - 1) frame.lines[ruleAt] = section(scene.rule.label, width, scene.rule.right ?? '').text;
  const band = scene.sub ?? scene.act, total = scene.preview.length, scrolls = total > previewRoom && width > 1;
  // The thumb is as long as the share of the preview in view, and sits where the window is.
  const thumb = Math.max(1, Math.round((previewRoom * previewRoom) / total)), thumbAt = Math.round((previewAt / (total - previewRoom || 1)) * (previewRoom - thumb));
  for (let i = 0; i < previewRoom; i++) {
    const row = scene.preview[previewAt + i], inThumb = i >= thumbAt && i < thumbAt + thumb;
    if (row) put(previewTop + i, row, previewAt + i === first(scene.preview, band), scrolls ? (inThumb ? theme.board.muted(mark('┃', '#')) : theme.board.frame(mark('│', '|'))) : '');
  }
  if (height > 1) frame.lines[height - 1] = footRow(scene.left ?? '', filterHints(state, scene.hints), width);
  frame.lines = frame.lines.map((line) => theme.board.text(fit(line, width)));
  frame.panes.push(
    { id: 'agents', x: 0, y: listTop, width, height: listRoom, offset: listAt, contentLength: list.length, rows: list, edge: 0, visible: listRoom },
    { id: 'preview', x: 0, y: previewTop, width, height: previewRoom, offset: previewAt, contentLength: scene.preview.length, rows: scene.preview, edge: 0, visible: previewRoom },
  );
  frame.workboard = { snapshot: board, targets, selected, rows: [...list, ...scene.preview] };
  return { ...nav, revealed: revealChanged ? marker : nav.revealed,
    split: { ...split, listScroll: compact ? split.listScroll : listAt, previewScroll: previewAt } };
}

/**
 * The Split layout (spec §2.2 "Panel layouts", `docs/design/panel-v8/` option 2): a list on top, a preview of the cursor row below.
 * A scene is what one view (Home, the hub, a page) says about itself; this file lays a scene out in the frame, gives way from
 * the preview's bottom first (blank rows, then the preview, never the list), scrolls each part by itself and paints the cursor.
 */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import type { MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { boardCursor, footRow, section } from './workboard-rows.js';
import { stripAnsi, theme } from './colors.js';
import { fit } from './monitor-text.js';
import { t } from './i18n.js';

export interface SplitScene {
  /** Every row of an entry carries the entry's `item` (a reason row too); header and blank rows carry none. */
  list: MonitorRow[];
  /** The entry under the cursor: its rows are the band. */
  cursor?: string;
  /** The preview's rule: what it previews, and what the entry says about itself. */
  rule: { label: string; right?: string };
  preview: MonitorRow[];
  /** While the keys are in the preview: the row under its cursor. */
  sub?: string;
  /** Outside it: the preview row `y` and `n` act on (the next to-try slice), painted as the cursor is. */
  act?: string;
  /** What the preview's scroll belongs to: another page or entry starts it at the top. */
  scope: string;
  hints: string;
  /** The footer's left side (Home: what was done today). */
  left?: string;
}
const MIN_PREVIEW = 3;
const blank = (r: MonitorRow) => !r.item && !stripAnsi(r.text).trim();
export const splitItems = (rows: readonly MonitorRow[] = []): string[] => [...new Set(rows.flatMap((r) => (r.item ? [r.item] : [])))];
/** The entry's rows are one band; in the preview only its first row is, as in Classic. */
const first = (rows: readonly MonitorRow[], item: string | undefined) => (item ? rows.findIndex((r) => r.item === item) : -1);
/** What the preview's scroll belongs to, and the cursor state a new scope clears. */
export function splitScope(state: MonitorState, scope: string): void {
  if (state.splitFor === scope) return;
  state.splitFor = scope;
  state.splitScroll = 0;
}
/** Keep the keys in the preview only while it has the row they are on. */
export const splitSubValid = (state: MonitorState, preview: readonly MonitorRow[]): string | undefined =>
  state.splitFocus === 'preview' && state.splitSub && preview.some((r) => r.item === state.splitSub) ? state.splitSub : undefined;

export function paintSplit(
  frame: MonitorFrame, scene: SplitScene, board: WorkboardSnapshot,
  targets: ReadonlyMap<string, WorkTarget>, selected: WorkTarget | undefined, width: number, height: number, notes: string[] = [],
): MonitorFrame {
  // A notice or an error sits on the rows under the tab row, as it does in Classic.
  const state = frame.state, top = 1 + notes.length, body = Math.max(0, height - 1 - top);
  notes.forEach((text, i) => { if (1 + i < height - 1) frame.lines[1 + i] = fit(text, width); });
  // Blank rows give way first; then the preview, from its bottom, down to three rows; then the list scrolls with its cursor.
  const gaps = body - (scene.list.length + 3) >= MIN_PREVIEW;
  const list = gaps ? scene.list : scene.list.filter((r) => !blank(r));
  const lead = gaps ? 1 : 0, rest = body - lead - (gaps ? 1 : 0) - 1;
  const listRoom = Math.max(0, Math.min(list.length, rest - MIN_PREVIEW));
  const previewRoom = Math.max(0, rest - listRoom);
  const at = first(list, scene.cursor), last = at < 0 ? -1 : list.map((r) => r.item).lastIndexOf(scene.cursor);
  let listAt = Math.max(0, Math.min(list.length - listRoom, state.splitListScroll ?? 0));
  if (at >= 0 && at < listAt) listAt = at;
  if (last >= listAt + listRoom) listAt = last - listRoom + 1;
  state.splitListScroll = listAt;
  const reveal = first(scene.preview, scene.sub);
  let previewAt = Math.max(0, Math.min(scene.preview.length - previewRoom, state.splitScroll ?? 0));
  // The row the keys moved to comes into view once; the scroll keys then move the window as they like.
  if (reveal >= 0 && state.boardRevealed !== `${scene.scope}|${scene.sub}`) {
    if (reveal < previewAt) previewAt = reveal;
    else if (reveal >= previewAt + previewRoom) previewAt = reveal - previewRoom + 1;
    state.boardRevealed = `${scene.scope}|${scene.sub}`;
  }
  state.splitScroll = previewAt;
  const put = (y: number, row: MonitorRow, banded: boolean) => {
    const text = fit(row.paint?.() ?? row.text, width);
    frame.lines[y] = banded ? boardCursor(text) : text;
  };
  const listTop = top + lead;
  for (let i = 0; i < listRoom; i++) {
    const row = list[listAt + i];
    if (row) put(listTop + i, row, !!scene.cursor && row.item === scene.cursor);
  }
  const ruleAt = listTop + listRoom + (gaps ? 1 : 0), previewTop = ruleAt + 1;
  if (ruleAt < height - 1) frame.lines[ruleAt] = section(scene.rule.label, width, scene.rule.right ?? '').text;
  const band = scene.sub ?? scene.act;
  for (let i = 0; i < previewRoom; i++) {
    const row = scene.preview[previewAt + i];
    if (row) put(previewTop + i, row, previewAt + i === first(scene.preview, band));
  }
  if (height > 1) frame.lines[height - 1] = footRow(scene.left ?? '', t(scene.hints), width);
  frame.lines = frame.lines.map((line) => theme.board.text(fit(line, width)));
  frame.panes.push(
    { id: 'agents', x: 0, y: listTop, width, height: listRoom, offset: listAt, contentLength: list.length, rows: list, edge: 0, visible: listRoom },
    { id: 'preview', x: 0, y: previewTop, width, height: previewRoom, offset: previewAt, contentLength: scene.preview.length, rows: scene.preview, edge: 0, visible: previewRoom },
  );
  frame.workboard = { snapshot: board, targets, selected, rows: [...list, ...scene.preview] };
  return frame;
}

/**
 * Split's keys and mouse (`docs/design/panel-v8/notes.md`, option 2): ↑↓ move in the list, PgUp/PgDn or the wheel over the preview
 * scroll it, Enter moves into the preview where it has rows to act on (then Enter acts as Classic's does, Esc returns), a click
 * selects and a second click is Enter. Everything else is Classic's: a step returns `undefined` and Classic's code runs.
 */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { targetKey } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorContext, MonitorOutcome, MonitorRect, MonitorState } from './monitor.js';
import { monitorRowAt } from './monitor-input.js';
import { splitItems } from './split-frame.js';
import { tryInput } from './try-input.js';

/** The list's share stays between a fifth and four fifths of the rows, so neither part can be sized away. */
const RATIO = [0.2, 0.8];
type Outcome = (action?: MonitorOutcome['action']) => MonitorOutcome;
const MOVE = ['up', 'down', 'home', 'end'];
const step = (items: string[], at: string | undefined, key: string): string | undefined =>
  items[key === 'home' ? 0 : key === 'end' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, items.indexOf(at ?? '') + (key === 'up' ? -1 : 1)))];
const panes = (ctx: MonitorContext) => ({ list: ctx.frame?.panes.find((p) => p.id === 'agents'), preview: ctx.frame?.panes.find((p) => p.id === 'preview') });
const inside = (pane: MonitorRect | undefined, y: number) => !!pane && y >= pane.y && y < pane.y + pane.height;
/** `=` `+` grow the list by a row, `-` grows the preview. Only while the list has the keys (with them in the preview the list is compact; Esc restores the share). True when the input was one of these. */
function resize(next: MonitorState, key: string, ctx: MonitorContext): boolean {
  const { list, preview } = panes(ctx), total = list && preview && next.splitFocus !== 'preview' ? list.height + preview.height : 0;
  const step = key === 'list-grow' ? 1 : key === 'list-shrink' ? -1 : 0;
  if (total && step) next.splitRatio = Math.round(Math.max(RATIO[0], Math.min(RATIO[1], (list!.height + step) / total)) * 1000) / 1000;
  return total > 0 && step !== 0;
}
/** What one input means in either view: the key to treat as pressed, a scroll or a move already made, or a row clicked. */
function read(next: MonitorState, input: WorkbenchInput, key: string, ctx: MonitorContext, move: (items: string[], key: string) => void) {
  const { list, preview } = panes(ctx);
  if (key === 'page-up' || key === 'page-down') {
    next.splitScroll = (next.splitScroll ?? 0) + (key === 'page-down' ? 1 : -1) * Math.max(1, (preview?.height ?? 1) - 1);
    return 'done' as const;
  }
  if (input.type !== 'mouse') return key;
  if (input.button !== 'left') {
    if (inside(preview, input.y)) next.splitScroll = (next.splitScroll ?? 0) + (input.button === 'wheel-down' ? 3 : -3);
    else if (next.splitFocus !== 'preview') move(splitItems(list?.rows), input.button === 'wheel-down' ? 'down' : 'up');
    return 'done' as const;
  }
  const row = inside(preview, input.y) ? monitorRowAt(preview!, input.x, input.y) : list && inside(list, input.y) ? monitorRowAt(list, input.x, input.y) : undefined;
  return row?.item ? { click: row.item, inPreview: inside(preview, input.y) } : ('done' as const);
}

export function splitHomeInput(
  next: MonitorState, input: WorkbenchInput, key: string, ctx: MonitorContext, result: Outcome,
  deps: { toggle: (item: string) => void; openProgress: (item: string) => void },
): MonitorOutcome | undefined {
  if (resize(next, key, ctx)) return result();
  const { list, preview } = panes(ctx), focus = next.splitFocus === 'preview';
  const subs = splitItems(preview?.rows), cursor = next.splitCursor;
  const move = (items: string[], k: string) => { const to = step(items, focus ? next.splitSub : cursor, k); if (focus) next.splitSub = to; else next.splitCursor = to; };
  const enter = () => {
    if (focus) return next.splitSub?.startsWith('home-progress:') ? deps.openProgress(next.splitSub) : next.splitSub && deps.toggle(next.splitSub);
    if (cursor === 'home-progress:progress') return deps.openProgress(cursor);
    if (subs.length) { next.splitFocus = 'preview'; next.splitSub = subs[0]; }
  };
  const got = read(next, input, key, ctx, move);
  if (typeof got === 'object') {
    // A click on the entry the cursor is on is Enter; on another it selects (and leaves the preview).
    if (got.inPreview) { if (focus && next.splitSub === got.click) enter(); else { next.splitFocus = 'preview'; next.splitSub = got.click; } }
    else if (got.click === cursor && !focus) enter();
    else { next.splitCursor = got.click; next.splitFocus = undefined; }
    return result();
  }
  if (got === 'done') return result();
  if (MOVE.includes(key)) { move(splitItems(focus ? preview?.rows : list?.rows), key); return result(); }
  if (key === 'enter' || key === 'activate') { enter(); return result(); }
  if (key === 'escape' && focus) { next.splitFocus = undefined; return result(); }
  if ((key === 'next-trouble' || key === 'previous-trouble') && !focus) {
    // Classic's order: what asks the owner, then what stalled.
    const workers = ctx.frame?.workboard?.snapshot.workers ?? [], now = ctx.nowMs ?? 0;
    const of = (state: string) => workers.filter((w) => projectWorkCard(w, now, next.cardStallMinutes).state === state);
    const lanes = [...of('needs-you'), ...of('stalled')].map((w) => targetKey({ kind: 'lane', laneId: w.laneId }));
    if (lanes.length) next.splitCursor = lanes[(Math.max(-1, lanes.indexOf(cursor ?? '')) + (key === 'previous-trouble' ? lanes.length - 1 : 1)) % lanes.length];
    return result();
  }
  return undefined;
}

export function splitProjectInput(next: MonitorState, input: WorkbenchInput, key: string, ctx: MonitorContext, result: Outcome, activate: () => MonitorOutcome): MonitorOutcome | undefined {
  if (resize(next, key, ctx)) return result();
  const { list, preview } = panes(ctx), focus = next.splitFocus === 'preview', at = focus ? next.splitSub : next.projectCursor;
  const subs = splitItems(preview?.rows), rows = [...(list?.rows ?? []), ...(preview?.rows ?? [])];
  const move = (items: string[], k: string) => { const to = step(items, at, k); if (focus) next.splitSub = to; next.projectCursor = to; };
  const intoPreview = (item: string) => {
    if (!focus) next.splitList = next.projectCursor;
    next.splitFocus = 'preview';
    next.projectCursor = next.splitSub = item;
  };
  const enter = () => {
    if (!focus && at && subs.length && !/^project:(page:|switch$)/.test(at)) {
      intoPreview(subs[0]);
      return result();
    }
    return activate();
  };
  const got = read(next, input, key, ctx, move);
  if (typeof got === 'object') {
    if (got.inPreview) {
      if (focus && at === got.click) return enter();
      intoPreview(got.click);
    } else if (got.click === at && !focus) return enter();
    else { next.splitFocus = undefined; next.projectCursor = got.click; if (focus && next.mainTab === 'project') next.trySelection = undefined; }
    return result();
  }
  if (got === 'done') return result();
  if (MOVE.includes(key)) { move(splitItems(focus ? preview?.rows : list?.rows), key); return result(); }
  if (key === 'escape' && focus) {
    next.splitFocus = undefined; next.projectCursor = next.splitList;
    if (next.mainTab === 'project') next.trySelection = undefined;
    return result();
  }
  if (key === 'enter' || key === 'activate') return enter();
  if (key === 'space' || key === 'try-accept' || key === 'try-flag') {
    const cursorRow = rows.find((r) => r.item === at && r.tryTarget);
    const row = cursorRow ?? (focus ? undefined : preview?.rows.find((r) => r.tryTarget));
    if (preview && row?.item) {
      const index = preview.rows.indexOf(row);
      if (key === 'space' && !cursorRow) intoPreview(row.item);
      // For an unmarked decision, show the target's header before accepting a second keypress.
      if (key !== 'space' && !next.trySelection && index >= 0 && (index < preview.offset || index >= preview.offset + preview.height)) {
        intoPreview(row.item);
        next.boardRevealed = undefined;
        return result();
      }
    }
    const tried = tryInput(next, key, row);
    if (tried) return tried;
  }
  return undefined;
}

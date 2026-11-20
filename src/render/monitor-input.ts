/** Shared passive-page input; Home owns all card navigation. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRect, MonitorRow, MonitorState } from './monitor.js';
import { harnessAddInput, workboardInput } from './workboard-input.js';
import { modelInputEvent } from './model-input.js';
import { presetInputKey } from './preset-input.js';
import { chainInputKey } from './chain-input.js';
import { jobModalInput } from './job-actions.js';
import { filterInput, filterScope } from './filter.js';
import { expInput } from './exp-view.js';
import { expShown } from './main-tabs.js';
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  const edge = pane.edge ?? 1;
  if (x < pane.x || x >= pane.x + pane.width || y < pane.y + edge || y >= pane.y + pane.height) return undefined;
  if (pane.visible !== undefined && y - pane.y - edge >= pane.visible) return undefined;
  const line = y - pane.y - edge < (pane.pinned ?? 0) ? y - pane.y - edge : pane.offset + y - pane.y - edge;
  return line >= 0 ? pane.rows[line] : undefined;
}
export function monitorItemAt(pane: MonitorRect, x: number, y: number): string | undefined {
  return monitorRowAt(pane, x, y)?.item || undefined;
}
export function handleMonitorInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  const out = route(state, input, ctx);
  // A `/` filter belongs to the view it was typed in: another tab, page, project, Help or the Inspector clears it.
  if ((out.state.filterQuery !== undefined || out.state.filterOpen) && filterScope(out.state) !== filterScope(state))
    out.state = { ...out.state, filterQuery: undefined, filterOpen: undefined };
  return out;
}
function route(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  if (expShown(state) && state.expPage?.edit) return expInput(state, input, ctx)!;
  if (state.controlPresetInput) return presetInputKey(state, input, ctx);
  if (state.controlChain) return chainInputKey(state, input, ctx, route);
  const add = harnessAddInput(state, input, ctx);
  if (add) return add;
  // The Control picker owns its own mouse targets and printable keys (`q` is a letter in it).
  if (state.projectInput) {
    const picked = modelInputEvent(state, input, ctx);
    if (picked) return picked;
  }
  // The `/` filter: its typing owns the keyboard, as the model input's does.
  const filter = filterInput(state, input);
  if (filter) return filter;
  const next = { ...state, tree: { ...state.tree }, modes: { ...state.modes }, scroll: { ...state.scroll } };
  const result = (action?: MonitorOutcome['action'], close = false): MonitorOutcome => ({ state: next, close, action });
  if (input.type === 'mouse' && input.button === 'left') next.projectInput = undefined;
  const key =
    input.type === 'key'
      ? input.key
      : input.type === 'mouse' && input.button !== 'left'
        ? input.button === 'wheel-down'
          ? 'down'
          : 'up'
        : '';
  if (key === 'close') return result(undefined, true);
  const modal = jobModalInput(state, input);
  if (modal) return modal;
  if (next.help) {
    const back =
      input.type === 'mouse' &&
      input.button === 'left' &&
      ctx.frame?.controls.some(
        (c) => c.kind === 'help' && input.y === c.y && input.x >= c.x && input.x < c.x + c.width
      );
    if (back || ['escape', 'help', 'enter'].includes(key)) next.help = false;
    else if (input.type === 'key' || (input.type === 'mouse' && input.button !== 'left')) {
      const direction = input.type === 'mouse' ? (input.button === 'wheel-down' ? 'down' : 'up') : key;
      const page = Math.max(1, ctx.frame?.helpPage?.count ?? 1);
      const delta =
        direction === 'down' ? 1 : direction === 'up' ? -1 : key === 'page-down' ? page : key === 'page-up' ? -page : 0;
      const max = Math.max(0, (ctx.frame?.helpPage?.total ?? 0) - page);
      next.helpScroll =
        key === 'home' ? 0 : key === 'end' ? max : Math.max(0, Math.min(max, (next.helpScroll ?? 0) + delta));
    }
    return result();
  }
  if (key === 'export-board' && next.focus === 'agents' && !expShown(next)) return result({ type: 'export-board' });
  if (key === 'help' || key === 'settings') next.trySelection = undefined;
  const board = workboardInput(next, input, ctx);
  if (board) return board;
  if (key === 'settings') return result({ type: 'settings' });
  if (key === 'brief-toggle') return result({ type: 'brief-toggle' });
  if (key === 'help') {
    next.help = true;
    next.helpScroll = 0;
  }
  if (next.focus === 'changes') {
    const pane = ctx.frame?.panes.find((p) => p.id === 'changes');
    const max = pane ? Math.max(0, pane.contentLength - Math.max(1, pane.height)) : Infinity;
    const delta = key === 'down' ? 1 : key === 'up' ? -1 : key === 'page-down' ? 5 : key === 'page-up' ? -5 : 0;
    next.scroll.changes = Math.max(0, Math.min(max, next.scroll.changes + delta));
  }
  return result();
}

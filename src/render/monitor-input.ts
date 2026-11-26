/** Shared input for panel views and overlays. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRect, MonitorRow, MonitorState } from './monitor.js';
import { harnessAddInput, workboardInput } from './workboard-input.js';
import { presetInputKey } from './preset-input.js';
import { chainInputKey, quickModelKey } from './chain-input.js';
import { jobModalInput } from './job-actions.js';
import { clearFilter, filterInput, filterRetentionScope, filterScope } from './filter.js';
import { expInput } from './exp-view.js';
import { resourcesShown } from './main-tabs.js';
import { hasUnsavedDraft } from './monitor-state.js';
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  const edge = pane.edge ?? 1;
  if (x < pane.x || x >= pane.x + pane.width || y < pane.y + edge || y >= pane.y + pane.height) return undefined;
  if (pane.visible !== undefined && y - pane.y - edge >= pane.visible) return undefined;
  const line = y - pane.y - edge < (pane.pinned ?? 0) ? y - pane.y - edge : pane.offset + y - pane.y - edge;
  return line >= 0 ? pane.rows[line] : undefined;
}
export function monitorItemAt(pane: MonitorRect, x: number, y: number): string | undefined {
  const row = monitorRowAt(pane, x, y);
  if (!row) return undefined;
  if (row.metroStations) {
    const col = x - pane.x;
    return row.metroStations.find((s) => col >= s.x && col < s.x + s.width)?.item;
  }
  return row.item || undefined;
}
export function handleMonitorInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  // A harness switch acknowledgement lasts until the next input, in the live panel and in pure routing.
  const ready = state.control.notice?.kind === 'harness'
    ? { ...state, control: { ...state.control, notice: undefined } } : state;
  const out = route(ready, input, ctx);
  // Leaving filtered Project diagnostics clears the query; a Feature sub-page opened from Tickets keeps it.
  if (filterRetentionScope(out.state) !== filterRetentionScope(state)) return { ...out, state: clearFilter(out.state) };
  if (!filterScope(out.state) && out.state.project.filter?.editing) {
    const query = out.state.project.filter.query;
    return { ...out, state: query ? { ...out.state, project: { ...out.state.project, filter: { query, editing: false } } } : clearFilter(out.state) };
  }
  return out;
}
function route(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  const key =
    input.type === 'key'
      ? input.key
      : input.type === 'mouse' && input.button !== 'left'
        ? input.button === 'wheel-down'
          ? 'down'
          : 'up'
        : '';
  if (state.help) {
    // Quitting still needs the chain's discard confirmation, visible after Help closes.
    if (key === 'close') return state.overlay?.kind === 'control-chain' && hasUnsavedDraft(state)
      ? route({ ...state, help: undefined }, input, ctx) : { state, close: true };
    const next = { ...state };
    const back =
      input.type === 'mouse' &&
      input.button === 'left' &&
      ctx.frame?.controls.some(
        (c) => c.kind === 'help' && input.y === c.y && input.x >= c.x && input.x < c.x + c.width
      );
    if (back || ['escape', 'help', 'enter'].includes(key)) next.help = undefined;
    else if (input.type === 'key' || (input.type === 'mouse' && input.button !== 'left')) {
      const page = Math.max(1, ctx.frame?.helpPage?.count ?? 1);
      const delta = key === 'down' ? 1 : key === 'up' ? -1 : key === 'page-down' ? page : key === 'page-up' ? -page : 0;
      const max = ctx.frame?.helpPage?.maxOffset ?? 0;
      next.help = { scroll: key === 'home' ? 0 : key === 'end' ? max : Math.max(0, Math.min(max, (state.help.scroll ?? 0) + delta)) };
    }
    return { state: next, close: false };
  }
  const overlay = state.overlay;
  switch (overlay?.kind) {
    case 'exp-edit': if (resourcesShown(state)) return expInput(state, input, ctx)!; break;
    case 'control-preset': return presetInputKey(state, overlay.sheet, input, ctx);
    case 'control-quick-model': return quickModelKey(state, overlay, input, ctx);
    case 'control-chain': return chainInputKey(state, overlay, input, ctx, route);
    case 'control-harness-add': return harnessAddInput(state, overlay, input, ctx);
    case 'confirm-stop':
    case 'confirm-batch':
    case undefined: break;
    default: overlay satisfies never;
  }
  // The `/` filter: its typing owns the keyboard, as the model input's does.
  const filter = filterInput(state, input);
  if (filter) return filter;
  const next = { ...state };
  const result = (action?: MonitorOutcome['action'], close = false): MonitorOutcome => ({ state: next, close, action });
  if (key === 'close') return result(undefined, true);
  const modal = jobModalInput(state, input);
  if (modal) return modal;
  if (key === 'export-board' && !next.subpage && !resourcesShown(next)) return result({ type: 'export-board' });
  const board = workboardInput(next, input, ctx);
  if (board) return board;
  if (key === 'settings') return result({ type: 'settings' });
  if (key === 'help') next.help = {};
  return result();
}

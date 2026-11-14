/** Shared passive-page input; Home owns all card navigation. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRect, MonitorRow, MonitorState } from './monitor.js';
import { workboardInput } from './workboard-input.js';
import { modelInputKey } from './model-input.js';
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
  // The Control plane's model input owns the keyboard (`q` is a letter in it); a click leaves it and is handled as ever.
  if (state.projectInput && input.type === 'key') return modelInputKey(state, input, ctx);
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
  if (next.help) {
    const back =
      input.type === 'mouse' &&
      input.button === 'left' &&
      ctx.frame?.controls.some(
        (c) => c.kind === 'help' && input.y === c.y && input.x >= c.x && input.x < c.x + c.width
      );
    if (back || ['escape', 'help', 'enter'].includes(key)) next.help = false;
    else {
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
  const board = workboardInput(next, input, ctx);
  if (board) return board;
  if (key === 'settings') return result({ type: 'settings' });
  if (key === 'brief-toggle') return result({ type: 'brief-toggle' });
  if (key === 'help') {
    next.help = true;
    next.helpScroll = 0;
  }
  if (key === 'escape') next.keys = false;
  if (next.focus === 'changes') {
    const delta = key === 'down' ? 1 : key === 'up' ? -1 : key === 'page-down' ? 5 : key === 'page-up' ? -5 : 0;
    next.scroll.changes = Math.max(0, next.scroll.changes + delta);
  }
  return result();
}

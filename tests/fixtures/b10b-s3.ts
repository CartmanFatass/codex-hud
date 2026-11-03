/**
 * B10B-s3 test helpers: a panel drawn through `renderMonitor` from a synthetic view model, and keys and clicks
 * resolved against the frame it drew, as the page does. Synthetic data only.
 */

import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import {
  handleMonitorInput,
  initialMonitorState,
  renderMonitor,
  type MonitorData,
  type MonitorFrame,
  type MonitorOutcome,
  type MonitorState,
} from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
import { FIXED_NOW, makeHudData, makeNestedTree } from './hud-data.js';

export interface PanelOptions {
  style?: 'rich' | 'compact';
  width?: number;
  height?: number;
  now?: number;
  /** The state to continue from (the frame before); default a fresh one. */
  state?: MonitorState;
  selected?: string | null;
  collapsed?: readonly string[];
  showAll?: boolean;
  sort?: 'created';
}

export function monitorInput(vm: DelegationViewModel | null | undefined, o: PanelOptions = {}): MonitorData {
  const state = o.state ?? initialMonitorState();
  state.style = o.style ?? state.style ?? 'compact';
  if (o.selected !== undefined) state.tree = { ...state.tree, selectedId: o.selected };
  if (o.collapsed) state.tree = { ...state.tree, collapsed: new Set(o.collapsed) };
  if (o.showAll !== undefined) state.tree = { ...state.tree, showAll: o.showAll };
  if (o.sort) state.tree = { ...state.tree, sort: o.sort };
  const hud = makeHudData();
  return {
    tree: makeNestedTree(),
    state,
    width: o.width ?? 48,
    height: o.height ?? 30,
    nowMs: o.now ?? FIXED_NOW.getTime(),
    hud: vm === undefined ? hud : { ...hud, delegation: vm },
  };
}

/** One frame of the panel. */
export function draw(vm: DelegationViewModel | null | undefined, o: PanelOptions = {}): MonitorFrame {
  return renderMonitor(monitorInput(vm, o));
}

export const text = (frame: MonitorFrame): string[] => frame.lines.map(stripAnsi);

/** A key pressed on the frame the user saw. */
export function press(frame: MonitorFrame, key: string, now = FIXED_NOW.getTime()): MonitorOutcome {
  return handleMonitorInput(frame.state, { type: 'key', key }, { tree: makeNestedTree(), frame, nowMs: now });
}

/** The same press, then the frame it leads to (the panel redraws after every input). */
export function step(
  vm: DelegationViewModel,
  frame: MonitorFrame,
  key: string,
  o: PanelOptions = {}
): { out: MonitorOutcome; frame: MonitorFrame } {
  const out = press(frame, key, o.now);
  return { out, frame: draw(vm, { ...o, state: out.state }) };
}

/** A left click at a cell of the frame. */
export function click(frame: MonitorFrame, x: number, y: number, now = FIXED_NOW.getTime()): MonitorOutcome {
  return handleMonitorInput(
    frame.state,
    { type: 'mouse', x, y, button: 'left' },
    { tree: makeNestedTree(), frame, nowMs: now }
  );
}

/** Where a row (by item key) is on the frame: the first screen line that carries it. */
export function lineOf(frame: MonitorFrame, item: string): number {
  const pane = frame.panes.find((p) => p.id === 'agents')!;
  const at = pane.rows.findIndex((row, i) => i >= (pane.pinned ?? 0) && row.item === item);
  if (at < 0) return -1;
  return pane.y + (at < (pane.pinned ?? 0) ? at : at - pane.offset);
}

export function selectedOf(frame: MonitorFrame): string | null {
  return frame.state.tree.selectedId;
}

/** The delegation buttons of the bar, by kind. */
export function buttons(frame: MonitorFrame) {
  return frame.controls.filter((c) => c.kind === 'delegation-open' || c.kind === 'delegation-recover');
}

/** The bar row's text. */
export function bar(frame: MonitorFrame): string {
  return stripAnsi(frame.lines[0]);
}

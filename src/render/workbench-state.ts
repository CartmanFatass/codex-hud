import { paneItemAt, panePageSize } from './workbench-layout.js';
import type { SubagentTree } from '../types.js';
import type { GitChanges } from '../collectors/git-changes.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { initialPanelState, visibleRows, reconcileSelection, applyKey, type PanelState } from './panel-state.js';

export type PaneId = 'agents' | 'details' | 'changes' | 'activity';
export const PANE_IDS: PaneId[] = ['agents', 'details', 'changes', 'activity'];
export type ActivityTab = 'tasks' | 'checks' | 'events';
export interface WorkbenchEvent {
  id: string;
  at: Date;
  title: string;
  detail: string[];
  status: 'running' | 'completed' | 'error' | 'unknown';
}
export interface PaneRect {
  id: PaneId; x: number; y: number; width: number; height: number;
  offset: number; contentLength: number;
  /** Per content line: logical item index, or null for non-selectable text. */
  rowItems?: Array<number | null>;
  summary?: boolean;
}
export interface WorkbenchState {
  tree: PanelState;
  focus: PaneId;
  scroll: Record<PaneId, number>;
  selectedFile: string | null;
  selectedEvent: string | null;
  preview: 'agent' | 'file' | 'event' | 'workspace';
  activityTab: ActivityTab;
  zoom: boolean;
  help: boolean;
  collapsed: Record<PaneId, boolean>;
  tasksEnabled: boolean;
  detailExpanded: boolean;
}
export interface WorkbenchContext {
  tree: SubagentTree;
  git?: GitChanges | null;
  panes: PaneRect[];
  events: WorkbenchEvent[];
}
export function initialWorkbenchState(): WorkbenchState {
  return { tree: { ...initialPanelState(), sort: 'active' }, focus: 'agents',
    scroll: { agents: 0, details: 0, changes: 0, activity: 0 },
    selectedFile: null, selectedEvent: null, preview: 'agent', activityTab: 'checks', zoom: false, help: false,
    collapsed: { agents:false, details:false, changes:false, activity:true }, tasksEnabled:false, detailExpanded:false };
}
export function reconcileWorkbench(state: WorkbenchState, tree: SubagentTree, git?: GitChanges | null): WorkbenchState {
  const rows = visibleRows(tree.nodes, state.tree);
  const nextTree = reconcileSelection(state.tree, tree.nodes, rows);
  const selectedFile = git?.files.some(file => file.path === state.selectedFile) ? state.selectedFile : git?.files[0]?.path ?? null;
  const changed = (state.preview === 'agent' && state.detailExpanded && state.tree.selectedId !== nextTree.selectedId) ||
    (state.preview === 'file' && selectedFile !== state.selectedFile);
  return { ...state, tree: nextTree, selectedFile, detailExpanded:state.tree.selectedId === nextTree.selectedId && state.detailExpanded, scroll: { ...state.scroll, details: changed ? 0 : state.scroll.details } };
}
function focusPane(state: WorkbenchState, focus: PaneId, ctx: WorkbenchContext): WorkbenchState {
  const preview = focus === 'agents' ? 'agent' : focus === 'changes' ? (ctx.panes.find(p => p.id === 'changes')?.summary ? 'workspace' : 'file')
    : focus === 'activity' && state.activityTab === 'events' ? 'event' : state.preview;
  return { ...state, focus, preview, collapsed:{...state.collapsed, [focus]:false}, scroll: { ...state.scroll, details: preview === state.preview ? state.scroll.details : 0 } };
}
export function handleWorkbenchInput(state: WorkbenchState, input: WorkbenchInput, ctx: WorkbenchContext): {state: WorkbenchState; close: boolean} {
  let next = { ...state, scroll: { ...state.scroll } };
  let key = input.type === 'key' ? input.key : '';
  let clickIndex: number | undefined;
  if (input.type === 'mouse') {
    const pane = ctx.panes.find(p => input.x >= p.x && input.x < p.x + p.width && input.y >= p.y && input.y < p.y + p.height);
    if (!pane) return { state, close: false };
    if (input.button === 'left' && input.y === pane.y && pane.id === 'details' && next.preview === 'agent' &&
        pane.width >= 8 && input.x >= pane.x+pane.width-5 && input.x < pane.x+pane.width-1) {
      return {state:{...focusPane(next,'details',ctx),detailExpanded:!next.detailExpanded,scroll:{...next.scroll,details:0}},close:false};
    }
    if (input.button === 'left' && input.y === pane.y) {
      return {state:{...focusPane(next,pane.id,ctx), collapsed:{...next.collapsed,[pane.id]:!next.collapsed[pane.id]}},close:false};
    }
    next = focusPane(next, pane.id,ctx);
    if (input.button === 'left') {
      clickIndex = paneItemAt(pane, input.x, input.y);
      if (pane.id === 'agents' && clickIndex !== undefined) {
        if (next.detailExpanded) next.scroll.details = 0;
        next.detailExpanded = false;
      }
    } else key = input.button === 'wheel-down' ? 'down' : 'up';
  }
  if (key === 'close') return { state: next, close: true };
  if (next.help) {
    if (['help', 'escape', 'enter'].includes(key)) next.help = false;
    return { state: next, close: false };
  }
  if (key === 'help') next.help = true;
  else if (key === 'tab' || key === 'shift-tab') {
    next = focusPane(next, PANE_IDS[(PANE_IDS.indexOf(next.focus) + (key === 'tab' ? 1 : 3)) % 4],ctx);
  } else if (PANE_IDS.includes(key as PaneId)) next = focusPane(next, key as PaneId,ctx);
  else if (key === 'detail-toggle' && next.preview === 'agent') {
    next = {...focusPane(next,'details',ctx),detailExpanded:!next.detailExpanded,scroll:{...next.scroll,details:0}};
  }
  else if (key === 'zoom') next.zoom = !next.zoom;
  else if (key === 'escape') {
    if (next.focus === 'details' && next.preview === 'agent' && next.detailExpanded) { next.detailExpanded=false; next.scroll.details=0; }
    else if (next.zoom) next.zoom = false;
    else if (next.focus === 'details') next = focusPane(next, next.preview === 'file' || next.preview === 'workspace' ? 'changes' : next.preview === 'event' ? 'activity' : 'agents',ctx);
    else if (next.focus !== 'agents') next = focusPane(next, 'agents',ctx);
    else return { state: next, close: true };
  } else if (key === 'next-tab' || key === 'previous-tab') {
    const tabs: ActivityTab[] = next.tasksEnabled ? ['tasks', 'checks', 'events'] : ['checks', 'events'];
    next.activityTab = tabs[(tabs.indexOf(next.activityTab) + (key === 'next-tab' ? 1 : tabs.length - 1)) % tabs.length];
    next.scroll.activity = 0;
    next = focusPane(next, 'activity',ctx);
  } else if (key === 'enter' && next.focus !== 'details') {
    const inspect = next.focus === 'agents';
    next = focusPane(next, 'details',ctx);
    if (inspect) { next.detailExpanded = true; next.scroll.details = 0; }
  }
  else {
    const pane = ctx.panes.find(p => p.id === next.focus);
    const page = panePageSize(pane);
    const delta = key === 'down' ? 1 : key === 'up' ? -1 : key === 'page-down' ? page : key === 'page-up' ? -page : 0;
    if (next.focus === 'agents') {
      const rows = visibleRows(ctx.tree.nodes, next.tree);
      const index = rows.findIndex(row => row.node.id === next.tree.selectedId);
      if (delta || key === 'home' || key === 'end' || clickIndex !== undefined) {
        const target = clickIndex ?? (key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, index) + delta);
        const row = rows[Math.max(0, Math.min(rows.length - 1, target))];
        if (row) next.tree = { ...next.tree, selectedId: row.node.id };
      } else if (key === 'sort') next.tree = { ...next.tree, sort: next.tree.sort === 'active' ? 'created' : 'active' };
      else if (['left', 'right', 'filter'].includes(key)) next.tree = applyKey(next.tree, key as 'left' | 'right' | 'filter', rows).state;
    } else if ((next.focus === 'changes' && !pane?.summary) || (next.focus === 'activity' && next.activityTab === 'events')) {
      if (!delta && key !== 'home' && key !== 'end' && clickIndex === undefined) return { state: next, close: false };
      const files = next.focus === 'changes';
      const ids = files ? ctx.git?.files.map(f => f.path) ?? [] : ctx.events.map(e => e.id);
      const current = ids.indexOf(files ? next.selectedFile ?? '' : next.selectedEvent ?? '');
      const target = clickIndex ?? (key === 'home' ? 0 : key === 'end' ? ids.length - 1 : Math.max(0, current) + delta);
      const id = ids[Math.max(0, Math.min(ids.length - 1, target))] ?? null;
      if (files) next.selectedFile = id; else next.selectedEvent = id;
    } else if (delta || key === 'home' || key === 'end') {
      next.scroll[next.focus] = key === 'home' ? 0 : key === 'end' ? Math.max(0, (pane?.contentLength ?? 0) - page) : Math.max(0, next.scroll[next.focus] + delta);
    }
  }
  if ((next.preview !== state.preview) || (next.preview === 'agent' && state.detailExpanded && next.tree.selectedId !== state.tree.selectedId) ||
      (next.preview === 'file' && next.selectedFile !== state.selectedFile) || (next.preview === 'event' && next.selectedEvent !== state.selectedEvent)) next.scroll.details = 0;
  if (next.tree.selectedId !== state.tree.selectedId) next.detailExpanded = false;
  return { state: next, close: false };
}

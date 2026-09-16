/**
 * View state for the subagent panel, kept apart from rendering so the
 * navigation rules can be tested without a terminal.
 *
 * Selection is held by agent id, never by row number. The tree is rebuilt
 * every second and agents come and go; tracking a row index would silently
 * move the selection onto a different agent while the reader was looking at
 * it.
 */

import type { SubagentTreeNode } from '../types.js';
import type { TreeKey } from '../utils/tree-keys.js';

export type PanelView = 'tree' | 'detail' | 'session' | 'help';
export type PanelFilter = 'all' | 'active' | 'failed' | 'unknown';

export const FILTER_ORDER: PanelFilter[] = ['all', 'active', 'failed', 'unknown'];

export interface PanelState {
  view: PanelView;
  sort?: 'active' | 'created';
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  filter: PanelFilter;
  scroll: number;
}

export interface PanelRow {
  node: SubagentTreeNode;
  depth: number;
  /** Directory-tree connector for this row. */
  prefix: string;
  hasChildren: boolean;
  collapsed: boolean;
  /** True when the row is only present to locate a matching descendant. */
  context: boolean;
  parentId: string | null;
}

export function initialPanelState(): PanelState {
  return { view: 'tree', selectedId: null, collapsed: new Set(), filter: 'all', scroll: 0 };
}

function matchesFilter(node: SubagentTreeNode, filter: PanelFilter): boolean {
  switch (filter) {
    case 'active':
      return node.status === 'running' || node.status === 'starting';
    case 'failed':
      return node.status === 'error';
    case 'unknown':
      return node.status === 'unknown';
    default:
      return true;
  }
}

function subtreeMatches(node: SubagentTreeNode, filter: PanelFilter): boolean {
  return matchesFilter(node, filter) || node.children.some((child) => subtreeMatches(child, filter));
}

/** Sort only siblings. Live descendants bring their whole branch forward. */
function orderedSiblings(nodes: SubagentTreeNode[], mode: PanelState['sort']): SubagentTreeNode[] {
  if (!mode) return nodes;
  const priority = (node: SubagentTreeNode): { rank: number; started: number } => {
    const active = node.status === 'running' || node.status === 'starting';
    let rank = active ? 0 : node.status === 'error' ? 1 : node.status === 'unknown' ? 2 : 3;
    let started = active ? (node.turnStartedAt ?? node.startedAt)?.getTime() ?? 0 : 0;
    for (const child of node.children) {
      const sub = priority(child);
      rank = Math.min(rank, sub.rank);
      if (sub.rank === 0) started = Math.max(started, sub.started);
    }
    return { rank, started };
  };
  const ranks = new Map(nodes.map(node => [node.id, priority(node)]));
  return [...nodes].sort((a, b) => {
    if (mode === 'active') {
      const aa = ranks.get(a.id)!;
      const bb = ranks.get(b.id)!;
      if (aa.rank !== bb.rank) return aa.rank - bb.rank;
      if (aa.rank === 0 && aa.started !== bb.started) return bb.started - aa.started;
    }
    return (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0) || a.id.localeCompare(b.id);
  });
}

/**
 * Flatten the tree into the rows the panel can actually show, honouring the
 * filter and any collapsed branches. An ancestor of a match is kept as
 * context so the reader can still see who spawned what.
 */
export function visibleRows(nodes: SubagentTreeNode[], state: PanelState): PanelRow[] {
  const rows: PanelRow[] = [];

  const walk = (items: SubagentTreeNode[], depth: number, prefix: string, parentId: string | null): void => {
    const shown = orderedSiblings(items.filter((node) => subtreeMatches(node, state.filter)), state.sort);
    shown.forEach((node, index) => {
      const isLast = index === shown.length - 1;
      const branch = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
      const hasChildren = node.children.some((child) => subtreeMatches(child, state.filter));
      const collapsed = state.collapsed.has(node.id);
      rows.push({
        node,
        depth,
        prefix: prefix + branch,
        hasChildren,
        collapsed,
        context: !matchesFilter(node, state.filter),
        parentId,
      });
      if (hasChildren && !collapsed) {
        const hang = depth === 0 ? '' : isLast ? '   ' : '│  ';
        walk(node.children, depth + 1, prefix + hang, node.id);
      }
    });
  };

  walk(nodes, 0, '', null);
  return rows;
}

function findRow(rows: PanelRow[], id: string | null): number {
  if (!id) {
    return -1;
  }
  return rows.findIndex((row) => row.node.id === id);
}

function containsId(nodes: SubagentTreeNode[], id: string): boolean {
  return nodes.some((node) => node.id === id || containsId(node.children, id));
}

/**
 * Keep the selection pointing at the same agent across refreshes.
 *
 * An agent that is merely hidden (collapsed away, or filtered out) keeps the
 * selection, so toggling a filter back restores what the reader was looking
 * at. Only an agent that has left the tree entirely gives it up.
 */
export function reconcileSelection(
  state: PanelState,
  nodes: SubagentTreeNode[],
  rows: PanelRow[]
): PanelState {
  if (state.selectedId && containsId(nodes, state.selectedId)) {
    return state;
  }
  const fallback = rows[0]?.node.id ?? null;
  if (fallback === state.selectedId) {
    return state;
  }
  // The agent is gone; a detail view of it has nothing left to show.
  return {
    ...state,
    selectedId: fallback,
    view: state.view === 'detail' && !fallback ? 'tree' : state.view,
  };
}

export interface KeyOutcome {
  state: PanelState;
  close: boolean;
}

function withSelection(state: PanelState, rows: PanelRow[], index: number): PanelState {
  if (rows.length === 0) {
    return state;
  }
  const clamped = Math.max(0, Math.min(rows.length - 1, index));
  return { ...state, selectedId: rows[clamped].node.id };
}

function toggleCollapse(state: PanelState, id: string, collapse: boolean): PanelState {
  const next = new Set(state.collapsed);
  if (collapse) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return { ...state, collapsed: next };
}

export function applyKey(state: PanelState, key: TreeKey, rows: PanelRow[]): KeyOutcome {
  const index = findRow(rows, state.selectedId);
  const current = index >= 0 ? rows[index] : undefined;

  switch (key) {
    case 'close':
      return { state, close: true };

    case 'back':
      // Escape steps back through the views, and closes from the top level.
      if (state.view !== 'tree') {
        return { state: { ...state, view: 'tree', scroll: 0 }, close: false };
      }
      return { state, close: true };

    case 'up':
      if (state.view !== 'tree') {
        return { state: { ...state, scroll: Math.max(0, state.scroll - 1) }, close: false };
      }
      return { state: withSelection(state, rows, index <= 0 ? 0 : index - 1), close: false };

    case 'down':
      if (state.view !== 'tree') {
        return { state: { ...state, scroll: state.scroll + 1 }, close: false };
      }
      return { state: withSelection(state, rows, index < 0 ? 0 : index + 1), close: false };

    case 'left':
      if (state.view !== 'tree' || !current) {
        return { state, close: false };
      }
      // Collapse an open branch, otherwise step out to the parent.
      if (current.hasChildren && !current.collapsed) {
        return { state: toggleCollapse(state, current.node.id, true), close: false };
      }
      if (current.parentId) {
        return { state: { ...state, selectedId: current.parentId }, close: false };
      }
      return { state, close: false };

    case 'right':
      if (state.view !== 'tree' || !current) {
        return { state, close: false };
      }
      if (current.hasChildren && current.collapsed) {
        return { state: toggleCollapse(state, current.node.id, false), close: false };
      }
      if (current.hasChildren && index >= 0 && rows[index + 1]) {
        return { state: { ...state, selectedId: rows[index + 1].node.id }, close: false };
      }
      return { state, close: false };

    case 'top':
      return state.view === 'tree'
        ? { state: withSelection(state, rows, 0), close: false }
        : { state: { ...state, scroll: 0 }, close: false };

    case 'bottom':
      return state.view === 'tree'
        ? { state: withSelection(state, rows, rows.length - 1), close: false }
        : { state, close: false };

    case 'open':
      if (state.view === 'tree' && state.selectedId) {
        return { state: { ...state, view: 'detail', scroll: 0 }, close: false };
      }
      return { state, close: false };

    case 'filter': {
      const next = FILTER_ORDER[(FILTER_ORDER.indexOf(state.filter) + 1) % FILTER_ORDER.length];
      return { state: { ...state, filter: next, view: 'tree', scroll: 0 }, close: false };
    }

    case 'session':
      return {
        state: { ...state, view: state.view === 'session' ? 'tree' : 'session', scroll: 0 },
        close: false,
      };

    case 'help':
      return {
        state: { ...state, view: state.view === 'help' ? 'tree' : 'help', scroll: 0 },
        close: false,
      };

    default:
      return { state, close: false };
  }
}

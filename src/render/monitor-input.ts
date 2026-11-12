/** What a key, a click or the wheel does to the panel: the next state, and anything it asks of the page. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type {
  MonitorContext,
  MonitorFrame,
  MonitorOutcome,
  MonitorPane,
  MonitorRect,
  MonitorRow,
  MonitorState,
  HelpTab,
} from './monitor.js';
import { MONITOR_PANES, HELP_TABS, listedAgents } from './monitor.js';
import { applyKey } from './panel-state.js';
import { workboardInput } from './workboard-input.js';
import {
  logKeyAction,
  openButtonAction,
  openKeyAction,
  recoverAction,
  selectedActions,
  type DelegationAction,
  type RowActions,
} from './delegation/actions.js';
import { stepStop, stopsOf } from './delegation/selection.js';
import type { DelegationView } from './delegation/panel.js';
import { directions } from './directions.js';
import { WHEEL_ROWS } from './agents-view.js';
import { nextLevel } from './status-foot.js';

/**
 * A click on a pane's button, or its number after the prefix: an open pane
 * closes, a closed one opens and takes focus. Closed, it takes no row, and
 * the focus moves to the next pane still open.
 */
export function clickTab(state: MonitorState, id: MonitorPane): MonitorState {
  if (state.modes[id] === 'closed') return openPane({ ...state, zoom: false }, id);
  return closePane(state, id);
}
function closePane(state: MonitorState, id: MonitorPane): MonitorState {
  const modes = { ...state.modes, [id]: 'closed' as const };
  const focus = state.focus !== id ? state.focus : (MONITOR_PANES.find((pane) => modes[pane] !== 'closed') ?? id);
  return { ...state, modes, zoom: state.zoom && state.focus !== id, focus };
}
/** `r` or the band: step the level that is on screen. */
function cycleStatus(state: MonitorState, ctx: MonitorContext): void {
  const height = ctx.frame?.lines.length ?? Number.POSITIVE_INFINITY;
  state.statusLevel = nextLevel(state, height);
  state.statusScroll = 0;
}
function openPane(state: MonitorState, id: MonitorPane): MonitorState {
  const preview = state.preview;
  const modes = { ...state.modes, [id]: 'open' as const };
  return {
    ...state,
    focus: id,
    preview,
    modes,
    scroll: { ...state.scroll, details: preview === state.preview ? state.scroll.details : 0 },
  };
}
/** The row under a point inside a pane's frame, or nothing on its borders. */
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  const edge = pane.edge ?? 1;
  if (x < pane.x || x >= pane.x + pane.width || y < pane.y + edge || y >= pane.y + pane.height) return undefined;
  // Past the rows drawn is the scroll hint, not a row.
  if (pane.visible !== undefined && y - pane.y - edge >= pane.visible) return undefined;
  const line = y - pane.y - edge < (pane.pinned ?? 0) ? y - pane.y - edge : pane.offset + y - pane.y - edge;
  return line >= 0 ? pane.rows[line] : undefined;
}
export function monitorItemAt(pane: MonitorRect, x: number, y: number): string | undefined {
  return monitorRowAt(pane, x, y)?.item || undefined;
}
export function handleMonitorInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  let next: MonitorState = {
    ...state,
    tree: { ...state.tree },
    modes: { ...state.modes },
    scroll: { ...state.scroll },
  };
  let key = input.type === 'key' ? input.key : '';
  const result = (action?: MonitorOutcome['action'], close = false): MonitorOutcome => ({ state: next, close, action });
  // The delegation view the user saw: its plan and rows are what a key or a click is resolved against.
  const del = ctx.frame?.delegation;
  // A key acts exactly when its button is drawn in the frame the user saw (the bar sheds the buttons below its
  // floor, and with no room for a row), and does what a click on that button does.
  const drawn = (kind: 'delegation-open' | 'delegation-recover') =>
    ctx.frame?.controls.some((control) => control.kind === kind) === true;
  const rowAction = (
    kind: 'delegation-open' | 'delegation-recover',
    choose: (actions: RowActions) => DelegationAction | null
  ): MonitorOutcome => {
    const actions = del && drawn(kind) ? selectedActions(del.plan, del.proj, next.tree.selectedId) : null;
    const action = actions ? choose(actions) : null;
    return result(action ?? undefined);
  };
  if (key === 'close') return result(undefined, true);
  // Space and Enter inspect the selection in either panel style.
  if (key === 'space') key = 'enter';
  if (next.help) {
    const back =
      input.type === 'mouse' &&
      input.button === 'left' &&
      ctx.frame?.controls.some(
        (c) => c.kind === 'help' && input.y === c.y && input.x >= c.x && input.x < c.x + c.width
      );
    const tab =
      input.type === 'mouse' && input.button === 'left'
        ? ctx.frame?.controls.find(
            (c) => c.kind === 'help-tab' && input.y === c.y && input.x >= c.x && input.x < c.x + c.width
          )
        : undefined;
    const pages = HELP_TABS;
    const at = Math.max(0, pages.indexOf(next.helpTab ?? 'keys'));
    if (back || ['escape', 'help', 'enter'].includes(key)) next.help = false;
    // Its pages: a click on a tab, or Tab and the arrows across.
    else if (tab?.item) {
      next.helpTab = tab.item as HelpTab;
      next.helpScroll = 0;
    } else if (['tab', 'right', 'shift-tab', 'left'].includes(key)) {
      next.helpTab = pages[(at + (key === 'tab' || key === 'right' ? 1 : pages.length - 1)) % pages.length];
      next.helpScroll = 0;
    } else {
      if (input.type === 'mouse')
        key = input.button === 'wheel-down' ? 'down' : input.button === 'wheel-up' ? 'up' : '';
      const page = Math.max(1, ctx.frame?.helpPage?.count ?? 1);
      const delta = key === 'down' ? 1 : key === 'up' ? -1 : key === 'page-down' ? page : key === 'page-up' ? -page : 0;
      const max = Math.max(0, (ctx.frame?.helpPage?.total ?? 0) - page);
      next.helpScroll =
        key === 'home' ? 0 : key === 'end' ? max : Math.max(0, Math.min(max, (next.helpScroll ?? 0) + delta));
    }
    return result();
  }
  const boardResult = workboardInput(next, input, ctx);
  if (boardResult) return boardResult;
  if (input.type === 'mouse') {
    const control =
      input.button === 'left'
        ? ctx.frame?.controls.find((c) => input.y === c.y && input.x >= c.x && input.x < c.x + c.width)
        : undefined;
    if (control?.kind === 'main') return result({ type: 'switch', id: ctx.tree.rootId });
    // The bar's Switch: the selected agent, as `o`.
    if (control?.kind === 'open-session')
      return next.tree.selectedId ? result({ type: 'switch', id: next.tree.selectedId }) : result();
    // The selected delegation row's `⇢` and `↻`: what the button's word says, nothing for a greyed `⇢`.
    if (control?.kind === 'delegation-open' || control?.kind === 'delegation-recover')
      return control.disabled
        ? result()
        : rowAction(control.kind, control.kind === 'delegation-open' ? openButtonAction : recoverAction);
    if (control?.kind === 'settings') return result({ type: 'settings' });
    if (control?.kind === 'help') {
      next.help = true;
      next.helpScroll = 0;
      return result();
    }
    // The held keys' chip hands them back to Codex, as Esc does.
    if (control?.kind === 'keys') {
      next.keys = false;
      return result();
    }
    if (control?.kind === 'older') {
      next.tree.showAll = !next.tree.showAll;
      return result();
    }
    if (control?.kind === 'tab' && control.pane) {
      next = ctx.navigationOverlay ? openPane({ ...next, zoom: false }, control.pane) : clickTab(next, control.pane);
      return result();
    }
    // A pane's band, or the agents' summary: zoom that pane, or restore it.
    if (control?.kind === 'zoom' && control.pane) {
      next.zoom = !(next.zoom && next.focus === control.pane);
      next.focus = control.pane;
      return result();
    }
    if (control?.kind === 'brief') return result({ type: 'brief-toggle' });
    if (control?.kind === 'level') {
      cycleStatus(next, ctx);
      return result({ type: 'status-level' });
    }
    // What was clicked is in view already: selecting it does not scroll.
    const pick = (id: string) => {
      next.tree.selectedId = id;
      next.preview = 'agent';
      next.scroll.details = 0;
      next.revealed = id;
      next.focus = 'agents';
    };
    const inspect = (id: string) => {
      pick(id);
      next = openPane(next, 'details');
    };
    if (control?.kind === 'log' && control.item) {
      // A subtask line on a rich card only selects it. The compact log still opens the Inspector.
      if (next.style === 'rich') {
        pick(control.item);
        return result();
      }
      inspect(control.item);
      return result();
    }
    // A card's name: select it. A second click, timed by the page, switches.
    if (control?.kind === 'switch' && control.item) {
      pick(control.item);
      return result({ type: 'pick', id: control.item });
    }
    // The wheel over the status card scrolls its brief, the rows above it stay.
    const card = ctx.frame?.statusCard;
    if (input.button !== 'left' && card && input.y >= card.y && input.y < card.y + card.height) {
      if (card.total > card.brief)
        next.statusScroll = Math.max(
          0,
          Math.min(
            card.total - card.brief,
            (next.statusScroll ?? 0) + (input.button === 'wheel-down' ? WHEEL_ROWS : -WHEEL_ROWS)
          )
        );
      return result();
    }
    {
      const pane = ctx.frame?.panes.find(
        (p) => input.x >= p.x && input.x < p.x + p.width && input.y >= p.y && input.y < p.y + p.height
      );
      if (!pane) {
        // The frame's side, or the gutter left of a pane: keys stay here.
        const panes = ctx.frame?.panes ?? [];
        if (input.button === 'left' && panes.some((p) => input.x < p.x && input.y >= p.y && input.y < p.y + p.height))
          next.keys = true;
        return result();
      }
      next.focus = pane.id;
      if (input.button === 'left') {
        {
          const row = monitorRowAt(pane, input.x, input.y);
          const id = row?.item;
          if (!id) {
            next.keys = true;
            return result();
          }
          if (pane.id === 'agents') {
            // A delegation row only selects: the Inspector has nothing to show for it yet, and a second click
            // must not hand a delegation key to the session switch.
            if (del || next.delegating) {
              if (del?.dest.index.has(id)) pick(id);
              return result();
            }
            if (!listedAgents(ctx.tree.nodes, next, ctx.nowMs ?? Date.now()).some((row) => row.node.id === id))
              return result();
            // A rich card only selects. A compact row opens the Inspector and arms a second click, which switches.
            if (next.style === 'rich') {
              pick(id);
              return result();
            }
            inspect(id);
            return result({ type: 'pick', id });
          }
          next.scroll.details = 0;
          return result();
        }
      } else if (pane.id === 'agents') {
        // The wheel scrolls what is under it, and leaves the selection be.
        next.scroll.agents = Math.max(
          0,
          next.scroll.agents + (input.button === 'wheel-down' ? WHEEL_ROWS : -WHEEL_ROWS)
        );
        return result();
      } else key = input.button === 'wheel-down' ? 'down' : 'up';
    }
  }
  if (key === 'settings') return result({ type: 'settings' });
  if (key === 'inspect' || key === 'activate') key = 'enter';
  if (key === 'brief-toggle') return result({ type: 'brief-toggle' });
  // `r` is Reset on the settings page; here it changes how much the status card shows.
  if (key === 'reset') {
    cycleStatus(next, ctx);
    return result({ type: 'status-level' });
  }
  if (key === 'main') return result({ type: 'switch', id: ctx.tree.rootId });
  // `o`, `L` and `R` on a delegation row: Open or Switch, Log, Reconcile or Resume. Each acts when its button is drawn.
  if (key === 'open-session' && (del || next.delegating)) return rowAction('delegation-open', openKeyAction);
  if (key === 'log') return rowAction('delegation-open', logKeyAction);
  if (key === 'resume-reconcile') return rowAction('delegation-recover', recoverAction);
  if (key === 'open-session')
    return next.focus === 'agents' && next.tree.selectedId
      ? result({ type: 'switch', id: next.tree.selectedId })
      : result();
  if (key === 'show-all') next.tree.showAll = !next.tree.showAll;
  else if (key === 'help') {
    next.help = true;
    next.helpScroll = 0;
  } else if (key === 'pane-close') {
    if (next.modes[next.focus] !== 'closed') next = closePane(next, next.focus);
  }
  // A pane's number, as its button: open it, or close it.
  else if (MONITOR_PANES.includes(key as MonitorPane))
    next = ctx.navigationOverlay
      ? openPane({ ...next, zoom: false }, key as MonitorPane)
      : clickTab(next, key as MonitorPane);
  else if (key === 'tab' || key === 'shift-tab') {
    const visible = MONITOR_PANES.filter((id) => next.modes[id] !== 'closed');
    if (visible.length)
      next.focus = visible[(visible.indexOf(next.focus) + (key === 'tab' ? 1 : visible.length - 1)) % visible.length];
  } else if (key === 'enter' || key === 'detail-toggle') {
    const from = next.focus;
    if (from === 'details') {
      next.expanded = !next.expanded;
      next.scroll.details = 0;
      return result();
    }
    if (from === 'changes') return result();
    next = openPane(next, 'details');
    next.scroll.details = 0;
    next.expanded = false;
  } else if (key === 'zoom') {
    next.zoom = !next.zoom;
  } else if (key === 'escape') {
    if (next.keys) {
      next.keys = false;
      return result();
    }
    if (next.zoom) next.zoom = false;
    else if (next.focus === 'details') {
      next.modes.details = 'closed';
      next.focus = 'agents';
    }
    // The bottom of the ladder is the agents list, never the panel's end:
    // pressed again and again, Esc stops there. q and F12 close the panel.
    else if (next.focus !== 'agents' && next.modes.agents !== 'closed') next.focus = 'agents';
  } else {
    const pane = ctx.frame?.panes.find((p) => p.id === next.focus);
    const page = Math.max(1, (pane?.height ?? 5) - (pane?.edge ?? 1));
    // A row an item takes more than one line of is one keyboard destination.
    const visibleItems = pane
      ? new Set(pane.rows.slice(pane.offset, pane.offset + page).flatMap((row) => (row.item ? [row.item] : [])))
      : new Set<string>();
    const itemPage = visibleItems.size || page;
    const delta =
      key === 'down' ? 1 : key === 'up' ? -1 : key === 'page-down' ? itemPage : key === 'page-up' ? -itemPage : 0;
    const move = delta !== 0 || key === 'home' || key === 'end';
    if (next.focus === 'agents' && del) {
      navigateDelegation(next, key, del, pane, page, delta, move);
    } else if (next.focus === 'agents') {
      const rows = listedAgents(ctx.tree.nodes, next, ctx.nowMs ?? Date.now());
      // A page key scrolls the view a page; the selection keys move the
      // selection, and the view follows it there.
      if (key === 'page-down' || key === 'page-up') {
        const view = Math.max(1, (pane?.visible ?? page) - (pane?.pinned ?? 0) - 1);
        next.scroll.agents = Math.max(0, next.scroll.agents + (key === 'page-down' ? view : -view));
      } else if (move) {
        next.revealed = null;
        // A subtask selected from its lead's card sits inside that card: up goes to the lead, down past it.
        let index = rows.findIndex((row) => row.node.id === next.tree.selectedId);
        const inside =
          index < 0 && next.tree.selectedId
            ? rows.findIndex((row) => row.node.id === directions(ctx.tree).family.get(next.tree.selectedId!))
            : -1;
        if (inside >= 0) index = delta < 0 ? inside + 1 : inside;
        const target = key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, index) + delta;
        const row = rows[Math.max(0, Math.min(rows.length - 1, target))];
        if (row) next.tree.selectedId = row.node.id;
      } else if (key === 'sort') next.tree.sort = next.tree.sort === 'active' ? 'created' : 'active';
      else if (['left', 'right', 'filter'].includes(key))
        next.tree = applyKey(next.tree, key as 'left' | 'right' | 'filter', rows).state;
    } else if (move) {
      next.scroll[next.focus] =
        key === 'home'
          ? 0
          : key === 'end'
            ? Math.max(0, (pane?.contentLength ?? 0) - page)
            : Math.max(0, next.scroll[next.focus] + delta);
    }
  }
  if (next.tree.selectedId !== state.tree.selectedId) next.scroll.details = 0;
  return result();
}

/**
 * The agents pane's keys over a delegation view: the selection moves over the plan's destinations, `h` and `l` fold
 * and unfold through `tree.collapsed` by row key, `s` and `a` change the order and the history (the plan is read from
 * the state again), `n` and `N` go to the next and previous stop. Pure but for the state it is given to write in.
 */
function navigateDelegation(
  next: MonitorState,
  key: string,
  view: DelegationView,
  pane: MonitorRect | undefined,
  page: number,
  delta: number,
  move: boolean
): void {
  const rows = view.dest.rows;
  const selected = next.tree.selectedId;
  const at = selected === null ? -1 : (view.dest.index.get(selected) ?? -1);
  const row = at >= 0 ? rows[at] : undefined;
  const fold = (key: string, folded: boolean) => {
    const collapsed = new Set(next.tree.collapsed);
    if (folded) collapsed.add(key);
    else collapsed.delete(key);
    next.tree.collapsed = collapsed;
  };
  if (key === 'page-down' || key === 'page-up') {
    // A page key scrolls the view a page; the selection keys move the selection, and the view follows it there.
    const span = Math.max(1, (pane?.visible ?? page) - (pane?.pinned ?? 0) - 1);
    next.scroll.agents = Math.max(0, next.scroll.agents + (key === 'page-down' ? span : -span));
  } else if (move) {
    next.revealed = null;
    const target = key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, at) + delta;
    const to = rows[Math.max(0, Math.min(rows.length - 1, target))];
    if (to) next.tree.selectedId = to.key;
  } else if (key === 'sort') next.tree.sort = next.tree.sort === 'active' ? 'created' : 'active';
  else if (key === 'left' && row) {
    // Fold an open branch, otherwise step out to the parent.
    if (row.pn && row.pn.children.length > 0 && !row.fold) fold(row.pn.key, true);
    else if (row.parentKey !== null && view.dest.index.has(row.parentKey)) next.tree.selectedId = row.parentKey;
  } else if (key === 'right' && row) {
    // Unfold a folded branch, otherwise step in to its first child.
    if (row.fold && row.pn) fold(row.pn.key, false);
    else if (row.pn && row.pn.children.length > 0) {
      // Rich groups native sub-rows inside their ancestor card, so a child may follow a sibling on screen.
      const child = rows.find((candidate) => candidate.parentKey === row.key);
      if (child) next.tree.selectedId = child.key;
    }
  } else if (key === 'next-trouble' || key === 'previous-trouble') {
    const to = stepStop(stopsOf(view.proj, view.dest), at, key === 'next-trouble' ? 1 : -1);
    if (to !== null) {
      next.revealed = null;
      next.tree.selectedId = rows[to].key;
    }
  }
}

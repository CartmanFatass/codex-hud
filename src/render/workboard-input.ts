/** Display-only main-tab routing; no answer/receipt/status or execution mutations. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
import { targetKey, type WorkTarget } from '../collectors/workboard-types.js';
import { monitorRowAt } from './monitor-input.js';
export function workboardInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome | null {
  const next = { ...state, tree: { ...state.tree }, modes: { ...state.modes }, scroll: { ...state.scroll } };
  const result = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const frame = ctx.frame,
    boardFrame = frame?.workboard;
  if (!boardFrame) return null;
  let key = input.type === 'key' ? input.key : '';
  const main = next.focus === 'agents';
  const inspector = next.focus === 'details';
  const tab = (home: boolean) => {
    next.mainTab = home ? 'home' : 'work';
    next.focus = 'agents';
    next.modes.agents = 'open';
    next.zoom = false;
    next.boardInspect = undefined;
    next.boardRevealed = undefined;
    next.boardAnchor = undefined;
  };
  if (key === 'home-tab' || key === 'work-tab') {
    tab(key === 'home-tab');
    return result();
  }
  if (key === 'summary') {
    next.boardInspect = 'summary';
    next.focus = 'details';
    next.modes.details = 'open';
    next.scroll.details = 0;
    return result();
  }
  const inspect = () => {
    const target = next.mainTab === 'work' ? next.workTarget : next.homeTarget;
    if (!target || !boardFrame || next.boardAnchor) return;
    const lane = boardFrame.snapshot.lanes.find((l) => l.id === target.laneId);
    const worker = target.kind === 'worker' ? lane?.workers.find((w) => w.id === target.workerId) : undefined;
    next.boardInspect = worker?.nodeId ? undefined : target;
    if (worker?.nodeId) next.tree.selectedId = worker.nodeId;
    next.preview = 'agent';
    next.focus = 'details';
    next.modes.details = 'open';
    next.scroll.details = 0;
    next.zoom = false;
  };
  if ((key === 'inspect' || key === 'details' || key === 'detail-toggle' || key === 'space') && main) {
    inspect();
    return result();
  }
  if (key === 'escape' && inspector && (next.mainTab || next.boardInspect)) {
    // Inspector return precedes standalone keys-release. Embedded forwarding is decided by the page.
    next.focus = 'agents';
    next.modes.details = 'closed';
    next.zoom = false;
    next.boardInspect = undefined;
    if (ctx.standalone) next.keys = true;
    return result();
  }
  if (!boardFrame || (!main && !next.boardInspect)) return null;
  const selected = () => (next.mainTab === 'work' ? next.workTarget : next.homeTarget);
  const setTarget = (target: WorkTarget) => {
    next.boardAnchor = undefined;
    if (next.mainTab === 'work') next.workTarget = target;
    else next.homeTarget = target;
  };
  const toggle = (item: string, open?: boolean) => {
    const set = new Set(next.boardExpanded);
    if (open === false || (open === undefined && set.has(item))) set.delete(item);
    else set.add(item);
    next.boardExpanded = set;
  };
  const activate = () => {
    if (next.boardAnchor) {
      toggle(next.boardAnchor);
      return;
    }
    const target = selected();
    if (next.mainTab === 'work' || !target) return;
    next.mainTab = 'work';
    next.workTarget = target;
    next.focus = 'agents';
    const folded = new Set(next.boardFolded);
    folded.delete(target.laneId);
    next.boardFolded = folded;
    next.boardRevealed = undefined;
  };
  if (input.type === 'mouse') {
    const control =
      input.button === 'left'
        ? frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width)
        : undefined;
    if (control?.kind === 'board-home' || control?.kind === 'board-work') {
      tab(control.kind === 'board-home');
      return result();
    }
    if (control?.kind === 'board-inspect') {
      inspect();
      return result();
    }
    if (control?.kind === 'board-activate') {
      const target = control.item ? boardFrame.targets.get(control.item) : selected();
      if (main && target) {
        setTarget(target);
        activate();
      }
      return result();
    }
    if (control?.kind === 'board-summary') {
      next.boardInspect = 'summary';
      next.focus = 'details';
      next.scroll.details = 0;
      return result();
    }
    if (control?.kind === 'settings') return result({ type: 'settings' });
    if (control?.kind === 'help') {
      next.help = true;
      return result();
    }
    const pane = frame?.panes.find((p) => p.id === (inspector ? 'details' : 'agents'));
    if (!pane) return result();
    if (input.button !== 'left') {
      const delta = input.button === 'wheel-down' ? 3 : -3;
      if (inspector) next.scroll.details = Math.max(0, next.scroll.details + delta);
      else if (next.mainTab === 'work') next.workScroll = Math.max(0, (next.workScroll ?? 0) + delta);
      else next.homeScroll = Math.max(0, (next.homeScroll ?? 0) + delta);
      return result();
    }
    const row = monitorRowAt(pane, input.x, input.y),
      item = control?.kind === 'board-pick' ? control.item : row?.item;
    if (item?.startsWith('fold:')) {
      next.boardAnchor = item;
      toggle(item);
      return result();
    }
    const target = item ? boardFrame.targets.get(item) : undefined;
    if (target) {
      if (selected() && targetKey(selected()!) === targetKey(target)) toggle(item!);
      else setTarget(target);
      next.keys = true;
    }
    return result();
  }
  if (key === 'enter' || key === 'activate') {
    if (main) activate();
    return result();
  }
  // Removed controls cannot act through hidden legacy shortcuts either.
  if (
    [
      'resume-reconcile',
      'reset',
      'brief-toggle',
      'show-all',
      'filter',
      'sort',
      'open-session',
      'main',
      'log',
      'pane-close',
      'zoom',
    ].includes(key)
  )
    return result();
  if (key === 'next-trouble' || key === 'previous-trouble') {
    const workers = boardFrame.snapshot.workers;
    const targets = [
      ...workers.filter((w) => w.homeNeedsHuman),
      ...workers.filter((w) => !w.homeNeedsHuman && w.stale),
    ].map((w) => ({ kind: 'worker' as const, laneId: w.laneId, workerId: w.id }));
    if (targets.length) {
      const at = targets.findIndex((t) => selected() && targetKey(t) === targetKey(selected()!));
      next.mainTab = 'work';
      next.workTarget =
        targets[(at + (key === 'previous-trouble' ? targets.length - 1 : 1) + targets.length) % targets.length];
      next.boardRevealed = undefined;
    }
    return result();
  }
  if ((key === 'left' || key === 'right') && main) {
    if (next.boardAnchor) {
      toggle(next.boardAnchor, key === 'right');
      return result();
    }
    const target = selected();
    if (!target) return result();
    if (next.mainTab === 'work' && target.kind === 'lane') {
      const folded = new Set(next.boardFolded);
      if (key === 'left') folded.add(target.laneId);
      else folded.delete(target.laneId);
      next.boardFolded = folded;
    } else toggle(targetKey(target), key === 'right');
    return result();
  }
  if (main && ['up', 'down', 'page-up', 'page-down', 'home', 'end'].includes(key)) {
    const rows = boardFrame.rows,
      items: string[] = [];
    for (const row of rows) {
      if (row.item && !items.includes(row.item)) items.push(row.item);
      for (const c of row.controls ?? []) if (c.item && !items.includes(c.item)) items.push(c.item);
    }
    const current = next.boardAnchor ?? (selected() ? targetKey(selected()!) : ''),
      at = items.indexOf(current);
    const step = key === 'up' ? -1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 1;
    const index =
      key === 'home' ? 0 : key === 'end' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + step));
    const item = items[index];
    if (item?.startsWith('fold:')) {
      next.boardAnchor = item;
      toggle(item, true);
      next.boardRevealed = undefined;
      return result();
    }
    const target = boardFrame.targets.get(item);
    if (target) setTarget(target);
    return result();
  }
  if (key === 'tab' || key === 'shift-tab') {
    tab(next.mainTab === 'work');
    return result();
  }
  return null;
}

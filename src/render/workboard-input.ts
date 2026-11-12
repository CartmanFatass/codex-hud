/** Display-only main-tab routing; no answer/receipt/status or execution mutations. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
import { targetKey, type WorkTarget } from '../collectors/workboard-types.js';
import { monitorRowAt } from './monitor-input.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { join } from 'node:path';
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
  // 3 (and Ctrl+\ 3) is kept for the Project tab (M4), not built: it does nothing, not even open the hidden Changes view.
  if (key === 'changes') return result();
  if (key === 'brief-toggle') return result({ type: 'brief-toggle' });
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
  const jobFiles = (): MonitorOutcome['action'] => {
    const target = selected();
    if (!target || !target.laneId.startsWith('thin-job:')) return;
    const lane = boardFrame.snapshot.lanes.find((l) => l.id === target.laneId);
    if (lane?.identity.kind !== 'invocation') return;
    const worker = target.kind === 'worker' ? lane.workers.find((w) => w.id === target.workerId) : undefined;
    // A job card with no question open opens its report, else its brief; the same on both tabs.
    const evidence =
      target.kind === 'decision'
        ? lane.decisions.find((d) => d.id === target.decisionId)?.evidence[0]
        : (worker?.work?.requestInfo?.evidence ?? worker?.evidence.at(-1));
    if (!evidence || !/^j[0-9a-f]{16}$/.test(evidence.sourceId)) return;
    const file = join(lane.identity.home, 'jobs', evidence.sourceId, evidence.relativePath);
    if (/^(report|brief)\.md$/.test(evidence.relativePath)) return { type: 'job-files', files: [file] };
    if (/^qa\/q\d+\.md$/.test(evidence.relativePath))
      return { type: 'job-files', files: [file, file.replace(/\.md$/, '.answer.md')] };
  };
  // Enter, or a click on the selected item: a lane folds or unfolds, any other item expands or collapses in place.
  // It never changes tab.
  const activate = (target = selected()) => {
    if (next.boardAnchor) {
      toggle(next.boardAnchor);
      return;
    }
    if (!target) return;
    if (target.kind !== 'lane') return toggle(targetKey(target));
    const folded = new Set(next.boardFolded);
    if (!folded.delete(target.laneId)) folded.add(target.laneId);
    next.boardFolded = folded;
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
    if (control?.kind === 'brief') return result({ type: 'brief-toggle' });
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
      if (selected() && targetKey(selected()!) === targetKey(target)) activate(target);
      else setTarget(target);
      next.keys = true;
    }
    return result();
  }
  if (key === 'enter' || key === 'activate') {
    if (main) activate();
    return result();
  }
  // `o` (decoded as open-session, which is also Ctrl+\ o) opens the selected job's file in $EDITOR, on both tabs.
  if (key === 'open-session' && main) return result(jobFiles());
  // Existing reveal is display-only and must apply to both main tabs (P2 q18).
  if (key === 'show-all' && main) {
    next.tree.showAll = !next.tree.showAll;
    return result();
  }
  // Removed controls cannot act through hidden legacy shortcuts either.
  if (['resume-reconcile', 'reset', 'filter', 'sort', 'main', 'log', 'pane-close', 'zoom'].includes(key))
    return result();
  if (key === 'next-trouble' || key === 'previous-trouble') {
    const workers = boardFrame.snapshot.workers;
    const targets = [
      ...workers.filter((w) => projectWorkCard(w, ctx.nowMs ?? 0, next.cardStallMinutes).state === 'needs-you'),
      ...workers.filter((w) => projectWorkCard(w, ctx.nowMs ?? 0, next.cardStallMinutes).state === 'stalled'),
    ].map((w) => ({ kind: 'worker' as const, laneId: w.laneId, workerId: w.id }));
    if (targets.length) {
      const at = targets.findIndex((t) => selected() && targetKey(t) === targetKey(selected()!));
      next.mainTab = 'work';
      next.workTarget =
        targets[(at + (key === 'previous-trouble' ? targets.length - 1 : 1) + targets.length) % targets.length];
      const folded = new Set(next.boardFolded);
      folded.delete(next.workTarget.laneId);
      next.boardFolded = folded;
      next.boardRevealed = undefined;
    }
    return result();
  }
  // Left and Right only move between the tabs (Home, Work; the Project tab comes with M4); they never fold or expand.
  if ((key === 'left' || key === 'right') && main) {
    tab(key === 'left');
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

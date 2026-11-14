/** Display-only main-tab routing; no answer/receipt/status or execution mutations. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
import { targetKey, type WorkTarget } from '../collectors/workboard-types.js';
import { monitorRowAt } from './monitor-input.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { cardExpanded } from './work-card.js';
import { projectFoldedSet, projectPageOf, projectListOpen, type ProjectPage } from './project-view.js';
import type { PlaceOp } from '../roles/role-control.js';
import { join } from 'node:path';
/** The Control plane's keys (named by the decoder) and what each asks of the place under the cursor. */
const PLACE_KEYS: Record<string, { op: PlaceOp; step?: 1 | -1 }> = {
  'place-harness': { op: 'harness' }, 'place-harness-prev': { op: 'harness', step: -1 },
  'place-model': { op: 'model' }, 'place-model-prev': { op: 'model', step: -1 },
  'place-thinking': { op: 'thinking' }, 'place-thinking-prev': { op: 'thinking', step: -1 },
  'place-add': { op: 'add' }, 'place-remove': { op: 'remove' },
  'place-up': { op: 'up' }, 'place-down': { op: 'down' }, 'place-clear': { op: 'clear' },
};
export function workboardInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome | null {
  const next = { ...state, tree: { ...state.tree }, modes: { ...state.modes }, scroll: { ...state.scroll } };
  const result = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const frame = ctx.frame,
    boardFrame = frame?.workboard;
  if (!boardFrame) return null;
  let key = input.type === 'key' ? input.key : '';
  const main = next.focus === 'agents';
  const inspector = next.focus === 'details';
  const home = () => {
    next.mainTab = 'home';
    next.focus = 'agents';
    next.modes.agents = 'open';
    next.zoom = false;
    next.boardInspect = undefined;
    next.boardRevealed = undefined;
    next.boardAnchor = undefined;
    next.projectList = undefined;
    next.projectBack = undefined;
  };
  // Opening a page keeps where it was left; closing it lands the hub's cursor on that page's row.
  const goProject = (page?: ProjectPage, cursor?: string) => {
    const from = projectPageOf(next), saved = { ...next.projectSaved };
    if (from) saved[from] = { cursor: next.projectCursor, scroll: next.projectScroll ?? 0 };
    const kept = page && !cursor ? saved[page] : undefined;
    next.projectSaved = saved;
    next.projectPage = page;
    next.projectCursor = page ? cursor ?? kept?.cursor : from && `project:page:${from}`;
    next.projectScroll = kept?.scroll ?? 0;
    next.boardRevealed = kept?.cursor;
  };
  // Another project for the tab: its pages start fresh (cursor, scroll, folds), the open page stays open.
  const useProject = (root?: string) => {
    if (root === next.projectRoot) return;
    next.projectRoot = root;
    // Esc goes back to the list only from a hub opened out of it, not from one stepped to with `[` and `]`.
    next.projectBack = undefined;
    next.projectSaved = {};
    // Resting on the name row, `[` and `]` keep it there.
    if (next.projectCursor !== 'project:switch') next.projectCursor = undefined;
    next.projectScroll = 0;
    next.projectFolded = undefined;
    next.boardRevealed = undefined;
  };
  const cycleProject = (step: number) => {
    const list = frame?.projects;
    if (!list) return;
    const at = Math.max(0, list.findIndex((p) => p.root === next.projectRoot)), to = list[(at + step + list.length) % list.length];
    useProject(to === list[0] ? undefined : to.root);
  };
  // The Projects list sits above the hubs: the name row opens it, a click on its entry opens that project's hub.
  const listed = projectListOpen(next, frame?.projects);
  const showList = (on: boolean) => {
    const root = next.projectRoot ?? frame?.projects?.[0].root;
    next.projectList = on || undefined;
    next.projectBack = undefined;
    next.projectCursor = on ? `project:list:${root}` : 'project:switch';
    next.projectScroll = 0;
    next.boardRevealed = undefined;
  };
  const openProject = (root: string) => {
    useProject(root === frame?.projects?.[0].root ? undefined : root);
    next.projectList = undefined;
    // Esc on a hub reached from the list goes back to it; on any other hub it does what it always did.
    next.projectBack = true;
    next.projectPage = undefined;
    next.projectCursor = undefined;
    next.projectScroll = 0;
    next.boardRevealed = undefined;
  };
  const back =
    input.type === 'mouse' &&
    input.button === 'left' &&
    frame?.controls.some(
      (c) => c.kind === 'board-back' && c.y === input.y && input.x >= c.x && input.x < c.x + c.width
    );
  if (back && main && next.mainTab === 'project' && (projectPageOf(next) || listed)) {
    if (listed) showList(false);
    else goProject();
    return result();
  }
  if (back || (key === 'escape' && next.focus === 'changes')) {
    home();
    return result();
  }
  if (inspector && next.boardInspect) {
    const rows = boardFrame.rows.filter((r) => r.files?.length),
      at = rows.findIndex((r) => r.item === next.inspectCursor);
    if (input.type === 'mouse' && input.button === 'left') {
      const pane = frame?.panes.find((p) => p.id === 'details'),
        row = pane && monitorRowAt(pane, input.x, input.y);
      if (row?.files?.length) {
        next.inspectCursor = row.item;
        return result({ type: 'open-files', files: row.files });
      }
    }
    if (['enter', 'activate', 'open-session'].includes(key))
      return result(rows[at] ? { type: 'open-files', files: rows[at].files! } : undefined);
    if (['up', 'down', 'home', 'end', 'page-up', 'page-down'].includes(key)) {
      const step = key === 'up' ? -1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 1;
      next.inspectCursor =
        rows[key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + step))]
          ?.item;
      return result();
    }
    if (['home-tab', 'project-tab', 'left', 'right', 'tab', 'shift-tab'].includes(key)) return result();
  }
  if (key === 'home-tab') {
    home();
    return result();
  }
  const tab = input.type === 'mouse' && input.button === 'left'
    ? frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width)?.kind : '';
  if (key === 'project-tab' || tab === 'board-project' || tab === 'board-home' ||
    (main && ['left', 'right', 'tab', 'shift-tab'].includes(key))) {
    const project = tab === 'board-project' || key === 'project-tab' || (tab !== 'board-home' && next.mainTab !== 'project');
    home();
    if (project) next.mainTab = 'project';
    return result();
  }
  if (key === 'changes') {
    next.focus = 'changes';
    next.boardInspect = undefined;
    next.modes.changes = 'open';
    next.zoom = true;
    return result();
  }
  if (key === 'brief-toggle' || tab === 'brief') return result({ type: 'brief-toggle' });
  if (main && next.mainTab === 'project') {
    // A hub entry may span two rows (the bar); the cursor visits it once.
    const rows = boardFrame.rows.filter((r, i, all) => r.item && all.findIndex((o) => o.item === r.item) === i),
      at = rows.findIndex((r) => r.item === next.projectCursor);
    // `o` opens a row's file even where Enter folds (a ticket, a long Next bullet); folds with no file toggle on either.
    const activate = (row = rows[at], open = false) => {
      if (open && row?.files) return { type: 'open-files' as const, files: row.files };
      if (row?.item === 'project:switch') showList(true);
      else if (row?.item?.startsWith('project:list:')) openProject(row.item.slice(13));
      else if (row?.item?.startsWith('project:page:')) goProject(row.item.slice(13) as ProjectPage);
      else if (row?.item?.startsWith('project:fold:')) {
        const folded = new Set(projectFoldedSet(next)), id = row.item.slice(13);
        if (!folded.delete(id)) folded.add(id);
        next.projectFolded = folded;
      } else if (row?.files) return { type: 'open-files' as const, files: row.files };
    };
    if (input.type === 'mouse') {
      const pane = frame?.panes.find((p) => p.id === 'agents');
      if (input.button !== 'left') next.projectScroll = Math.max(0, (next.projectScroll ?? 0) + (input.button === 'wheel-down' ? 3 : -3));
      else {
        const row = pane && monitorRowAt(pane, input.x, input.y);
        if (row?.item) {
          const again = row.item === next.projectCursor;
          next.projectCursor = row.item;
          // A hub entry is a link: one click opens it. Elsewhere a click selects and a second one acts.
          return result(again || /^project:(page:|list:|switch$)/.test(row.item) ? activate(row) : undefined);
        }
      }
      return result();
    }
    if (['enter', 'activate', 'open-session'].includes(key)) return result(activate(undefined, key === 'open-session'));
    if ((key === 'project-prev' || key === 'project-next') && !listed) {
      cycleProject(key === 'project-next' ? 1 : -1);
      return result();
    }
    if (['up', 'down', 'page-up', 'page-down', 'home', 'end'].includes(key)) {
      const step = key === 'up' ? -1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 1;
      next.projectCursor = rows[key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + step))]?.item;
      return result();
    }
    // A place row is `project:role:<role>:<index>`; the panel applies the edit to the role files and shows the result next frame.
    const place = PLACE_KEYS[key], onPlace = /^project:role:(.+):(\d+)$/.exec(next.projectCursor ?? '');
    if (place && onPlace && projectPageOf(next) === 'control')
      return result({ type: 'role-edit', role: onPlace[1], index: Number(onPlace[2]), ...place });
    if (key === 'escape' && (projectPageOf(next) || listed || (next.projectBack && frame?.projects))) {
      if (listed) showList(false);
      else if (projectPageOf(next)) goProject();
      else showList(true);
      return result();
    }
    if (!['help', 'settings', 'escape'].includes(key)) return result();
  }
  const inspect = () => {
    const target = next.homeTarget;
    if (!target || !boardFrame || next.boardAnchor) return;
    const lane = boardFrame.snapshot.lanes.find((l) => l.id === target.laneId);
    const worker = target.kind === 'worker' ? lane?.workers.find((w) => w.id === target.workerId) : undefined;
    next.boardInspect = target;
    if (worker?.nodeId) next.tree.selectedId = worker.nodeId;
    next.preview = 'agent';
    next.focus = 'details';
    next.modes.details = 'open';
    next.scroll.details = 0;
    next.inspectCursor = undefined;
    next.boardRevealed = undefined;
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
  const selected = () => next.homeTarget;
  const setTarget = (target: WorkTarget) => {
    next.boardAnchor = undefined;
    next.homeTarget = target;
  };
  const toggle = (item: string, open?: boolean) => {
    const set = new Set(next.boardExpanded);
    const worker = boardFrame.snapshot.workers.find(
      (w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id }) === item
    );
    const expanded = worker && !worker.homeNeedsHuman ? cardExpanded(next, item) : set.has(item);
    if (open === false || (open === undefined && expanded)) set.delete(item);
    else set.add(item);
    next.boardExpanded = set;
    if (worker) next.boardToggled = new Set([...(next.boardToggled ?? []), item]);
  };
  const jobFiles = (): MonitorOutcome['action'] => {
    const target = selected();
    if (!target) return;
    const lane = boardFrame.snapshot.lanes.find((l) => l.id === target.laneId);
    const worker = target.kind === 'worker' ? lane?.workers.find((w) => w.id === target.workerId) : undefined;
    if (worker?.nativeDepth !== undefined) {
      const files = worker.files?.[0]?.paths;
      return files?.length ? { type: 'open-files', files } : undefined;
    }
    if (!target.laneId.startsWith('thin-job:') || lane?.identity.kind !== 'invocation') return;
    // A job card with no question open opens its report, else its brief.
    const evidence =
      target.kind === 'decision'
        ? lane.decisions.find((d) => d.id === target.decisionId)?.evidence[0]
        : (worker?.work?.requestInfo?.evidence ?? worker?.evidence.at(-1));
    if (!evidence || !/^j[0-9a-f]{16}$/.test(evidence.sourceId)) return;
    const file = join(lane.identity.home, 'jobs', evidence.sourceId, evidence.relativePath);
    if (/^(report|brief)\.md$/.test(evidence.relativePath)) return { type: 'open-files', files: [file] };
    if (/^qa\/q\d+\.md$/.test(evidence.relativePath))
      return {
        type: 'open-files',
        files: worker?.work?.requestInfo?.evidence === evidence ? [file] : [file, file.replace(/\.md$/, '.answer.md')],
      };
  };
  const openProgress = (item: string) => {
    const id = item.slice('home-progress:'.length);
    home();
    next.mainTab = 'project';
    // Home's block is the panel's own project's.
    useProject(undefined);
    if (id === 'progress') return goProject('progress');
    // A ticket row opens its feature, unfolded, on the Tickets page.
    goProject('tickets', `project:fold:${id}`);
    next.projectFolded = new Set([...projectFoldedSet(next)].filter((key) => key !== id));
  };
  // Cards expand in place; the compact progress block opens its Project destination.
  const activate = (target = selected()) => {
    if (next.boardAnchor?.startsWith('home-progress:')) return openProgress(next.boardAnchor);
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
    if (control?.kind === 'board-home') {
      home();
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
      else next.homeScroll = Math.max(0, (next.homeScroll ?? 0) + delta);
      return result();
    }
    const row = monitorRowAt(pane, input.x, input.y),
      item = control?.kind === 'board-pick' ? control.item : row?.item;
    if (item?.startsWith('home-progress:')) {
      openProgress(item);
      return result();
    }
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
  // `o` (also Ctrl+\ o) opens the selected job's file in $EDITOR.
  if (key === 'open-session' && main) return result(next.boardAnchor ? undefined : jobFiles());
  if (key === 'show-all' && main) {
    next.tree.showAll = !next.tree.showAll;
    return result();
  }
  // Removed controls cannot act through hidden legacy shortcuts either.
  if (['resume-reconcile', 'reset', 'filter', 'main', 'log', 'pane-close', 'zoom'].includes(key))
    return result();
  if (key === 'next-trouble' || key === 'previous-trouble') {
    const workers = boardFrame.snapshot.workers;
    const targets = [
      ...workers.filter((w) => projectWorkCard(w, ctx.nowMs ?? 0, next.cardStallMinutes).state === 'needs-you'),
      ...workers.filter((w) => projectWorkCard(w, ctx.nowMs ?? 0, next.cardStallMinutes).state === 'stalled'),
    ].map((w) => ({ kind: 'worker' as const, laneId: w.laneId, workerId: w.id }));
    if (targets.length) {
      const at = targets.findIndex((t) => selected() && targetKey(t) === targetKey(selected()!));
      const target =
        targets[(at + (key === 'previous-trouble' ? targets.length - 1 : 1) + targets.length) % targets.length];
      setTarget(target);
      const folded = new Set(next.boardFolded);
      folded.delete(target.laneId);
      next.boardFolded = folded;
      next.boardRevealed = undefined;
    }
    return result();
  }
  if (main && ['left', 'right', 'tab', 'shift-tab'].includes(key)) return result();
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
    if (item?.startsWith('home-progress:')) {
      next.boardAnchor = item;
      next.boardRevealed = undefined;
      return result();
    }
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
  return null;
}

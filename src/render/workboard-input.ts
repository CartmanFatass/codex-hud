/** Main-tab routing. It mutates nothing: the owner's micro-actions on a job leave as actions (`job-actions.ts`) for the panel to run. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
import { copyControlTab, controlRoleItem, controlRoleOf, harnessFold, initialControlView, type OverlayState } from './monitor-state.js';
import { targetKey, type WorkTarget } from '../collectors/workboard-types.js';
import { monitorRowAt } from './monitor-input.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { cardExpanded } from './work-card.js';
import { projectFoldedSet, projectPageOf, projectListOpen, type ProjectPage } from './project-view.js';
import type { RoleFact } from '../roles/role-control.js';
import { openQuickModel, roleModelIndex } from './chain-input.js';
import { splitHomeInput, splitProjectInput } from './split-input.js';
import { join } from 'node:path';
import { tryInput } from './try-input.js';
import { openJobAction } from './job-actions.js';
import { controlShown, mainTabOf, mainTabs, type MainTab } from './main-tabs.js';
import { expInput } from './exp-view.js';
import { harnessId, restoreId } from './harness-page.js';

const clickKind = (input: WorkbenchInput, ctx: MonitorContext) => input.type === 'mouse' && input.button === 'left'
  ? ctx.frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width)?.kind : undefined;

/** While Add back owns the keyboard, printable shortcuts are filter text. */
export function harnessAddInput(state: MonitorState, add: Extract<OverlayState, { kind: 'control-harness-add' }>, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  const out = (value: Omit<typeof add, 'kind'> | undefined, action?: MonitorOutcome['action']): MonitorOutcome => ({
    state: { ...state, overlay: value && { ...value, kind: 'control-harness-add' } }, close: false, action,
  });
  const pane = ctx.frame?.panes.find((p) => p.id === 'preview') ?? ctx.frame?.panes.find((p) => p.id === 'agents');
  const items = (pane?.rows ?? []).flatMap((r) => restoreId(r.item) ? [r.item!] : []);
  const at = Math.max(0, items.indexOf(add.pick ?? ''));
  const select = (i: number) => out({ ...add, pick: items[Math.max(0, Math.min(items.length - 1, i))] });
  const restore = (item = items[at]) => {
    const id = restoreId(item);
    return out(add, id ? { type: 'harness-switch', id, off: false } : undefined);
  };
  if (input.type === 'mouse') {
    const hit = clickKind(input, ctx);
    if (hit === 'harness-back') return out(undefined);
    if (hit === 'harness-restore') return restore();
    if (input.button !== 'left') return select(at + (input.button === 'wheel-down' ? 1 : -1));
    const item = pane && monitorRowAt(pane, input.x, input.y)?.item;
    return item && items.includes(item) ? item === add.pick ? restore(item) : out({ ...add, pick: item }) : out(add);
  }
  if (input.text) return out({ text: (add.text + input.text).slice(0, 128) });
  if (input.key === 'escape' || input.key === 'close') return out(undefined);
  if (input.key === 'backspace') return out({ text: [...add.text].slice(0, -1).join('') });
  if (input.key === 'enter') return restore();
  const page = Math.max(1, (pane?.height ?? 1) - 2);
  if (input.key === 'home' || input.key === 'end') return select(input.key === 'home' ? 0 : items.length - 1);
  if (/^(?:up|down|page-up|page-down)$/.test(input.key))
    return select(at + (input.key.endsWith('up') ? -1 : 1) * (input.key.startsWith('page') ? page : 1));
  return out(add);
}

export function workboardInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome | null {
  let next = { ...state, control: copyControlTab(state.control), tree: { ...state.tree }, modes: { ...state.modes }, scroll: { ...state.scroll } };
  const result = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const frame = ctx.frame,
    boardFrame = frame?.workboard;
  if (!boardFrame) return null;
  const key = input.type === 'key' ? input.text === ' ' ? 'space' : input.key : '';
  const main = next.focus === 'agents', classic = next.panelLayout !== 'split';
  const inspector = next.focus === 'details';
  const goTab = (tab: MainTab = 'home') => {
    next.control.notice = undefined;
    const keepingProject = next.mainTab === 'control' || tab === 'control';
    next.mainTab = tab;
    if (tab === 'home' || next.trySelection && state.mainTab === 'home') next.trySelection = undefined;
    next.focus = 'agents';
    next.modes.agents = 'open';
    next.boardInspect = undefined;
    if (!keepingProject) {
      next.boardRevealed = undefined;
      next.boardAnchor = undefined;
      next.projectList = undefined;
      next.projectBack = undefined;
    }
  };
  // Opening a page keeps where it was left; closing it lands the hub's cursor on that page's row.
  const goProject = (page?: ProjectPage, cursor?: string) => {
    const from = projectPageOf(next), saved = { ...next.projectSaved };
    const full = (classic ? next.projectTry : undefined) ?? { cursor: next.projectCursor, scroll: next.projectScroll ?? 0 };
    if (from) saved[from] = full;
    next.trySelection = undefined;
    next.projectTry = undefined;
    const kept = page && !cursor ? saved[page] : undefined;
    next.projectSaved = saved;
    next.projectPage = page;
    next.projectCursor = page ? cursor ?? kept?.cursor : from && (from === 'waiting' ? `project:wait:${next.projectWait}` : `project:page:${from}`);
    next.projectScroll = kept?.scroll ?? 0;
    next.boardRevealed = kept?.cursor;
  };
  // Progress's to-try filter: on, it keeps where the full feed was; off (the same key, Enter on its header or Esc), the feed is back there.
  const tryOnly = () => {
    const full = next.projectTry;
    next.trySelection = undefined;
    next.projectTry = full ? undefined : { cursor: next.projectCursor, scroll: next.projectScroll ?? 0 };
    next.projectCursor = full ? full.cursor : 'project:try';
    next.projectScroll = full?.scroll ?? 0;
    next.boardRevealed = full?.cursor;
  };
  // A waiting item's whole text; closing the page puts the cursor back on the item's row.
  const readWait = (i: number) => {
    next.projectWait = i;
    goProject('waiting', `project:wait:${i}:0`);
  };
  // Another project for the tab: its pages start fresh (cursor, scroll, folds), the open page stays open.
  const useProject = (root?: string) => {
    if (root === next.projectRoot) return;
    next.projectRoot = root;
    next.control.notice = undefined;
    next.control.roles = initialControlView('roles');
    next.trySelection = undefined;
    // Esc goes back to the list only from a hub opened out of it, not from one stepped to with `[` and `]`.
    next.projectBack = undefined;
    next.projectSaved = {};
    next.projectTry = undefined;
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
    next.trySelection = undefined;
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
    goTab();
    return result();
  }
  // `g`, `r` and `X` on a HUD job, on Home (either layout) and in the Inspector; before the keys that move the cursor take `g` for Home.
  const job = (main && next.mainTab === 'home') || (inspector && next.boardInspect) ? openJobAction(next, input, key, boardFrame.snapshot, result) : undefined;
  if (job) return job;
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
    if (['left', 'right', 'tab', 'shift-tab'].includes(key)) return result();
  }
  const tab = clickKind(input, ctx);
  const control = controlShown(next);
  const harnessKey = input.type === 'key' && input.text === 'h';
  if (control && (harnessKey || tab === 'control-roles' || tab === 'control-harnesses')) {
    next.control.subTab = (harnessKey ? next.control.subTab === 'roles' : tab === 'control-harnesses') ? 'harnesses' : 'roles';
    next.control.notice = undefined;
    return result();
  }
  const tabs = mainTabs(next), clicked = tabs.find(({ id }) => tab === `board-${id}`);
  if (clicked || (main && ['left', 'right', 'tab', 'shift-tab'].includes(key))) {
    const at = tabs.findIndex(({ id }) => id === mainTabOf(next));
    const step = key === 'left' || key === 'shift-tab' ? -1 : 1;
    goTab(clicked?.id ?? tabs[(at + step + tabs.length) % tabs.length].id);
    return result();
  }
  if (main && mainTabOf(next) === 'exp') {
    if (['help', 'settings', 'brief-toggle'].includes(key)) return null;
    if (tab === 'brief') return result({ type: 'brief-toggle' });
    return expInput(next, input, ctx) ?? result();
  }
  if (key === 'changes') {
    next.trySelection = undefined;
    next.focus = 'changes';
    next.boardInspect = undefined;
    next.modes.changes = 'open';
    return result();
  }
  if (key === 'brief-toggle' || tab === 'brief') return result({ type: 'brief-toggle' });
  if (control && (key === 'project-prev' || key === 'project-next')) {
    cycleProject(key === 'project-next' ? 1 : -1);
    return result();
  }
  if (control || (main && next.mainTab === 'project')) {
    const view = control ? next.control[next.control.subTab] : undefined, nav = view?.nav;
    const cursor = nav ? nav.cursor : next.projectCursor;
    const select = (item?: string) => { if (nav) nav.cursor = item; else next.projectCursor = item; };
    const toggleFold = (id: string) => {
      const folded = new Set(view?.folded ?? projectFoldedSet(next));
      if (!folded.delete(id)) folded.add(id);
      if (view) view.folded = folded;
      else next.projectFolded = folded;
    };
    // A hub entry may span two rows (the bar); the cursor visits it once.
    const rows = boardFrame.rows.filter((r, i, all) => r.item && all.findIndex((o) => o.item === r.item) === i),
      at = rows.findIndex((r) => r.item === cursor);
    const harnesses = control && next.control.subTab === 'harnesses';
    const switchAction = (row: typeof rows[number] | undefined, remove = false): MonitorOutcome['action'] => {
      const id = harnessId(row?.item);
      if (id && row?.harnessOff !== undefined && (!remove || !row.harnessOff))
        return { type: 'harness-switch', id, off: !row.harnessOff };
    };
    if (nav && !harnesses) {
      const openChain = (role: RoleFact, at = 0) => {
        nav.cursor = controlRoleItem(role.role);
        nav.split.focus = 'list';
        next.overlay = { kind: 'control-chain', role, at, mode: { kind: 'places' } };
        return result();
      };
      if (key !== 'escape') next.control.notice = undefined;
      const rowFact = (item?: string) => rows.find((r) => r.item === controlRoleItem(controlRoleOf(item) ?? ''))?.roleFact;
      if (input.type === 'mouse' && input.button === 'left') {
        const pane = frame?.panes.find((p) => p.id === 'preview'), list = frame?.panes.find((p) => p.id === 'agents');
        const place = pane && monitorRowAt(pane, input.x, input.y)?.item;
        const listItem = list && monitorRowAt(list, input.x, input.y)?.item;
        const index = /:(\d+)$/.exec(place ?? '')?.[1];
        const role = rowFact(place ?? listItem);
        if (role && index !== undefined) {
          if (tab !== 'control-model') return openChain(role, Number(index));
          next = openQuickModel(next, role, Number(index), ctx);
          nav.cursor = controlRoleItem(role.role);
          return result();
        }
        if (!tab && role && listItem === cursor) return openChain(role);
      }
      if (tab === 'control-open-file' && rows[at]?.files) return result({ type: 'open-files', files: rows[at]!.files! });
      const clickedRole = input.type === 'mouse' && input.button === 'left'
        ? frame?.controls.find((c) => c.kind.startsWith('preset-') && c.y === input.y && input.x >= c.x && input.x < c.x + c.width)?.item
        : undefined;
      const fact = (clickedRole ? rows.find((r) => r.item === clickedRole) : rows[at])?.roleFact;
      const op = tab?.startsWith('preset-') ? tab : key;
      if (fact && (key === 'enter' || key === 'activate')) return openChain(fact);
      if (fact && fact.source !== 'project') {
        if (key === 'place-model' || tab === 'control-model') {
          next = openQuickModel(next, fact, roleModelIndex(fact), ctx);
          return result();
        }
        if (op === 'role-preset' || op === 'role-preset-prev' || op === 'preset-next' || op === 'preset-prev')
          return result({ type: 'role-edit', role: fact.role, index: 0, op: 'preset',
            step: op.endsWith('prev') ? -1 : 1, revision: fact.revision });
        if ((op === 'preset-list' && fact.presets?.length) || op === 'preset-copy' || op === 'preset-empty' || ((op === 'preset-rename' || op === 'preset-delete') && fact.preset)) {
          nav.cursor = controlRoleItem(fact.role);
          nav.split.focus = 'list';
          next.overlay = { kind: 'control-preset', sheet: op === 'preset-list' ? { mode: 'list', role: fact, text: '', at: 0 }
            : op === 'preset-delete' ? { mode: 'delete', role: fact }
              : { mode: op === 'preset-copy' ? 'copy' : op === 'preset-empty' ? 'empty' : 'rename', role: fact, text: '' } };
          return result();
        }
      }
    }
    if (harnesses) {
      if (key === 'place-add' || tab === 'harness-add') {
        next.overlay = { kind: 'control-harness-add', text: '' };
        return result();
      }
      if (key === 'space' || key === 'place-remove' || tab === 'harness-toggle' || tab === 'harness-remove')
        return result(switchAction(rows[at], key === 'place-remove' || tab === 'harness-remove'));
      if (tab === 'harness-fold') {
        if (rows[at]?.item === harnessFold) toggleFold(harnessFold.slice('project:fold:'.length));
        return result();
      }
      if (tab === 'harness-refresh') return result({ type: 'refresh-models' });
      if (tab === 'help') { next.help = true; next.helpScroll = 0; return result(); }
    }
    // `o` opens a row's file even where Enter folds (a ticket, a long Next bullet); folds with no file toggle on either.
    const activate = (row = rows[at], open = false) => {
      if (open) {
        if (row?.files) return { type: 'open-files' as const, files: row.files };
        if (harnesses) return;
      }
      if (harnesses && harnessId(row?.item)) return switchAction(row);
      const role = /^inbox:role:(.+)$/.exec(row?.item ?? '')?.[1];
      if (role) {
        const selectedRoot = next.projectRoot ?? frame?.projects?.[0].root;
        // Project can still be rendering the previous root while a switch is loading.
        if (selectedRoot && frame?.projectDisplayRoot && frame.projectDisplayRoot !== selectedRoot) return;
        goTab('control');
        next.control.subTab = 'roles';
        const roles = next.control.roles.nav;
        next.control.roles = { ...next.control.roles, nav: { ...roles, cursor: controlRoleItem(role), scroll: 0,
          revealed: undefined, split: { ...roles.split, focus: 'list', listCursor: undefined, previewCursor: undefined } } };
      } else if (row?.item === 'project:switch') showList(true);
      else if (row?.item?.startsWith('project:list:')) openProject(row.item.slice(13));
      else if (row?.item?.startsWith('project:page:')) goProject(row.item.slice(13) as ProjectPage);
      else if (classic && row?.item === 'project:try') tryOnly();
      else if (/^project:wait:\d+$/.test(row?.item ?? '')) readWait(Number(row!.item!.slice(13)));
      else if (row?.item?.startsWith('project:fold:')) toggleFold(row.item.slice(13));
      else if (row?.files) return { type: 'open-files' as const, files: row.files };
    };
    // The Split layout has its own list and preview; what it does not do is Classic's, below.
    if (!classic && frame?.panes.some((p) => p.id === 'preview')) {
      const out = splitProjectInput(next, nav, input, key, ctx, result, () => result(activate()));
      if (out) return out;
    }
    if (input.type === 'mouse') {
      const pane = frame?.panes.find((p) => p.id === 'agents');
      if (input.button !== 'left') {
        const page = Math.max(1, pane?.height ?? 1), max = Math.max(0, (pane?.contentLength ?? 0) - page);
        const scroll = Math.max(0, Math.min(max, (nav?.scroll ?? next.projectScroll ?? 0) + (input.button === 'wheel-down' ? 3 : -3)));
        if (nav) nav.scroll = scroll;
        else next.projectScroll = scroll;
      } else {
        const row = pane && monitorRowAt(pane, input.x, input.y);
        if (row?.item) {
          const again = row.item === cursor;
          select(row.item);
          // A hub entry is a link: one click opens it. Elsewhere a click selects and a second one acts.
          return result(again || /^project:(page:|list:|switch$|try$|wait:\d+$)/.test(row.item) ? activate(row) : undefined);
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
      select(rows[key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + step))]?.item);
      return result();
    }
    if (!control && classic && projectPageOf(next) === 'progress') {
      if (input.type === 'key' && input.text === 't') {
        tryOnly();
        return result();
      }
      const tried = (next.acceptance !== 'slice' || next.projectTry || next.projectLayout === 'board' || next.projectLayout === 'inbox') && tryInput(next, key, rows[at]);
      if (tried) return tried;
    }
    if (!control && classic && !projectPageOf(next) && !listed && (next.acceptance !== 'slice' || next.projectLayout === 'inbox')) {
      const tried = tryInput(next, key, rows[at]);
      if (tried) return tried;
    }
    if (control) {
      if (key === 'reset') return result({ type: 'refresh-models' });
      return ['help', 'settings'].includes(key) ? null : result();
    }
    if (key === 'escape' && (projectPageOf(next) || listed || (next.projectBack && frame?.projects))) {
      if (listed) showList(false);
      else if (classic && next.projectTry) tryOnly();
      else if (projectPageOf(next)) goProject();
      else showList(true);
      return result();
    }
    if (!['help', 'settings', 'escape'].includes(key)) return result();
  }
  const homeTry = boardFrame?.rows.find((r) => r.item === next.boardAnchor && r.tryTarget);
  if (main && (homeTry || next.trySelection) && !(key === 'space' && !homeTry)) {
    const tried = tryInput(next, key, homeTry);
    if (tried) return tried;
    if (key === 'open-session' && homeTry?.files) return result({ type: 'open-files', files: homeTry.files });
  }
  const inspect = () => {
    const target = next.homeTarget;
    if (!target || target.kind === 'decision' || !boardFrame || next.boardAnchor) return;
    const lane = boardFrame.snapshot.lanes.find((l) => l.id === target.laneId);
    const worker = target.kind === 'worker' ? lane?.workers.find((w) => w.id === target.workerId) : undefined;
    next.boardInspect = target;
    if (worker?.nodeId) next.tree.selectedId = worker.nodeId;
    next.focus = 'details';
    next.modes.details = 'open';
    next.scroll.details = 0;
    next.inspectCursor = undefined;
    next.boardRevealed = undefined;
  };
  if ((key === 'inspect' || key === 'details' || key === 'detail-toggle' || key === 'space') && main) {
    inspect();
    return result();
  }
  if (key === 'escape' && inspector && (next.mainTab || next.boardInspect)) {
    next.focus = 'agents';
    next.modes.details = 'closed';
    next.boardInspect = undefined;
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
    const evidence = worker?.work?.requestInfo?.evidence ?? worker?.evidence.at(-1);
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
    goTab('project');
    // Home's block is the panel's own project's.
    useProject(undefined);
    if (id === 'waiting') {
      // The hub's Waiting block, with the cursor on its fold.
      next.projectPage = undefined;
      next.projectCursor = 'project:fold:waiting';
      next.projectScroll = 0;
      return;
    }
    if (/^wait:\d+$/.test(id)) return readWait(Number(id.slice(5)));
    if (id === 'progress' || id === 'latest') return goProject('progress');
    // A ticket row opens the Tickets page where it was left: its lanes cross features, so no feature row is there to rest on.
    goProject('tickets');
  };
  const taskStop = (item?: string) => item?.startsWith('project:fold:task:');
  // Cards expand in place; the compact progress block opens its Project destination.
  const activate = (target = selected()) => {
    if (taskStop(next.boardAnchor)) {
      const item = next.boardAnchor!;
      goTab('project');
      useProject(undefined);
      goProject('progress', item);
      next.projectFolded = new Set([...(next.projectFolded ?? []), item.slice('project:fold:'.length)]);
      return;
    }
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
  if (next.panelLayout === 'split' && main && frame?.panes.some((p) => p.id === 'preview')) {
    const out = splitHomeInput(next, input, key, ctx, result, { toggle: (item) => {
      if (/^project:fold:(task|ledger):/.test(item)) {
        const id = item.slice('project:fold:'.length), folded = new Set(next.projectFolded);
        if (!folded.delete(id)) folded.add(id);
        next.projectFolded = folded;
      } else toggle(item);
    }, openProgress });
    if (out) return out;
  }
  if (input.type === 'mouse') {
    const control =
      input.button === 'left'
        ? frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width)
        : undefined;
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
      const page = Math.max(1, pane.height), max = Math.max(0, pane.contentLength - page);
      const delta = input.button === 'wheel-down' ? 3 : -3;
      if (inspector) next.scroll.details = Math.max(0, Math.min(max, next.scroll.details + delta));
      else next.homeScroll = Math.max(0, Math.min(max, (next.homeScroll ?? 0) + delta));
      return result();
    }
    const row = monitorRowAt(pane, input.x, input.y),
      item = control?.kind === 'board-pick' ? control.item : row?.item;
    if (item && taskStop(item)) {
      const again = next.boardAnchor === item;
      next.boardAnchor = item;
      if (again) activate();
      return result();
    }
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
      if (!next.boardAnchor && selected() && targetKey(selected()!) === targetKey(target)) activate(target);
      else setTarget(target);
    }
    return result();
  }
  if (key === 'enter' || key === 'activate') {
    if (main) activate();
    return result();
  }
  // `o` opens the selected job's file in $EDITOR.
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
    if (item?.startsWith('home-progress:') || taskStop(item)) {
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

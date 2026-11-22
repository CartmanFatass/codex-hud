/** Main-tab routing. It mutates nothing: the owner's micro-actions on a job leave as actions (`job-actions.ts`) for the panel to run. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
import { closeSubpage, copyControlTab, controlRoleItem, controlRoleOf, harnessFold, homeAnchor, homeCursor, homeTarget,
  onlyTry, openSubpage, switchProject, transitionProjectView, transitionTab, type OverlayState, type ProjectSubPage } from './monitor-state.js';
import { targetKey, type WorkTarget } from '../collectors/workboard-types.js';
import { monitorRowAt } from './monitor-input.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { cardExpanded } from './work-card.js';
import { projectPageOf, projectListOpen } from './project-view.js';
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
  // Only the routed tab's navigation is edited. Transitions replace other branches as needed.
  let next: MonitorState = { ...state };
  switch (state.activeTab) {
    case 'home': next.home = { ...state.home, split: { ...state.home.split } }; break;
    case 'project': next.project = { ...state.project, nav: { ...state.project.nav, split: { ...state.project.nav.split } } }; break;
    case 'control': next.control = copyControlTab(state.control); break;
    case 'exp': break;
  }
  const result = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const frame = ctx.frame,
    boardFrame = frame?.workboard;
  if (!boardFrame) return null;
  const key = input.type === 'key' ? input.text === ' ' ? 'space' : input.key : '';
  const main = !next.subpage, classic = next.prefs.panelLayout !== 'split';
  const inspector = next.subpage?.kind === 'inspector' ? next.subpage : undefined;
  const goTab = (tab: MainTab = 'home') => { next = transitionTab(next, tab); };
  const goProject = (page?: ProjectSubPage, cursor?: string) => {
    next = transitionProjectView(next, page ? { kind: page } : { kind: 'hub' }, { cursor });
  };
  // Progress's to-try filter keeps the full feed's place until it is turned off.
  const tryOnly = () => {
    const { view, nav } = next.project;
    if (view.kind !== 'progress') return;
    const full = view.onlyTry;
    next.project = { ...next.project, trySelection: undefined,
      view: { kind: 'progress', onlyTry: full ? undefined : { cursor: nav.cursor, scroll: nav.scroll } },
      nav: { ...nav, cursor: full ? full.cursor : 'project:try', scroll: full?.scroll ?? 0, revealed: full?.cursor } };
  };
  const readWait = (index: number) => {
    next = transitionProjectView(next, { kind: 'waiting', index }, { cursor: `project:wait:${index}:0` });
  };
  const useProject = (root?: string) => { next = switchProject(next, root); };
  const cycleProject = (step: number) => {
    const list = frame?.projects;
    if (!list) return;
    const at = Math.max(0, list.findIndex((p) => p.root === next.selectedProject)), to = list[(at + step + list.length) % list.length];
    useProject(to === list[0] ? undefined : to.root);
  };
  // The Projects list sits above the hubs: the name row opens it, a click on its entry opens that project's hub.
  const listed = projectListOpen(next, frame?.projects);
  const showList = (on: boolean) => {
    const root = next.selectedProject ?? frame?.projects?.[0].root;
    next = transitionProjectView(next, { kind: on ? 'projects-list' : 'hub' }, {
      cursor: on ? `project:list:${root}` : 'project:switch', fromProjectsList: false });
  };
  const openProject = (root: string) => {
    useProject(root === frame?.projects?.[0].root ? undefined : root);
    next = transitionProjectView(next, { kind: 'hub' }, { fromProjectsList: true });
  };
  const back =
    input.type === 'mouse' &&
    input.button === 'left' &&
    frame?.controls.some(
      (c) => c.kind === 'board-back' && c.y === input.y && input.x >= c.x && input.x < c.x + c.width
    );
  if (back && main && next.activeTab === 'project' && (projectPageOf(next) || listed)) {
    if (listed) showList(false);
    else goProject();
    return result();
  }
  if (back || (key === 'escape' && next.subpage?.kind === 'changes')) {
    goTab();
    return result();
  }
  // `g`, `r` and `X` on a HUD job, on Home (either layout) and in the Inspector; before the keys that move the cursor take `g` for Home.
  const job = (main && next.activeTab === 'home') || inspector ? openJobAction(next, input, key, boardFrame.snapshot, result) : undefined;
  if (job) return job;
  if (inspector) {
    const rows = boardFrame.rows.filter((r) => r.files?.length),
      at = rows.findIndex((r) => r.item === inspector.cursor);
    if (input.type === 'mouse' && input.button === 'left') {
      const pane = frame?.panes.find((p) => p.id === 'details'),
        row = pane && monitorRowAt(pane, input.x, input.y);
      if (row?.files?.length) {
        next.subpage = { ...inspector, cursor: row.item };
        return result({ type: 'open-files', files: row.files });
      }
    }
    if (['enter', 'activate', 'open-session'].includes(key))
      return result(rows[at] ? { type: 'open-files', files: rows[at].files! } : undefined);
    if (['up', 'down', 'home', 'end', 'page-up', 'page-down'].includes(key)) {
      const step = key === 'up' ? -1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 1;
      const cursor =
        rows[key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + step))]
          ?.item;
      next.subpage = { ...inspector, cursor };
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
    if (next.activeTab === 'home' || next.activeTab === 'project') next[next.activeTab].trySelection = undefined;
    next = openSubpage(next, { kind: 'changes', scroll: next.subpage?.kind === 'changes' ? next.subpage.scroll : next.lastChangesScroll });
    return result();
  }
  if (key === 'brief-toggle' || tab === 'brief') return result({ type: 'brief-toggle' });
  if (control && (key === 'project-prev' || key === 'project-next')) {
    cycleProject(key === 'project-next' ? 1 : -1);
    return result();
  }
  // Project and Control share list navigation, but own their views and actions.
  if (control || (main && next.activeTab === 'project')) {
    const view = control ? next.control[next.control.subTab] : undefined;
    const nav = view?.nav ?? next.project.nav, cursor = nav.cursor;
    const select = (item?: string) => { nav.cursor = item; };
    const toggleFold = (id: string) => {
      const folded = new Set(view?.folded ?? next.project.folded);
      if (!folded.delete(id)) folded.add(id);
      if (view) view.folded = folded;
      else next.project.folded = folded;
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
    if (view && !harnesses) {
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
      if (tab === 'help') { next.help = {}; return result(); }
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
        const selectedRoot = next.selectedProject ?? frame?.projects?.[0].root;
        // Project can still be rendering the previous root while a switch is loading.
        if (selectedRoot && frame?.projectDisplayRoot && frame.projectDisplayRoot !== selectedRoot) return;
        goTab('control');
        next.control.subTab = 'roles';
        const roles = next.control.roles.nav;
        next.control.roles = { ...next.control.roles, nav: { ...roles, cursor: controlRoleItem(role), scroll: 0,
          revealed: undefined, split: { ...roles.split, focus: 'list', listCursor: undefined, previewCursor: undefined } } };
      } else if (row?.item === 'project:switch') showList(true);
      else if (row?.item?.startsWith('project:list:')) openProject(row.item.slice(13));
      else if (row?.item?.startsWith('project:page:')) goProject(row.item.slice(13) as ProjectSubPage);
      else if (classic && row?.item === 'project:try') tryOnly();
      else if (/^project:wait:\d+$/.test(row?.item ?? '')) readWait(Number(row!.item!.slice(13)));
      else if (row?.item?.startsWith('project:fold:')) toggleFold(row.item.slice(13));
      else if (row?.files) return { type: 'open-files' as const, files: row.files };
    };
    // The Split layout has its own list and preview; what it does not do is Classic's, below.
    if (!classic && frame?.panes.some((p) => p.id === 'preview')) {
      const out = splitProjectInput(next, view?.nav, input, key, ctx, result, () => result(activate()));
      if (out) return out;
    }
    if (input.type === 'mouse') {
      const pane = frame?.panes.find((p) => p.id === 'agents');
      if (input.button !== 'left') {
        const page = Math.max(1, pane?.height ?? 1), max = Math.max(0, (pane?.contentLength ?? 0) - page);
        nav.scroll = Math.max(0, Math.min(max, nav.scroll + (input.button === 'wheel-down' ? 3 : -3)));
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
      const tried = (next.prefs.acceptance !== 'slice' || onlyTry(next.project.view) || next.prefs.projectLayout === 'board' || next.prefs.projectLayout === 'inbox') && tryInput(next, key, rows[at]);
      if (tried) return tried;
    }
    if (!control && classic && !projectPageOf(next) && !listed && (next.prefs.acceptance !== 'slice' || next.prefs.projectLayout === 'inbox')) {
      const tried = tryInput(next, key, rows[at]);
      if (tried) return tried;
    }
    if (control) {
      if (key === 'reset') return result({ type: 'refresh-models' });
      return ['help', 'settings'].includes(key) ? null : result();
    }
    if (key === 'escape' && (projectPageOf(next) || listed || (next.project.fromProjectsList && frame?.projects))) {
      if (listed) showList(false);
      else if (classic && onlyTry(next.project.view)) tryOnly();
      else if (projectPageOf(next)) goProject();
      else showList(true);
      return result();
    }
    return ['help', 'settings', 'escape'].includes(key) ? null : result();
  }

  // Home's cards, list stops, task folds and mouse actions (including Inspector scrolling).
  const anchor = () => homeAnchor(next.home);
  const selected = () => homeTarget(next.home);
  const setAnchor = (item?: string) => { next.home.cursor = homeCursor(selected(), item); };
  const homeTry = boardFrame.rows.find((r) => r.item === anchor() && r.tryTarget);
  if (main && (homeTry || next.home.trySelection) && !(key === 'space' && !homeTry)) {
    const tried = tryInput(next, key, homeTry);
    if (tried) return tried;
    if (key === 'open-session' && homeTry?.files) return result({ type: 'open-files', files: homeTry.files });
  }
  const inspect = () => {
    const target = selected();
    if (!target || target.kind === 'decision' || anchor()) return;
    const lane = boardFrame.snapshot.lanes.find((l) => l.id === target.laneId);
    const worker = target.kind === 'worker' ? lane?.workers.find((w) => w.id === target.workerId) : undefined;
    next = openSubpage(next, { kind: 'inspector', target, scroll: 0, selectedNodeId: worker?.nodeId });
  };
  if ((key === 'inspect' || key === 'details' || key === 'detail-toggle' || key === 'space') && main) {
    inspect();
    return result();
  }
  if (key === 'escape' && inspector) {
    next = closeSubpage(next);
    return result();
  }
  if (!main && !inspector) return null;
  const setTarget = (target: WorkTarget) => { next.home.cursor = homeCursor(target); };
  const toggle = (item: string, open?: boolean) => {
    const set = new Set(next.home.expanded);
    const worker = boardFrame.snapshot.workers.find(
      (w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id }) === item
    );
    const expanded = worker && !worker.homeNeedsHuman ? cardExpanded(next, item) : set.has(item);
    if (open === false || (open === undefined && expanded)) set.delete(item);
    else set.add(item);
    next.home.expanded = set;
    if (worker) next.home.toggled = new Set([...(next.home.toggled ?? []), item]);
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
      next = transitionProjectView(next, { kind: 'hub' }, { cursor: 'project:fold:waiting' });
      return;
    }
    if (/^wait:\d+$/.test(id)) return readWait(Number(id.slice(5)));
    if (id === 'progress' || id === 'latest' || id.startsWith('latest:')) return goProject('progress');
    // A ticket row opens the Tickets page where it was left: its lanes cross features, so no feature row is there to rest on.
    goProject('tickets');
  };
  const taskStop = (item?: string) => item?.startsWith('project:fold:task:');
  // Cards expand in place; the compact progress block opens its Project destination.
  const activate = (target = selected()) => {
    if (taskStop(anchor())) {
      const item = anchor()!;
      goTab('project');
      useProject(undefined);
      goProject('progress', item);
      next.project.folded = new Set([...(next.project.folded ?? []), item.slice('project:fold:'.length)]);
      return;
    }
    if (anchor()?.startsWith('home-progress:')) return openProgress(anchor()!);
    if (anchor()) {
      toggle(anchor()!);
      return;
    }
    if (!target) return;
    if (target.kind !== 'lane') return toggle(targetKey(target));
    const folded = new Set(next.home.foldedLanes);
    if (!folded.delete(target.laneId)) folded.add(target.laneId);
    next.home.foldedLanes = folded;
  };
  if (next.prefs.panelLayout === 'split' && main && frame?.panes.some((p) => p.id === 'preview')) {
    const out = splitHomeInput(next, input, key, ctx, result, { toggle: (item) => {
      if (/^project:fold:(task|ledger):/.test(item)) {
        const id = item.slice('project:fold:'.length), expanded = new Set(next.home.expandedTasks);
        if (!expanded.delete(id)) expanded.add(id);
        next.home.expandedTasks = expanded;
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
      next.help = {};
      return result();
    }
    const pane = frame?.panes.find((p) => p.id === (inspector ? 'details' : 'agents'));
    if (!pane) return result();
    if (input.button !== 'left') {
      const page = Math.max(1, pane.height), max = Math.max(0, pane.contentLength - page);
      const delta = input.button === 'wheel-down' ? 3 : -3;
      if (inspector) next.subpage = { ...inspector, scroll: Math.max(0, Math.min(max, inspector.scroll + delta)) };
      else next.home.scroll = Math.max(0, Math.min(max, (next.home.scroll ?? 0) + delta));
      return result();
    }
    const row = monitorRowAt(pane, input.x, input.y),
      item = control?.kind === 'board-pick' ? control.item : row?.item;
    if (item && taskStop(item)) {
      const again = anchor() === item;
      setAnchor(item);
      if (again) activate();
      return result();
    }
    if (item?.startsWith('home-progress:')) {
      openProgress(item);
      return result();
    }
    if (item?.startsWith('fold:')) {
      setAnchor(item);
      toggle(item);
      return result();
    }
    const target = item ? boardFrame.targets.get(item) : undefined;
    if (target) {
      if (!anchor() && selected() && targetKey(selected()!) === targetKey(target)) activate(target);
      else setTarget(target);
    }
    return result();
  }
  if (key === 'enter' || key === 'activate') {
    if (main) activate();
    return result();
  }
  // `o` opens the selected job's file in $EDITOR.
  if (key === 'open-session' && main) return result(anchor() ? undefined : jobFiles());
  if (key === 'show-all' && main) {
    next.home.showAll = !next.home.showAll;
    return result();
  }
  // Removed controls cannot act through hidden legacy shortcuts either.
  if (['resume-reconcile', 'reset', 'filter', 'main', 'log', 'pane-close', 'zoom'].includes(key))
    return result();
  if (key === 'next-trouble' || key === 'previous-trouble') {
    const workers = boardFrame.snapshot.workers;
    const targets = [
      ...workers.filter((w) => projectWorkCard(w, ctx.nowMs ?? 0, next.prefs.cardStallMinutes).state === 'needs-you'),
      ...workers.filter((w) => projectWorkCard(w, ctx.nowMs ?? 0, next.prefs.cardStallMinutes).state === 'stalled'),
    ].map((w) => ({ kind: 'worker' as const, laneId: w.laneId, workerId: w.id }));
    if (targets.length) {
      const at = targets.findIndex((t) => selected() && targetKey(t) === targetKey(selected()!));
      const target =
        targets[(at + (key === 'previous-trouble' ? targets.length - 1 : 1) + targets.length) % targets.length];
      setTarget(target);
      const folded = new Set(next.home.foldedLanes);
      folded.delete(target.laneId);
      next.home.foldedLanes = folded;
      next.home.revealed = undefined;
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
    const current = anchor() ?? (selected() ? targetKey(selected()!) : ''),
      at = items.indexOf(current);
    const step = key === 'up' ? -1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 1;
    const index =
      key === 'home' ? 0 : key === 'end' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + step));
    const item = items[index];
    if (item?.startsWith('home-progress:') || taskStop(item)) {
      setAnchor(item);
      next.home.revealed = undefined;
      return result();
    }
    if (item?.startsWith('fold:')) {
      setAnchor(item);
      toggle(item, true);
      next.home.revealed = undefined;
      return result();
    }
    const target = boardFrame.targets.get(item);
    if (target) setTarget(target);
    return result();
  }
  return null;
}

/** Main-tab routing. It mutates nothing: the owner's micro-actions on a job leave as actions (`job-actions.ts`) for the panel to run. */
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { backFromSubpage, CONTROL_VIEWS, copyControlTab, controlRoleItem, controlRoleOf, harnessFold, jobsPage,
  switchProject, transitionProjectView, transitionTab, type OverlayState, type ProjectSubPage } from './monitor-state.js';
import { monitorRowAt } from './monitor-input.js';
import { ACCEPT_ALL, projectPageOf, projectListOpen } from './project-view.js';
import { PROJECT_STRIP_MORE } from './project-strip.js';
import { isRequestMoreItem } from './request-area.js';
import type { RoleFact } from '../roles/role-control.js';
import { openQuickModel, roleModelIndex } from './chain-input.js';
import { openBatchAction, openJobAction } from './job-actions.js';
import { controlShown, resourcesShown, MAIN_TABS, type MainTab } from './main-tabs.js';
import { expInput } from './exp-view.js';
import { harnessId, restoreId } from './harness-page.js';
import { OTHER_PROJECTS } from './home-view.js';

const clickKind = (input: WorkbenchInput, ctx: MonitorContext) => input.type === 'mouse' && input.button === 'left'
  ? ctx.frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width)?.kind : undefined;

/** While Add back owns the keyboard, printable shortcuts are filter text. */
export function harnessAddInput(state: MonitorState, add: Extract<OverlayState, { kind: 'control-harness-add' }>, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  const out = (value: Omit<typeof add, 'kind'> | undefined, action?: MonitorOutcome['action']): MonitorOutcome => ({
    state: { ...state, overlay: value && { ...value, kind: 'control-harness-add' } }, close: false, action,
  });
  const pane = ctx.frame?.panes.find((p) => p.id === 'agents');
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
    case 'home': break;
    case 'project': next.project = { ...state.project, nav: { ...state.project.nav } }; break;
    case 'execution': next.execution = { ...state.execution }; break;
    case 'control': next.control = copyControlTab(state.control); break;
  }
  const result = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const frame = ctx.frame,
    boardFrame = frame?.workboard;
  if (!boardFrame) return null;
  const key = input.type === 'key' ? input.text === ' ' ? 'space' : input.key : '';
  const main = !next.subpage;
  const openObjective = (target: NonNullable<MonitorRow['objectiveTarget']>) => {
    next.subpage = { kind: 'objective', target, scroll: 0 };
  };
  const goTab = (tab: MainTab = 'home') => { next = transitionTab(next, tab); };
  const goProject = (page?: ProjectSubPage, cursor?: string) => {
    next = transitionProjectView(next, page ? { kind: page } : { kind: 'hub' }, { cursor });
  };
  const readWait = (index: number, request: string) => {
    next = transitionProjectView(next, { kind: 'waiting', index, request }, { cursor: `project:wait:${index}:0` });
  };
  const useProject = (root?: string) => { next = switchProject(next, root); };
  const cycleProject = (step: number) => {
    const list = frame?.projects;
    if (!list) return;
    const at = Math.max(0, list.findIndex((p) => p.root === next.selectedProject)), to = list[(at + step + list.length) % list.length];
    useProject(to === list[0] ? undefined : to.root);
  };
  // The Projects list sits behind the strip's +N: a click or Enter on an entry opens that project on the tab that opened the list.
  const listed = projectListOpen(next, frame?.projects);
  const showList = (on: boolean) => {
    const root = next.selectedProject ?? frame?.projects?.[0].root;
    const fromExec = on ? next.activeTab === 'execution'
      : next.project.view.kind === 'projects-list' && next.project.view.from === 'execution';
    if (on) {
      next = { ...transitionProjectView(next, { kind: 'projects-list', ...(fromExec ? { from: 'execution' } : {}) }, {
        cursor: `project:list:${root}`, fromProjectsList: false }), activeTab: 'project' };
    } else {
      next = { ...transitionProjectView(next, { kind: 'hub' }, {
        cursor: undefined, fromProjectsList: false }), activeTab: fromExec ? 'execution' : 'project' };
    }
  };
  const openProject = (root: string) => {
    const fromExec = next.project.view.kind === 'projects-list' && next.project.view.from === 'execution';
    useProject(root === frame?.projects?.[0].root ? undefined : root);
    next = transitionProjectView(next, { kind: 'hub' }, { fromProjectsList: !fromExec });
    if (fromExec) next = { ...next, activeTab: 'execution' };
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
  if (next.subpage && (back || key === 'escape')) {
    next = backFromSubpage(next);
    return result();
  }
  const tab = clickKind(input, ctx);
  const control = controlShown(next);
  const viewKey = input.type === 'key' && input.text === 'h';
  const controlView = CONTROL_VIEWS.find((id) => tab === `control-${id}`);
  if (control && (viewKey || controlView)) {
    next.control.subTab = controlView ?? CONTROL_VIEWS[(CONTROL_VIEWS.indexOf(next.control.subTab) + 1) % CONTROL_VIEWS.length];
    next.control.notice = undefined;
    return result();
  }
  const tabs = MAIN_TABS, clicked = tabs.find(({ id }) => tab === `board-${id}`);
  if (clicked || (main && ['left', 'right', 'tab', 'shift-tab'].includes(key))) {
    const at = tabs.findIndex(({ id }) => id === next.activeTab);
    const step = key === 'left' || key === 'shift-tab' ? -1 : 1;
    goTab(clicked?.id ?? tabs[(at + step + tabs.length) % tabs.length].id);
    return result();
  }
  if (resourcesShown(next)) {
    if (['help', 'settings'].includes(key)) return null;
    return expInput(next, input, ctx) ?? result();
  }
  if (control && (key === 'project-prev' || key === 'project-next')) {
    cycleProject(key === 'project-next' ? 1 : -1);
    return result();
  }
  // Project, Execution and Control share list navigation, but own their views and actions.
  const execution = main && next.activeTab === 'execution';
  if (control || execution || (main && next.activeTab === 'project')) {
    const view = control && next.control.subTab !== 'resources' ? next.control[next.control.subTab] : undefined;
    const nav = view?.nav ?? (execution ? next.execution : next.project.nav), cursor = nav.cursor;
    const select = (item?: string) => { nav.cursor = item; };
    const toggleFold = (id: string) => {
      const folded = new Set(view?.folded ?? next.project.folded);
      if (!folded.delete(id)) folded.add(id);
      if (view) view.folded = folded;
      else next.project.folded = folded;
    };
    // A selectable entry may span multiple rows; the cursor visits it once.
    const seenReq = new Set<string>(), seenBody = new Set<string>();
    const reqRows = (boardFrame.requests ?? []).filter((r) => r.item && !seenReq.has(r.item) && seenReq.add(r.item));
    const bodyRows = boardFrame.rows.filter((r) => r.item && !seenBody.has(r.item) && seenBody.add(r.item));
    const hasStripMore = !control && frame.controls.some((c) => c.kind === 'project-strip-more');
    const rows = [...(hasStripMore ? [{ item: PROJECT_STRIP_MORE, text: '' }] : []), ...reqRows, ...bodyRows];
    const at = rows.findIndex((r) => r.item === cursor);
    const harnesses = control && next.control.subTab === 'harnesses';
    const switchAction = (row: typeof rows[number] | undefined, remove = false): MonitorOutcome['action'] => {
      const id = harnessId(row?.item);
      if (id && row?.harnessOff !== undefined && (!remove || !row.harnessOff))
        return { type: 'harness-switch', id, off: !row.harnessOff };
    };
    if (view && !harnesses) {
      const openChain = (role: RoleFact, at = 0) => {
        if (role.optionalEnabled === false) return result();
        nav.cursor = controlRoleItem(role.role);
        next.overlay = { kind: 'control-chain', role, at, mode: { kind: 'places' } };
        return result();
      };
      if (key !== 'escape') next.control.notice = undefined;
      const rowFact = (item?: string) => rows.find((r) => r.item === controlRoleItem(controlRoleOf(item) ?? ''))?.roleFact;
      if (input.type === 'mouse' && input.button === 'left') {
        const list = frame?.panes.find((p) => p.id === 'agents');
        const listItem = list && monitorRowAt(list, input.x, input.y)?.item;
        const index = /:(\d+)$/.exec(listItem ?? '')?.[1];
        const role = rowFact(listItem);
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
      if (fact?.role === 'council' && ((input.type === 'key' && input.text === 'g') || tab === 'council-grant'))
        return result({ type: 'council-grant' });
      if (fact?.optionalEnabled !== undefined && (key === 'space' || tab === 'role-toggle')) {
        nav.revealed = undefined;
        return result({ type: 'role-switch', role: fact.role, enabled: !fact.optionalEnabled });
      }
      const op = tab?.startsWith('preset-') ? tab : key;
      if (fact && (key === 'enter' || key === 'activate')) return openChain(fact);
      if (fact && fact.source !== 'project' && fact.optionalEnabled !== false) {
        if (key === 'place-model' || tab === 'control-model') {
          next = openQuickModel(next, fact, roleModelIndex(fact), ctx);
          return result();
        }
        if (op === 'role-preset' || op === 'role-preset-prev' || op === 'preset-next' || op === 'preset-prev')
          return result({ type: 'role-edit', role: fact.role, index: 0, op: 'preset',
            step: op.endsWith('prev') ? -1 : 1, revision: fact.revision });
        if ((op === 'preset-list' && fact.presets?.length) || op === 'preset-copy' || op === 'preset-empty' || ((op === 'preset-rename' || op === 'preset-delete') && fact.preset)) {
          nav.cursor = controlRoleItem(fact.role);
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
      if (row?.execRun) {
        next.subpage = { kind: 'run-detail', flow: row.execRun, scroll: 0 };
        return;
      }
      if (row?.execJob) {
        next.subpage = { kind: 'inspector', target: row.execJob.target, scroll: 0, from: 'execution' };
        return;
      }
      if (row?.objectiveEvidence) return { type: 'open-objective-evidence' as const, ...row.objectiveEvidence };
      if (row?.objectiveTarget) openObjective(row.objectiveTarget);
      else if (row?.item === PROJECT_STRIP_MORE) showList(true);
      else if (row?.item?.startsWith('project:list:')) openProject(row.item.slice(13));
      else if (row?.item?.startsWith('project:page:')) goProject(row.item.slice(13) as ProjectSubPage);
      else if (row?.item === ACCEPT_ALL) return { type: 'accept-all' as const };
      else if (row?.waitingTarget) readWait(row.waitingTarget.index, row.waitingTarget.request);
      else if (row?.item?.startsWith('project:fold:')) toggleFold(row.item.slice(13));
      else if (row?.files) return { type: 'open-files' as const, files: row.files };
    };
    if (input.type === 'mouse') {
      const pane = frame?.panes.find((p) => p.id === 'agents');
      if (input.button !== 'left') {
        const page = Math.max(1, pane?.height ?? 1), max = Math.max(0, (pane?.contentLength ?? 0) - page);
        nav.scroll = Math.max(0, Math.min(max, nav.scroll + (input.button === 'wheel-down' ? 3 : -3)));
      } else {
        const stripHit = !control ? frame?.controls.find((c) =>
          (c.kind === 'project-strip-pick' || c.kind === 'project-strip-more') &&
          c.y === input.y && input.x >= c.x && input.x < c.x + c.width) : undefined;
        if (stripHit?.kind === 'project-strip-pick' && stripHit.item) {
          useProject(stripHit.item === frame?.projects?.[0].root ? undefined : stripHit.item);
          return result();
        }
        if (stripHit?.kind === 'project-strip-more') {
          showList(true);
          return result();
        }
        const reqHit = !control ? frame?.controls.find((c) =>
          (c.kind === 'request-pick' || c.kind === 'request-more') &&
          c.y === input.y && input.x >= c.x && input.x < c.x + c.width) : undefined;
        if (reqHit?.item) {
          const row = reqRows.find((r) => r.item === reqHit.item);
          if (row) {
            select(row.item);
            return result(activate(row));
          }
        }
        const row = pane && monitorRowAt(pane, input.x, input.y);
        if (row?.item) {
          const again = row.item === cursor;
          select(row.item);
          // A hub entry is a link: one click opens it. Elsewhere a click selects and a second one acts.
          return result(again || row.waitingTarget || /^project:(page:|list:)/.test(row.item) ? activate(row) : undefined);
        }
      }
      return result();
    }
    if (execution && key === 'stop-job') {
      const batch = rows[at]?.batch;
      if (batch) openBatchAction(next, batch);
      return result();
    }
    if (input.type === 'key' && (input.text === 'g' || input.text === 'P' || input.text === 'H') && execution) {
      const job = rows[at]?.execJob;
      const type = input.text === 'g' ? 'focus-job-tab' : input.text === 'P' ? 'pin-job-tab' : 'hide-job-tab';
      return result(job?.tab ? { type, dir: job.dir } : undefined);
    }
    if (['enter', 'activate', 'open-session'].includes(key)) return result(activate(undefined, key === 'open-session'));
    if ((key === 'project-prev' || key === 'project-next') && (execution || !listed)) {
      cycleProject(key === 'project-next' ? 1 : -1);
      return result();
    }
    if (['up', 'down', 'page-up', 'page-down', 'home', 'end'].includes(key)) {
      const step = key === 'up' ? -1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 1;
      select(rows[key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + step))]?.item);
      return result();
    }
    if (control) {
      if (key === 'reset') return result({ type: 'refresh-models' });
      return ['help', 'settings'].includes(key) ? null : result();
    }
    if (!execution && key === 'escape' && (projectPageOf(next) || listed || (next.project.fromProjectsList && frame?.projects))) {
      if (listed) showList(false);
      else if (projectPageOf(next)) goProject();
      else showList(true);
      return result();
    }
    return ['help', 'settings', 'escape'].includes(key) ? null : result();
  }

  if (tab === 'settings') return result({ type: 'settings' });
  if (tab === 'help') { next.help = {}; return result(); }
  const sub = next.subpage;
  const enter = key === 'enter' || key === 'activate';
  if (!sub && next.activeTab === 'home' && (key === 'jobs' || tab === 'board-jobs')) {
    next.subpage = jobsPage(next);
    return result();
  }
  if ((sub?.kind === 'jobs' || sub?.kind === 'inspector') && (key === 'native-inspector' || tab === 'board-native')) {
    next.subpage = { kind: 'native-inspector', scroll: 0, ...(sub.kind === 'inspector' && { back: sub }) };
    return result();
  }
  if (sub?.kind === 'inspector') {
    const job = openJobAction(next, input, key, boardFrame.snapshot, result);
    if (job) return job;
  }
  if (sub?.kind === 'jobs' && key === 'stop-job') {
    const batch = boardFrame.rows.find((row) => row.item === sub.cursor)?.batch;
    if (batch) openBatchAction(next, batch);
    return result();
  }
  const pane = frame?.panes[0];
  if (!frame || !pane) return null;
  const nav = sub ?? frame.state.home;
  const moveScroll = (scroll: number) => {
    const offset = Math.max(0, Math.min(Math.max(0, pane.contentLength - pane.height), scroll));
    if (sub) {
      next.subpage = { ...sub, scroll: offset };
      if (sub.kind === 'jobs') next.jobs = { cursor: sub.cursor, scroll: offset, revealed: sub.revealed };
    } else next.home = { ...nav, scroll: offset };
    return result();
  };
  const objective = sub?.kind === 'objective';
  const reqRows = (boardFrame.requests ?? []).filter((r, i, all) => r.item && all.findIndex((o) => o.item === r.item) === i);
  const bodyActions = boardFrame.rows.filter((r, i, all) => r.item && ((sub && !objective) || r.item !== all[i - 1]?.item));
  const actions = [...reqRows, ...bodyActions];
  const cursor = nav.cursor;
  const select = (item?: string) => {
    if (sub) next.subpage = { ...sub, cursor: item, revealed: undefined };
    else next.home = { ...nav, cursor: item, revealed: undefined };
    return result();
  };
  const toggleOtherProjects = () => {
    next.home = { ...frame.state.home, cursor: OTHER_PROJECTS, revealed: undefined, othersExpanded: !frame.state.home.othersExpanded };
    return result();
  };
  const toggleRequestsMore = (item: string) => {
    if (objective && next.activeTab === 'project') {
      const folded = new Set(next.project.folded);
      if (!folded.delete('waiting:more')) folded.add('waiting:more');
      next.project = { ...next.project, folded };
      next.subpage = { ...sub!, cursor: item, revealed: undefined };
    } else {
      next.home = {
        ...frame.state.home,
        requestsExpanded: !frame.state.home.requestsExpanded,
        ...(!sub ? { cursor: item, revealed: undefined } : {}),
      };
      if (objective) next.subpage = { ...sub!, cursor: item, revealed: undefined };
    }
    return result();
  };
  if (!sub && key === 'home-other-projects' && actions.some((row) => row.item === OTHER_PROJECTS)) return toggleOtherProjects();
  const act = (row: MonitorRow | undefined, fileOnly = false) => {
    if (!fileOnly && isRequestMoreItem(row?.item)) return toggleRequestsMore(row!.item!);
    if (objective && !fileOnly && row?.waitingTarget) {
      const { root, index, request } = row.waitingTarget;
      next.subpage = undefined;
      if (root) useProject(!frame.projects || root === frame.projects[0].root ? undefined : root);
      goTab('project');
      readWait(index, request);
      return result();
    }
    if (!sub && !fileOnly && row?.item === OTHER_PROJECTS) return toggleOtherProjects();
    if (!sub && !fileOnly && row?.advisorCopy) {
      select(row.item);
      return result({ type: 'copy-advisor', ...row.advisorCopy });
    }
    if (!sub && !fileOnly && row?.objectiveTarget) {
      select(row.item);
      openObjective(row.objectiveTarget);
      return result();
    }
    if (!sub && !fileOnly && row?.homeTarget) {
      const { root, index, request } = row.homeTarget;
      useProject(!frame.projects || root === frame.projects[0].root ? undefined : root);
      goTab('project');
      if (index === undefined) goProject();
      else if (request !== undefined) readWait(index, request);
      return result();
    }
    if (row?.files?.length) return result({ type: 'open-files', files: row.files });
    if (row?.commit) return result({ type: 'git-show', ...row.commit });
    const target = row?.item && boardFrame.targets.get(row.item);
    if (!fileOnly && target && target.kind === 'worker') {
      if (sub?.kind === 'jobs') next.jobs = { cursor: row.item, scroll: sub.scroll, revealed: sub.revealed };
      next.subpage = { kind: 'inspector', target, scroll: 0 };
    }
    return result();
  };
  if (input.type === 'mouse') {
    if (input.button !== 'left') return moveScroll(nav.scroll + (input.button === 'wheel-down' ? 3 : -3));
    const reqHit = frame.controls.find((c) =>
      (c.kind === 'request-pick' || c.kind === 'request-more') &&
      c.y === input.y && input.x >= c.x && input.x < c.x + c.width);
    if (reqHit?.item) {
      const row = reqRows.find((r) => r.item === reqHit.item);
      if (row) return act(row);
    }
    const row = monitorRowAt(pane, input.x, input.y);
    if (row?.item && !sub && row.item.startsWith('home:card:schedule:') && !row.homeTarget) return select(row.item);
    return row?.item ? objective && row.item !== cursor ? select(row.item) : act(row) : result();
  }
  if (enter || key === 'open-session') {
    const request = sub?.kind === 'inspector' ? boardFrame.snapshot.workers.find((w) => w.id === sub.target.workerId)?.work?.requestInfo : undefined;
    const preferred = sub?.kind === 'inspector' && (actions.find((row) => row.files?.[0].endsWith('/report.md'))
      ?? (request && actions.find((row) => row.files?.[0].endsWith(`/qa/${request.id}.md`)))
      ?? actions.find((row) => row.files?.[0].endsWith('/brief.md')) ?? actions.find((row) => row.files));
    return act(actions.find((row) => row.item === cursor) ?? (preferred || undefined), key === 'open-session');
  }
  const step = key === 'up' ? -1 : key === 'down' ? 1 : key === 'page-up' ? -Math.max(1, pane.height) : key === 'page-down' ? Math.max(1, pane.height) : 0;
  if (step || key === 'home' || key === 'end') {
    if ((sub?.kind === 'jobs' || ((!sub || objective) && (key === 'up' || key === 'down')) ||
      (objective && (key === 'home' || key === 'end'))) && actions.length) {
      const at = actions.findIndex((r) => r.item === cursor);
      return select(actions[key === 'home' ? 0 : key === 'end' ? actions.length - 1 : Math.max(0, Math.min(actions.length - 1, at + step))]?.item);
    }
    // Home can page past Waiting into the handoff; Inspector scrolls its evidence.
    return moveScroll(key === 'home' ? 0 : key === 'end' ? pane.contentLength : nav.scroll + step);
  }
  if ((objective || sub?.kind === 'inspector' || sub?.kind === 'native-inspector') && actions.length && (key === 'tab' || key === 'shift-tab')) {
    const at = actions.findIndex((r) => r.item === cursor);
    return select(actions[(at < 0 ? key === 'tab' ? 0 : actions.length - 1 : (at + (key === 'tab' ? 1 : -1) + actions.length) % actions.length)]?.item);
  }
  return null;
}

/** One frame grammar for Home and the kept passive pages. */
import type { ProjectItem } from '../collectors/project-board.js';
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { nativeInspectorRows, workInspectorRows } from './work-inspector.js';
import { homeRows, OTHER_PROJECTS, otherProjectsHint, unattendedRow } from './home-view.js';
import { scheduleBadge, scheduleView } from './home-cards.js';
import { objectiveDetailRows } from './objective-detail.js';
import { runDetailRows } from './execution-run-detail.js';
import { executionRows } from './execution-view.js';
import { workflowDetailRows } from './execution-workflow.js';
import { activeFilter, type RowNav } from './monitor-state.js';
import { isHudJob, jobTarget, jobsRows } from './work-jobs.js';
import { ACCEPT_ALL, projectRows, projectPageOf, projectCrumb, projectListOpen } from './project-view.js';
import { projectHeaderRows, projectLinks } from './inbox-project.js';
import { PROJECT_STRIP_MORE, projectStripRow } from './project-strip.js';
import { isRequestMoreItem, requestAreaRows, type ScopedRequest } from './request-area.js';
import { boardCursor, boardRow, section, kvRows, subTopRow, footRow, footerLayout, mark, type FooterHints } from './workboard-rows.js';
import { modelInput, pickOf } from './model-input.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText } from './monitor-text.js';
import { t } from './i18n.js';
import { batchKeys, batchPromptRows, inspectorKeys, stopPromptRows } from './job-actions.js';
import { filterHints, filterProject, filterRow, filterScope } from './filter.js';
import { controlShown, executionShown, resourcesShown, MAIN_TABS } from './main-tabs.js';
import { controlHeader, controlHints, controlRows, presetFooterControls, roleRows } from './control-page.js';
import { presetSheet } from './preset-input.js';
import { chainSheet } from './chain-input.js';
import { glyph } from './control-view.js';
import { paintModelPicker } from './model-picker-view.js';
import { addBackHints, harnessAddRows, harnessFooterControls, harnessHints, harnessRows } from './harness-page.js';
import { expHints, expRows } from './exp-view.js';
function helpRows(input: MonitorData, state: MonitorState, width: number) {
  const half = width >= 80 ? Math.floor((width - 4) / 2) : width;
  const mouse = input.mouse !== false;
  const everywhere = [
    ['← → Tab', mouse ? 'switch tab (a click too)' : 'switch tab'],
    ['Shift+Tab', 'previous tab'],
    ['h l', 'left / right (h outside Control)'],
    ['↑ ↓ j k', 'move; PgUp PgDn page'],
    ['Home End', 'first / last row (G = End)'],
    ['⏎', 'act on the row; the footer says what it does there'],
    ['o', 'open the row’s file in $EDITOR'],
    ['', 'In Inspector, Tab selects files and child jobs'],
    ['/', 'filter rows live'],
    ['Backspace', 'edit filter text'],
    ['Esc', 'back; clear a filter first; does nothing at a tab root'],
    [',', 'Settings'],
    ['?', 'this page'],
    ['w', 'write the review board (HTML)'],
    ['q', 'close panel (also Q, ^C, ^D)'],
    ...(mouse ? [['click', 'select; links open directly; wheel scrolls']] : []),
    ['s r', 'Settings: save / reset'],
  ];
  const home = [
    ['a', 'expand / fold other projects'],
    ['v', 'open Jobs; Enter opens Inspector for the selected job'],
    ['n', 'Jobs or Inspector: show this session’s native subagents'],
    ['g P H', 'Inspector: peek/focus, pin visible, or hide the job tab; headless output is shown here'],
    ['1-4 d', 'job: answer its open question'],
    ['X', 'job: stop (y confirms); Jobs batch: pause/resume/stop'],
    ['r', 'failed job: request a retry'],
  ];
  const project = [
    ['[ ]', 'previous / next project'],
    ['t', 'open Tickets'],
    ['b', 'open Working tree (with Git facts)'],
    ['d', 'open Docs'],
    ['⏎', 'Accept all: record all pending slices'],
  ];
  const execution = [
    ['[ ]', 'previous / next project'],
    ['g P H', 'Execution: peek/focus, pin visible, or hide the job’s tab; ⏎ opens it'],
    ['X', 'Execution batch: pause/resume/stop'],
  ];
  const control = [
    ['c C', 'role: next / previous preset'],
    ['p', 'role: choose a preset by name'],
    ['N I', 'role: new draft, copied or empty'],
    ['R D', 'role: rename / delete the preset'],
    ['i Del', 'place: add / remove; harness: add back / off'],
    ['K J', 'place: move up / down'],
    ['m', mouse ? 'role/place: picker in this pane; one click or Enter sets. In a draft, fill only; else save.'
      : 'role/place: picker in this pane; Enter sets. In a draft, fill only; else save.'],
    ['Esc', 'picker: clear filter, then close'],
    ['^R', 'picker: refresh model lists'],
    ['x', 'place: clear its exhausted mark'],
    ['s', 'draft: save and select it'],
    ['h', 'Roles / Harnesses / Resources'],
    ['Space', 'harness: on / off'],
    ['r', 'refresh the model lists'],
    ['', 'Saved to $HUD_HOME/roles; the next job uses it. Project role files are read-only here.'],
  ];
  const keys: MonitorRow[] = [];
  const add = (heading: string, bindings: string[][]) => {
    if (keys.length) keys.push(boardRow(''));
    const at = keys.length;
    keys.push(section(t(heading), half), ...bindings.flatMap(([key, label]) =>
      kvRows(key, t(label), half, key ? undefined : theme.board.muted, Math.max(7, visualLength(t(key))))));
    return at;
  };
  add('Everywhere', everywhere);
  add('Home', home);
  const projectStart = add('Project', project);
  const executionStart = add('Execution', execution);
  const controlStart = add('Control', control);
  const legend = (label: string, ...groups: string[][]) => groups.map((group, i) =>
    boardRow(`${theme.board.muted(fit(i ? '' : t(label).toLowerCase(), 7))} ${group.join('  ')}`));
  const entry = (symbol: string, label: string) => `${symbol} ${t(label).toLowerCase()}`;
  const { active, attention, muted, success } = theme.board;
  const marks = [
    section(t('Marks'), half),
    ...legend('Route', [entry(muted(mark('▂', '-')), 'light'), entry(muted(mark('▄', '=')), 'standard'), entry(muted(mark('▆', '#')), 'hard')],
      [entry(muted(mark('∅', 'h')), 'headless: no herdr tab')]),
    ...legend('Slices', [entry(active(mark('◐', '@')), 'working'), entry(attention(mark('◆', '!')), 'blocked'), entry(muted(mark('◇', 'o')), 'to try')],
      [entry(success(mark('✓', '+')), 'accepted'), entry(muted(mark('○', '-')), 'todo')]),
    ...legend('Answers', [entry(attention(mark('◆', '*')), 'differs from the default')], [entry(muted(mark('◇', 'o')), 'as proposed')]),
    ...legend('Places', [entry(glyph('active'), 'next'), entry(glyph('standby'), 'standby'), entry(glyph('exhausted'), 'exhausted')],
      [entry(glyph('off'), 'Off'), entry(glyph('missing'), 'not installed')]),
  ];
  const rows = width < 80 ? [...keys, boardRow(''), ...marks]
    : Array.from({ length: Math.max(keys.length, marks.length) }, (_, i) =>
        boardRow(fit(keys[i]?.text ?? '', half) + '    ' + fit(marks[i]?.text ?? '', width - half - 4)));
  const start = state.activeTab === 'project' ? projectStart : state.activeTab === 'execution' ? executionStart : state.activeTab === 'control' ? controlStart : undefined;
  return { rows: [boardRow(''), ...rows], anchor: start === undefined ? undefined : rows[start] };
}
export function renderWorkboardFrame(
  input: MonitorData,
  state: MonitorState,
  source: WorkboardSnapshot,
  now: number
): MonitorFrame {
  const width = Math.max(0, Math.floor(input.width)),
    height = Math.max(0, Math.floor(input.height));
  const frame: MonitorFrame = {
    state,
    lines: Array.from({ length: height }, () => fit('', width)),
    panes: [],
    controls: [],
    projectDisplayRoot: input.projectDisplayRoot,
    ...((input.projects?.length ?? 0) > 1 ? { projects: input.projects } : {}),
  };
  if (!width || !height) return frame;
  const help = state.help, subpage = !help ? state.subpage : undefined;
  const inspector = subpage?.kind === 'inspector' ? subpage : undefined;
  const jobs = subpage?.kind === 'jobs' ? subpage : undefined;
  const native = subpage?.kind === 'native-inspector' ? subpage : undefined;
  const objective = subpage?.kind === 'objective' ? subpage : undefined;
  const runDetail = subpage?.kind === 'run-detail' ? subpage : undefined;
  const sub = subpage || help;
  const project = !sub && state.activeTab === 'project';
  const execution = executionShown(state);
  const control = controlShown(state), resources = resourcesShown(state);
  const controlView = control && state.control.subTab !== 'resources' ? state.control[state.control.subTab] : undefined;
  const withControlNav = (nav: RowNav) => ({ ...state.control, [state.control.subTab]: { ...controlView!, nav } });
  const harnesses = control && state.control.subTab === 'harnesses';
  const roles = control && state.control.subTab === 'roles';
  let overlay = state.overlay;
  const addingHarness = harnesses && overlay?.kind === 'control-harness-add' ? overlay : undefined;
  if (roles) {
    frame.controlModels = input.project?.models;
    frame.controlNow = now;
    if (overlay?.kind === 'control-chain' && !overlay.draft && overlay.mode.kind === 'places') {
      const role = overlay.role.role;
      const latest = input.project?.roles.find((r) => r.role === role);
      if (latest && latest !== overlay.role) overlay = { ...overlay, role: latest };
    }
  }
  // The picker is for a place that can take a model: with it gone it closes, returning to its parent view.
  const picker = roles ? modelInput(overlay) : undefined;
  const pick = picker && pickOf(input.project, picker, overlay?.kind === 'control-chain' && overlay.draft ? undefined : state.control.modelPrevious);
  if (picker && !pick) {
    if (overlay?.kind === 'control-quick-model') overlay = undefined;
    else if (overlay?.kind === 'control-chain') overlay = { ...overlay,
      mode: overlay.mode.kind === 'sheet' ? { ...overlay.mode, input: undefined } : { kind: 'places' } };
  }
  const chain = roles && overlay?.kind === 'control-chain' ? overlay : undefined;
  const resourcePage = resources ? state.exp : undefined;
  const expEdit = resources && overlay?.kind === 'exp-edit' ? overlay : undefined;
  if (resources) frame.expData = input.expData;
  const home = !sub && !project && !execution && !control;
  const page = project ? projectPageOf(state) : undefined;
  const list = project && projectListOpen(state, input.projects);
  const hub = project && !page && !list;
  const links = hub ? projectLinks(input.project) : [];
  // The Project filter narrows the snapshot for Tickets.
  const filter = filterScope(state) ? activeFilter(state) : undefined, needle = filter?.query.toLowerCase() ?? '';
  let matches: number | undefined;
  if (needle && input.project && page === 'tickets') {
    const found = filterProject(input.project, needle);
    input = { ...input, project: found.data };
    matches = found.count;
  }
  const bar = filter ? filterRow(state, matches, width) : resourcePage?.notice ? boardRow(
    (resourcePage.notice === 'Saved' ? theme.board.success : theme.board.attention)(t(resourcePage.notice))
  ) : undefined;
  const controlTop = control && !pick ? controlHeader(input, state, width) : [];
  const strip = (input.projects?.length ?? 0) > 1 && ((project && !page && !list) || execution)
    ? projectStripRow(input.projects!, state.selectedProject, width) : undefined;
  const selectedRoot = state.selectedProject ?? input.projects?.[0]?.root ?? input.projectDisplayRoot ?? '';
  const projectWaitingList = (root: string): readonly ProjectItem[] => {
    if (input.project && input.projectDisplayRoot && input.projectDisplayRoot === root) return input.project.waiting;
    if (root) {
      const fromOverview = input.projects?.find((p) => p.root === root)?.overview?.waitingItems;
      if (fromOverview) return fromOverview;
      const fromPortfolio = input.homePortfolio?.projects.find((p) => p.root === root)?.snapshot?.waiting;
      if (fromPortfolio) return fromPortfolio;
    }
    if (input.project && (!input.projectDisplayRoot || !root)) return input.project.waiting;
    return [];
  };
  const showHomeRequests = home;
  const showProjectRequests = (project && !list && page !== 'waiting') || Boolean(objective);
  const requestsExpanded = showHomeRequests || (Boolean(objective) && state.activeTab === 'home')
    ? Boolean(state.home.requestsExpanded)
    : state.project.folded.has('waiting:more');
  const scopedRequests: ScopedRequest[] = showHomeRequests
    ? (input.homePortfolio
      ? input.homePortfolio.requests.map((r) => ({
          root: r.project.root, projectName: r.project.name, item: r.item, index: r.index, files: r.files,
        }))
      : (input.homeWaiting ?? []).map((item, index) => ({
          root: selectedRoot, projectName: input.projectName ?? '', item, index,
        })))
    : showProjectRequests
      ? (() => {
          const root = objective ? objective.target.root : selectedRoot;
          return projectWaitingList(root).map((item, index) => ({ root, projectName: '', item, index }));
        })()
      : [];
  const reqRows = scopedRequests.length
    ? requestAreaRows(scopedRequests, { showProject: showHomeRequests, width, now, expanded: requestsExpanded })
    : [];
  const unattendedLine = home && input.homePortfolio?.unattended
    ? unattendedRow(input.homePortfolio.unattended, width).text : undefined;
  const truncatedFiles = project && !list && [input.project?.stateTruncated && 'STATE.md', input.project?.specTruncated && 'spec.md'].filter(Boolean).join(', ');
  const projectTop = hub && input.project ? projectHeaderRows(input.project, width, now, input.projectName ?? '', !!strip) : [];
  const pinned = [...controlTop, ...projectTop];
  const headers = [...(unattendedLine ? [unattendedLine] : []), ...(strip ? [''] : []), ...reqRows.map(() => ''), ...pinned.map((r) => r.text), ...(bar ? [bar.text] : []),
    ...(inspector ? stopPromptRows(state, width).map((r) => r.text) : []),
    ...(jobs || execution ? batchPromptRows(state, width).map((r) => r.text) : []),
    ...(truncatedFiles ? [fit(theme.board.attention(t('Truncated: {files}', { files: truncatedFiles })), width)] : []),
    ...(control && input.error ? [theme.error(monitorText(input.error))] : [])];
  const top = Math.min(headers.length, Math.max(0, height - 2));
  const room = Math.max(0, height - 2 - top);
  const unattendedTop = unattendedLine && top > 0 ? 1 : 0;
  const stripTop = strip && top > unattendedTop ? 1 : 0;
  const reqStart = unattendedTop + stripTop;
  const reqVisible = Math.min(reqRows.length, Math.max(0, top - reqStart));
  const visibleReqRows = reqRows.slice(0, reqVisible);
  if (strip && stripTop) {
    for (const c of strip.controls) frame.controls.push({ ...c, y: 1 + unattendedTop });
  }
  pinned.slice(0, Math.max(0, top - reqStart - reqVisible)).forEach((row, i) => {
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: 1 + reqStart + reqVisible + i });
  });
  const target = inspector?.target;
  const lane = target && source.lanes.find((l) => l.id === target.laneId);
  const worker = target && lane?.workers.find((w) => w.id === target.workerId);
  const activeRun = runDetail ? input.execution?.runs?.find((r) => r.flow === runDetail.flow) : undefined;
  const crumb = help ? t('Help') : objective ? t('Objective') : runDetail ? `${t('Run')} · ${monitorText(activeRun ? `${activeRun.label} ${activeRun.flow.slice(0, 8)}` : runDetail.flow.slice(0, 8))}` : native ? t('Native subagents') : jobs ? t('Jobs')
    : t('Inspector') + (worker ? ` · ${monitorText(worker.displayId || worker.id.replace(/^thin-job:/, ''))}` : '');
  const schedule = scheduleView(input.openSchedule, now);
  if (sub || page || list) {
    // An open subpage or the Projects list has no tab row: clicking anywhere on its crumb row returns.
    const at = page && projectCrumb(page, input.project, width, (input.projects?.length ?? 0) > 1 ? input.projectName : '');
    frame.lines[0] = subTopRow(at?.crumb ?? (list ? t('Projects') : crumb), at?.right ?? '', width);
    frame.controls.push({ kind: help ? 'help' : 'board-back', x: 0, y: 0, width });
  } else {
    const overviewSum = input.projects?.some((p) => p.overview !== undefined)
      ? input.projects.reduce((sum, p) => sum + (p.overview?.waiting ?? 0), 0) : undefined;
    const homeCount = input.homeRequestCount
      ?? input.homePortfolio?.requests.length
      ?? input.homeWaiting?.length
      ?? overviewSum
      ?? (home ? input.project?.waiting.length ?? 0 : 0);
    const selectedOverview = selectedRoot ? input.projects?.find((p) => p.root === selectedRoot)?.overview?.waiting : undefined;
    const selectedPortfolio = selectedRoot ? input.homePortfolio?.projects.find((p) => p.root === selectedRoot)?.snapshot?.waiting.length : undefined;
    const projectMatchesSelected = !input.projectDisplayRoot || !selectedRoot || input.projectDisplayRoot === selectedRoot;
    const projectCount = input.projectWaiting
      ?? (projectMatchesSelected ? input.project?.waiting.length : undefined)
      ?? selectedOverview
      ?? selectedPortfolio
      ?? input.project?.waiting.length
      ?? 0;
    // A count is a `?` and its number, the mark of what waits for the owner everywhere else: a bare number beside a tab reads as its key.
    const badge = (n: number) => (n ? ' ' + theme.board.attention(`?${n}`) : '');
    const counts = { home: homeCount, project: projectCount, execution: 0, control: 0 };
    const liveJobs = input.executionCount ?? input.execution?.jobs.length ?? input.project?.active.length ?? 0;
    const liveBadge = (active: boolean) => (liveJobs > 0 ? `·${active ? String(liveJobs) : theme.board.active(String(liveJobs))}` : '');
    const tabs = MAIN_TABS, calendar = scheduleBadge(schedule);
    const labels = (requests: 'all' | 'active' | 'none', due: boolean, live: boolean) => tabs.map((tab) =>
      ` ${t(tab.label)}${live && tab.id === 'execution' ? liveBadge(state.activeTab === 'execution') : ''}${requests === 'all' || (requests === 'active' && tab.id === state.activeTab) ? badge(counts[tab.id]) : ''}${due && tab.id === 'home' ? calendar : ''} `);
    let titles = labels('all', true, true);
    if (visualLength(titles.join('')) > width) titles = labels('all', false, true);
    if (visualLength(titles.join('')) > width) titles = labels('active', true, true);
    if (visualLength(titles.join('')) > width) titles = labels('active', false, true);
    if (visualLength(titles.join('')) > width) titles = labels('none', true, true);
    if (visualLength(titles.join('')) > width) titles = labels('none', false, true);
    if (visualLength(titles.join('')) > width) titles = labels('none', false, false);
    frame.lines[0] = fit(titles.map((label, i) => (state.activeTab === tabs[i].id ? theme.board.title : theme.board.muted)(label)).join(''), width);
    let x = 0;
    for (const [i, label] of titles.entries()) {
      const span = visualLength(label);
      const clipped = Math.max(0, Math.min(width, x + span) - x);
      if (clipped > 0) frame.controls.push({ kind: `board-${tabs[i].id}`, x, y: 0, width: clipped });
      x += span;
    }
  }
  if (pick) return paintModelPicker(frame, input.project!, picker!, pick, width, height, now);
  if (roles && overlay?.kind === 'control-preset') {
    const captured = overlay.sheet.role;
    const latest = input.project?.roles.find((r) => r.role === captured.role && r.revision === captured.revision);
    if (latest && latest !== captured) overlay = { ...overlay, sheet: { ...overlay.sheet, role: latest } };
  }
  state = overlay === state.overlay ? state : { ...state, overlay };
  frame.state = state;
  const presetInput = roles && overlay?.kind === 'control-preset' ? overlay.sheet : undefined;
  const targets = new Map<string, WorkTarget>();
  if (jobs || inspector) for (const w of source.workers.filter(isHudJob)) {
    const job = jobTarget(w);
    targets.set(targetKey(job), job);
  }
  const anchor = chain && roleRows(chain.role, width, now);
  const sheetRoom = height - 3 - top - Number(!!input.publicationNotice) - (anchor ? anchor.length : 0);
  const sheet = chain && anchor && input.project ? chainSheet(chain, input.project.models, width, sheetRoom, now)
    : presetInput && presetSheet(presetInput, width, sheetRoom);
  const sheetRows = sheet ? [section(sheet.rule.label, width, sheet.rule.right), ...sheet.rows] : undefined;
  let chainTop = 0;
  if (anchor && sheetRows) {
    const list = controlRows(input.project, state.control.roles, width, now);
    const at = list.findIndex((r) => r.item === anchor[0]!.item);
    if (at < 0) sheetRows.unshift(...anchor);
    else {
      const after = list.findIndex((r, i) => i >= at + anchor.length && !r.controls?.some((c) => c.item === anchor[0]!.item));
      sheetRows.unshift(...list.slice(0, at), ...anchor);
      if (after >= 0) sheetRows.push(...list.slice(after));
      chainTop = at;
    }
  }
  const helpContent = help ? helpRows(input, state, width) : undefined;
  const harnessAdd = addingHarness && input.project ? harnessAddRows(input.project, addingHarness, width) : undefined;
  if (harnessAdd && addingHarness) state = { ...state, overlay: { ...addingHarness, pick: harnessAdd.pick } };
  let rows: MonitorRow[] = helpContent
    ? helpContent.rows
    : objective ? objectiveDetailRows(objective, width)
    : runDetail ? activeRun ? runDetailRows(activeRun, width, now, activeRun.kind === 'queue' ? undefined : workflowDetailRows(activeRun, width, now)) : [boardRow(fit(t('Run not available'), width))]
    : native ? nativeInspectorRows(input.tree, width, now)
      : inspector ? worker ? workInspectorRows(worker, width, now, source.workers.filter((w) => w.parentJobId === worker.id))
        : [boardRow(t('Job not available'))]
        : jobs ? jobsRows(source.workers, width, !!input.jobsObserved, source.batches)
        : project
          ? projectRows(input.project, state, width, now, input.projects, input.worktrees, input.projectActivity)
          : execution ? executionRows(input.execution, state.execution.cursor === PROJECT_STRIP_MORE && !strip?.hasMore ? undefined : state.execution.cursor, width, now)
          : resourcePage ? expRows(resourcePage, expEdit, input.expData, width, now, Math.max(0, height - 2 - top - Number(!!input.publicationNotice)))
          : control ? harnesses && input.project ? harnessAdd
              ? [section(t('Add back'), width), ...harnessAdd.rows] : harnessRows(input.project, state.control.harnesses, width)
            : sheetRows ?? controlRows(input.project, state.control.roles, width, now)
          : homeRows(input.homePortfolio, width, now, room - Number(!!input.error) - Number(!!input.publicationNotice),
              state.home.othersExpanded, input.homeToday, schedule, false);
  if (!control && input.error) rows.unshift(boardRow(theme.error(monitorText(input.error))));
  if (input.publicationNotice) rows.unshift(boardRow(theme.warning(monitorText(input.publicationNotice))));
  if (hub && rows.length > room) {
    let spare = room - rows.filter((row) => !row.objectiveSubtitle).length;
    rows = rows.filter((row) => !row.objectiveSubtitle || spare-- > 0);
  }
  const actions = rows.filter((r) => r.item);
  const reqItems = visibleReqRows.filter((r, i, all) => r.item && all.findIndex((o) => o.item === r.item) === i);
  const hasReq = (c?: string) => !!c && reqItems.some((r) => r.item === c);
  // Do not jump past the evidence when an Inspector first opens. Enter opens the preferred evidence file;
  // the details can still be scrolled without selecting a file first.
  const inspect = inspector ?? native ?? runDetail;
  const inspectCursor = inspect?.cursor && actions.some((r) => r.item === inspect.cursor) ? inspect.cursor : undefined;
  const listNav = jobs ?? objective ?? (home ? state.home : undefined);
  const listCursor = listNav && (
    hasReq(listNav.cursor) || actions.some((r) => r.item === listNav.cursor)
      ? listNav.cursor
      : home ? (reqItems[0]?.item ?? actions[0]?.item) : (actions[0]?.item ?? reqItems[0]?.item)
  );
  const nav = controlView?.nav ?? (project ? state.project.nav : execution ? state.execution : undefined);
  const stripMore = !!(strip && stripTop && strip.hasMore);
  const hasCursor = (cursor?: string) => (stripMore && cursor === PROJECT_STRIP_MORE) || hasReq(cursor) || rows.some((r) => r.item && r.item === cursor);
  // Home and Project hub start on the first request, else the first body item (ahead of the strip's +N);
  // Project sub-pages start on their first body item so Up reaches the last request row.
  const navDefault = hub
    ? (reqItems[0]?.item ?? rows.find((r) => r.objectiveTarget)?.item ?? rows.find((r) => r.item)?.item ?? (stripMore ? PROJECT_STRIP_MORE : undefined))
    : (rows.find((r) => r.item)?.item ?? reqItems[0]?.item ?? (stripMore ? PROJECT_STRIP_MORE : undefined));
  const cursor = nav && !hasCursor(nav.cursor) && (project || execution || (!addingHarness && !sheet && input.project))
    ? navDefault : nav?.cursor;
  const expCursor = resourcePage && !expEdit && !hasCursor(resourcePage.cursor) ? rows.find((r) => r.item)?.item : resourcePage?.cursor;
  const key = addingHarness ? harnessAdd?.pick : sheet ? sheet.cursor : nav ? cursor : inspect ? inspectCursor
    : resourcePage ? expEdit ? undefined : expCursor : listCursor;
  const helpStart = helpContent?.anchor ? rows.indexOf(helpContent.anchor) : 0;
  const cursorAt = rows.findIndex((r) => r.item === key), max = Math.max(helpStart, rows.length - room);
  const scroll = help
    ? (help.scroll ?? helpStart)
    : sheet ? chainTop + Number(!!input.publicationNotice && !!anchor)
    : addingHarness ? 0 : subpage?.scroll ?? nav?.scroll ?? resourcePage?.scroll ?? state.home.scroll;
  let offset = Math.max(0, Math.min(max, scroll));
  if (anchor && key && cursorAt >= offset + room) offset = Math.max(0, cursorAt - room + 1);
  let revealed = nav ? nav.revealed : inspect ? inspect.revealed : resourcePage ? resourcePage.revealed : listNav?.revealed;
  if (!help && !sheet && key && (addingHarness || revealed !== key) && room) {
    if (cursorAt < 0) {
      offset = 0;
      if (!addingHarness) revealed = key;
    } else {
      // An Execution card is several rows of one job: bring all of it into view, and the page's head with the first.
      const last = execution ? rows.map((r) => r.item).lastIndexOf(key) : cursorAt;
      if (execution && cursorAt === rows.findIndex((r) => r.item) && last < room) offset = 0;
      else if (cursorAt < offset) offset = cursorAt;
      else if (last >= offset + room) offset = Math.min(cursorAt, last - room + 1);
      if (!addingHarness) revealed = key;
    }
  }
  if (help) {
    state = { ...state, help: { scroll: offset } };
    frame.helpPage = { count: room, maxOffset: max };
  } else if (inspect) state = { ...state, subpage: { ...inspect, cursor: inspectCursor, scroll: offset, revealed } };
  else if (objective) state = { ...state, subpage: { ...objective, cursor: listCursor, scroll: offset, revealed } };
  else if (jobs) {
    const place = { cursor: listCursor, scroll: offset, revealed };
    state = { ...state, jobs: place, subpage: { kind: 'jobs', ...place } };
  }
  else if (nav && project) state = { ...state, project: { ...state.project, nav: { ...nav, cursor, scroll: offset, revealed } } };
  else if (nav && execution) state = { ...state, execution: { ...nav, cursor, scroll: offset, revealed } };
  else if (nav && !addingHarness && !sheet && input.project) state = { ...state, control: withControlNav({ ...nav, cursor, scroll: offset, revealed }) };
  else if (resourcePage) state = { ...state, exp: { ...resourcePage, cursor: expCursor, scroll: offset, revealed: expEdit ? undefined : revealed } };
  else if (home) state = { ...state, home: { ...state.home, cursor: listCursor, scroll: offset, revealed } };
  frame.state = state;
  if (strip && stripTop) headers[unattendedTop] = strip.paint(key === PROJECT_STRIP_MORE);
  for (let i = 0; i < reqVisible; i++) {
    const row = visibleReqRows[i]!;
    const text = fit(row.paint?.() ?? row.text, width);
    const marked = !help && !!key && row.item === key;
    headers[reqStart + i] = marked ? boardCursor(text) : text;
    if (row.item) {
      const kind = isRequestMoreItem(row.item) ? 'request-more' : 'request-pick';
      frame.controls.push({ kind, item: row.item, x: 0, y: 1 + reqStart + i, width });
    }
  }
  headers.slice(0, top).forEach((text, i) => { frame.lines[1 + i] = text; });
  for (let i = 0; i < room; i++) {
    const row = rows[offset + i];
    if (!row) continue;
    const text = fit(row.paint?.() ?? row.text, width);
    // The cursor marks every row of the selected Projects list entry.
    const marked = offset + i === cursorAt || ((list || control) && !!key && row.item === key);
    frame.lines[i + 1 + top] = !help && marked ? boardCursor(text) : text;
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: i + 1 + top });
  }
  const projectSwitch = frame.projects ? ['[ ] project'] : [];
  const selectedReq = visibleReqRows.find((r) => r.item === key);
  const selected = selectedReq ?? actions.find((r) => r.item === key);
  const reqFoldHint = requestsExpanded ? '⏎ fold' : '⏎ expand';
  const hints: FooterHints = help
    ? { modal: ['Esc back'] }
    : objective ? (selectedReq
        ? [isRequestMoreItem(selectedReq.item) ? reqFoldHint : '⏎ open', ...(!isRequestMoreItem(selectedReq.item) && selectedReq.files ? ['o file'] : []), 'Esc back']
        : [...(selected?.files ? ['o file'] : selected?.commit ? ['o commit'] : []), 'Esc back'])
    : runDetail ? ['Esc back']
    : inspector ? inspectorKeys(worker)
      : native ? ['Esc back'] : jobs ? [...(selected?.batch ? batchKeys(selected.batch) : listCursor ? ['⏎ details'] : []), 'n subagents', 'Esc back']
        : resourcePage ? expHints(resourcePage, expEdit)
        : control ? harnesses ? addingHarness ? addBackHints : harnessHints(input.project, state.control.harnesses)
            : sheet ? sheet.hints : controlHints(input.project, cursor)
        : execution ? [...(key === PROJECT_STRIP_MORE ? ['⏎ open'] : selected ? ['⏎ details'] : []),
             ...(selected?.batch ? batchKeys(selected.batch) : []), ...projectSwitch,
             ...(selected?.execJob?.tab ? ['g job tab', 'P pin tab', 'H hide tab'] : [])]
        : project ? (page === 'waiting' ? ['o file', 'Esc back']
          : cursor === ACCEPT_ALL ? ['⏎ accept all', 'Esc back']
          : selectedReq && page ? [isRequestMoreItem(selectedReq.item) ? reqFoldHint : '⏎ open', 'Esc back']
          : page === 'tickets' ? ['⏎ details', 'Esc back', 'o file']
          : page || list ? ['⏎ open', 'Esc back']
          : [...(isRequestMoreItem(selectedReq?.item) ? [reqFoldHint] : selected?.objectiveTarget ? ['⏎ details'] : cursor?.startsWith('project:fold:')
            ? [state.project.folded.has(cursor.slice(13)) ? '⏎ fold' : '⏎ expand'] : cursor ? ['⏎ open'] : []),
            ...links.map((link) => link.hint), ...projectSwitch])
        : [...(listCursor ? selected?.item === OTHER_PROJECTS
          ? [otherProjectsHint(state.home.othersExpanded), state.home.othersExpanded ? '⏎ fold' : '⏎ expand']
          : selectedReq ? [isRequestMoreItem(selectedReq.item) ? reqFoldHint : '⏎ open']
          : selected?.advisorCopy ? ['⏎ copy']
          : selected?.objectiveTarget ? ['⏎ details'] : selected?.homeTarget ? ['⏎ open'] : [] : []), 'v Jobs'];
  if (harnesses && height > 1) harnessFooterControls(frame, hints, width, height - 1);
  if (roles && height > 1) presetFooterControls(frame, hints, width, height - 1);
  if (height > 1) {
    const footer = filterHints(state, hints);
    frame.lines[height - 1] = footRow('', footer, width);
    for (const { key, x, width: span } of footerLayout(footer, width)) {
      const kind = key === 'v Jobs' ? 'board-jobs' : key === 'n subagents' ? 'board-native' : key === '? help' ? 'help' : undefined;
      if (kind) frame.controls.push({ kind, x, width: span, y: height - 1 });
    }
  }
  // The theme's own text colour under every row, so a row with no ink of its own is not the terminal's.
  frame.lines = frame.lines.map((line) => theme.board.text(fit(line, width)));
  frame.panes.push({
    id: inspector || native || objective || runDetail ? 'details' : 'agents',
    x: 0,
    y: 1 + top,
    width,
    height: room,
    offset,
    contentLength: rows.length,
    rows,
    edge: 0,
    visible: room,
  });
  frame.workboard = { snapshot: source, targets, rows, ...(links.length ? { projectLinks: links } : {}),
    ...(visibleReqRows.length ? { requests: visibleReqRows } : {}) };
  return frame;
}

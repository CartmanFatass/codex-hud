/** One frame grammar for Home and the kept passive pages. */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { boardInspectorRows } from './work-inspector.js';
import { homeRows } from './home-view.js';
import { skillsRows } from './skills-view.js';
import { projectRows, homeSpareRows, projectPageOf, projectCrumb, projectListOpen } from './project-view.js';
import { visibleWorkboard } from './work-visibility.js';
import { boardCursor, boardRow, section, kvRows, subTopRow, footRow, hintText, mark } from './workboard-rows.js';
import { changesRows } from './monitor-panes.js';
import { pickOf } from './model-input.js';
import { theme, visualLength, stripAnsi } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { homeScene } from './split-home.js';
import { projectScene } from './split-project.js';
import { paintSplit, splitScrolls } from './split-frame.js';
import { homeKeys, stopPromptRows } from './job-actions.js';
import { filterHints, filterNeedle, filterProject, filterRow, filterScope, homeMatcher } from './filter.js';
import { expShown, mainTabs } from './main-tabs.js';
import { expHints, expRows } from './exp-view.js';
export { footHints } from './workboard-rows.js';
function helpRows(input: MonitorData, width: number): MonitorRow[] {
  const half = width >= 80 ? Math.floor((width - 4) / 2) : width;
  const keys = [
    section(t('Keys'), half),
    ...[
      ['← → Tab', 'switch tab (a click too)'],
      ['f', 'Changes'],
      ['↑ ↓', 'move'],
      ...(input.state.panelLayout === 'split' ? [['PgUp Dn', 'scroll the preview (Split)'], ['= + -', 'Split: list bigger / smaller']] : []),
      ['/', 'filter rows live'],
      ['⏎', 'expand / collapse in place'],
      ['o', 'open the file in $EDITOR'],
      ['[ ]', 'switch project (Project)'],
      ['Space', 'mark a to-try row'],
      ['y n', 'accept / flag the marked to-try rows'],
      ['c C', 'role: next / previous preset'],
      ['p e', 'place: harness, thinking (capitals go back)'],
      ['m', 'place: pick a model (provider, then model; type to filter)'],
      ['i Del', 'place: add, remove'],
      ['K J', 'place: move up, move down'],
      ['x', 'place: clear its exhausted mark'],
      ['r', 'place: refresh model lists'],
      ['g', 'job: go to its herdr tab'],
      ['1-4 d', 'job: answer its open question'],
      ['X', 'job: stop it (y confirms)'],
      ['v', 'inspect: details and files'],
      ['a', 'show / hide older jobs and decisions (Home)'],
      ['> <', 'next / previous card that needs you (Home)'],
      ['b', 'models on / off'],
      ['w', 'export a review board (HTML) and open it'],
      [',', 'Settings'],
      ['?', 'this page'],
      ['Esc', 'back'],
    ].flatMap(([key, label]) => kvRows(key, t(label), half, undefined, 7)),
  ];
  const marks = [
    section(t('Marks'), half),
    boardRow(
      `${theme.board.success(mark('✓', '+'))} ${t('done')}      ${theme.board.active(mark('◉', '@'))} ${t('running')}   ${theme.board.attention('?')} ${t('asking you')}`
    ),
    boardRow(
      `${theme.board.danger(mark('✗', 'x'))} ${t('failed')}    ${theme.board.muted(mark('−', '-'))} ${t('stopped')}   ${theme.board.stalled(mark('◷', '~'))} ${t('stalled')}`
    ),
    boardRow(`${theme.board.attention(mark('◆', '*'))} ${t('answer differs from the default')}`),
    boardRow(`${theme.board.muted(mark('◇', 'o'))} ${t('answer as proposed')}`),
    boardRow(`${theme.board.active(mark('┃', '|'))} ${t('body of a card')}`),
    ...flowLines(t('dim rows are older ones, shown with a'), half).map((s) => boardRow(theme.board.muted(s))),
    ...flowLines(t('lavender words are marked by the model'), half).map((s) => boardRow(theme.board.identifier(s))),
  ];
  const rows =
    width < 80
      ? [...keys, boardRow(''), ...marks]
      : Array.from({ length: Math.max(keys.length, marks.length) }, (_, i) =>
          boardRow(fit(keys[i]?.text ?? '', half) + '    ' + fit(marks[i]?.text ?? '', width - half - 4))
        );
  const notes = [
    'In Project ⏎ opens a page, then a row or fold; o opens its file; Esc goes back',
    ...(input.state.panelLayout === 'split' ? ['Split: ⏎ opens the row’s preview, Esc comes back; click selects, again opens'] : []),
    'On the Control plane c/C applies the next/previous role preset; p m e i Del K J x change the place under the cursor (m picks a model, r refreshes model lists): written to $HUD_HOME/roles, used by the next job; a project role file in force is only opened',
    'In the Inspector ⏎ opens the file',
    ...(input.mouse !== false ? ['click selects · again expands · wheel scrolls'] : []),
  ];
  rows.push(boardRow(''), ...notes.flatMap((s) => flowLines(t(s), width).map((s) => boardRow(theme.board.muted(s)))));
  return [boardRow(''), ...rows, ...skillsRows(input.backupSkills, width)];
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
    ...((input.projects?.length ?? 0) > 1 ? { projects: input.projects } : {}),
  };
  if (!width || !height) return frame;
  const help = state.help,
    inspector = !help && state.focus === 'details',
    changes = !help && state.focus === 'changes';
  const sub = inspector || help || changes;
  const project = !sub && state.mainTab === 'project';
  const exp = expShown(state);
  const experiment = exp ? { ...state.expPage } : undefined;
  if (exp) frame.expData = input.expData;
  const home = !sub && !project && !exp;
  const page = project ? projectPageOf(state) : undefined;
  const list = project && projectListOpen(state, input.projects);
  // The `/` filter: Home's board keeps the cards that match; Progress and Tickets read a snapshot of the slices or tickets that do.
  const filtering = !!filterScope(state) && (!!state.filterOpen || !!state.filterQuery), needle = filtering ? filterNeedle(state) : '';
  let matches: number | undefined;
  if (needle && input.project && (page === 'progress' || page === 'tickets')) {
    const found = filterProject(input.project, page, needle);
    input = { ...input, project: found.data };
    matches = found.count;
  }
  const board = inspector ? source : visibleWorkboard(input, source, state, now, home && needle ? homeMatcher(source, needle, now, state.cardStallMinutes) : undefined);
  if (home && needle) matches = board.workers.length + board.decisions.length;
  const bar = filtering ? filterRow(state, matches, width) : experiment?.notice ? boardRow(
    (experiment.notice === 'Saved' ? theme.board.success : theme.board.attention)(t(experiment.notice))
  ) : undefined;
  const top = bar ? 1 : 0;
  const target = state.boardInspect;
  const lane = board.lanes.find((l) => l.id === target?.laneId);
  const decision = target?.kind === 'decision' ? lane?.decisions.find((d) => d.id === target.decisionId) : undefined;
  const worker =
    target?.kind === 'worker'
      ? lane?.workers.find((w) => w.id === target.workerId)
      : lane?.workers.find((w) => w.evidence.some((e) => e.sourceId === decision?.evidence[0]?.sourceId));
  const crumb = help
    ? t('Help')
    : changes
      ? t('Changes')
      : `${t('Home')} ${mark('›', '>')} ${monitorText(lane?.label ?? '')}${worker?.role ? ' · ' + monitorText(worker.role) : ''}${target?.kind === 'decision' ? ' ' + (lane?.decisions.find((d) => d.id === target.decisionId)?.evidence[0]?.relativePath.match(/q\d+/)?.[0] ?? '') : ''}`;
  if (sub || page || list) {
    // An open subpage or the Projects list has no tab row: clicking anywhere on its crumb row returns.
    const at = page && projectCrumb(page, input.project, width, now, (input.projects?.length ?? 0) > 1 ? input.projectName : '');
    frame.lines[0] = subTopRow(at?.crumb ?? (list ? t('Projects') : crumb), at?.right ?? '', width);
    frame.controls.push({ kind: help ? 'help' : 'board-back', x: 0, y: 0, width });
  } else {
    const count = source.workers.filter((w) => w.homeNeedsHuman).length;
    // A count is a `?` and its number, the mark of what waits for the owner everywhere else: a bare number beside a tab reads as its key.
    const badge = (n: number) => (n ? ' ' + theme.board.attention(`?${n}`) : '');
    const counts = { home: count, project: input.project?.waiting.length ?? 0 };
    const tabs = mainTabs(state);
    const labels = (badges: boolean, marker: boolean) => tabs.map((tab) =>
      ` ${t(tab.label)}${'experimental' in tab ? marker ? ` ${theme.board.muted(t('exp'))}` : ''
        : badges ? badge(counts[tab.id]) : ''} `);
    let titles = labels(true, true);
    let models = t(input.modelEnabled === false ? 'models off' : 'models on');
    const fits = (words: string[], right: string) => visualLength(words.join('')) + (right ? visualLength(right) + 1 : 0) <= width;
    if (state.experiments && !fits(titles, models)) {
      // EXP gets a whole hit target: drop badges, then its optional mark, then the models hint before cutting tabs.
      titles = labels(false, true);
      if (!fits(titles, models)) titles = labels(false, false);
      if (!fits(titles, models)) { models = ''; titles = labels(false, fits(labels(false, true), '')); }
    }
    const modelsWidth = visualLength(models);
    const leftRoom = Math.max(0, width - (modelsWidth ? modelsWidth + 1 : 0));
    frame.lines[0] = pair(titles.map((label, i) => (state.mainTab === tabs[i].id ? theme.board.title : theme.board.muted)(label)).join(''),
      (input.modelEnabled === false ? theme.board.attention : theme.board.muted)(models), width);
    let x = 0;
    for (const [i, label] of titles.entries()) {
      const span = visualLength(label);
      const clipped = Math.max(0, Math.min(leftRoom, x + span) - x);
      if (clipped > 0) frame.controls.push({ kind: `board-${tabs[i].id}`, x, y: 0, width: clipped });
      x += span;
    }
    if (models) frame.controls.push({ kind: 'brief', x: Math.max(0, width - modelsWidth), y: 0, width: Math.min(width, modelsWidth) });
  }
  // The picker is for a place that can take a model: with it gone (another page, another project) it closes.
  if (state.projectInput && !(project && page === 'control' && pickOf(input.project, state.projectInput))) state.projectInput = undefined;
  const targets = new Map<string, WorkTarget>();
  for (const lane of board.lanes) {
    const all: WorkTarget[] = [
      { kind: 'lane', laneId: lane.id },
      ...lane.workers.map((w) => ({ kind: 'worker' as const, laneId: lane.id, workerId: w.id })),
      ...lane.decisions.map((d) => ({ kind: 'decision' as const, laneId: lane.id, decisionId: d.id })),
    ];
    for (const target of all) targets.set(targetKey(target), target);
  }
  const doneToday = () => {
    const today = new Date(now).toDateString();
    return source.workers.filter(
      (w) =>
        ['done', 'completed', 'closed', 'idle_grace'].includes(w.state) &&
        w.settledAt !== null &&
        new Date(w.settledAt).toDateString() === today
    ).length;
  };
  // The Split layout draws Home, the hub and the pages that are lists in its own frame (split-*.ts); the rest is Classic's.
  if (state.panelLayout === 'split' && !sub && !list && !exp) {
    const build = (w: number) => home ? homeScene(input, board, state, targets, w, now, doneToday())
      : project && !(page === 'control' && state.projectInput) ? projectScene(input, state, board, page, w, now) : undefined;
    const notes = [...(bar ? [bar.text] : []), ...stopPromptRows(state, width).map((r) => r.text), input.publicationNotice && theme.warning(monitorText(input.publicationNotice)), input.error && theme.error(monitorText(input.error))].filter((x): x is string => !!x);
    let scene = build(width);
    // A preview that scrolls keeps its last cell for the scrollbar: its rows are laid out one cell narrower, so none is cut.
    if (scene && splitScrolls(scene, state, height, notes.length)) scene = { ...scene, preview: build(width - 1)?.preview ?? scene.preview };
    if (scene) return paintSplit(frame, scene, board, targets, state.homeTarget, width, height, notes);
  }
  const rows = help
    ? helpRows(input, width)
    : changes
      ? [boardRow(''), ...changesRows(input, state, width, now)]
      : inspector
        ? boardInspectorRows(lane, state.boardInspect, state, width, now)
        : project
          ? projectRows(input.project, state, width, now, source, input.modelEnabled, input.projectName, input.projects,
              Math.max(0, height - 2 - top - (input.error ? 1 : 0) - (input.publicationNotice ? 1 : 0)), input.tryMarks)
          : experiment ? expRows(experiment, input.expData, width, now) : homeRows(board, state, width, now, input);
  if (input.error) rows.unshift(boardRow(theme.error(monitorText(input.error))));
  if (input.publicationNotice) rows.unshift(boardRow(theme.warning(monitorText(input.publicationNotice))));
  // A stop waiting for its answer is the top row of Home and the Inspector, where the job under the cursor is.
  if (home || inspector) rows.unshift(...stopPromptRows(state, width));
  if (home) {
    // The waiting items and the newest landed slices sit under the cards, progress at the bottom (owner): the work above keeps the room next to it.
    const spare = height - 2 - top - rows.length;
    if (!needle) rows.push(...homeSpareRows(input.project, width, spare, now, !!rows.at(-1) && !!stripAnsi(rows.at(-1)!.text).trim()));
  }
  if (state.boardAnchor?.startsWith('home-progress:') && !rows.some((r) => r.item === state.boardAnchor))
    state.boardAnchor = undefined;
  let selected = state.homeTarget;
  if (home && (!selected || !rows.some((r) => r.item === targetKey(selected!)))) {
    const order = source.lanes.flatMap((l) => [
      { kind: 'lane' as const, laneId: l.id },
      ...l.workers.map((w) => ({ kind: 'worker' as const, laneId: l.id, workerId: w.id })),
      ...l.decisions.map((d) => ({ kind: 'decision' as const, laneId: l.id, decisionId: d.id })),
    ]);
    const at = order.findIndex((t) => selected && targetKey(t) === targetKey(selected));
    selected = order
      .map((target, i) => ({ target, distance: Math.abs(i - at) }))
      .filter(({ target }) => rows.some((r) => r.item === targetKey(target)))
      .sort((a, b) => a.distance - b.distance)[0]?.target;
    state.homeTarget = selected;
  }
  if (home && !selected && !state.boardAnchor)
    state.boardAnchor = rows.find((r) => r.item?.startsWith('home-progress:'))?.item;
  const files = rows.filter((r) => r.files?.length);
  if (inspector && !files.some((r) => r.item === state.inspectCursor))
    state.inspectCursor =
      files.find((r) => r.files?.[0].endsWith(worker?.work?.requestInfo?.evidence?.relativePath ?? '/report.md'))
        ?.item ?? files[0]?.item;
  // A new hub or page starts on its first destination (Inbox hub: first Needs-you row; else a page row, not the Waiting fold).
  if (project && (!state.projectCursor || !rows.some((r) => r.item === state.projectCursor)))
    state.projectCursor = (!page && !list && state.projectLayout === 'inbox'
      ? rows.find((r) => r.item && r.item !== 'project:switch') || rows.find((r) => r.item)
      : rows.find((r) => r.item?.startsWith('project:page:')) || rows.find((r) => r.item))?.item;
  // The model picker is the page while it is open: its picked entry is the cursor, and the page's own scroll and reveal wait.
  const picking = project && page === 'control' && !!state.projectInput;
  if (experiment && !experiment.edit && !rows.some((r) => r.item && r.item === experiment.cursor))
    experiment.cursor = rows.find((r) => r.item)?.item;
  if (experiment?.edit) state.boardRevealed = undefined;
  const key = picking ? 'project:pick' : project ? state.projectCursor : inspector ? state.inspectCursor
    : experiment ? experiment.edit ? undefined : experiment.cursor : state.boardAnchor ?? (selected ? targetKey(selected) : '');
  let room = Math.max(0, height - 2 - top);
  let preview: MonitorRow[] = [];
  if (project && page === 'control' && !picking) {
    const start = rows.findIndex((r) => r.placePreview);
    if (start >= 0) {
      const count = rows.filter((r) => r.placePreview).length;
      // Under the role list when it fits; on a shorter frame keep it below the scrollable rows.
      // If even the preview would fill the terminal, leave it in the ordinary scrolling content.
      if (start + count > room && count < room) {
        preview = rows.splice(start, count);
        room -= count;
      }
    }
  }
  const cursorAt = rows.findIndex((r) => r.item === key), max = Math.max(0, rows.length - room);
  const scroll = help
    ? (state.helpScroll ?? 0)
    : picking ? 0
    : sub
      ? state.scroll[changes ? 'changes' : 'details']
      : project ? (state.projectScroll ?? 0) : experiment ? (experiment.scroll ?? 0) : (state.homeScroll ?? 0);
  let offset = Math.max(0, Math.min(max, scroll));
  if (!help && !changes && !picking && key && state.boardRevealed !== key && room) {
    if (cursorAt < offset) offset = cursorAt;
    else if (cursorAt >= offset + room) offset = cursorAt - room + 1;
    state.boardRevealed = key;
  }
  if (help) {
    state.helpScroll = offset;
    frame.helpPage = { count: room, total: rows.length };
  } else if (sub) state.scroll[changes ? 'changes' : 'details'] = offset;
  else if (project) { if (!picking) state.projectScroll = offset; }
  else if (experiment) state.expPage = { ...experiment, scroll: offset };
  else state.homeScroll = offset;
  if (bar) frame.lines[1] = bar.text;
  for (let i = 0; i < room; i++) {
    const row = rows[offset + i];
    if (!row) continue;
    const text = fit(row.paint?.() ?? row.text, width);
    // A Projects list entry is two rows and the cursor marks both.
    const marked = offset + i === cursorAt || (list && !!key && row.item === key);
    frame.lines[i + 1 + top] = !help && !changes && marked ? boardCursor(text) : text;
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: i + 1 + top });
  }
  preview.forEach((row, i) => { frame.lines[room + 1 + top + i] = row.text; });
  const done = doneToday();
  const hints = help
    ? '↑↓ scroll  esc back'
    : inspector
      ? '↑↓ move  ⏎ open  esc back'
      : changes
        ? '↑↓ scroll  esc back'
        : project ? (state.projectInput ? 'type filter  ↑↓ pick  ⏎ set  esc cancel  tab all  ← back'
          : page === 'control' && state.projectCursor?.startsWith('project:role:') ? '↑↓ move  ⏎ open  c C preset  ? help  p harness  m model  e thinking  i add  Del remove  x clear  r refresh'
          : page === 'control' && state.projectCursor?.startsWith('project:fold:role:') ? '↑↓ move  ⏎ places  c C preset  o open file  esc back  ? help  r refresh'
          : page === 'control' ? '↑↓ move  ⏎ open  esc back  ? help  r refresh'
          : page === 'waiting' ? '↑↓ scroll  o open  esc back  ? help'
          : page === 'progress' ? (state.projectTry ? 'Space mark  y accept  n flag  t all  ↑↓ move  esc back  ⏎ open  ? help'
            : (state.projectLayout === 'board' || state.projectLayout === 'inbox') && rows.some((r) => r.item === state.projectCursor && r.tryTarget) ? 'Space mark  y accept  n flag  ⏎ details  o open file  t to try  esc back  ? help'
            : '↑↓ move  ⏎ open  t to try  esc back  ? help')
          : page || list ? '↑↓ move  ⏎ open  esc back  ? help'
          : state.projectLayout === 'inbox' && rows.some((r) => r.item === state.projectCursor && r.tryTarget)
            ? (frame.projects ? 'Space mark  y accept  n flag  ⏎ details  o open file  ←→ tab  [ ] project  ? help' : 'Space mark  y accept  n flag  ⏎ details  o open file  ←→ tab  ? help')
          : frame.projects ? '↑↓ move  ⏎ open  ←→ tab  [ ] project  ? help' : '↑↓ move  ⏎ open  ←→ tab  ? help')
        : experiment ? expHints(experiment, input.expData) : homeKeys(state, source, 'expand');
  if (height > 1)
    frame.lines[height - 1] = footRow(
      !home || !done ? '' : theme.board.success(`${mark('✓', '+')} ${t('{n} done today', { n: done })}`),
      filterHints(state, hintText(hints)),
      width
    );
  // The theme's own text colour under every row, so a row with no ink of its own is not the terminal's.
  frame.lines = frame.lines.map((line) => theme.board.text(fit(line, width)));
  frame.panes.push({
    id: inspector ? 'details' : changes ? 'changes' : 'agents',
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
  frame.workboard = { snapshot: board, targets, selected, rows };
  return frame;
}

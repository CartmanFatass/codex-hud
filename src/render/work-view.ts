/** One frame grammar for Home and the kept passive pages. */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { boardInspectorRows } from './work-inspector.js';
import { homeRows } from './home-view.js';
import { skillsRows } from './skills-view.js';
import { projectRows, homeSpareRows, projectPageOf, projectCrumb, projectListOpen } from './project-view.js';
import { visibleWorkboard } from './work-visibility.js';
import { boardCursor, boardRow, section, kvRows, subTopRow, footRow, homeDoneCount, mark, type FooterHints } from './workboard-rows.js';
import { changesRows } from './monitor-panes.js';
import { modelInput, pickOf } from './model-input.js';
import { theme, visualLength, stripAnsi } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { homeScene } from './split-home.js';
import { projectScene, TRY_ACTIONS } from './split-project.js';
import { paintSplit, splitScrolls } from './split-frame.js';
import { homeKeys, stopPromptRows } from './job-actions.js';
import { filterHints, filterNeedle, filterProject, filterRow, filterScope, homeMatcher } from './filter.js';
import { controlShown, expShown, mainTabs } from './main-tabs.js';
import { controlNavigation, storeControlNavigation } from './control-navigation.js';
import { controlHeader, controlHints, controlRows, controlScene, presetFooterControls, roleRows } from './control-page.js';
import { presetSheet } from './preset-input.js';
import { chainSheet } from './chain-input.js';
import { glyph } from './control-view.js';
import { paintModelPicker } from './model-picker-view.js';
import { addBackHints, harnessAddRows, harnessFooterControls, harnessHints, harnessRows, harnessScene } from './harness-page.js';
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
    ['/', 'filter rows live'],
    ['Backspace', 'edit filter text'],
    ['Esc', 'back; clear a filter first; does nothing at a tab root'],
    [',', 'Settings'],
    ['?', 'this page'],
    ['b', 'model text on / off'],
    ['w', 'write the review board (HTML)'],
    ['f', 'Changes'],
    ['q', 'close panel (also Q, ^C, ^D)'],
    ...(mouse ? [['click', 'select; again = ⏎; wheel scrolls']] : []),
    ['s r t', 'Settings: save / reset / test'],
  ];
  const home = [
    ['g', 'job: go to its herdr tab'],
    ['1-4 d', 'job: answer its open question'],
    ['X', 'job: stop it (y confirms)'],
    ['v', 'inspect: details and files'],
    ['a', 'show / hide older cards'],
    ['> <', 'next / previous card that needs you'],
  ];
  const project = [
    ['[ ]', 'previous / next project'],
    ['Space', 'mark a to-try row'],
    ['y n', 'accept / flag the marked rows, or the current one'],
    ['t', 'Progress: only what is to try'],
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
    ['h', 'Roles / Harnesses'],
    ['Space', 'harness: on / off'],
    ['r', 'refresh the model lists'],
    ['', 'Saved to $HUD_HOME/roles; the next job uses it. Project role files are read-only here.'],
  ];
  const split = [
    ['⏎ Esc', 'into the preview / back'],
    ['PgUp Dn', 'scroll the preview'],
    ['= + -', 'list bigger / smaller'],
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
  const controlStart = add('Control', control);
  if (state.panelLayout === 'split') add('Split', split);

  const legend = (label: string, ...groups: string[][]) => groups.map((group, i) =>
    boardRow(`${theme.board.muted(fit(i ? '' : t(label).toLowerCase(), 7))} ${group.join('  ')}`));
  const entry = (symbol: string, label: string) => `${symbol} ${t(label).toLowerCase()}`;
  const { active, attention, danger, muted, stalled, success } = theme.board;
  const marks = [
    section(t('Marks'), half),
    ...legend('Jobs', [entry(active(mark('◉', '@')), 'running'), entry(attention('?'), 'asking'), entry(stalled(mark('◷', '~')), 'stalled')],
      [entry(success(mark('✓', '+')), 'done'), entry(danger(mark('✗', 'x')), 'failed'), entry(muted(mark('−', '-')), 'stopped')]),
    ...legend('Slices', [entry(active(mark('◐', '@')), 'working'), entry(attention(mark('◆', '!')), 'blocked'), entry(muted(mark('◇', 'o')), 'to try')],
      [entry(success(mark('✓', '+')), 'accepted'), entry(muted(mark('○', '-')), 'todo')]),
    ...legend('Answers', [entry(attention(mark('◆', '*')), 'differs from the default')], [entry(muted(mark('◇', 'o')), 'as proposed')]),
    ...legend('Places', [entry(glyph('active'), 'next'), entry(glyph('standby'), 'standby'), entry(glyph('exhausted'), 'exhausted')],
      [entry(glyph('off'), 'Off'), entry(glyph('missing'), 'not installed')]),
    ...kvRows('dim', t('older rows; a shows them'), half, muted, 7),
    ...flowLines(t('lavender words are marked by the model'), half).map((s) => boardRow(theme.board.identifier(s))),
  ];
  const rows = width < 80 ? [...keys, boardRow(''), ...marks]
    : Array.from({ length: Math.max(keys.length, marks.length) }, (_, i) =>
        boardRow(fit(keys[i]?.text ?? '', half) + '    ' + fit(marks[i]?.text ?? '', width - half - 4)));
  const start = state.mainTab === 'project' ? projectStart : state.mainTab === 'control' ? controlStart : undefined;
  return { rows: [boardRow(''), ...rows, ...skillsRows(input.backupSkills, width)], anchor: start === undefined ? undefined : rows[start] };
}
export function renderWorkboardFrame(
  input: MonitorData,
  state: MonitorState,
  source: WorkboardSnapshot,
  now: number
): MonitorFrame {
  if (!controlShown(state)) return renderFrame(input, state, source, now);
  const frame = renderFrame(input, controlNavigation(state), source, now);
  frame.state = storeControlNavigation(state, frame.state);
  return frame;
}

function renderFrame(input: MonitorData, state: MonitorState, source: WorkboardSnapshot, now: number): MonitorFrame {
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
  const help = state.help,
    inspector = !help && state.focus === 'details',
    changes = !help && state.focus === 'changes';
  const sub = inspector || help || changes;
  const project = !sub && state.mainTab === 'project';
  const control = controlShown(state), exp = expShown(state);
  const harnesses = control && state.controlHarnesses, addingHarness = harnesses && state.overlay?.kind === 'control-harness-add';
  const roles = control && !harnesses;
  const overlay = state.overlay;
  if (roles) {
    frame.controlModels = input.project?.models;
    frame.controlNow = now;
    if (overlay?.kind === 'control-chain' && !overlay.draft && overlay.mode.kind === 'places') {
      const latest = input.project?.roles.find((r) => r.role === overlay.role.role);
      if (latest && latest !== overlay.role) state.overlay = { ...overlay, role: latest };
    }
  }
  // The picker is for a place that can take a model: with it gone it closes, returning to its parent view.
  const picker = roles ? modelInput(overlay) : undefined;
  const pick = picker && pickOf(input.project, picker, overlay?.kind === 'control-chain' && overlay.draft ? undefined : state.modelPrevious);
  if (picker && !pick) {
    if (overlay?.kind === 'control-quick-model') state.overlay = undefined;
    else if (overlay?.kind === 'control-chain') state.overlay = { ...overlay,
      mode: overlay.mode.kind === 'sheet' ? { ...overlay.mode, input: undefined } : { kind: 'places' } };
  }
  const chain = roles && state.overlay?.kind === 'control-chain' ? state.overlay : undefined;
  const experiment = exp ? { ...state.expPage } : undefined;
  const expEdit = exp && overlay?.kind === 'exp-edit' ? overlay : undefined;
  if (exp) frame.expData = input.expData;
  const home = !sub && !project && !control && !exp;
  const page = project ? projectPageOf(state) : undefined;
  const list = project && projectListOpen(state, input.projects);
  // The `/` filter: Home's board keeps the cards that match; Progress and Tickets read a snapshot of the slices or tickets that do.
  const filtering = !!filterScope(state) && (!!state.filterOpen || !!state.filterQuery), needle = filtering ? filterNeedle(state) : '';
  let matches: number | undefined;
  if (needle && input.project && (page === 'progress' || page === 'tickets')) {
    const found = filterProject(input.project, page, needle, state.acceptance, !!state.projectTry);
    input = { ...input, project: found.data };
    matches = found.count;
  }
  const board = inspector || pick ? source : visibleWorkboard(input, source, state, now, home && needle ? homeMatcher(source, needle, now, state.cardStallMinutes) : undefined);
  if (home && needle) matches = board.workers.length;
  const bar = filtering ? filterRow(state, matches, width) : experiment?.notice ? boardRow(
    (experiment.notice === 'Saved' ? theme.board.success : theme.board.attention)(t(experiment.notice))
  ) : undefined;
  const controlTop = control && !pick ? controlHeader(input, state, width) : [];
  const truncatedFiles = project && !list && [input.project?.stateTruncated && 'STATE.md', input.project?.specTruncated && 'spec.md'].filter(Boolean).join(', ');
  const headers = [...controlTop.map((r) => r.text), ...(bar ? [bar.text] : []),
    ...(truncatedFiles ? [fit(theme.board.attention(t('Truncated: {files}', { files: truncatedFiles })), width)] : []),
    ...(control && input.error ? [theme.error(monitorText(input.error))] : [])];
  const top = Math.min(headers.length, Math.max(0, height - 2));
  controlTop.slice(0, top).forEach((row, i) => {
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: 1 + i });
  });
  const target = state.boardInspect;
  const lane = board.lanes.find((l) => l.id === target?.laneId);
  const worker = target?.kind === 'worker' ? lane?.workers.find((w) => w.id === target.workerId) : undefined;
  const crumb = help
    ? t('Help')
    : changes
      ? t('Changes')
      : `${t('Home')} ${mark('›', '>')} ${monitorText(lane?.label ?? '')}${worker?.role ? ' · ' + monitorText(worker.role) : ''}`;
  if (sub || page || list) {
    // An open subpage or the Projects list has no tab row: clicking anywhere on its crumb row returns.
    const at = page && projectCrumb(page, input.project, width, now, (input.projects?.length ?? 0) > 1 ? input.projectName : '', state.acceptance);
    frame.lines[0] = subTopRow(at?.crumb ?? (list ? t('Projects') : crumb), at?.right ?? '', width);
    frame.controls.push({ kind: help ? 'help' : 'board-back', x: 0, y: 0, width });
  } else {
    const count = source.workers.filter((w) => w.homeNeedsHuman).length;
    // A count is a `?` and its number, the mark of what waits for the owner everywhere else: a bare number beside a tab reads as its key.
    const badge = (n: number) => (n ? ' ' + theme.board.attention(`?${n}`) : '');
    const counts = { home: count, project: input.projectWaiting ?? input.project?.waiting.length ?? 0, control: 0, exp: 0 };
    const tabs = mainTabs(state);
    const labels = (badges: boolean) => tabs.map((tab) => ` ${t(tab.label)}${badges ? badge(counts[tab.id]) : ''} `);
    let titles = labels(true);
    let models = input.modelEnabled === false ? t('models off') : '';
    // Drop the model hint before tab badges; keep whole tab labels and hit targets.
    if (visualLength(titles.join('')) + (models ? visualLength(models) + 1 : 0) > width) models = '';
    if (visualLength(titles.join('')) > width) titles = labels(false);
    const modelsWidth = visualLength(models);
    const leftRoom = Math.max(0, width - (modelsWidth ? modelsWidth + 1 : 0));
    frame.lines[0] = pair(titles.map((label, i) => (state.mainTab === tabs[i].id ? theme.board.title : theme.board.muted)(label)).join(''),
      models && theme.board.attention(models), width);
    let x = 0;
    for (const [i, label] of titles.entries()) {
      const span = visualLength(label);
      const clipped = Math.max(0, Math.min(leftRoom, x + span) - x);
      if (clipped > 0) frame.controls.push({ kind: `board-${tabs[i].id}`, x, y: 0, width: clipped });
      x += span;
    }
    if (models) frame.controls.push({ kind: 'brief', x: Math.max(0, width - modelsWidth), y: 0, width: Math.min(width, modelsWidth) });
  }
  if (pick) return paintModelPicker(frame, input.project!, picker!, pick, width, height, now);
  if (roles && overlay?.kind === 'control-preset') {
    const captured = overlay.sheet.role;
    const latest = input.project?.roles.find((r) => r.role === captured.role && r.revision === captured.revision);
    if (latest && latest !== captured) state.overlay = { ...overlay, sheet: { ...overlay.sheet, role: latest } };
  }
  const presetInput = roles && state.overlay?.kind === 'control-preset' ? state.overlay.sheet : undefined;
  const targets = new Map<string, WorkTarget>();
  for (const lane of board.lanes) {
    const all: WorkTarget[] = [
      { kind: 'lane', laneId: lane.id },
      ...lane.workers.map((w) => ({ kind: 'worker' as const, laneId: lane.id, workerId: w.id })),
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
      : project ? projectScene(input, state, board, page, w, now) : undefined;
    const notes = [...headers, ...stopPromptRows(state, width).map((r) => r.text), input.publicationNotice && theme.warning(monitorText(input.publicationNotice)), !control && input.error && theme.error(monitorText(input.error))].filter((x): x is string => !!x);
    const controlSplit = control && input.project;
    const sceneFor = (w: number) => controlSplit ? harnesses ? harnessScene(controlSplit, state, width, w)
      : controlScene(controlSplit, state, width, now, w, height, notes.length) : build(w);
    let scene = sceneFor(width);
    // A preview that scrolls keeps its last cell for the scrollbar: its rows are laid out one cell narrower, so none is cut.
    if (scene && splitScrolls(scene, state, height, notes.length)) scene = { ...scene,
      preview: sceneFor(width - 1)?.preview ?? scene.preview };
    if (scene) {
      if (harnesses && height > 1) harnessFooterControls(frame, scene.hints, width, height - 1);
      if (control && !harnesses && height > 1) presetFooterControls(frame, scene.hints, width, height - 1);
      return paintSplit(frame, scene, board, targets, state.homeTarget, width, height, notes);
    }
  }
  const anchor = chain && roleRows(chain.role, width, now);
  const sheetRoom = height - 3 - top - Number(!!input.publicationNotice) - (anchor ? anchor.length : 0);
  const sheet = chain && anchor && input.project ? chainSheet(chain, input.project.models, width, sheetRoom, now)
    : presetInput && presetSheet(presetInput, width, sheetRoom);
  const sheetRows = sheet ? [section(sheet.rule.label, width, sheet.rule.right), ...sheet.rows] : undefined;
  let chainTop = 0;
  if (anchor && sheetRows) {
    const list = controlRows(input.project, state, width, now);
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
  const rows: MonitorRow[] = helpContent
    ? helpContent.rows
    : changes
      ? [boardRow(''), ...changesRows(input, state, width, now)]
      : inspector
        ? boardInspectorRows(lane, state.boardInspect, state, width, now)
        : project
          ? projectRows(input.project, state, width, now, source, input.modelEnabled, input.projectName, input.projects,
              Math.max(0, height - 2 - top - (input.error ? 1 : 0) - (input.publicationNotice ? 1 : 0)), input.tryMarks)
          : control ? harnesses && input.project ? addingHarness
              ? [section(t('Add back'), width), ...harnessAddRows(input.project, state, width)] : harnessRows(input.project, state, width)
            : sheetRows ?? controlRows(input.project, state, width, now)
          : experiment ? expRows(experiment, expEdit, input.expData, width, now, Math.max(0, height - 2 - top - Number(!!input.error) - Number(!!input.publicationNotice))) : homeRows(board, state, width, now, input);
  if (!control && input.error) rows.unshift(boardRow(theme.error(monitorText(input.error))));
  if (input.publicationNotice) rows.unshift(boardRow(theme.warning(monitorText(input.publicationNotice))));
  // A stop waiting for its answer is the top row of Home and the Inspector, where the job under the cursor is.
  if (home || inspector) rows.unshift(...stopPromptRows(state, width));
  if (home) {
    // The waiting items and the newest landed slices sit under the cards, progress at the bottom (owner): the work above keeps the room next to it.
    const spare = height - 2 - top - rows.length;
    if (!needle) rows.push(...homeSpareRows(input.project, width, spare, now, !!rows.at(-1) && !!stripAnsi(rows.at(-1)!.text).trim(), state, input.tryMarks));
  }
  if (home && state.boardAnchor && /^(home-progress:|project:fold:task:)/.test(state.boardAnchor) && !rows.some((r) => r.item === state.boardAnchor))
    state.boardAnchor = undefined;
  let selected = state.homeTarget;
  if (home && (!selected || !rows.some((r) => r.item === targetKey(selected!)))) {
    const order = source.lanes.flatMap((l) => [
      { kind: 'lane' as const, laneId: l.id },
      ...l.workers.map((w) => ({ kind: 'worker' as const, laneId: l.id, workerId: w.id })),
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
  if (control && !addingHarness && !sheet && input.project && !rows.some((r) => r.item && r.item === state.projectCursor))
    state.projectCursor = rows.find((r) => r.item)?.item;
  if (experiment && !expEdit && !rows.some((r) => r.item && r.item === experiment.cursor))
    experiment.cursor = rows.find((r) => r.item)?.item;
  if (expEdit) state.boardRevealed = undefined;
  const key = addingHarness && state.overlay?.kind === 'control-harness-add' ? state.overlay.pick
    : sheet ? sheet.cursor : project || control ? state.projectCursor : inspector ? state.inspectCursor
    : experiment ? expEdit ? undefined : experiment.cursor : state.boardAnchor ?? (selected ? targetKey(selected) : '');
  const room = Math.max(0, height - 2 - top);
  const helpStart = helpContent?.anchor ? rows.indexOf(helpContent.anchor) : 0;
  const cursorAt = rows.findIndex((r) => r.item === key), max = Math.max(helpStart, rows.length - room);
  const scroll = help
    ? (state.helpScroll ?? helpStart)
    : sheet ? chainTop + Number(!!input.publicationNotice && !!anchor)
    : addingHarness ? 0
    : sub
      ? state.scroll[changes ? 'changes' : 'details']
      : project || control ? (state.projectScroll ?? 0) : experiment ? (experiment.scroll ?? 0) : (state.homeScroll ?? 0);
  let offset = Math.max(0, Math.min(max, scroll));
  if (anchor && key && cursorAt >= offset + room) offset = Math.max(0, cursorAt - room + 1);
  if (!help && !changes && !sheet && key && (addingHarness || state.boardRevealed !== key) && room) {
    if (cursorAt < offset) offset = cursorAt;
    else if (cursorAt >= offset + room) offset = cursorAt - room + 1;
    if (!addingHarness) state.boardRevealed = key;
  }
  if (help) {
    state.helpScroll = offset;
    frame.helpPage = { count: room, maxOffset: max };
  } else if (sub) state.scroll[changes ? 'changes' : 'details'] = offset;
  else if (project || control) { if (!addingHarness && !sheet && (!control || input.project)) state.projectScroll = offset; }
  else if (experiment) state.expPage = { ...experiment, scroll: offset };
  else state.homeScroll = offset;
  headers.slice(0, top).forEach((text, i) => { frame.lines[1 + i] = text; });
  for (let i = 0; i < room; i++) {
    const row = rows[offset + i];
    if (!row) continue;
    const text = fit(row.paint?.() ?? row.text, width);
    // A Projects list entry is two rows and the cursor marks both.
    const marked = offset + i === cursorAt || ((list || control) && !!key && row.item === key);
    frame.lines[i + 1 + top] = !help && !changes && marked ? boardCursor(text) : text;
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: i + 1 + top });
  }
  const done = doneToday();
  const projectSwitch = frame.projects ? ['[ ] project'] : [];
  const onTry = (project || home) && rows.some((r) => r.item === (project ? state.projectCursor : state.boardAnchor) && r.tryTarget);
  const hints: FooterHints = help
    ? { modal: ['Esc back'] }
    : inspector ? ['⏎ open', 'Esc back']
      : changes ? ['Esc back']
        : control ? harnesses ? addingHarness ? addBackHints : harnessHints(input.project, state)
            : sheet ? sheet.hints : controlHints(input.project, state.projectCursor)
        : project ? (page === 'waiting' ? ['o file', 'Esc back']
          : page === 'progress' ? (state.projectTry ? [...TRY_ACTIONS, 't all', '⏎ open', 'Esc back']
            : onTry && (state.acceptance !== 'slice' || state.projectLayout === 'board' || state.projectLayout === 'inbox') ? [...TRY_ACTIONS, '⏎ details', 'Esc back', 'o file', 't to try']
            : state.acceptance !== 'slice' && state.projectCursor?.startsWith('project:fold:task:') ? ['⏎ details', 'Esc back', 'o file', 't to try']
            : ['t to try', '⏎ open', 'Esc back'])
          : page === 'tickets' && state.acceptance !== 'slice' ? ['⏎ details', 'Esc back', 'o file']
          : page || list ? ['⏎ open', 'Esc back']
          : onTry && (state.acceptance !== 'slice' || state.projectLayout === 'inbox') ? [...TRY_ACTIONS, '⏎ details', 'o file', ...projectSwitch]
          : ['⏎ open', ...projectSwitch])
        : experiment ? expHints(experiment, expEdit) : onTry ? [...TRY_ACTIONS, '⏎ details', 'o file'] : homeKeys(state, source, 'expand');
  if (harnesses && height > 1) harnessFooterControls(frame, hints, width, height - 1);
  if (control && !harnesses && height > 1) presetFooterControls(frame, hints, width, height - 1);
  if (height > 1)
    frame.lines[height - 1] = footRow(
      home ? homeDoneCount(done, width) : '',
      filterHints(state, hints),
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

/** One frame grammar for Home and the kept passive pages. */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { boardInspectorRows } from './work-inspector.js';
import { homeRows } from './home-view.js';
import { projectRows, homeProgressRows } from './project-view.js';
import { visibleWorkboard } from './work-visibility.js';
import { boardCursor, boardRow, section, kvRows, subTopRow, footRow, mark } from './workboard-rows.js';
import { changesRows } from './monitor-panes.js';
import { theme, visualLength } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
export { footHints } from './workboard-rows.js';
function helpRows(input: MonitorData, width: number): MonitorRow[] {
  const half = width >= 80 ? Math.floor((width - 4) / 2) : width;
  const keys = [
    section(t('Keys'), half),
    ...[
      ['1 2', 'Home · Project'],
      ['← → Tab', 'next / previous tab'],
      ['3', 'Changes'],
      ['↑ ↓', 'move'],
      ['⏎', 'expand / collapse in place'],
      ['o', 'open the file in $EDITOR'],
      ['v', 'inspect: details and files'],
      ['a', 'show / hide older jobs and decisions (Home)'],
      ['n N', 'next / previous trouble (Home)'],
      ['b', 'models on / off'],
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
    'In Project and the Inspector ⏎ opens the file',
    ...(input.mouse !== false ? ['click selects · again expands · wheel scrolls'] : []),
  ];
  rows.push(boardRow(''), ...notes.flatMap((s) => flowLines(t(s), width).map((s) => boardRow(theme.board.muted(s)))));
  if (input.embedded)
    rows.push(
      ...flowLines(t("In Codex's own panel press {p} first", { p: input.prefix ?? 'Ctrl+\\' }), width).map((s) =>
        boardRow(theme.board.muted(s))
      )
    );
  return [boardRow(''), ...rows];
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
  };
  if (!width || !height) return frame;
  const help = state.help,
    inspector = !help && state.focus === 'details',
    changes = !help && state.focus === 'changes';
  const sub = inspector || help || changes;
  const project = !sub && state.mainTab === 'project';
  const board = inspector ? source : visibleWorkboard(input, source, state, now);
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
  if (sub) {
    frame.lines[0] = subTopRow(crumb, '', width);
    frame.controls.push({ kind: help ? 'help' : 'board-back', x: 0, y: 0, width: 2 });
  } else {
    const count = board.workers.filter((w) => w.homeNeedsHuman).length;
    const title = ` ${t('Home')}${count ? ' ' + theme.board.attention(String(count)) : ''} `;
    const waiting = input.project?.waiting.length ?? 0;
    const projectTitle = ` ${t('Project')}${waiting ? ' ' + theme.board.attention(String(waiting)) : ''} `;
    const models = t(input.modelEnabled === false ? 'models off' : 'models on');
    frame.lines[0] = pair(
      (project ? theme.board.muted : theme.board.title)(title) +
        (project ? theme.board.title : theme.board.muted)(projectTitle),
      (input.modelEnabled === false ? theme.board.attention : theme.board.muted)(models),
      width
    );
    frame.controls.push({ kind: 'board-home', x: 0, y: 0, width: visualLength(title) });
    frame.controls.push({ kind: 'board-project', x: visualLength(title), y: 0, width: visualLength(projectTitle) });
    frame.controls.push({
      kind: 'brief',
      x: Math.max(0, width - visualLength(models)),
      y: 0,
      width: visualLength(models),
    });
  }
  const rows = help
    ? helpRows(input, width)
    : changes
      ? [boardRow(''), ...changesRows(input, state, width, now)]
      : inspector
        ? boardInspectorRows(lane, state.boardInspect, state, width, now)
        : project
          ? projectRows(input.project, state, width, now, source, input.modelEnabled)
          : homeRows(board, state, width, now, input);
  if (input.error) rows.unshift(boardRow(theme.error(monitorText(input.error))));
  if (input.publicationNotice) rows.unshift(boardRow(theme.warning(monitorText(input.publicationNotice))));
  if (!sub && !project) rows.push(...homeProgressRows(input.project, width, height - 2 - rows.length));
  if (state.boardAnchor?.startsWith('home-progress:') && !rows.some((r) => r.item === state.boardAnchor))
    state.boardAnchor = undefined;
  const targets = new Map<string, WorkTarget>();
  for (const lane of board.lanes) {
    const all: WorkTarget[] = [
      { kind: 'lane', laneId: lane.id },
      ...lane.workers.map((w) => ({ kind: 'worker' as const, laneId: lane.id, workerId: w.id })),
      ...lane.decisions.map((d) => ({ kind: 'decision' as const, laneId: lane.id, decisionId: d.id })),
    ];
    for (const target of all) targets.set(targetKey(target), target);
  }
  let selected = state.homeTarget;
  if (!sub && !project && (!selected || !rows.some((r) => r.item === targetKey(selected!)))) {
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
  if (!sub && !project && !selected && !state.boardAnchor)
    state.boardAnchor = rows.find((r) => r.item?.startsWith('home-progress:'))?.item;
  const files = rows.filter((r) => r.files?.length);
  if (inspector && !files.some((r) => r.item === state.inspectCursor))
    state.inspectCursor =
      files.find((r) => r.files?.[0].endsWith(worker?.work?.requestInfo?.evidence?.relativePath ?? '/report.md'))
        ?.item ?? files[0]?.item;
  if (project && !rows.some((r) => r.item === state.projectCursor)) state.projectCursor = rows.find((r) => r.item)?.item;
  const key = project ? state.projectCursor : inspector ? state.inspectCursor : state.boardAnchor ?? (selected ? targetKey(selected) : '');
  const cursorAt = rows.findIndex((r) => r.item === key),
    room = Math.max(0, height - 2),
    max = Math.max(0, rows.length - room);
  const scroll = help
    ? (state.helpScroll ?? 0)
    : sub
      ? state.scroll[changes ? 'changes' : 'details']
      : project ? (state.projectScroll ?? 0) : (state.homeScroll ?? 0);
  let offset = Math.max(0, Math.min(max, scroll));
  if (!help && !changes && key && state.boardRevealed !== key && room) {
    if (cursorAt < offset) offset = cursorAt;
    else if (cursorAt >= offset + room) offset = cursorAt - room + 1;
    state.boardRevealed = key;
  }
  if (help) {
    state.helpScroll = offset;
    frame.helpPage = { count: room, total: rows.length };
  } else if (sub) state.scroll[changes ? 'changes' : 'details'] = offset;
  else if (project) state.projectScroll = offset;
  else state.homeScroll = offset;
  for (let i = 0; i < room; i++) {
    const row = rows[offset + i];
    if (!row) continue;
    const text = fit(row.paint?.() ?? row.text, width);
    frame.lines[i + 1] = !help && !changes && offset + i === cursorAt ? boardCursor(text) : text;
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: i + 1 });
  }
  const today = new Date(now).toDateString();
  const done = source.workers.filter(
    (w) =>
      ['done', 'completed', 'closed', 'idle_grace'].includes(w.state) &&
      w.settledAt !== null &&
      new Date(w.settledAt).toDateString() === today
  ).length;
  const hints = help
    ? '↑↓ scroll  esc back'
    : inspector
      ? '↑↓ move  ⏎ open  esc back'
      : changes
        ? '↑↓ scroll  esc back'
        : project ? '↑↓ move  ⏎ open  ←→ tab  ? help'
        : '↑↓ move  ⏎ expand  o open  v inspect  a all  , settings  ? help  ←→ tab';
  if (height > 1)
    frame.lines[height - 1] = footRow(
      sub || project ? '' : theme.board.success(`${mark('✓', '+')} ${t('{n} done today', { n: done })}`),
      t(hints),
      width
    );
  frame.lines = frame.lines.map((line) => fit(line, width));
  frame.panes.push({
    id: inspector ? 'details' : changes ? 'changes' : 'agents',
    x: 0,
    y: 1,
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

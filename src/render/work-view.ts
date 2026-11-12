/** Passive Home/Work viewport. The full width belongs to the rows, including column zero. */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { icon } from './control-bar.js';
import { laneRows, orderedLanes, retainedWorker } from './work-lanes.js';
import { workInspectorRows } from './work-inspector.js';
import { homeRows, doneToday } from './home-view.js';
import { visibleWorkboard } from './work-visibility.js';
import { boardCursor, boardRow, section, workerRow, decisionTitle, decisionBlock } from './workboard-rows.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, flowLines, pair } from './monitor-text.js';
import { t } from './i18n.js';
export function workRows(
  input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const rows = [
    boardRow(''),
    ...orderedLanes(board, now)
      .filter((lane) => lane.workers.some((w) => retainedWorker(w, now, state.tree.showAll)))
      .flatMap((lane) => laneRows(input, lane, state, width, now)),
    ...decisionBlock(board, state, width, now),
  ];
  if (!board.lanes.length) rows.push(boardRow(theme.dim(t('No observed work'))));
  return rows;
}
export function boardInspectorRows(
  input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number
): MonitorRow[] {
  const target = state.boardInspect;
  if (!target) return [];
  const lane = board.lanes.find((l) => l.id === target.laneId);
  if (!lane) return [{ text: t('Source no longer available') }];
  const rows = [section(t('Source details'), width)];
  const add = (label: string, value: string) =>
    rows.push(...flowLines(`${t(label)}: ${monitorText(value)}`, width).map((text) => ({ text })));
  add('Title', lane.title);
  const decision = target.kind === 'decision' ? lane.decisions.find((d) => d.id === target.decisionId) : null;
  if (decision) {
    add('answer', decisionTitle(decision));
    if (decision.question) add('asked', decision.question);
    if (decision.instead) add('instead of', decision.instead);
  } else if (target.kind === 'worker') {
    const worker = lane.workers.find((w) => w.id === target.workerId);
    if (worker)
      rows.push(
        workerRow(worker, width, input.nowMs ?? 0),
        ...workInspectorRows(worker, state, width, input.nowMs ?? 0)
      );
  }
  return rows;
}
/** Key hints are separated by two spaces; whole hints are dropped from the right until the rest fits `room`. */
export function footHints(hints: string, room: number): string {
  const parts = hints.split('  ');
  while (parts.length && visualLength(parts.join('  ')) > room) parts.pop();
  return parts.join('  ');
}
export function renderWorkboardHelp(
  input: MonitorData,
  state: MonitorState,
  board: WorkboardSnapshot,
  now: number
): MonitorFrame {
  const frame = renderWorkboardFrame(input, state, board, now);
  const words = [
    'Help — Shortcuts',
    '1 Home · 2 Work · , Settings · ? Help',
    '←→ tab · ↑↓ move · ⏎ expand/collapse · o open · v inspect',
    'b: pause / resume models',
    'a: reveal/hide finished agents · display only',
    'Esc: back',
  ];
  frame.lines = frame.lines.map((_, i) => fit(t(words[i] ?? ''), input.width));
  frame.controls = [];
  return frame;
}
export function renderWorkboardFrame(
  input: MonitorData,
  state: MonitorState,
  board: WorkboardSnapshot,
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
  const home = state.mainTab !== 'work',
    inspector = state.focus === 'details';
  board = visibleWorkboard(input, board, state, now);
  const needs = board.workers.filter((w) => w.homeNeedsHuman).length,
    alive = board.workers.filter((w) => retainedWorker(w, now, state.tree.showAll)).length;
  const labels = [t('Home') + (needs ? ' ' + needs : ''), t('Work') + (alive ? ' ' + alive : '')];
  let x = 0;
  const tabs = labels
    .map((label, i) => {
      const text = ` ${label} `;
      frame.controls.push({ kind: i ? 'board-work' : 'board-home', x, y: 0, width: visualLength(text) });
      x += visualLength(text);
      return i === (home ? 0 : 1) && !inspector ? theme.board.title(text) : theme.dim(text);
    })
    .join('');
  const models = input.modelEnabled !== undefined && x + 3 <= width;
  frame.lines[0] = fit(tabs + (models ? ` ${icon(input.modelEnabled ? 'pause' : 'resume')} ` : ''), width);
  if (models) frame.controls.push({ kind: 'brief', x, y: 0, width: 3 });
  let rows = inspector
    ? boardInspectorRows(input, board, state, width)
    : home
      ? homeRows(board, state, width, now, input)
      : workRows(input, board, state, width, now);
  if (input.error) rows.unshift(boardRow(theme.error(monitorText(input.error))));
  if (input.publicationNotice) rows.unshift(boardRow(theme.warning(monitorText(input.publicationNotice))));
  const targets = new Map<string, WorkTarget>();
  for (const lane of board.lanes) {
    const all: WorkTarget[] = [
      { kind: 'lane', laneId: lane.id },
      ...lane.workers.map((w) => ({ kind: 'worker' as const, laneId: lane.id, workerId: w.id })),
      ...lane.decisions.map((d) => ({ kind: 'decision' as const, laneId: lane.id, decisionId: d.id })),
    ];
    for (const target of all) targets.set(targetKey(target), target);
  }
  let selected = home ? state.homeTarget : state.workTarget;
  if (!selected || !rows.some((r) => r.item === targetKey(selected!)))
    selected = rows.flatMap((r) => (r.item && targets.has(r.item) ? [targets.get(r.item)!] : []))[0];
  if (home) state.homeTarget = selected;
  else state.workTarget = selected;
  const key = selected ? targetKey(selected) : '',
    cursorAt = rows.findIndex((r) => r.item === key);
  const room = Math.max(0, height - 2),
    max = Math.max(0, rows.length - room);
  let offset = Math.max(
    0,
    Math.min(max, inspector ? state.scroll.details : home ? (state.homeScroll ?? 0) : (state.workScroll ?? 0))
  );
  if (!inspector && key && state.boardRevealed !== `${home}:${key}` && room) {
    if (cursorAt < offset) offset = cursorAt;
    else if (cursorAt >= offset + room) offset = cursorAt - room + 1;
    state.boardRevealed = `${home}:${key}`;
  }
  if (inspector) state.scroll.details = offset;
  else if (home) state.homeScroll = offset;
  else state.workScroll = offset;
  for (let i = 0; i < room; i++) {
    const row = rows[offset + i];
    if (!row) continue;
    const text = fit(row.paint?.() ?? row.text, width);
    frame.lines[i + 1] = !inspector && offset + i === cursorAt ? boardCursor(text) : text;
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: i + 1 });
  }
  const done = theme.board.success(t('✓ {n} done today', { n: doneToday(board, now) }));
  const foot = footHints(
    inspector ? t('Esc: back') : t('1 2 tab  ↑↓ move  ⏎ expand  o open'),
    width - visualLength(done) - 1
  );
  if (height > 1) frame.lines[height - 1] = pair(done, foot && theme.dim(foot), width);
  frame.lines = frame.lines.map((line) => fit(line, width));
  frame.panes.push({
    id: inspector ? 'details' : 'agents',
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

/** Passive Home viewport. The full width belongs to the rows, including column zero. */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { icon } from './control-bar.js';
import { workInspectorRows } from './work-inspector.js';
import { homeRows } from './home-view.js';
import { visibleWorkboard } from './work-visibility.js';
import { boardCursor, boardRow, section, workerRow, decisionTitle } from './workboard-rows.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
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
    '1 Home · , Settings · ? Help',
    '↑↓ move · ⏎ expand/collapse · o open · v inspect',
    'b: pause / resume models',
    'a: show/hide older jobs and decisions',
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
  const inspector = state.focus === 'details';
  board = visibleWorkboard(input, board, state, now);
  const title = ` ${t('Home')} `, x = visualLength(title);
  frame.controls.push({ kind: 'board-home', x: 0, y: 0, width: x });
  const models = input.modelEnabled !== undefined && x + 3 <= width;
  frame.lines[0] = fit(theme.board.title(title) + (models ? ` ${icon(input.modelEnabled ? 'pause' : 'resume')} ` : ''), width);
  if (models) frame.controls.push({ kind: 'brief', x, y: 0, width: 3 });
  let rows = inspector
    ? boardInspectorRows(input, board, state, width)
    : homeRows(board, state, width, now, input);
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
  let selected = state.homeTarget;
  if (!selected || !rows.some((r) => r.item === targetKey(selected!)))
    selected = rows.flatMap((r) => (r.item && targets.has(r.item) ? [targets.get(r.item)!] : []))[0];
  state.homeTarget = selected;
  const key = selected ? targetKey(selected) : '',
    cursorAt = rows.findIndex((r) => r.item === key);
  const room = Math.max(0, height - 2),
    max = Math.max(0, rows.length - room);
  let offset = Math.max(
    0,
    Math.min(max, inspector ? state.scroll.details : (state.homeScroll ?? 0))
  );
  if (!inspector && key && state.boardRevealed !== key && room) {
    if (cursorAt < offset) offset = cursorAt;
    else if (cursorAt >= offset + room) offset = cursorAt - room + 1;
    state.boardRevealed = key;
  }
  if (inspector) state.scroll.details = offset;
  else state.homeScroll = offset;
  for (let i = 0; i < room; i++) {
    const row = rows[offset + i];
    if (!row) continue;
    const text = fit(row.paint?.() ?? row.text, width);
    frame.lines[i + 1] = !inspector && offset + i === cursorAt ? boardCursor(text) : text;
    for (const control of row.controls ?? []) frame.controls.push({ ...control, y: i + 1 });
  }
  const foot = footHints(inspector ? t('Esc: back') : t('↑↓ move  ⏎ expand  o open  a all'), width);
  if (height > 1) frame.lines[height - 1] = fit(theme.dim(foot), width);
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

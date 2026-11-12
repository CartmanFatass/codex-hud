/** Shared cell-exact rows. No I/O. */
import type { DecisionRecord, OwnerWorker, WorkLane, WorkTarget } from '../collectors/workboard-types.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { callTime } from '../collectors/workboard.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { theme, visualLength, stripAnsi } from './colors.js';
import { displayConfig } from './hud-config.js';
import { pair, monitorText, fit, flowLines } from './monitor-text.js';
import { ageText, stemLines, paintSentence, jobSentenceRows } from './work-card.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import { t } from './i18n.js';
import { currentDecision } from './work-visibility.js';
export const asciiBoard = () => displayConfig().icons === 'text';
export const mark = (unicode: string, ascii: string) => (asciiBoard() ? ascii : unicode);
export const boardCursor = (text: string) =>
  theme.board.selected(text.replace(/\x1b\[48;[0-9;]+m|\x1b\[38;2;25;21;13m/g, ''));
export function minuteAge(at: number | null, now: number): string {
  return at === null ? '' : ageText(Math.max(0, Math.floor((now - at) / 60000)));
}
export const roleWord = (role: string | null) => monitorText(role ?? '');
export function boardRow(text: string, target?: WorkTarget): MonitorRow {
  const key = target ? targetKey(target) : undefined;
  return { text, ...(key ? { item: key, key } : {}) };
}
export function section(text: string, width: number, right: string | boolean = ''): MonitorRow {
  const tail = typeof right === 'string' ? right : '';
  const left = `${text} ${theme.board.frame(mark('─', '-').repeat(Math.max(0, width - visualLength(text) - visualLength(tail) - (tail ? 2 : 1))))}`;
  return boardRow(tail ? pair(left, theme.board.muted(tail), width) : fit(left, width));
}
export function kvRows(
  label: string,
  value: string,
  width: number,
  ink = (s: string) => s,
  column = width < 56 ? 9 : 10
): MonitorRow[] {
  return flowLines(monitorText(value), Math.max(1, width - column - 1)).map((line, i) =>
    boardRow(
      fit(
        `${theme.board.muted(fit(i ? '' : t(label === 'instead of' && width < 56 ? 'instead' : label), column))} ${ink(line)}`,
        width
      )
    )
  );
}
export const itemRow = (glyph: string, left: string, right: string, width: number): MonitorRow =>
  boardRow(pair(`${glyph || ' '} ${left}`, theme.board.muted(right), width));
export const subTopRow = (crumb: string, right: string, width: number): string =>
  theme.board.title(pair(`${mark('‹', '<')} ${crumb}`, right, width));
export function footHints(hints: string, room: number): string {
  const parts = hints.split('  ');
  while (parts.length && visualLength(parts.join('  ')) > room) parts.pop();
  return parts.join('  ');
}
export function footRow(left: string, hints: string, width: number): string {
  return pair(left, theme.board.muted(footHints(hints, width - visualLength(left) - (left ? 2 : 0))), width);
}
export const decisionTitle = (record: DecisionRecord) =>
  keywordMarks(monitorText(record.modelTitle ?? record.option?.replace(/^[a-z0-9]+:\s*/i, '') ?? record.title)).plain;
/** Collapsed title; expanded (Enter), title and localized decision detail. Display only. */
export function decisionRows(
  record: DecisionRecord,
  lane: WorkLane,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const target: WorkTarget = { kind: 'decision', laneId: lane.id, decisionId: record.id };
  const source = record.evidence[0]?.sourceId;
  const worker = lane.workers.find((w) => w.evidence.some((e) => e.sourceId === source)) ?? lane.workers[0];
  const q = record.evidence[0]?.relativePath.match(/(?:^|\/)(q\d+)\.md$/)?.[1] ?? '';
  const ink = record.departure ? theme.board.attention : theme.board.muted;
  const age = minuteAge(callTime(record), now);
  const old = !currentDecision(record, now);
  const left = `${ink(mark(record.departure ? '◆' : '◇', record.departure ? '*' : 'o'))} ${[record.category ? `[${t(record.category)}]` : '', `${monitorText(lane.label)} · ${roleWord(worker?.role ?? null)}`, q].filter(Boolean).join(' ')}`;
  if (!state.boardExpanded?.has(targetKey(target))) {
    // `worth a look` gives way to the age alone when it would leave the title under ten cells.
    const long = `${t('worth a look')} · ${age}`;
    const right = !old && record.departure && width - visualLength(left) - visualLength(long) - 3 >= 10 ? long : age;
    const title = record.modelTitle ? paintSentence(record.modelTitle) : ink(decisionTitle(record));
    const row = pair(`${left}  ${title}`, ink(right), width);
    return [boardRow(old ? theme.board.muted(stripAnsi(row)) : theme.board.title(row), target)];
  }
  const right = `${record.departure ? t('worth a look') + ' · ' : ''}${age}`;
  const rows = [
    theme.board.title(pair(left, ink(right), width)),
    ...(record.modelTitle ? jobSentenceRows(record.modelTitle, width, ink, true) : stemLines(decisionTitle(record), width, ink)),
    ...[
      ['asked', record.modelQuestion ?? record.question],
      [record.verdict ? 'verdict' : 'answer', record.modelAnswer ?? record.verdict ?? record.option ?? (record.kind === 'answer' ? record.title : undefined)],
      ['instead of', record.modelInstead ?? record.instead],
      ['why', record.modelWhy ?? record.rationale ?? record.context],
    ].flatMap(([label, value]) => value ? stemLines(`${t(label!)} ${value}`, width, ink) : []),
  ];
  return [...rows.map((text, i) => boardRow(i ? theme.board.body(text) : text, target)), boardRow('')];
}
/** "Decided for you": current decisions, with older ones revealed by show-all. */
export function decisionBlock(
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number,
  source = board
): MonitorRow[] {
  const decisions = board.decisions
    .slice()
    .sort(
      (a, b) =>
        Number(b.category === 'owner authorisation') - Number(a.category === 'owner authorisation') ||
        (state.tree.showAll ? 0 : Number(b.departure) - Number(a.departure)) || (callTime(b) ?? 0) - (callTime(a) ?? 0)
    );
  if (!decisions.length) return [];
  const rows = [section(t('Decided for you'), width, String(decisions.length))];
  for (let i = 0; i < decisions.length; i++) {
    if (!state.tree.showAll && i && decisions[i - 1].departure && !decisions[i].departure && rows.at(-1)?.text)
      rows.push(boardRow(''));
    const lane = source.lanes.find((l) => l.id === decisions[i].laneId);
    if (lane) rows.push(...decisionRows(decisions[i], lane, state, width, now));
  }
  return rows;
}

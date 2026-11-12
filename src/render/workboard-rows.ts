/** Shared cell-exact rows. No I/O. */
import type { DecisionRecord, OwnerWorker, WorkLane, WorkTarget } from '../collectors/workboard-types.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { callTime } from '../collectors/workboard.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { theme, visualLength } from './colors.js';
import { displayConfig } from './hud-config.js';
import { pair, monitorText } from './monitor-text.js';
import { ageText, stemLines } from './work-card.js';
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
export function section(text: string, width: number, _heavy = false): MonitorRow {
  return boardRow(`${text} ${theme.board.frame(mark('─', '-').repeat(Math.max(0, width - visualLength(text) - 1)))}`);
}
export function workerRow(worker: OwnerWorker, width: number, now: number): MonitorRow {
  return boardRow(
    pair(
      `${worker.homeNeedsHuman ? '?' : mark('●', '*')} ${roleWord(worker.role)}  ${monitorText(worker.task)}`,
      minuteAge(worker.settledAt ?? worker.startedAt, now),
      width
    ),
    { kind: 'worker', laneId: worker.laneId, workerId: worker.id }
  );
}
export const decisionTitle = (record: DecisionRecord) =>
  monitorText(record.modelTitle ?? record.option?.replace(/^[a-z0-9]+:\s*/i, '') ?? record.title);
/** Collapsed, one row (title cut to fit); expanded (Enter), the whole title, question and `instead of`. Display only. */
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
  const left = `${ink(mark(record.departure ? '◆' : '◇', record.departure ? '*' : 'o'))} ${[`${monitorText(lane.label)} · ${roleWord(worker?.role ?? null)}`, q, currentDecision(record, now) ? '' : t('older item')].filter(Boolean).join(' ')}`;
  if (!state.boardExpanded?.has(targetKey(target))) {
    // `worth a look` gives way to the age alone when it would leave the title under ten cells.
    const long = `${t('worth a look')} · ${age}`;
    const right = record.departure && width - visualLength(left) - visualLength(long) - 3 >= 10 ? long : age;
    return [boardRow(theme.board.title(pair(`${left}  ${ink(decisionTitle(record))}`, ink(right), width)), target)];
  }
  const right = `${record.departure ? t('worth a look') + ' · ' : ''}${age}`;
  const rows = [
    theme.board.title(pair(left, ink(right), width)),
    ...stemLines(decisionTitle(record), width, ink),
    ...(record.question ? stemLines(`${t('asked')} ${record.question}`, width, ink) : []),
    ...(record.departure && record.instead ? stemLines(`${t('instead of')} ${record.instead}`, width, ink) : []),
  ];
  return [...rows.map((text, i) => boardRow(i ? theme.board.body(text) : text, target)), boardRow('')];
}
/** "Decided for you": current decisions, with older ones revealed by show-all. */
export function decisionBlock(board: WorkboardSnapshot, state: MonitorState, width: number, now: number, source = board): MonitorRow[] {
  const decisions = board.decisions
    .slice().sort((a, b) => (state.tree.showAll ? 0 : Number(b.departure) - Number(a.departure)) || (callTime(b) ?? 0) - (callTime(a) ?? 0));
  if (!decisions.length) return [];
  const rows = [
    boardRow(
      pair(t('Decided for you') + ' ' + mark('─', '-').repeat(Math.max(0, width - 19)), String(decisions.length), width)
    ),
  ];
  for (let i = 0; i < decisions.length; i++) {
    if (i && decisions[i - 1].departure && !decisions[i].departure && rows.at(-1)?.text) rows.push(boardRow(''));
    const lane = source.lanes.find((l) => l.id === decisions[i].laneId);
    if (lane) rows.push(...decisionRows(decisions[i], lane, state, width, now));
  }
  return rows;
}

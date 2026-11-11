/** Shared cell-exact rows. No I/O. */
import type { DecisionRecord, OwnerWorker, WorkLane, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { callTime } from '../collectors/workboard.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { theme, visualLength } from './colors.js';
import { displayConfig } from './hud-config.js';
import { pair, monitorText } from './monitor-text.js';
import { ageText, stemLines } from './work-card.js';
import { t } from './i18n.js';
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
  monitorText(record.option?.replace(/^[a-z0-9]+:\s*/i, '') ?? record.title);
export function decisionRows(
  record: DecisionRecord,
  lane: WorkLane,
  _state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const target: WorkTarget = { kind: 'decision', laneId: lane.id, decisionId: record.id };
  const source = record.evidence[0]?.sourceId;
  const worker = lane.workers.find((w) => w.evidence.some((e) => e.sourceId === source)) ?? lane.workers[0];
  const q = record.evidence[0]?.relativePath.match(/(?:^|\/)(q\d+)\.md$/)?.[1] ?? '';
  const ink = record.departure ? theme.board.attention : theme.board.muted;
  const right = `${record.departure ? t('worth a look') + ' · ' : ''}${minuteAge(callTime(record), now)}`;
  const rows = [
    theme.board.title(
      pair(
        `${ink(mark(record.departure ? '◆' : '◇', record.departure ? '*' : 'o'))} ${monitorText(lane.label)} · ${roleWord(worker?.role ?? null)} ${q}`,
        ink(right),
        width
      )
    ),
    ...stemLines(decisionTitle(record), width, ink),
    ...(record.question ? stemLines(`${t('asked')} ${record.question}`, width, ink) : []),
    ...(record.departure && record.instead ? stemLines(`${t('instead of')} ${record.instead}`, width, ink) : []),
  ];
  return rows.map((text, i) => boardRow(i ? theme.board.body(text) : text, target));
}

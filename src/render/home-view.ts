/** Home: the ask, package lanes, then decisions made for the owner. */
import { targetKey, type WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { isLocalDay } from '../collectors/workboard.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { boardRow, minuteAge, decisionBlock, mark } from './workboard-rows.js';
import { laneRows, orderedLanes, retainedWorker } from './work-lanes.js';
import { requestLines, stemLines } from './work-card.js';
import { theme } from './colors.js';
import { fit, pair, monitorText } from './monitor-text.js';
import { t } from './i18n.js';
export function doneToday(board: WorkboardSnapshot, now: number): number {
  return board.workers.filter((w) => isLocalDay(w.settledAt, now)).length;
}
export function homeRows(
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number,
  input?: MonitorData
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')];
  const needs = board.workers.filter((w) => w.homeNeedsHuman);
  for (const worker of needs) {
    const card = projectWorkCard(worker, now),
      r = worker.work?.requestInfo;
    const target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
    const lane = board.lanes.find((l) => l.id === worker.laneId);
    // Collapsed, the short card; Enter expands it to the question whole, the context and every option.
    const open = state.boardExpanded?.has(targetKey(target)) === true;
    const hint = `${t(open ? '⏎ collapse' : '⏎ expand')}  ${t('o open')}`;
    rows.push(
      boardRow(
        theme.board.askTitle(
          pair(
            `? ${monitorText(worker.role ?? '')} · ${monitorText(lane?.label ?? '')}`,
            `${t('asking')} ${minuteAge(worker.humanEndedAt, now)}`,
            width
          )
        ),
        target
      )
    );
    const n = r?.options.length ?? 0;
    const choices = [
      n ? t(n === 1 ? '{n} option' : '{n} options', { n }) : '',
      r?.suggested ? `${t('default')}: ${r.suggested}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const lines = (
      open && r
        ? requestLines(card, true).flatMap((part) => stemLines(part, width, theme.board.attention))
        : [
            ...stemLines(r?.question ?? worker.ask ?? card.reason ?? '', width, theme.board.attention, 3),
            ...(choices ? stemLines(choices, width, theme.board.attention, 1) : []),
          ]
    ).map((line) =>
      line.replace(
        new RegExp(`(${t('default')}: )([a-zA-Z])([).,:])`),
        (_match, before, letter, after) => before + theme.board.askTitle(letter) + after
      )
    );
    rows.push(...lines.map((line) => boardRow(theme.board.slab(line), target)));
    rows.push(
      boardRow(
        theme.board.slab(
          fit(
            `${theme.board.attention(mark('┃', '|'))} ${pair(monitorText(r?.evidence?.relativePath ?? ''), hint, Math.max(0, width - 2))}`,
            width
          )
        ),
        target
      ),
      boardRow('')
    );
  }
  if (!needs.length) {
    const running = board.workers.filter((w) => w.settledAt === null).length;
    rows.push(
      boardRow(
        theme.board.success(
          pair(`${mark('✓', '+')} ${t('Nothing needs you')}`, running ? t('{n} running', { n: running }) : '', width)
        )
      ),
      boardRow('')
    );
  }
  if (input)
    for (const lane of orderedLanes(board, now)) {
      if (lane.workers.every((w) => !retainedWorker(w, now, state.tree.showAll))) continue;
      rows.push(...laneRows(input, lane, state, width, now));
    }
  rows.push(...decisionBlock(board, state, width, now));
  return rows;
}

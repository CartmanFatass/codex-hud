/** Home: the ask, package lanes, then decisions made for the owner. */
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { callTime, isLocalDay } from '../collectors/workboard.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { boardRow, minuteAge, decisionRows, mark } from './workboard-rows.js';
import { laneRows, orderedLanes, retainedWorker } from './work-lanes.js';
import { stemLines } from './work-card.js';
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
    const body = [
      r?.question ?? worker.ask ?? card.reason ?? '',
      r?.context ? `${t('blocked')} ${r.context}` : '',
      ...(r?.options ?? []),
      r?.suggested ? `${t('default')} ${r.suggested}` : '',
    ].filter(Boolean);
    for (const text of body)
      rows.push(
        ...stemLines(text, width, theme.board.attention).map((line) =>
          boardRow(
            theme.board.slab(
              text.startsWith(t('default') + ' ')
                ? line.replace(
                    new RegExp(`(${t('default')} )([a-zA-Z])([).,:])`),
                    (_match, before, letter, after) => before + theme.board.askTitle(letter) + after
                  )
                : line
            ),
            target
          )
        )
      );
    rows.push(
      boardRow(
        theme.board.slab(
          fit(
            `${theme.board.attention(mark('┃', '|'))} ${pair(monitorText(r?.evidence?.relativePath ?? ''), t('⏎ read'), Math.max(0, width - 2))}`,
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
  const decisions = board.decisions
    .filter((d) => isLocalDay(callTime(d), now))
    .sort((a, b) => Number(b.departure) - Number(a.departure) || (callTime(b) ?? 0) - (callTime(a) ?? 0));
  if (decisions.length) {
    rows.push(
      boardRow(
        pair(
          t('Decided for you') + ' ' + mark('─', '-').repeat(Math.max(0, width - 19)),
          String(decisions.length),
          width
        )
      )
    );
    for (let i = 0; i < decisions.length; i++) {
      if (i && decisions[i - 1].departure && !decisions[i].departure) rows.push(boardRow(''));
      const lane = board.lanes.find((l) => l.id === decisions[i].laneId);
      if (lane) rows.push(...decisionRows(decisions[i], lane, state, width, now));
    }
  }
  return rows;
}

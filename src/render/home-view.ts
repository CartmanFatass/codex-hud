/** Home is a passive triage page. QA and ordinary errors are not owner intervention. */
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { homeCalls } from '../collectors/workboard.js';
import type { DecisionRecord } from '../collectors/workboard-types.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { targetKey } from '../collectors/workboard-types.js';
import { t } from './i18n.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, pair, flowLines } from './monitor-text.js';
import {
  boardRow,
  decisionRows,
  laneRow,
  mark,
  minuteAge,
  section,
  workerRow,
  workerColumns,
  callCount,
} from './workboard-rows.js';
export function homeRows(board: WorkboardSnapshot, state: MonitorState, width: number, now: number): MonitorRow[] {
  const inbox: MonitorRow[] = [],
    progress: MonitorRow[] = [];
  const wide = width >= 100,
    leftWidth = wide ? Math.floor(width * 0.58) : width,
    rightWidth = wide ? width - leftWidth - 3 : width;
  const needs = board.workers.filter((w) => w.homeNeedsHuman);
  if (needs.length) {
    inbox.push(section(t('need you') + ` ${needs.length}`, leftWidth, true));
    for (const worker of needs) {
      const target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
      const prefix = `${theme.board.attention(mark('┃', '|') + '?')} `;
      const text = `${monitorText(worker.task)}: ${t('Ended needing a human')}`;
      const age = minuteAge(worker.humanEndedAt, now);
      const lines = flowLines(text, Math.max(1, leftWidth - 4 - visualLength(age)));
      for (let i = 0; i < lines.length; i++)
        inbox.push(
          boardRow(
            i ? `  ${lines[i]}` : pair(prefix + theme.bold(lines[i]), theme.board.attention(age), leftWidth),
            target
          )
        );
    }
  } else
    inbox.push(
      boardRow(
        board.coverage.incomplete
          ? theme.dim(t('Needs-you coverage incomplete'))
          : theme.board.success(`${mark('✓', '+')} ${t('nothing needs you')}`)
      )
    );
  const calls = homeCalls(board, now);
  const feed = (records: readonly DecisionRecord[], label: string, fold: string) => {
    if (!records.length) return;
    inbox.push(section(`${t(label)} ${records.length}`, leftWidth));
    let ordinary = 0,
      hidden = 0;
    for (const record of records) {
      if (!record.oneWay && ordinary++ >= 3 && !state.boardExpanded?.has(fold)) {
        hidden++;
        continue;
      }
      const lane = board.lanes.find((l) => l.id === record.laneId);
      if (lane) inbox.push(...decisionRows(record, lane, state, leftWidth, now));
    }
    if (hidden) inbox.push({ text: theme.dim(t('+{n} earlier', { n: hidden })), item: fold, key: fold });
  };
  feed(calls.worth, 'worth a look', 'fold:worth');
  feed(calls.routine, 'decided for you', 'fold:routine');
  if (calls.older.length) {
    inbox.push({
      text: theme.dim(t('{n} older today', { n: calls.older.length })),
      item: 'fold:older',
      key: 'fold:older',
    });
    if (state.boardExpanded?.has('fold:older'))
      for (const record of calls.older) {
        const lane = board.lanes.find((l) => l.id === record.laneId);
        if (lane) inbox.push(...decisionRows(record, lane, state, leftWidth, now));
      }
  }
  const selected = state.boardAnchor ? undefined : state.homeTarget;
  if (selected) {
    const key = targetKey(selected),
      at = inbox.map((r) => r.item).lastIndexOf(key);
    if (at >= 0) {
      const hint = t('Enter: open in Work');
      inbox.splice(at + 1, 0, {
        ...boardRow(theme.dim(hint), selected),
        controls: [{ kind: 'board-activate', item: key, x: 0, width: Math.min(leftWidth, visualLength(hint)) }],
      });
    }
  }
  progress.push(section(t('work · observed start order'), rightWidth));
  for (const lane of board.lanes) progress.push(laneRow(lane, rightWidth, now, true));
  if (!board.lanes.length) progress.push(boardRow(theme.dim(t('No observed work'))));
  const rows: MonitorRow[] = wide
    ? Array.from({ length: Math.max(inbox.length, progress.length) }, (_, i) => {
        // Both columns retain their own keyboard destinations through targets carried by the physical rows.
        const a = inbox[i],
          b = progress[i];
        const rightSelected =
          !!b?.item &&
          !state.boardAnchor &&
          (selected
            ? targetKey(selected) === b.item
            : !inbox.some((row) => row.item) &&
              b.item === targetKey({ kind: 'lane', laneId: board.lanes[0]?.id ?? '' }));
        const right = rightSelected
          ? theme.board.selected((b?.text ?? '').replace(/^[│|]/u, mark('›', '>')))
          : (b?.text ?? '');
        return {
          text: fit(a?.text ?? '', leftWidth) + theme.frame(` ${mark('│', '|')} `) + fit(right, rightWidth),
          item: a?.item,
          key: a?.key,
          controls: [
            ...(a?.controls ?? []),
            ...(b?.item ? [{ kind: 'board-pick' as const, item: b.item, x: leftWidth + 3, width: rightWidth }] : []),
          ],
        };
      })
    : [...inbox, ...progress];
  rows.push(section(t('workers'), width));
  const columns = workerColumns(board.workers, width, now);
  for (const worker of board.workers) rows.push(workerRow(worker, width, now, columns));
  if (width >= 56 && calls.today)
    rows.push(
      boardRow(
        theme.dim(`${t('today')} ${callCount(calls.today)}${board.coverage.incomplete ? ` · ${t('partial')}` : ''}`)
      )
    );
  return rows;
}

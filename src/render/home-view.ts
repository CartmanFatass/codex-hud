/** Home is a passive triage page. QA and ordinary errors are not owner intervention. */
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { homeCalls, isLocalDay } from '../collectors/workboard.js';
import { isThinLane } from '../collectors/thin-jobs.js';
import type { DecisionRecord } from '../collectors/workboard-types.js';
import type { MonitorRow, MonitorState, MonitorData } from './monitor.js';
import { laneRows } from './work-lanes.js';
import { targetKey } from '../collectors/workboard-types.js';
import { t } from './i18n.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, pair, flowLines } from './monitor-text.js';
import {
  boardRow,
  boardCursor,
  decisionRows,
  laneRow,
  mark,
  minuteAge,
  roleWord,
  section,
  workerRow,
  workerColumns,
  callCount,
} from './workboard-rows.js';
/** A thin job that has settled leaves the workers list after this long; the day's count keeps it. */
const FINISHED_LINGER_MS = 10 * 60000;
export function homeRows(
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number,
  input?: MonitorData
): MonitorRow[] {
  const inbox: MonitorRow[] = [],
    progress: MonitorRow[] = [];
  // Thin jobs have no packages or phases: without a package lane the work pane has nothing to draw.
  const packages = board.lanes.filter((l) => !isThinLane(l.id));
  const wide = width >= 100 && (packages.length > 0 || board.lanes.length === 0),
    leftWidth = wide ? Math.floor(width * 0.58) : width,
    rightWidth = wide ? width - leftWidth - 3 : width;
  const needs = board.workers.filter((w) => w.homeNeedsHuman);
  if (needs.length) {
    inbox.push(section(t('need you') + ` ${needs.length}`, leftWidth, true));
    for (const worker of needs) {
      const target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
      const prefix = `${theme.board.attention(mark('┃', '|') + '?')} `;
      // An open question names its role and says what is asked; an ended job says that it ended.
      const label = worker.ask ? roleWord(worker.role) + ' ' : '';
      const text = worker.ask ? monitorText(worker.ask) : `${monitorText(worker.task)}: ${t('Ended needing a human')}`;
      const age = minuteAge(worker.humanEndedAt, now);
      const lines = flowLines(text, Math.max(1, leftWidth - 4 - visualLength(age) - visualLength(label)));
      for (let i = 0; i < lines.length; i++)
        inbox.push(
          boardRow(
            i
              ? `  ${' '.repeat(visualLength(label))}${lines[i]}`
              : pair(prefix + label + theme.bold(lines[i]), theme.board.attention(age), leftWidth),
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
  if (packages.length || !board.lanes.length) {
    progress.push(section(t('work · observed start order'), rightWidth));
    for (const lane of packages) progress.push(laneRow(lane, rightWidth, now, true));
    if (!board.lanes.length) progress.push(boardRow(theme.dim(t('No observed work'))));
  }
  if (wide && input) {
    const lane = packages.find((l) => l.id === selected?.laneId) ?? packages[0];
    if (lane) {
      progress.push(section(t('Work peek'), rightWidth));
      progress.push(...laneRows(input, lane, { ...state, mainTab: 'work', workTarget: undefined }, rightWidth, now));
    }
  }
  let rightCursor = false;
  const rows: MonitorRow[] = wide
    ? Array.from({ length: Math.max(inbox.length, progress.length) }, (_, i) => {
        // Both columns retain their own keyboard destinations through targets carried by the physical rows.
        const a = inbox[i],
          b = progress[i];
        const rightSelected =
          !rightCursor &&
          !!b?.item &&
          !state.boardAnchor &&
          (selected
            ? !inbox.some((row) => row.item === targetKey(selected)) && targetKey(selected) === b.item
            : !inbox.some((row) => row.item) && b.item === targetKey({ kind: 'lane', laneId: packages[0]?.id ?? '' }));
        if (rightSelected) rightCursor = true;
        const renderRight = () => {
          const text = b?.paint?.() ?? b?.text ?? '';
          return rightSelected ? boardCursor(text) : text;
        };
        return {
          text: '',
          paint: () =>
            fit(a?.paint?.() ?? a?.text ?? '', leftWidth) +
            theme.frame(` ${mark('│', '|')} `) +
            fit(renderRight(), rightWidth),
          item: a?.item,
          key: a?.key,
          sentenceWorkers: [...(a?.sentenceWorkers ?? []), ...(b?.sentenceWorkers ?? [])],
          controls: [
            ...(a?.controls ?? []),
            ...(b?.item ? [{ kind: 'board-pick' as const, item: b.item, x: leftWidth + 3, width: rightWidth }] : []),
          ],
        };
      })
    : [...inbox, ...progress];
  rows.push(section(t('workers'), width));
  // Model and thinking belong to the wide worker band; below it the task keeps the room.
  const shown = board.workers
    .filter(
      (w) =>
        !isThinLane(w.laneId) || w.settledAt === null || state.tree.showAll || now - w.settledAt <= FINISHED_LINGER_MS
    )
    .map((w) => (isThinLane(w.laneId) && width < 100 ? { ...w, model: null, effort: null } : w));
  const columns = workerColumns(shown, width, now);
  for (const worker of shown) rows.push(workerRow(worker, width, now, columns));
  const finished = board.workers.filter((w) => isThinLane(w.laneId) && isLocalDay(w.settledAt, now));
  const failed = finished.filter((w) => w.state === 'failed').length,
    done = finished.length - failed;
  // `width` is the frame minus its margin column, so 55 is the 56-column panel.
  if (width >= 55 && (calls.today || finished.length))
    rows.push(
      boardRow(
        theme.dim(
          `${t('today')} ${[
            calls.today ? callCount(calls.today) : '',
            done ? t('{n} done', { n: done }) : '',
            failed ? t('{n} failed', { n: failed }) : '',
            calls.today && board.coverage.incomplete ? t('partial') : '',
          ]
            .filter(Boolean)
            .join(' · ')}`
        )
      )
    );
  return rows;
}

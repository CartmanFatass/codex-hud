/** Home: the ask, package lanes, then decisions made for the owner. */
import { targetKey, type OwnerWorker, type WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { boardRow, minuteAge, decisionBlock, mark, footHints } from './workboard-rows.js';
import { laneRows, orderedLanes } from './work-lanes.js';
import { quietDecisionSummary, requestLines, stemLines } from './work-card.js';
import { theme } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { currentWorker, currentDecision, foldedWorker } from './work-visibility.js';
import { answerable, answerKeys } from './job-actions.js';
/** The amber question title and options, with the answer keys beside the expanded options. */
export function askSlabRows(worker: OwnerWorker, board: WorkboardSnapshot, state: MonitorState, width: number, now: number, underLane = false): MonitorRow[] {
  const rows: MonitorRow[] = [];
  const card = projectWorkCard(worker, now),
    r = worker.work?.requestInfo;
  const target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
  const lane = underLane ? undefined : board.lanes.find((l) => l.id === worker.laneId);
  // Collapsed, the short card; Enter expands it to the question whole, the context and every option.
  const open = state.boardExpanded?.has(targetKey(target)) === true;
  const keys = open ? footHints(answerKeys(worker).join('  '), width - 2) : '';
  rows.push(
    boardRow(
      theme.board.askTitle(
        pair(
          `? ${worker.labels?.category ? `[${t(worker.labels.category)}] ` : ''}${monitorText(worker.role ?? '')}${underLane ? '' : ` · ${monitorText(lane?.label ?? '')}`}`,
          `${t('asking')} ${minuteAge(worker.humanEndedAt, now)}`,
          width
        )
      ),
      target
    )
  );
  const n = r?.options.length ?? 0;
  const quiet = quietDecisionSummary(worker.quietDecision);
  const choices = [
    n ? t(n === 1 ? '{n} option' : '{n} options', { n }) : '',
    r?.suggested ? `${t('default')}: ${r.suggested}` : '',
    quiet,
  ]
    .filter(Boolean)
    .join(' · ');
  const lines =
    open && r
      ? [...requestLines(card, true, answerable(worker) !== undefined), quiet].filter(Boolean).flatMap((part) => stemLines(part, width, theme.board.attention))
      : [
          ...stemLines(r?.question ?? worker.ask ?? card.reason ?? '', width, theme.board.attention, 3),
          ...(choices ? stemLines(choices, width, theme.board.attention, 1) : []),
        ];
  rows.push(...lines.map((line) => boardRow(theme.board.slab(line), target)));
  if (keys) rows.push(boardRow(theme.board.slab(fit(`${theme.board.attention(mark('┃', '|'))} ${keys}`, width)), target));
  rows.push(boardRow(''));
  return rows;
}
/** Only the newest result opens by itself, and only before its fold time: running cards change activity constantly and would make Home jump. */
export function markNewest(board: WorkboardSnapshot, state: MonitorState, now: number): void {
  const newest = board.workers
    .filter((w) => !state.boardFolded?.has(w.laneId) && w.settledAt !== null && !w.parentJobId && currentWorker(w, now, state) && !foldedWorker(w, now, state))
    .reduce<(typeof board.workers)[number] | undefined>(
      (a, w) => (!a || (w.settledAt ?? 0) > (a.settledAt ?? 0) ? w : a),
      undefined
    );
  state.boardNewest = newest ? targetKey({ kind: 'worker', laneId: newest.laneId, workerId: newest.id }) : undefined;
}
export function homeRows(
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number,
  input?: MonitorData
): MonitorRow[] {
  markNewest(board, state, now);
  // With a `/` filter the board holds only what matches: no summary line, brief, older count or progress block of the whole.
  const filtering = !!state.filterQuery;
  const rows: MonitorRow[] = [boardRow('')];
  const needs = board.workers.filter((w) => w.homeNeedsHuman)
    .sort((a, b) => Number(b.labels?.category === 'owner authorisation') - Number(a.labels?.category === 'owner authorisation'));
  // STATE's waiting items count with the job questions; with none of either the line says so. Questions already show as cards.
  const waiting = input?.project?.waiting.length ?? 0, running = board.workers.filter((w) => w.settledAt === null).length;
  if (!filtering && (waiting || !needs.length))
    rows.push(
      {
        ...boardRow(
          waiting
            ? theme.board.attention(fit(`? ${t('{n} waiting for you', { n: needs.length + waiting })} · ${t('{n} running', { n: running })}`, width))
            : theme.board.success(fit(`${mark('✓', '+')} ${t('Nothing needs you')} · ${t('{n} running', { n: running })}`, width))
        ),
        ...(waiting ? { item: 'home-progress:waiting' } : {}),
      },
      boardRow('')
    );
  for (const worker of needs) rows.push(...askSlabRows(worker, board, state, width, now));
  if (!filtering && board.homeBrief) rows.push(...flowLines(monitorText(board.homeBrief), width).map((s) => boardRow(theme.board.text(s))), boardRow(''));
  if (input)
    for (const lane of state.tree.showAll && !board.workers.some((w) => w.homeRank !== undefined) ? board.lanes : orderedLanes(board, now)) {
      if (!lane.workers.length) continue;
      rows.push(...laneRows(input, lane, state, width, now));
    }
  rows.push(...decisionBlock(board, state, width, now, input?.workboard));
  const source = input?.workboard;
  if (filtering && !board.workers.length && !board.decisions.length) rows.push(boardRow(theme.board.muted('  ' + t('No matches'))));
  const hidden = source && !filtering
    ? source.workers.filter((w) => !currentWorker(w, now, state)).length +
      source.decisions.filter((d) => !currentDecision(d, now)).length
    : 0;
  if (hidden)
    rows.push(
      boardRow(theme.board.muted(t(state.tree.showAll ? '{n} older shown · a hide' : '+{n} older · a', { n: hidden })))
    );
  return rows;
}

/** Home: compact top summary with Variant A worker roster, prominent ask slabs and packed package lanes. */
import { targetKey, type OwnerWorker, type WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { boardRow, minuteAge, mark, footHints } from './workboard-rows.js';
import { orderedLanes } from './work-lanes.js';
import { askRows, jobRows } from './work-jobs.js';
import { quietDecisionSummary, requestLines, questionOriginalRows, stemLines } from './work-card.js';
import { theme, visualLength } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { activeFlow, currentWorker, foldedWorker, unattendedFailure } from './work-visibility.js';
import {
  hasRosterWorkers,
  isUnreadReport,
  renderWorkerRoster,
  sonicChildrenRunning,
  workerModelPlain,
  type RosterRung,
} from './worker-roster.js';
import { answerable, answerKeys } from './job-actions.js';

/** Top status + Variant A worker roster strip shared by Classic Home and Split Home. */
export function homeSummaryRow(
  board: WorkboardSnapshot,
  input: MonitorData | undefined,
  width: number,
  now: number,
  interactive = true
): MonitorRow {
  const needs = board.workers.filter((w) => !w.parentJobId && w.homeNeedsHuman);
  const waiting = input?.project?.waiting.length ?? 0;
  const askCount = needs.length + waiting;
  const failCount = board.workers.filter((w) => !w.parentJobId && unattendedFailure(w)).length;
  const unreadCount = board.workers.filter(
    (w) => !w.parentJobId && isUnreadReport(w) && !w.homeNeedsHuman && !unattendedFailure(w)
  ).length;
  const failTail = failCount
    ? ` ${theme.board.muted('·')} ${theme.board.danger(`${mark('✗', 'x')}${failCount}`)}`
    : '';
  const leftForms =
    askCount > 0
      ? [
          `${theme.board.attention(`? ${t('{n} waiting for you', { n: askCount })}`)}${failTail}`,
          `${theme.board.attention(`? ${t('{n} waiting', { n: askCount })}`)}${failTail}`,
          `${theme.board.attention(`?${askCount}`)}${failCount ? ' ' + theme.board.danger(`${mark('✗', 'x')}${failCount}`) : ''}`,
        ]
      : failCount > 0
        ? [
            theme.board.danger(`${mark('✗', 'x')} ${t('{n} failed', { n: failCount })}`),
            theme.board.danger(`${mark('✗', 'x')}${failCount}`),
          ]
        : unreadCount > 0
          ? [
              theme.board.success(`${mark('✓●', '+*')} ${t('{n} unread', { n: unreadCount })}`),
              theme.board.success(`${mark('✓●', '+*')}${unreadCount}`),
            ]
          : [
              theme.board.success(`${mark('✓', '+')} ${t('Nothing needs you')}`),
              theme.board.success(`${mark('✓', '+')} ${t('Clear')}`),
              theme.board.success(mark('✓', '+')),
            ];

  const sourceWorkers = input?.workboard?.workers ?? board.workers;
  let line = '';
  if (!hasRosterWorkers(sourceWorkers, now)) {
    const idleRight = theme.board.muted(t('{n} running', { n: 0 }));
    const left = leftForms.find((l) => visualLength(l) + 2 + visualLength(idleRight) <= width) ?? leftForms.at(-1)!;
    line = pair(left, visualLength(left) + 2 + visualLength(idleRight) <= width ? idleRight : '', width);
  } else {
    const combos: readonly [string, RosterRung][] = [
      [leftForms[0], 'full'],
      [leftForms[1] ?? leftForms[0], 'full'],
      [leftForms[0], 'no-model'],
      [leftForms[1] ?? leftForms[0], 'no-model'],
      [leftForms[1] ?? leftForms[0], 'provider'],
      [leftForms.at(-1)!, 'provider'],
      [leftForms[1] ?? leftForms[0], 'compact'],
      [leftForms.at(-1)!, 'compact'],
    ];
    for (const [left, rung] of combos) {
      const right = renderWorkerRoster(sourceWorkers, rung, now);
      if (right && visualLength(left) + 2 + visualLength(right) <= width) {
        line = pair(left, right, width);
        break;
      }
    }
    if (!line) line = fit(leftForms.at(-1)!, width);
  }
  return {
    ...boardRow(line),
    ...(interactive && waiting ? { item: 'home-progress:waiting' } : {}),
  };
}

/** The amber question title and options, with model/effort + `⚡N` packed on the title row and answer keys when open. */
export function askSlabRows(
  worker: OwnerWorker,
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number,
  underLane = false
): MonitorRow[] {
  const rows: MonitorRow[] = [];
  const card = projectWorkCard(worker, now),
    r = worker.work?.requestInfo?.display ?? worker.work?.requestInfo;
  const target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
  const lane = underLane ? undefined : board.lanes.find((l) => l.id === worker.laneId);
  const open = state.home.expanded?.has(targetKey(target)) === true;
  const keys = open ? footHints(answerKeys(worker).join('  '), width - 2) : '';
  const left = `? ${worker.labels?.category ? `[${t(worker.labels.category)}] ` : ''}${monitorText(worker.role ?? '')}${underLane ? '' : ` · ${monitorText(lane?.label ?? '')}`}`;
  const askAge = `${t('asking')} ${minuteAge(worker.humanEndedAt, now)}`.trim();
  const sonic = sonicChildrenRunning(board.workers, worker.id);
  const sonicStr = sonic > 0 ? `${mark('⚡', '*')}${sonic}` : '';
  const modelFull = workerModelPlain(worker, 'full');
  const modelCompact = workerModelPlain(worker, 'compact');
  const rightCands = [
    [modelFull, sonicStr, askAge].filter(Boolean).join('  '),
    [modelCompact, sonicStr, askAge].filter(Boolean).join(' '),
    [sonicStr, askAge].filter(Boolean).join(' '),
    askAge,
  ];
  const right = rightCands.find((c) => visualLength(left) + 2 + visualLength(c) <= width) ?? askAge;
  rows.push(boardRow(theme.board.askTitle(pair(left, right, width)), target));
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
      ? [...requestLines(card, true, answerable(worker) !== undefined), quiet]
          .filter(Boolean)
          .flatMap((part) => stemLines(part, width, theme.board.attention))
      : [
          ...stemLines(r?.question ?? worker.ask ?? card.reason ?? '', width, theme.board.attention, 3),
          ...(choices ? stemLines(choices, width, theme.board.attention, 1) : []),
        ];
  rows.push(...lines.map((line) => boardRow(theme.board.slab(line), target)));
  rows.push(...questionOriginalRows(card, state, width));
  if (keys) rows.push(boardRow(theme.board.slab(fit(`${theme.board.attention(mark('┃', '|'))} ${keys}`, width)), target));
  rows.push(boardRow(''));
  return rows;
}

/** Only the newest current settled non-child result opens by itself, before its fold time. Classic's job rows never do (the report sentence is in the Inspector); its native subagent cards and Split's preview still do. */
export function newestCard(board: WorkboardSnapshot, state: MonitorState, now: number): string | undefined {
  const newest = board.workers
    .filter(
      (w) =>
        !state.home.foldedLanes?.has(w.laneId) &&
        w.settledAt !== null &&
        !w.parentJobId &&
        (state.prefs.panelLayout === 'split' || w.nativeDepth !== undefined) &&
        currentWorker(w, now, state.prefs) &&
        !foldedWorker(w, now, state.prefs) &&
        (isUnreadReport(w) || unattendedFailure(w) || activeFlow(w) || w.nativeDepth !== undefined || !w.files?.length)
    )
    .reduce<(typeof board.workers)[number] | undefined>(
      (a, w) => (!a || (w.settledAt ?? 0) > (a.settledAt ?? 0) ? w : a),
      undefined
    );
  return newest ? targetKey({ kind: 'worker', laneId: newest.laneId, workerId: newest.id }) : undefined;
}

export function homeRows(
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number,
  input?: MonitorData
): MonitorRow[] {
  const filtering = !!state.home.filter?.query;
  const rows: MonitorRow[] = [];
  const needs = board.workers
    .filter((w) => !w.parentJobId && w.homeNeedsHuman)
    .sort((a, b) => Number(b.labels?.category === 'owner authorisation') - Number(a.labels?.category === 'owner authorisation'));

  if (!filtering) {
    rows.push(homeSummaryRow(board, input, width, now, true), boardRow(''));
  } else {
    rows.push(boardRow(''));
  }

  // A question is its row and its text until the owner opens it into the slab (Enter or a click).
  for (const worker of needs)
    rows.push(...(state.home.expanded?.has(targetKey({ kind: 'worker', laneId: worker.laneId, workerId: worker.id })) ? askSlabRows(worker, board, state, width, now) : askRows(worker, board, state, width, now)));
  if (!filtering && board.homeBrief) {
    rows.push(...flowLines(monitorText(board.homeBrief), width).map((s) => boardRow(theme.board.text(s))), boardRow(''));
  }
  const allWorkers = input?.workboard?.workers ?? board.workers;
  if (input) {
    const ordered =
      state.home.showAll && !board.workers.some((w) => w.homeRank !== undefined)
        ? board.lanes
        : orderedLanes(board, now, true);
    rows.push(...jobRows(input, ordered, state, width, now, allWorkers));
  }
  const source = input?.workboard;
  const visibleMainCount = board.workers.filter((w) => !w.parentJobId).length;
  if (filtering && !visibleMainCount) rows.push(boardRow(theme.board.muted('  ' + t('No matches'))));
  const hidden = source && !filtering ? source.workers.filter((w) => !w.parentJobId && !currentWorker(w, now, state.prefs)).length : 0;
  if (hidden) {
    rows.push(
      boardRow(theme.board.muted(t(state.home.showAll ? '{n} older shown · a hide' : '+{n} older · a', { n: hidden })))
    );
  }
  return rows;
}

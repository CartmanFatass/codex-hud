/** Shared package lanes on Home. Sonic children fold into `⚡N` on their parent worker; never sonic rows or cards. */
import type { WorkboardSnapshot, WorkLane, OwnerWorker } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { cardExpanded, failed, milestoneLine, pulseLine, renderWorkCard, workPhaseText } from './work-card.js';
import { boardRow, mark } from './workboard-rows.js';
import { pair, monitorText } from './monitor-text.js';
import { theme, visualLength, stripAnsi } from './colors.js';
import { currentWorker, foldedWorker, unattendedFailure, activeFlow } from './work-visibility.js';
import { isUnreadReport, laneSonicRunning, mainLaneWorkers, sonicBadge, sonicChildrenRunning } from './worker-roster.js';
import { t } from './i18n.js';

export function workerPriority(w: OwnerWorker, now: number): number {
  if (w.superseded) return 7;
  if (w.failureObserved) return 6;
  if (w.homeRank !== undefined) return -w.homeRank;
  const card = projectWorkCard(w, now);
  return w.homeNeedsHuman
    ? 0
    : card.state === 'stalled'
      ? 1
      : unattendedFailure(w)
        ? 2
        : isUnreadReport(w) || card.state === 'awaiting-acceptance'
          ? 3
          : card.state === 'in-progress' || activeFlow(w)
            ? 4
            : card.state === 'queued'
              ? 4.5
              : 5;
}

export function orderedLanes(board: WorkboardSnapshot, now: number): WorkLane[] {
  const rank = (lane: WorkLane) => {
    const main = mainLaneWorkers(lane);
    const list = main.length ? main : lane.workers;
    return list.length ? Math.min(...list.map((w) => workerPriority(w, now))) : 99;
  };
  return [...board.lanes].sort((a, b) => rank(a) - rank(b));
}

/**
 * A lane's right side: one state glyph per non-child job, oldest dispatch first (`✓●` unread, `✓` done, `◉` running,
 * `?` asking, `✗` failed, `○` queued, `◷` stalled, `−` stopped). Older jobs that do not fit `room` are `+N`.
 */
export function laneStrip(lane: WorkLane, state: MonitorState, now: number, room: number, extra = ''): string {
  const main = mainLaneWorkers(lane);
  const cards = [...main]
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((w) => projectWorkCard(w, now, state.prefs.cardStallMinutes));
  if (!cards.length) return extra;
  const glyph = {
    unread: theme.board.success(mark('✓●', '+*')),
    done: theme.board.success(mark('✓', '+')),
    run: theme.board.active(mark('◉', '@')),
    queue: theme.board.muted(mark('○', 'o')),
    stall: theme.board.stalled(mark('◷', '~')),
    ask: theme.board.attention('?'),
    fail: theme.board.danger(mark('✗', 'x')),
    stop: theme.board.muted(mark('−', '-')),
  };
  const tokens = cards.map((c) => {
    const kind =
      c.worker.state === 'stopped'
        ? 'stop'
        : failed(c)
          ? 'fail'
          : c.state === 'needs-you'
            ? 'ask'
            : c.state === 'queued'
              ? 'queue'
              : c.state === 'stalled'
                ? 'stall'
                : c.state === 'in-progress'
                  ? 'run'
                  : isUnreadReport(c.worker)
                    ? 'unread'
                    : 'done';
    const painted = glyph[kind];
    return c.worker.superseded ? theme.board.muted(stripAnsi(painted)) : painted;
  });
  const tail = extra ? ' ' + extra : '';
  let keep = tokens.length;
  const measure = (n: number) => {
    const slice = tokens.slice(-n);
    const olderW = n < tokens.length ? String(tokens.length - n).length + 2 : 0;
    return olderW + slice.reduce((sum, tok) => sum + visualLength(tok), 0) + Math.max(0, slice.length - 1);
  };
  while (keep > 1 && measure(keep) + visualLength(tail) > room) keep--;
  const older = tokens.length - keep ? theme.board.muted(`+${tokens.length - keep}`) + ' ' : '';
  return older + tokens.slice(-keep).join(' ') + tail;
}

/** A lane header's phase: a thin-job lane reads its non-child workers (`review r1 · fixing`, `landing`); others use their own. */
export function lanePhase(lane: WorkLane, visibleMain: readonly OwnerWorker[], now: number): string {
  let phase = lane.phase ?? '';
  if (lane.id.startsWith('thin-job:')) {
    const active = visibleMain
      .filter((w) => w.settledAt === null)
      .sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];
    const landing = !active && visibleMain.some((w) => w.flow?.kind === 'land' && activeFlow(w));
    const hasFail = !active && visibleMain.some((w) => unattendedFailure(w));
    const review = active?.work?.phases.filter((p) => p.startsWith('review')).at(-1);
    phase = active
      ? review
        ? review.includes('accept')
          ? review
          : `${review.match(/^review r\d+/)?.[0] ?? 'review'} · fixing`
        : ''
      : landing
        ? 'landing'
        : hasFail
          ? 'failed'
          : '';
  } else if (phase === 'working' || phase === 'done' || phase === 'build') {
    phase = '';
  }
  return phase;
}

export interface LaneRowsOptions {
  /** Skip asking workers already shown in the Ask Slab above. */
  skipAsking?: boolean;
  /** Full worker list for counting active sonic children even when a subset is rendered. */
  allWorkers?: readonly OwnerWorker[];
}

export function laneRows(
  _input: MonitorData,
  lane: WorkLane,
  state: MonitorState,
  width: number,
  now: number,
  opts: LaneRowsOptions = {}
): MonitorRow[] {
  const target = { kind: 'lane' as const, laneId: lane.id };
  const allMain = mainLaneWorkers(lane);
  const visibleMain = opts.skipAsking ? allMain.filter((w) => !w.homeNeedsHuman) : allMain;
  if (!visibleMain.length) return [];

  const phase = lanePhase(lane, visibleMain, now);

  const foldedLane = state.home.foldedLanes?.has(lane.id) === true;
  const labelText = monitorText(
    lane.identity.kind === 'native' ? lane.label.replace('this session', t('this session')) : lane.label
  );
  const label = `${theme.board.muted(labelText)}${phase ? '  ' + theme.board.muted(workPhaseText(phase)) : ''}`;
  const foldedSonic = foldedLane ? sonicBadge(laneSonicRunning(lane)) : '';
  const strip = laneStrip(
    { ...lane, workers: visibleMain },
    state,
    now,
    Math.max(Math.floor(width / 3), width - visualLength(label) - 1),
    foldedSonic
  );
  const header = pair(label, strip, width);
  const rows: MonitorRow[] = [
    boardRow(
      visibleMain.every((w) => !currentWorker(w, now, state.prefs)) ? theme.board.muted(stripAnsi(header)) : header,
      target
    ),
  ];
  if (foldedLane) return rows;

  const workers =
    state.home.showAll || lane.identity.kind === 'native'
      ? visibleMain
      : [...visibleMain].sort((a, b) => workerPriority(a, now) - workerPriority(b, now));
  const pool = opts.allWorkers ?? lane.workers;

  for (const worker of workers) {
    const card = projectWorkCard(worker, now, state.prefs.cardStallMinutes);
    const sentence = card.reason ? t(card.reason) : '';
    const indent = worker.nativeDepth === 2 ? '  ' : '';
    const room = Math.max(1, width - indent.length);
    const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: worker.id });
    const hidden = !currentWorker(worker, now, state.prefs);
    const expanded = cardExpanded(state, key);
    const folded = !expanded && (hidden || foldedWorker(worker, now, state.prefs));
    const sonic = sonicChildrenRunning(pool, worker.id);
    // Important workers (unhandled failures, unread reports before fold, land/scout flows, stalled, or expanded) show body rows;
    // secondary workers (routine running, queued, read settled) pack into a single dense row until Enter expands them.
    const prominent =
      expanded ||
      unattendedFailure(worker) ||
      (isUnreadReport(worker) && !folded) ||
      (!!worker.flow && (!folded || activeFlow(worker) || worker.flow.state === 'failed')) ||
      card.state === 'stalled' ||
      (worker.homeNeedsHuman && !!worker.modelSentence);
    let lines = renderWorkCard(card, state, room, sentence, '', { sonic, compact: !prominent });
    if (hidden && !expanded) lines = [theme.board.muted(stripAnsi(lines[0]))];
    if (expanded && worker.state === 'working' && !worker.homeNeedsHuman) {
      const milestone = milestoneLine(worker, room),
        pulse = pulseLine(worker, room);
      if (milestone) lines = [...lines, theme.board.body(milestone)];
      if (pulse) lines = [...lines, theme.board.body(pulse)];
    }
    rows.push(...lines.map((text) => ({ text: indent + text, item: key, key })));
  }
  return rows;
}

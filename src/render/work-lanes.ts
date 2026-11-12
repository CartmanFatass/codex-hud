/** Shared package lanes on Home. */
import type { WorkboardSnapshot, WorkLane, OwnerWorker } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { failed, renderWorkCard, workPhaseText } from './work-card.js';
import { boardRow, mark } from './workboard-rows.js';
import { pair, monitorText, fit } from './monitor-text.js';
import { theme, visualLength, stripAnsi } from './colors.js';
import { currentWorker } from './work-visibility.js';
import { t } from './i18n.js';
export function workerPriority(w: OwnerWorker, now: number): number {
  const card = projectWorkCard(w, now);
  return w.homeNeedsHuman
    ? 0
    : card.state === 'stalled'
      ? 1
      : w.work?.failed
        ? 2
        : card.state === 'awaiting-acceptance'
          ? 3
          : card.state === 'in-progress'
            ? 4
            : 5;
}
export function orderedLanes(board: WorkboardSnapshot, now: number): WorkLane[] {
  return [...board.lanes].sort(
    (a, b) =>
      Math.min(...a.workers.map((w) => workerPriority(w, now))) -
      Math.min(...b.workers.map((w) => workerPriority(w, now)))
  );
}
/**
 * A lane's right side: one glyph per job, oldest dispatch first (`✓` done, `◉` running, `?` asking, `✗` failed, `−`
 * stopped), then the role of the newest job running or asking. Older jobs that do not fit `room` are `+N`.
 */
export function laneStrip(lane: WorkLane, state: MonitorState, now: number, room: number): string {
  const cards = [...lane.workers]
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((w) => projectWorkCard(w, now, state.cardStallMinutes));
  const glyph = {
    done: theme.board.success(mark('✓', '+')),
    run: theme.board.active(mark('◉', '@')),
    ask: theme.board.attention('?'),
    fail: theme.board.danger(mark('✗', 'x')),
    stop: theme.board.muted(mark('−', '-')),
  };
  const kinds = cards.map((c) =>
    c.worker.state === 'stopped'
      ? 'stop'
      : failed(c)
        ? 'fail'
        : c.state === 'needs-you'
          ? 'ask'
          : c.state === 'in-progress' || c.state === 'stalled'
            ? 'run'
            : 'done'
  );
  const live = kinds.map((k) => k === 'run' || k === 'ask').lastIndexOf(true);
  const role = live < 0 ? '' : ' ' + theme.board.muted(monitorText(cards[live].role));
  let keep = cards.length;
  const width = (n: number) => 2 * n - 1 + (n < cards.length ? String(cards.length - n).length + 2 : 0);
  while (keep > 1 && width(keep) + visualLength(role) > room) keep--;
  const older = cards.length - keep ? theme.board.muted(`+${cards.length - keep}`) + ' ' : '';
  const glyphs = kinds.slice(-keep).map((k) => glyph[k]);
  return older + glyphs.join(' ') + role;
}
export function laneRows(
  input: MonitorData,
  lane: WorkLane,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const target = { kind: 'lane' as const, laneId: lane.id };
  if (lane.id.startsWith('thin-job:')) {
    const active = [...lane.workers]
      .filter((w) => w.settledAt === null)
      .sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];
    const review = active?.work?.phases.filter((p) => p.startsWith('review')).at(-1);
    const phase = active
      ? review
        ? review.includes('accept')
          ? review
          : `${review.match(/^review r\d+/)?.[0]} · fixing`
        : (active.phase ?? 'build')
      : 'done';
    lane = { ...lane, phase };
  }
  const label = `${monitorText(lane.identity.kind === 'native' ? lane.label.replace('this session', t('this session')) : lane.label)}${lane.phase ? '  ' + workPhaseText(lane.phase) : ''}`;
  const strip = laneStrip(lane, state, now, Math.max(Math.floor(width / 3), width - visualLength(label) - 1));
  const header = pair(label, strip, width);
  const rows = [
    boardRow(lane.workers.every((w) => !currentWorker(w, now)) ? theme.board.muted(stripAnsi(header)) : header, target),
  ];
  if (state.boardFolded?.has(lane.id)) return rows;
  const workers =
    state.tree.showAll || lane.identity.kind === 'native'
      ? lane.workers
      : [...lane.workers].sort((a, b) => workerPriority(a, now) - workerPriority(b, now));
  for (const worker of workers) {
    const card = projectWorkCard(worker, now, state.cardStallMinutes);
    const sentence = card.reason ? t(card.reason) : '';
    const indent = worker.nativeDepth === 2 ? '  ' : '';
    const room = Math.max(1, width - indent.length);
    const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: worker.id });
    // Home's asking card is a title-only pointer back to the complete slab.
    let lines =
      worker.homeNeedsHuman && !worker.modelSentence
        ? renderWorkCard(card, state, room, '').slice(0, 1)
        : renderWorkCard(card, state, room, sentence);
    if (!currentWorker(worker, now) && !state.boardExpanded?.has(key)) lines = [theme.board.muted(stripAnsi(lines[0]))];
    rows.push(...lines.map((text) => ({ text: indent + text, item: key, key })));
  }
  rows.push(boardRow(''));
  return rows;
}

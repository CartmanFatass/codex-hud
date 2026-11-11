/** Shared package lanes on Home and Work. */
import type { WorkboardSnapshot, WorkLane, OwnerWorker } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { renderWorkCard, workPhaseText } from './work-card.js';
import { boardRow, mark } from './workboard-rows.js';
import { fit, pair, monitorText } from './monitor-text.js';
import { theme } from './colors.js';
import { t, language } from './i18n.js';
export const FINISHED_LINGER_MS = 10 * 60000;
export function retainedWorker(w: OwnerWorker, now: number, showAll = false): boolean {
  return (
    showAll ||
    !w.id.startsWith('thin-job:') ||
    w.settledAt === null ||
    w.work?.facadeClosed === false ||
    now - Math.max(w.settledAt, w.work?.facadeClosedAt ?? 0) <= FINISHED_LINGER_MS
  );
}
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
export function lineMap(lane: WorkLane, width: number): string {
  const stages = ['build', 'review', 'accept', 'done'];
  // Fixing is the observed substage between review and acceptance, not a percentage.
  const stage = lane.phase?.includes('fixing')
    ? 1.6
    : Math.max(0, stages.indexOf(lane.phase?.startsWith('review') ? 'review' : (lane.phase ?? 'build')));
  const at = Math.round((stage * (width - 1)) / 3);
  return Array.from({ length: width }, (_, i) =>
    i === at
      ? theme.value(mark('◉', '@'))
      : stages.some((_, n) => Math.round((n * (width - 1)) / 3) === i)
        ? i < at
          ? theme.board.active(mark('●', 'o'))
          : theme.board.frame(mark('○', 'o'))
        : i < at
          ? theme.board.active(mark('━', '='))
          : theme.board.frame(mark('─', '-'))
  ).join('');
}
export function laneRows(
  input: MonitorData,
  lane: WorkLane,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const work = state.mainTab === 'work',
    target = { kind: 'lane' as const, laneId: lane.id };
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
        : 'build'
      : lane.workers.some((w) => projectWorkCard(w, now).state === 'awaiting-acceptance')
        ? 'accept'
        : 'done';
    lane = { ...lane, phase };
  }
  const label = `${monitorText(lane.label)}${lane.phase ? '  ' + workPhaseText(lane.phase) : ''}`;
  const rows = [boardRow(work ? fit(label, width) : pair(label, lineMap(lane, 16), width), target)];
  if (work) {
    const names = [t('build'), t('review'), language() === 'zh' ? t('acceptance') : t('accept'), t('done')];
    const step = Math.floor((width - 3) / 3);
    rows.push(
      boardRow(
        fit(
          '  ' +
            fit(names[0], step) +
            fit(names[1], step) +
            pair(names[2], names[3], Math.max(0, width - 3 - 2 * step)),
          width
        )
      )
    );
    rows.push(boardRow('  ' + lineMap(lane, Math.max(1, width - 3))), boardRow(''));
  }
  if (state.boardFolded?.has(lane.id)) return rows;
  const workers = [...lane.workers]
    .filter((w) => retainedWorker(w, now, state.tree.showAll))
    .sort((a, b) => workerPriority(a, now) - workerPriority(b, now));
  for (const worker of workers) {
    const card = projectWorkCard(worker, now, state.cardStallMinutes);
    const logs = worker.nodeId ? input.agentLog?.get(worker.nodeId) : undefined;
    const sentence = worker.id.startsWith('thin-job:')
      ? (card.reason ?? '')
      : (input.jobProgress?.get(worker.id)?.note?.line ??
        [...(logs ?? [])].reverse().find((e) => ['note', 'digest', 'cause'].includes(e.kind))?.text ??
        '');
    const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: worker.id });
    // Home's asking card is a title-only pointer back to the complete slab.
    const lines =
      !work && worker.homeNeedsHuman
        ? renderWorkCard(card, state, width, '').slice(0, 1)
        : renderWorkCard(card, state, width, sentence);
    rows.push(...lines.map((text) => ({ text, item: key, key, sentenceWorkers: [worker.id] })));
    if (work) rows.push(boardRow(''));
  }
  if (!work) rows.push(boardRow(''));
  return rows;
}

/** The one lane/card layout used by Work and the 110-column Home peek. */
import type { WorkboardSnapshot, WorkLane } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { renderWorkCard, workCardHeight, cardSentence, workPhaseText } from './work-card.js';
import { laneRow, decisionRows, mark, boardCursor } from './workboard-rows.js';
import { fit } from './monitor-text.js';
import { theme } from './colors.js';
import { facadeOnly } from './job-details.js';
export function laneRows(
  input: MonitorData,
  lane: WorkLane,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const phases = new Set(
    lane.workers.map((worker) => {
      const card = projectWorkCard(worker, now, state.cardStallMinutes);
      return card.state === 'done'
        ? 'done'
        : card.state === 'awaiting-acceptance'
          ? 'awaiting-acceptance'
          : (card.phases.at(-1) ?? null);
    })
  );
  const phase = phases.size > 1 ? 'mixed' : phases.size ? [...phases][0] : lane.phase;
  const header = laneRow(
    { ...lane, title: lane.title === lane.label ? '' : lane.title, phase },
    width,
    now,
    true,
    phase && phase !== 'awaiting-acceptance' ? workPhaseText(phase) : undefined
  );
  if (state.boardFolded?.has(lane.id)) return [header];
  const wide = width >= 100;
  const column = wide ? Math.floor((width - 3) / 2) : width;
  const cards: MonitorRow[][] = lane.workers.map((worker) => {
    const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: worker.id });
    const nativeName =
      lane.identity.kind === 'native' && (state.cardVisibility?.cardLabel === false || state.labelAsName === false)
        ? input.tree.nodes.find((n) => n.id === worker.nodeId)?.name
        : undefined;
    const card = projectWorkCard(nativeName ? { ...worker, task: nativeName } : worker, now, state.cardStallMinutes);
    // Only an existing native subject can reuse its existing native grant; job/task text is never material.
    const nativeNode = worker.nodeId
      ? input.tree.nodes.find((n) => n.id === worker.nodeId && !facadeOnly(n))
      : undefined;
    const logs = nativeNode ? input.agentLog?.get(nativeNode.id) : undefined;
    const raw =
      state.cardVisibility?.cardSummary !== false
        ? [...(logs ?? [])].reverse().find((e) => ['note', 'digest', 'cause'].includes(e.kind))?.text
        : undefined;
    const sentence = raw ? cardSentence(raw) : '';
    const expanded = state.boardExpanded?.has(key) === true;
    let rendered: readonly string[] | undefined;
    const draw = () => (rendered ??= renderWorkCard(card, state, column, sentence, expanded, false, raw));
    const count = workCardHeight(card, sentence, expanded, raw, column);
    return Array.from({ length: count }, (_, i) => ({
      text: '',
      item: key,
      key,
      paint: () => {
        const text = draw()[i] ?? fit('', column);
        return i === 0 && state.workTarget && targetKey(state.workTarget) === key ? boardCursor(text) : text;
      },
    }));
  });
  // Reserve the right-column cursor cell without replacing a decision's semantic ! / · marker.
  const calls = lane.decisions
    .flatMap((d) => decisionRows(d, lane, state, Math.max(1, column - 1), now))
    .map((row) => ({ ...row, text: ' ' + row.text }));
  if (!wide) return [header, ...cards.flat(), ...calls];
  const left: MonitorRow[] = [],
    right: MonitorRow[] = [];
  if (calls.length) {
    left.push(...cards.flat());
    right.push(...calls);
  } else
    cards.forEach((rows, i) => {
      (i % 2 ? right : left).push(...rows);
    });
  const result = [header];
  let rightCursor = false;
  const selected = state.workTarget ? targetKey(state.workTarget) : '';
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i],
      b = right[i];
    const selectedRight = !rightCursor && !!b?.item && b.item === selected;
    if (selectedRight) rightCursor = true;
    const paintRight = () => {
      const text = b?.paint?.() ?? b?.text ?? '';
      return selectedRight ? boardCursor(text) : text;
    };
    result.push({
      text: '',
      item: a?.item,
      key: a?.key,
      paint: () =>
        fit(a?.paint?.() ?? a?.text ?? '', column) +
        theme.frame(` ${mark('│', '|')} `) +
        fit(paintRight(), width - column - 3),
      controls: [
        ...(a?.item ? [{ kind: 'board-pick' as const, item: a.item, x: 0, width: column }] : []),
        ...(b?.item ? [{ kind: 'board-pick' as const, item: b.item, x: column + 3, width: width - column - 3 }] : []),
      ],
    });
  }
  return result;
}
export function laneTargets(board: WorkboardSnapshot, state: MonitorState): string[] {
  return board.lanes.flatMap((lane) => [
    targetKey({ kind: 'lane', laneId: lane.id }),
    ...(state.boardFolded?.has(lane.id)
      ? []
      : [
          ...lane.workers.map((w) => targetKey({ kind: 'worker', laneId: lane.id, workerId: w.id })),
          ...lane.decisions.map((d) => targetKey({ kind: 'decision', laneId: lane.id, decisionId: d.id })),
        ]),
  ]);
}

/**
 * Split Home: a list with one row per package lane and per block (waiting, decided, progress), and below it the preview of the
 * row under the cursor: the question slab and today's cards, the waiting items and latest slices, the decisions, or the progress
 * block. The list is the same height whatever runs; a question or a failure keeps a reason row, so what needs the owner is
 * always a row, and the cursor starts on the first of them.
 */
import { targetKey, type OwnerWorker, type WorkboardSnapshot, type WorkLane, type WorkTarget } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { askSlabRows, markNewest } from './home-view.js';
import { laneRows, orderedLanes, workerPriority } from './work-lanes.js';
import { ageText, failed, stemLines, workCardDetail, workPhaseText, workStateGlyph, workStateInk, workStateWord } from './work-card.js';
import { barText, currentRows, homeProgressRows, inline, landedAge, landedMark, landedNewest, ledgerText, roleInk, waitingRows } from './project-view.js';
import { boardRow, decisionBlock, mark, minuteAge, section } from './workboard-rows.js';
import { splitScope, splitSubValid, type SplitScene } from './split-frame.js';
import { fit, flowLines, monitorText, pair } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';

const WAITING = 'home-progress:waiting', PROGRESS = 'home-progress:progress', DECIDED = 'split:decided';
interface Entry { item: string; needs: boolean; rows: MonitorRow[]; preview: () => { label: string; right?: string; rows: MonitorRow[] } }
/** A lane's phase as Home's lane header says it: a thin-job lane reads it off its newest job. */
function lanePhase(lane: WorkLane, now: number): string {
  if (!lane.id.startsWith('thin-job:')) return lane.phase ?? '';
  const active = lane.workers.filter((w) => w.settledAt === null).sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];
  const review = active?.work?.phases.filter((p) => p.startsWith('review')).at(-1);
  if (!active) return 'done';
  return review ? (review.includes('accept') ? review : `${review.match(/^review r\d+/)?.[0] ?? review} · fixing`) : (active.phase ?? 'build');
}
const tries = (waiting: readonly { value: string }[]) => waiting.filter((r) => /^try\b/i.test(r.value)).length;
/** The target the lane's acting job is: the one that asks, else the most important. */
export const laneTop = (lane: WorkLane, now: number): OwnerWorker =>
  [...lane.workers].sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];

export function homeScene(
  input: MonitorData, board: WorkboardSnapshot, state: MonitorState, targets: ReadonlyMap<string, WorkTarget>, width: number, now: number, done: number,
): SplitScene {
  markNewest(board, state, now);
  const data = input.project, group = (lane: WorkLane) => Math.min(...lane.workers.map((w) => workerPriority(w, now)));
  const lanes = (state.tree.showAll && !board.workers.some((w) => w.homeRank !== undefined) ? board.lanes : orderedLanes(board, now)).filter((l) => l.workers.length);
  const names = lanes.map((l) => monitorText(l.identity.kind === 'native' ? l.label.replace('this session', t('this session')) : l.label));
  const col = Math.max(8, Math.min(14, Math.floor(width / 3), Math.max(0, ...names.map(visualLength))));
  const laneEntry = (lane: WorkLane, i: number): Entry => {
    const top = laneTop(lane, now), card = projectWorkCard(top, now, state.cardStallMinutes), item = targetKey({ kind: 'lane', laneId: lane.id });
    const native = lane.identity.kind === 'native', running = lane.workers.filter((w) => w.settledAt === null).length, phase = lanePhase(lane, now);
    const ink = workStateInk(card), word = workStateWord(card);
    const age = top.homeNeedsHuman ? minuteAge(top.humanEndedAt, now) : top.settledAt !== null ? minuteAge(top.settledAt, now) : ageText(card.elapsedMinutes ?? 0);
    // A lane whose jobs have all settled says how many; one that failed says who ran it (the right side says it failed).
    const mid = native ? t('native') : phase === 'done' ? (failed(card) ? monitorText(card.role) : t('{n} done', { n: lane.workers.length })) : workPhaseText(phase);
    const right = native ? theme.board.muted(t('{n} running', { n: running })) : word
      ? `${ink(word)} ${theme.board.muted(age)}` : `${roleInk(card.role)(monitorText(card.role))} ${theme.board.muted(age)}`;
    const rows: MonitorRow[] = [{ text: pair(`${ink(workStateGlyph(card))} ${fit(names[i], col)} ${theme.board.muted(mid)}`, right, width), item }];
    // A question or a failure keeps its reason on a row of its own: it is what the owner opens the panel for.
    const why = top.homeNeedsHuman ? top.work?.requestInfo?.question ?? top.ask ?? card.reason ?? '' : failed(card) ? workCardDetail(card) : '';
    if (why) rows.push({ text: stemLines(why, width, ink, 1)[0], item });
    return { item, needs: group(lane) <= 2, rows, preview: () => {
      const slabs = board.workers.filter((w) => w.homeNeedsHuman && w.laneId === lane.id).flatMap((w) => askSlabRows(w, board, state, width, now));
      // The asking job's pointer card is the slab above it; every other card is today's, and no fold hides one here.
      const cards = laneRows(input, { ...lane, workers: lane.workers.filter((w) => !w.homeNeedsHuman) }, { ...state, boardFolded: undefined }, width, now).slice(1, -1);
      return { label: names[i], right: [mid, t('{n} jobs', { n: lane.workers.length })].join(' · '), rows: [...slabs, ...cards] };
    } };
  };
  const waits = data?.waiting ?? [];
  const waiting: Entry[] = !waits.length ? [] : [{ item: WAITING, needs: true, rows: [{ item: WAITING,
    text: pair(`${theme.board.attention('?')} ${t('Waiting for you')}`, theme.board.muted([waits.length, tries(waits) && t('{n} to try', { n: tries(waits) })].filter(Boolean).join(' · ')), width) }],
  preview: () => ({ label: t('Waiting for you'), right: [waits.length, tries(waits) && t('{n} to try', { n: tries(waits) })].filter(Boolean).join(' · '), rows: [
    ...waits.flatMap((r, i) => waitingRows(r, i, width, now, true).map((row) => ({ ...row, item: `home-progress:wait:${i}` }))),
    ...(landedNewest(data!).length ? [boardRow(''), section(t('Latest'), width, t('newest first')), ...landedNewest(data!).slice(0, width < 56 ? 3 : 5).map(({ r }): MonitorRow => ({
      text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now), width), item: 'home-progress:latest' }))] : [])] }) }];
  const departures = board.decisions.filter((d) => d.departure).length;
  const decided: Entry[] = !board.decisions.length ? [] : [{ item: DECIDED, needs: false, rows: [{ item: DECIDED,
    text: pair(`${departures ? theme.board.attention(mark('◆', '*')) : theme.board.muted(mark('◇', 'o'))} ${t('Decided for you')}`,
      theme.board.muted([board.decisions.length, departures && t('{n} worth a look', { n: departures })].filter(Boolean).join(' · ')), width) }],
  preview: () => ({ label: t('Decided for you'), right: String(board.decisions.length), rows: decisionBlock(board, state, width, now, input.workboard).slice(1) }) }];
  const block = data ? homeProgressRows(data, width, 99, false) : [];
  // Recommended mode's brief paragraph is the Progress row's preview, where the summary is.
  const brief = board.homeBrief ? [...flowLines(monitorText(board.homeBrief), width).map((l) => boardRow(theme.board.text(l))), boardRow('')] : [];
  const progress: Entry[] = !block.length && !brief.length ? [] : (() => {
    const cur = data ? currentRows(data) : undefined, total = cur ? cur.rows.length - cur.counts.dropped : 0, milestone = data?.ladder.current && cur && !(cur.whole && cur.rows.length) ? monitorText(data.ladder.current) : '';
    return [{ item: PROGRESS, needs: false, rows: [{ item: PROGRESS, text: pair(`${theme.board.active(mark('◐', '@'))} ${t('Progress')}${milestone ? '  ' + theme.board.muted(milestone) : ''}`,
      total && cur ? `${barText({ counts: cur.counts }, 14)} ${theme.board.muted(`${cur.counts.accepted}/${total}`)}` : '', width) }],
    preview: () => ({ label: t('Progress'), right: milestone && `${t('Milestone')} ${milestone}`, rows: [...brief, ...block.slice(1)] }) }];
  })();
  const entries = [...lanes.flatMap((l, i) => (group(l) <= 4 ? [laneEntry(l, i)] : [])), ...waiting,
    ...lanes.flatMap((l, i) => (group(l) <= 4 ? [] : [laneEntry(l, i)])), ...decided, ...progress];
  const items = entries.map((e) => e.item);
  const cursor = state.splitCursor && items.includes(state.splitCursor) ? state.splitCursor : (entries.find((e) => e.needs) ?? entries[0])?.item;
  state.splitCursor = cursor;
  const entry = entries.find((e) => e.item === cursor), shown = entry?.preview() ?? { label: '', rows: [] };
  const scope = `home|${cursor}`;
  splitScope(state, scope);
  const sub = splitSubValid(state, shown.rows);
  if (state.splitFocus && !sub) state.splitFocus = undefined;
  // `o` and `v` act on the job under the cursor: the lane's, or the card the keys are on in the preview.
  const lane = lanes.find((l) => targetKey({ kind: 'lane', laneId: l.id }) === cursor), at = sub ?? cursor;
  state.boardAnchor = at && /^(home-progress:|split:)/.test(at) ? at : undefined;
  if (!state.boardAnchor) state.homeTarget = sub ? targets.get(sub) : lane ? { kind: 'worker', laneId: lane.id, workerId: laneTop(lane, now).id } : state.homeTarget;
  return {
    list: entries.length ? entries.flatMap((e) => e.rows) : [boardRow(theme.board.muted(fit('  ' + t('Nothing in progress'), width)))],
    cursor, rule: { label: shown.label, right: shown.right }, preview: shown.rows, sub, scope,
    left: done ? theme.board.success(`${mark('✓', '+')} ${t('{n} done today', { n: done })}`) : '',
    hints: sub ? '↑↓ move  ⏎ expand  esc back  PgUp PgDn scroll  o open  v inspect  ? help' : '↑↓ move  ⏎ open  PgUp PgDn scroll  o open  v inspect  a all  , settings  ? help  ←→ tab',
  };
}

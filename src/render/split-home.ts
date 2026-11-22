/**
 * Split Home: a list with one row per package lane and per block (waiting, progress), and below it the preview of the
 * row under the cursor: the question slab and today's cards, the waiting items and latest work, or the progress
 * block. The list is the same height whatever runs; a question or a failure keeps a reason row, so what needs the owner is
 * always a row, and the cursor starts on the first of them.
 */
import { targetKey, type OwnerWorker, type WorkboardSnapshot, type WorkLane, type WorkTarget } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { askSlabRows } from './home-view.js';
import { homeCursor, homeTarget, type HomeCursor } from './monitor-state.js';
import { homeKeys } from './job-actions.js';
import { laneRows, orderedLanes, workerPriority } from './work-lanes.js';
import type { WorkCard } from '../collectors/work-card.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import { ageText, failed, paintSentence, phaseChain, stemLines, workCardDetail, workPhaseText, workStateGlyph, workStateInk, workStateWord } from './work-card.js';
import { acceptedText, briefStack, currentRows, homeProgressRows, landedAge, landedInline, landedMark, landedEntries, roleInk, taskRows, tryCount, trySentence, waitingRows } from './project-view.js';
import { boardRow, homeDoneCount, mark, minuteAge, originalRows, section } from './workboard-rows.js';
import { splitSubValid, type SplitScene } from './split-frame.js';
import { cutWords, fit, flowLines, monitorText, pair } from './monitor-text.js';
import { stripAnsi, theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';

const WAITING = 'home-progress:waiting', PROGRESS = 'home-progress:progress';
interface Entry { item: string; needs: boolean; rows: MonitorRow[]; /** The lane's first row with a working cue, shown while the cursor is elsewhere. */ cued?: MonitorRow; preview: () => { label: string; right?: string; rows: MonitorRow[] } }
/** A lane's phase as Home's lane header says it: a thin-job lane reads it off its newest job. */
function lanePhase(lane: WorkLane, now: number): string {
  if (!lane.id.startsWith('thin-job:')) return lane.phase ?? '';
  const active = lane.workers.filter((w) => w.settledAt === null).sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];
  const review = active?.work?.phases.filter((p) => p.startsWith('review')).at(-1);
  if (!active) return 'done';
  return review ? (review.includes('accept') ? review : `${review.match(/^review r\d+/)?.[0] ?? review} · fixing`) : (active.phase ?? 'build');
}
const CUE_MIN = 6;
/** What a working lane's row says in its free cells: the model sentence's marked keywords that fit, else the card's reason or its phases so far. Nothing when `room` is short. */
function laneCue(card: WorkCard, room: number): string {
  if (room < CUE_MIN) return '';
  const { plain, spans } = keywordMarks(monitorText(card.worker.modelSentence ?? ''));
  let used = 0;
  const picked: string[] = [];
  for (const span of spans) {
    const word = plain.slice(span.start, span.end), need = visualLength(word) + (picked.length ? 1 : 0);
    if (used + need > room) break;
    used += need;
    picked.push(`«${span.type}${word}»`);
  }
  if (picked.length) return paintSentence(picked.join(' '));
  const fact = cutWords(monitorText(card.reason ? t(card.reason) : card.phases.length > 1 ? phaseChain(card) : ''), room);
  return fact ? theme.board.muted(fact) : '';
}
/** The target the lane's acting job is: the one that asks, else the most important. */
export const laneTop = (lane: WorkLane, now: number): OwnerWorker =>
  [...lane.workers].sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];

export function homeScene(
  input: MonitorData, board: WorkboardSnapshot, state: MonitorState, targets: ReadonlyMap<string, WorkTarget>, width: number, now: number, done: number,
): SplitScene & { homeCursor?: HomeCursor } {
  // With a `/` filter the list is the lanes that match: the waiting and progress blocks are the whole project's.
  const filtering = !!state.home.filter?.query;
  const data = input.project, group = (lane: WorkLane) => Math.min(...lane.workers.map((w) => workerPriority(w, now)));
  const lanes = (state.home.showAll && !board.workers.some((w) => w.homeRank !== undefined) ? board.lanes : orderedLanes(board, now)).filter((l) => l.workers.length);
  const names = lanes.map((l) => monitorText(l.identity.kind === 'native' ? l.label.replace('this session', t('this session')) : l.label));
  const col = Math.max(8, Math.min(14, Math.floor(width / 3), Math.max(0, ...names.map(visualLength))));
  const laneEntry = (lane: WorkLane, i: number): Entry => {
    const top = laneTop(lane, now), card = projectWorkCard(top, now, state.prefs.cardStallMinutes), item = targetKey({ kind: 'lane', laneId: lane.id });
    const native = lane.identity.kind === 'native', running = lane.workers.filter((w) => w.settledAt === null).length, phase = lanePhase(lane, now);
    const ink = workStateInk(card), word = workStateWord(card);
    const age = top.homeNeedsHuman ? minuteAge(top.humanEndedAt, now) : top.settledAt !== null ? minuteAge(top.settledAt, now) : ageText(card.elapsedMinutes ?? 0);
    // The state word is said once, on the right. The middle says what else is known: a running lane's phase; for a lane that asks,
    // failed or finished, the role (a finished lane of several jobs, how many) and never the word again.
    const role = monitorText(card.role), jobs = t('{n} jobs', { n: lane.workers.length }), phaseText = workPhaseText(phase);
    const mid = native ? t('subagents') : failed(card) || phase === 'done' ? (lane.workers.length > 1 && !failed(card) ? jobs : role) : word && phaseText.includes(word) ? role : phaseText;
    const right = native ? theme.board.muted(t('{n} running', { n: running })) : word
      ? `${ink(word)} ${theme.board.muted(age)}` : `${roleInk(card.role)(role)} ${theme.board.muted(age)}`;
    // A middle that does not fit the row whole goes on a row of its own, not cut.
    const suffix = !native && names[i].match(/[-/#]\d+$/)?.[0];
    const label = suffix && visualLength(names[i]) > col ? truncateAnsi(names[i], col - suffix.length) + suffix : names[i];
    const head = `${ink(workStateGlyph(card))} ${fit(label, col)}`, own = visualLength(head) + 1 + visualLength(mid) + 1 + visualLength(right) > width;
    const lead = own ? head : `${head} ${theme.board.muted(mid)}`;
    const rows: MonitorRow[] = [{ text: pair(lead, right, width), item }];
    if (own) rows.push({ text: fit(`  ${theme.board.muted(mid)}`, width), item });
    if (top.superseded) for (const row of rows) row.text = theme.board.muted(stripAnsi(row.text));
    // A job at work shows what it is on in the row's free cells, while the cursor is elsewhere.
    const cue = card.state === 'in-progress' && top.settledAt === null ? laneCue(card, width - visualLength(lead) - visualLength(right) - 2) : '';
    // A question or a failure keeps its reason on a row of its own: it is what the owner opens the panel for.
    const why = top.homeNeedsHuman ? top.work?.requestInfo?.display?.question ?? top.work?.requestInfo?.question ?? top.ask ?? card.reason ?? '' : failed(card) && !top.superseded && !top.failureObserved ? workCardDetail(card) : '';
    if (why) rows.push({ text: stemLines(why, width, ink, 1)[0], item });
    return { item, needs: group(lane) <= 2, rows, cued: cue ? { text: pair(`${lead} ${cue}`, right, width), item } : undefined, preview: () => {
      const slabs = board.workers.filter((w) => w.homeNeedsHuman && w.laneId === lane.id).flatMap((w) => askSlabRows(w, board, state, width, now, true));
      // The asking job's pointer card is the slab above it; every other card is today's, and no fold hides one here.
      const cards = laneRows(input, { ...lane, workers: lane.workers.filter((w) => !w.homeNeedsHuman) }, { ...state, home: { ...state.home, foldedLanes: new Set() } }, width, now).slice(1, -1);
      return { label: names[i], right: [mid, mid === jobs ? '' : jobs].filter(Boolean).join(' · '), rows: [...slabs, ...cards] };
    } };
  };
  const waits = data?.waiting ?? [], n = data ? tryCount(data, state.prefs.acceptance) : 0;
  const waitFacts = [waits.length && t(waits.length === 1 ? '{n} ask' : '{n} asks', { n: waits.length }), n && t('{n} to try', { n })].filter(Boolean).join(' · ');
  const pendingRows = () => {
    if (!data || !n) return [];
    const latest = landedEntries(data, state.prefs.acceptance, true).filter(entry => 'task' in entry || entry.r.state === 'try').slice(0, width < 56 ? 3 : 5).flatMap((entry): MonitorRow[] => {
      if ('task' in entry) return taskRows(entry.task, data, state, width, now, input.tryMarks, true, state.home.expandedTasks);
      const { r } = entry, head = `  ${landedMark(r)} ${monitorText(r.id)}`, age = landedAge(r, now);
      return (trySentence(r) ? briefStack(head, trySentence(r), age, width) : [landedInline(r, head, age, width)])
        .map((text) => ({ text, item: `home-progress:latest:${r.id}`, tryTarget: { milestone: r.milestone, slices: [r] } }));
    });
    return [boardRow(''), section(t('To try'), width, String(n)), ...latest];
  };
  const waiting: Entry[] = filtering || (!waits.length && !n) ? [] : [{ item: WAITING, needs: true, rows: [{ item: WAITING,
    text: pair(`${theme.board.attention('?')} ${t('Waiting for you')}`, theme.board.muted(waitFacts), width) }],
  preview: () => ({ label: t('Waiting for you'), right: waitFacts, rows: [
      ...waits.flatMap((r, i) => [...waitingRows(r, i, width, now, Infinity).map((row) => ({ ...row, item: `home-progress:wait:${i}` })),
        ...originalRows(r.original, `original:wait:${i}`, state.home.expanded.has(`original:wait:${i}`), width)]),
      ...pendingRows(),
    ] }) }];
  const block = data ? homeProgressRows(data, width, Infinity, false, state.prefs.acceptance, state.home.expanded) : [];
  // Recommended mode's brief paragraph is the Progress row's preview, where the summary is.
  const brief = board.homeBrief ? [...flowLines(monitorText(board.homeBrief), width).map((l) => boardRow(theme.board.text(l))), boardRow('')] : [];
  const progress: Entry[] = filtering || (!block.length && !brief.length) ? [] : (() => {
    const cur = data ? currentRows(data) : undefined, milestone = data?.ladder.current && cur && !(cur.whole && cur.rows.length) ? monitorText(data.ladder.current) : '';
    const lead = `${theme.board.active(mark('◐', '@'))} ${t('Progress')}`, facts = milestone ? [milestone] : [];
    if (cur?.rows.length) {
      const tries = tryCount({ ledger: cur.rows }, state.prefs.acceptance), working = cur.counts.working;
      if (tries || working) {
        const full = [t('{n} to try', { n: tries }), `${working} ${t('working')}`];
        facts.push(...(visualLength([lead, ...facts, ...full].join(' · ')) <= width ? full : [t('{n} try', { n: tries }), t('{n} live', { n: working })]));
      } else if (cur.rows.length > cur.counts.dropped) facts.push(acceptedText(cur.counts, cur.rows.length));
    }
    while (facts.length > 1 && visualLength(lead) + 2 + visualLength(facts.join(' · ')) > width) facts.pop();
    return [{ item: PROGRESS, needs: false, rows: [{ item: PROGRESS, text: pair(lead, theme.board.muted(facts.join(' · ')), width) }],
    preview: () => ({ label: t('Progress'), right: milestone && `${t('Milestone')} ${milestone}`, rows: [...brief, ...block.slice(1), ...pendingRows()] }) }];
  })();
  const entries = [...lanes.flatMap((l, i) => (group(l) <= 4 ? [laneEntry(l, i)] : [])), ...waiting,
    ...lanes.flatMap((l, i) => (group(l) <= 4 ? [] : [laneEntry(l, i)])), ...progress];
  const items = entries.map((e) => e.item);
  const split = state.home.split, atList = split.listCursor;
  const cursor = atList && items.includes(atList) ? atList : (entries.find((e) => e.needs) ?? entries[0])?.item;
  const entry = entries.find((e) => e.item === cursor), shown = entry?.preview() ?? { label: '', rows: [] };
  const scope = `home|${cursor}`, sub = splitSubValid(split, shown.rows);
  // `o` and `v` act on the job under the cursor: the lane's, or the card the keys are on in the preview.
  const lane = lanes.find((l) => targetKey({ kind: 'lane', laneId: l.id }) === cursor), at = sub ?? cursor;
  const anchor = at && /^(home-progress:|split:|original:|project:fold:(task|ledger):)/.test(at) ? at : undefined;
  const target = anchor ? homeTarget(state.home) : sub ? targets.get(sub)
    : lane ? { kind: 'worker' as const, laneId: lane.id, workerId: laneTop(lane, now).id } : homeTarget(state.home);
  const selected = homeCursor(target, anchor);
  return {
    homeCursor: selected,
    nav: { scroll: state.home.scroll, revealed: state.home.revealed, split: { ...split, focus: sub ? 'preview' : 'list', listCursor: cursor,
      previewFor: scope, previewScroll: split.previewFor === scope ? split.previewScroll : 0 } },
    list: entries.length ? entries.flatMap((e) => (e.cued && e.item !== cursor ? [e.cued, ...e.rows.slice(1)] : e.rows)) : [boardRow(theme.board.muted(fit('  ' + t(filtering ? 'No matches' : 'Nothing in progress'), width)))],
    cursor, rule: { label: shown.label, right: shown.right }, preview: shown.rows, sub, scope,
    left: homeDoneCount(done, width),
    hints: shown.rows.some((r) => r.item === sub && r.tryTarget) ? ['Space mark', 'y accept', 'n flag', '⏎ details', 'Esc back', 'o file']
      : homeKeys({ ...state, home: { ...state.home, cursor: selected } }, board, sub ? 'expand' : 'open', !!sub),
  };
}

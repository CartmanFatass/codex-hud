/**
 * Split Home: a top Variant A worker summary strip, one compact row per package lane and per block (waiting, progress),
 * and below it the preview of the row under the cursor. Sonic children fold into `⚡N` on their parent lane/worker
 * (never sonic rows, never hijacking a lane row); only open questions and unhandled failures keep a second reason row.
 */
import { targetKey, type OwnerWorker, type WorkboardSnapshot, type WorkLane, type WorkTarget } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { askSlabRows, homeSummaryRow } from './home-view.js';
import { homeCursor, homeTarget, type HomeCursor } from './monitor-state.js';
import { TRY_ACTIONS } from './split-project.js';
import { homeKeys } from './job-actions.js';
import { laneRows, orderedLanes, workerPriority } from './work-lanes.js';
import { activeFlow, unattendedFailure } from './work-visibility.js';
import { isUnreadReport, laneSonicRunning, mainLaneWorkers, sonicBadge, workerModelBadge } from './worker-roster.js';
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

/** The target the lane's acting job is: the most important non-child worker (never a sonic child). */
export const laneTop = (lane: WorkLane, now: number): OwnerWorker => {
  const main = mainLaneWorkers(lane);
  const pool = main.length ? main : lane.workers;
  return [...pool].sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];
};

/** A lane's phase as Split's list row says it, read from non-child workers. */
function lanePhase(lane: WorkLane, now: number): string {
  if (!lane.id.startsWith('thin-job:')) return lane.phase ?? '';
  const main = mainLaneWorkers(lane);
  const active = main.filter((w) => w.settledAt === null).sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];
  const review = active?.work?.phases.filter((p) => p.startsWith('review')).at(-1);
  if (!active) return main.some((w) => w.flow?.kind === 'land' && activeFlow(w)) ? 'landing' : main.some((w) => unattendedFailure(w)) ? 'failed' : 'done';
  return review ? (review.includes('accept') ? review : `${review.match(/^review r\d+/)?.[0] ?? review} · fixing`) : (active.phase ?? 'build');
}

const CUE_MIN = 6;
/** What a working lane's row says in its free cells: the model sentence's marked keywords that fit, else the card's reason or phases. */
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

export function homeScene(
  input: MonitorData, board: WorkboardSnapshot, state: MonitorState, targets: ReadonlyMap<string, WorkTarget>, width: number, now: number, done: number,
): SplitScene & { homeCursor?: HomeCursor } {
  const filtering = !!state.home.filter?.query;
  const data = input.project;
  const group = (lane: WorkLane) => {
    const main = mainLaneWorkers(lane);
    const list = main.length ? main : lane.workers;
    return Math.min(...list.map((w) => workerPriority(w, now)));
  };
  const lanes = (state.home.showAll && !board.workers.some((w) => w.homeRank !== undefined) ? board.lanes : orderedLanes(board, now))
    .filter((l) => mainLaneWorkers(l).length > 0);
  const names = lanes.map((l) => monitorText(l.identity.kind === 'native' ? l.label.replace('this session', t('this session')) : l.label));
  const col = Math.max(8, Math.min(14, Math.floor(width / 3), Math.max(0, ...names.map(visualLength))));

  const laneEntry = (lane: WorkLane, i: number): Entry => {
    const main = mainLaneWorkers(lane);
    const top = laneTop(lane, now), card = projectWorkCard(top, now, state.prefs.cardStallMinutes), item = targetKey({ kind: 'lane', laneId: lane.id });
    const native = lane.identity.kind === 'native';
    const running = main.filter((w) => w.settledAt === null && w.state !== 'queued').length;
    const sonic = laneSonicRunning(lane);
    const phase = lanePhase(lane, now);
    const ink = workStateInk(card), word = workStateWord(card);
    const glyph = workStateGlyph(card);
    const age = top.homeNeedsHuman ? minuteAge(top.humanEndedAt, now) : top.settledAt !== null ? minuteAge(top.settledAt, now) : ageText(card.elapsedMinutes ?? 0);
    const role = monitorText(card.role);
    const jobs = t(main.length === 1 ? '{n} job' : '{n} jobs', { n: main.length });
    const phaseText = workPhaseText(phase);
    const flowMid = top.flow && activeFlow(top)
      ? `${theme.board.active(mark('◉', '@'))} ${top.flow.steps.map((s) => t(s.key)).join(mark('▸', '>'))}`
      : '';
    const midText = native
      ? t('subagents')
      : failed(card) || phase === 'done'
        ? (main.length > 1 && !failed(card) ? jobs : role)
        : word && phaseText.includes(word)
          ? role
          : phaseText;
    const mid = flowMid || theme.board.muted(midText);
    const sonicStr = sonicBadge(sonic);
    const stateOrRole = native
      ? theme.board.muted(t('{n} running', { n: running }))
      : word
        ? `${(top.flow && activeFlow(top) && word === t('land') ? theme.board.active : ink)(word)} ${theme.board.muted(age)}`
        : `${roleInk(card.role)(role)} ${theme.board.muted(age)}`;
    const makeRight = (lvl: '' | 'full' | 'compact' | 'min') =>
      native
        ? stateOrRole
        : [lvl ? workerModelBadge(top, lvl) : '', sonicStr, stateOrRole].filter(Boolean).join(' ');

    const labelCol = Math.max(4, col - (visualLength(glyph) - 1));
    const suffix = !native && names[i].match(/[-/#]\d+$/)?.[0];
    const label = suffix && visualLength(names[i]) > labelCol ? truncateAnsi(names[i], labelCol - suffix.length) + suffix : truncateAnsi(names[i], labelCol);
    const head = `${ink(glyph)} ${fit(label, labelCol)}`;

    // Pack into a single row: prefer showing `mid` + richest model mark that fits, dropping model detail then `mid` before ever adding a second row.
    let right = makeRight('');
    let showMid = false;
    for (const lvl of ['full', 'compact', 'min', ''] as const) {
      const cand = makeRight(lvl);
      if (visualLength(head) + 1 + visualLength(mid) + 2 + visualLength(cand) <= width) {
        right = cand;
        showMid = true;
        break;
      }
    }
    if (!showMid) {
      for (const lvl of ['full', 'compact', 'min', ''] as const) {
        const cand = makeRight(lvl);
        if (visualLength(head) + 2 + visualLength(cand) <= width) {
          right = cand;
          break;
        }
      }
    }
    const lead = showMid ? `${head} ${mid}` : head;
    const rows: MonitorRow[] = [{ text: pair(lead, right, width), item }];
    if (top.superseded) for (const row of rows) row.text = theme.board.muted(stripAnsi(row.text));
    // A job at work shows model keywords in the row's free cells while the cursor is elsewhere.
    const cue = card.state === 'in-progress' && top.settledAt === null ? laneCue(card, width - visualLength(lead) - visualLength(right) - 2) : '';
    // Only open questions and unhandled failures keep a second reason row in Split's list.
    const why = top.homeNeedsHuman
      ? top.work?.requestInfo?.display?.question ?? top.work?.requestInfo?.question ?? top.ask ?? card.reason ?? ''
      : unattendedFailure(top)
        ? workCardDetail(card)
        : '';
    if (why) rows.push({ text: stemLines(why, width, ink, 1)[0], item });
    return {
      item,
      needs: group(lane) <= 2,
      rows,
      cued: cue ? { text: pair(`${lead} ${cue}`, right, width), item } : undefined,
      preview: () => {
        const slabs = board.workers.filter((w) => !w.parentJobId && w.homeNeedsHuman && w.laneId === lane.id).flatMap((w) => askSlabRows(w, board, state, width, now, true));
        const cards = laneRows(
          input,
          lane,
          { ...state, home: { ...state.home, foldedLanes: new Set() } },
          width,
          now,
          { skipAsking: true, allWorkers: lane.workers }
        ).slice(1);
        const ruleRight = [
          midText && midText !== jobs ? midText : '',
          jobs,
          sonic > 0 ? `${mark('⚡', '*')}${sonic}` : '',
        ].filter(Boolean).join(' · ');
        return { label: names[i], right: ruleRight, rows: [...slabs, ...cards] };
      },
    };
  };

  const waits = data?.waiting ?? [], n = data ? tryCount(data, state.prefs.acceptance) : 0;
  const waitFacts = [waits.length && t(waits.length === 1 ? '{n} ask' : '{n} asks', { n: waits.length }), n && t('{n} to try', { n })].filter(Boolean).join(' · ');
  const pendingRows = () => {
    if (!data || !n) return [];
    const latest = landedEntries(data, state.prefs.acceptance, true).filter((entry) => 'task' in entry || entry.r.state === 'try').slice(0, width < 56 ? 3 : 5).flatMap((entry): MonitorRow[] => {
      if ('task' in entry) return taskRows(entry.task, data, state, width, now, input.tryMarks, true, state.home.expandedTasks);
      const { r } = entry, head = `  ${landedMark(r)} ${monitorText(r.id)}`, age = landedAge(r, now);
      return (trySentence(r) ? briefStack(head, trySentence(r), age, width) : [landedInline(r, head, age, width)])
        .map((text) => ({ text, item: `home-progress:latest:${r.id}`, tryTarget: { milestone: r.milestone, slices: [r] } }));
    });
    return [boardRow(''), section(t('To try'), width, String(n)), ...latest];
  };
  const waiting: Entry[] = filtering || (!waits.length && !n) ? [] : [{
    item: WAITING,
    needs: true,
    rows: [{ item: WAITING, text: pair(`${theme.board.attention('?')} ${t('Waiting for you')}`, theme.board.muted(waitFacts), width) }],
    preview: () => ({
      label: t('Waiting for you'),
      right: waitFacts,
      rows: [
        ...waits.flatMap((r, i) => [
          ...waitingRows(r, i, width, now, Infinity).map((row) => ({ ...row, item: `home-progress:wait:${i}` })),
          ...originalRows(r.original, `original:wait:${i}`, state.home.expanded.has(`original:wait:${i}`), width),
        ]),
        ...pendingRows(),
      ],
    }),
  }];
  const block = data ? homeProgressRows(data, width, Infinity, false, state.prefs.acceptance, state.home.expanded) : [];
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
    return [{
      item: PROGRESS,
      needs: false,
      rows: [{ item: PROGRESS, text: pair(lead, theme.board.muted(facts.join(' · ')), width) }],
      preview: () => ({ label: t('Progress'), right: milestone && `${t('Milestone')} ${milestone}`, rows: [...brief, ...block.slice(1), ...pendingRows()] }),
    }];
  })();

  const entries = [
    ...lanes.flatMap((l, i) => (group(l) < 5 ? [laneEntry(l, i)] : [])),
    ...waiting,
    ...lanes.flatMap((l, i) => (group(l) < 5 ? [] : [laneEntry(l, i)])),
    ...progress,
  ];
  const items = entries.map((e) => e.item);
  const split = state.home.split, atList = split.listCursor;
  const cursor = atList && items.includes(atList) ? atList : (entries.find((e) => e.needs) ?? entries[0])?.item;
  const entry = entries.find((e) => e.item === cursor), shown = entry?.preview() ?? { label: '', rows: [] };
  const scope = `home|${cursor}`, sub = splitSubValid(split, shown.rows);
  const lane = lanes.find((l) => targetKey({ kind: 'lane', laneId: l.id }) === cursor), at = sub ?? cursor;
  const anchor = at && /^(home-progress:|split:|original:|project:fold:(task|ledger):)/.test(at) ? at : undefined;
  const target = anchor ? homeTarget(state.home) : sub ? targets.get(sub)
    : lane ? { kind: 'worker' as const, laneId: lane.id, workerId: laneTop(lane, now).id } : homeTarget(state.home);
  const selected = homeCursor(target, anchor);
  const summary = !filtering && entries.length ? [homeSummaryRow(board, input, width, now, false)] : [];
  const bodyRows = entries.length
    ? entries.flatMap((e) => (e.cued && e.item !== cursor ? [e.cued, ...e.rows.slice(1)] : e.rows))
    : [boardRow(theme.board.muted(fit('  ' + t(filtering ? 'No matches' : 'Nothing in progress'), width)))];
  return {
    homeCursor: selected,
    nav: {
      scroll: state.home.scroll,
      revealed: state.home.revealed,
      split: {
        ...split,
        focus: sub ? 'preview' : 'list',
        listCursor: cursor,
        previewFor: scope,
        previewScroll: split.previewFor === scope ? split.previewScroll : 0,
      },
    },
    list: [...summary, ...bodyRows],
    cursor,
    rule: { label: shown.label, right: shown.right },
    preview: shown.rows,
    sub,
    scope,
    left: homeDoneCount(done, width),
    hints: shown.rows.some((r) => r.item === sub && r.tryTarget)
      ? [...TRY_ACTIONS, '⏎ details', 'Esc back', 'o file']
      : homeKeys({ ...state, home: { ...state.home, cursor: selected } }, board, sub ? 'expand' : 'open', !!sub),
  };
}

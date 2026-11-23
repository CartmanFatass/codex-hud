/**
 * Classic Home's jobs (`home-compact/03`): one row per job (state glyph, ticket id, the stage strip, the executor group, `⚡N`, the
 * age and the silence), the running job's current sentence under it, a lane header only when a lane shows several jobs, and the
 * queued and the finished-and-read jobs each folded into one row. A job that needs the owner (asking, failed, an unread report)
 * shows the reason where the strip would be (an asking job its question on the line below); a land has no sub-row, its fifth stage cell says it.
 */
import { targetKey, type OwnerWorker, type WorkboardSnapshot, type WorkLane } from '../collectors/workboard-types.js';
import { projectWorkCard, workMinute, type WorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { ageText, cardExpanded, cardSentence, failed, flowStepDetail, milestoneLine, pulseLine, renderWorkCard, workPhaseText, workStateGlyph, workStateInk, workStateWord } from './work-card.js';
import { lanePhase, laneRows, laneStrip, workerPriority } from './work-lanes.js';
import { activeFlow, currentWorker, unattendedFailure } from './work-visibility.js';
import { isUnreadReport, laneSonicRunning, mainLaneWorkers, routeBadge, sonicBadge, sonicChildrenRunning, workerModelBadge } from './worker-roster.js';
import { ROLE_GLYPHS } from './model-glyphs.js';
import { roleInk } from './project-view.js';
import { fit, flowLines, monitorText, pair } from './monitor-text.js';
import { stripAnsi, theme, truncateAnsi, visualLength } from './colors.js';
import { mark, minuteAge } from './workboard-rows.js';
import { STRIP_CELLS, stageStrip } from './job-stages.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import { t } from './i18n.js';

/** `idw` is the ticket-id column's width on this frame (0: ids are not padded), so the stage strips start in one column. */
interface Ctx { state: MonitorState; width: number; now: number; pool: readonly OwnerWorker[]; idw: number }
type FoldKind = 'queued' | 'done';
type Job = readonly [OwnerWorker, WorkLane];
/** Minutes without output before the silence mark shows. */
const QUIET_MINUTES = 3;
/** Cells a row's reason keeps before its right side narrows, the ticket-id column's floor, and the longest id a job without a ticket gets. */
const MIN_REASON = 12, MIN_ID = 8, MAX_UNTICKETED_ID = 16;
/** What the right side loses as a row narrows, first to last (the sonic helper count outlasts the marks before it); the id, the strip (or the reason) and the age stay. */
const DROPS = ['route', 'model', 'role', 'sonic', 'silence'] as const;
/** The state glyph's fixed two-cell column, so ids start in the same column on every row. */
const cell = (glyph: string) => glyph + ' '.repeat(Math.max(0, 2 - visualLength(glyph)));
/** The job's id on its row: its ticket's, else its lane's short name (the package, or the head of the brief); a child under a lane header, which shares that name, gets the head of its own brief's heading. */
const jobId = (w: OwnerWorker, lane: Pick<WorkLane, 'label'>, child = false) =>
  w.displayId ? monitorText(w.displayId) : truncateAnsi((child && jobTitle(w, true)) || monitorText(lane.label), MAX_UNTICKETED_ID);

/** The role's statusline icon (`ROLE_GLYPHS`, ASCII in text mode) in the role's ink; a role with no icon of its own gets `•`. */
export function roleMark(role: string): string {
  const [glyph, ascii] = ROLE_GLYPHS[Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other'];
  return roleInk(role)(mark(glyph, ascii));
}

/** The queued job or the read, settled job that folds into one row; everything else keeps its own (so does a settled job whose sonic children still run: their `⚡N` is on it, and one the owner opened). */
function foldKind(w: OwnerWorker, lane: WorkLane, c: Ctx): FoldKind | undefined {
  if (!currentWorker(w, c.now, c.state.prefs) || cardExpanded(c.state, targetKey({ kind: 'worker', laneId: lane.id, workerId: w.id }))) return undefined;
  if (w.settledAt === null) return w.state === 'queued' ? 'queued' : undefined;
  return unattendedFailure(w) || isUnreadReport(w) || activeFlow(w) || w.flow?.state === 'failed' || sonicChildrenRunning(c.pool, w.id) ? undefined : 'done';
}

/** The ticket's heading, else the brief's (a child under its lane header leads with the brief's); raw task text only when nothing else names the job. */
export function jobTitle(w: OwnerWorker, child: boolean): string {
  const heading = child ? (w.briefTitle ?? w.ticketTitle) : (w.ticketTitle ?? w.briefTitle);
  const text = monitorText(heading ?? (w.displayId ? '' : w.task)), id = monitorText(w.displayId ?? '');
  return id && text.startsWith(id) ? text.slice(id.length).replace(/^[\s:–—-]+/, '') : text;
}

/** `scouting · 1m`: a scouted dispatch's step and the time in it, under the job's row. */
function scoutRow(w: OwnerWorker, c: Ctx): string {
  const flow = w.flow!;
  const tail = [flowStepDetail(flow.step ?? ''), minuteAge(flow.updatedAt, c.now)].filter(Boolean).join(' · ');
  return theme.board.body(fit(`${theme.board.active(mark('┃', '|'))} ${theme.board.active(t('scouting'))}${tail ? theme.board.muted(` · ${tail}`) : ''}`, c.width));
}

/**
 * What takes the stage strip's place, painted, when the job has none to show: the question it asks, the failure, a land gone red,
 * the unread report, its queue place, its stop or its supersession. Empty when the strip says it all.
 */
function reasonText(w: OwnerWorker, card: WorkCard): string {
  const { danger, muted, success } = theme.board, cross = mark('✗', 'x');
  if (w.superseded) return muted(t('superseded'));
  if (w.state === 'stopped') return muted(t('stopped'));
  if (card.state === 'queued') return muted(workStateWord(card));
  if (w.homeNeedsHuman) {
    const n = w.work?.requestInfo?.options.length ?? 0, category = w.labels?.category;
    return workStateInk(card)((n ? t('asks {n} opts', { n }) : t('asks')) + (category ? ` [${t(category)}]` : ''));
  }
  if (failed(card)) return danger(`${cross} ${cardSentence(card.reason ? t(card.reason) : '') || t('failed')}`);
  if (w.flow?.state === 'failed') return danger(`${cross} ${t('{step} red', { step: t(w.flow.steps.find((s) => s.state === 'failed')?.key ?? 'land') })}`);
  if (isUnreadReport(w) && !activeFlow(w)) {
    const outcome = w.labels?.outcome?.value;
    return success(`${mark('●', '*')} ${t('report unread')}${outcome && outcome !== 'done' ? ` [${t(outcome)}]` : ''}`);
  }
  return '';
}

/** What the row's second line says: an asking job's question, else a running job's current sentence (the model's, else its own latest progress line); none without one. */
const sentenceOf = (w: OwnerWorker): string | undefined =>
  w.homeNeedsHuman ? w.work?.requestInfo?.display?.question ?? w.work?.requestInfo?.question ?? w.ask
    : w.settledAt === null && w.state === 'working' ? w.modelSentence ?? w.latest_progress?.text : undefined;

/** The sentence under its row, in `ink` (dim for a running job, the ask colour for a question): one line, two from 100 columns, the last cut with …. */
function summaryRows(raw: string | undefined, room: number, wide: boolean, ink: (s: string) => string): string[] {
  if (!raw) return [];
  const pad = '   ', text = keywordMarks(monitorText(raw)).plain.replace(/\s+/g, ' ').trim(), max = wide ? 2 : 1;
  let lines = flowLines(text, room - pad.length);
  if (lines.length > max) lines = [...lines.slice(0, max - 1), truncateAnsi(lines.slice(max - 1).join(' '), room - pad.length)];
  return lines.map((line) => fit(pad + ink(line), room));
}

function jobRow(w: OwnerWorker, lane: Pick<WorkLane, 'id' | 'label'>, c: Ctx, indent = ''): MonitorRow[] {
  const card = projectWorkCard(w, c.now, c.state.prefs.cardStallMinutes);
  const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: w.id });
  const open = cardExpanded(c.state, key), ink = workStateInk(card), room = c.width - indent.length;
  const running = w.settledAt === null && w.state === 'working' && !w.homeNeedsHuman;
  const id = jobId(w, lane, !!indent), reason = reasonText(w, card);
  const head = `${indent}${cell(ink(workStateGlyph(card)))} ${theme.board.identifier(c.idw ? fit(id, c.idw - indent.length) : id)}  `;
  // The age is the job's own; the silence is the time since it last wrote, dim, then amber once the card calls it stalled.
  const age = theme.board.muted(ageText(running ? workMinute(w.startedAt, c.now) ?? 0 : card.elapsedMinutes ?? 0));
  const quiet = running && (card.inactivityMinutes ?? 0) >= QUIET_MINUTES
    ? (card.state === 'stalled' ? theme.board.stalled : theme.board.muted)(t('quiet {age}', { age: ageText(card.inactivityMinutes!) })) : '';
  const sonic = sonicChildrenRunning(c.pool, w.id);
  let line: string;
  if (reason) {
    const rights = [[sonicBadge(sonic), age], [age]].map((parts) => parts.filter(Boolean).join(' '));
    line = pair(head + reason, rights.find((r) => visualLength(head) + MIN_REASON + 1 + visualLength(r) <= c.width) ?? age, c.width);
  } else {
    // The frame can cross the stall threshold before the next collector snapshot.
    const strip = stageStrip(card.state === 'stalled' && w.stage ? { ...w, stage: undefined } : w);
    // Narrow the right side one mark at a time before the strip or the id is cut.
    const parts = (drop: number): [string, string] => {
      const keep = (d: (typeof DROPS)[number]) => !DROPS.slice(0, drop).includes(d);
      const [role, model] = [keep('role') ? roleMark(card.role) : '', keep('model') ? workerModelBadge(w, 'compact') : ''];
      const executor = role + (role && model ? mark('', ' ') : '') + model;
      const group = [executor, keep('route') ? routeBadge(w) : '', keep('sonic') ? sonicBadge(sonic) : ''].filter(Boolean).join(' ');
      return [head + strip + (group ? '  ' + group : ''), [age, keep('silence') ? quiet : ''].filter(Boolean).join(' ')];
    };
    let drop = 0;
    while (drop < DROPS.length && visualLength(parts(drop)[0]) + 1 + visualLength(parts(drop)[1]) > c.width) drop++;
    line = pair(...parts(drop), c.width);
  }
  const band = open || card.state === 'needs-you' || card.state === 'stalled' || activeFlow(w) || isUnreadReport(w) || w.flow?.state === 'failed';
  const rows: MonitorRow[] = [{
    // A question's row wears the ask slab's amber, on a plain line like the slab's own header.
    text: !currentWorker(w, c.now, c.state.prefs) && !open ? theme.board.muted(stripAnsi(line))
      : w.homeNeedsHuman ? theme.board.askTitle(stripAnsi(line)) : band ? theme.board.title(line) : line,
    item: key, key,
  }];
  const body: string[] = open
    ? [...renderWorkCard(card, c.state, room, card.reason ? t(card.reason) : '').slice(1)]
    : [...summaryRows(sentenceOf(w), room, c.width >= 100, w.homeNeedsHuman ? theme.board.attention : theme.board.muted), ...(activeFlow(w) && w.flow?.kind === 'scout' ? [scoutRow(w, { ...c, width: room })] : [])];
  if (open && running) {
    const milestone = milestoneLine(w, room), pulse = pulseLine(w, room);
    if (milestone) body.push(theme.board.body(milestone));
    if (pulse) body.push(theme.board.body(pulse));
  }
  return [...rows, ...body.map((text) => ({ text: indent + text, item: key, key }))];
}

/** A collapsed asking job: its row (`asks`, the option count) and its question under it; the ask slab is what Enter opens. Ids are not padded: no strip aligns with it. */
export function askRows(w: OwnerWorker, board: WorkboardSnapshot, state: MonitorState, width: number, now: number): MonitorRow[] {
  const lane = board.lanes.find((l) => l.id === w.laneId);
  return jobRow(w, { id: w.laneId, label: lane?.label ?? '' }, { state, width, now, pool: board.workers, idw: 0 });
}

/** A lane with several jobs: its ticket id and title once, the phase at the right (or the folded lane's job strip). */
function headerRow(lane: WorkLane, shown: readonly OwnerWorker[], c: Ctx): MonitorRow {
  const title = shown.find((w) => w.ticketTitle)?.ticketTitle;
  const left = theme.board.identifier(monitorText(lane.label)) + (title ? '  ' + theme.board.muted(monitorText(title)) : '');
  const right = c.state.home.foldedLanes?.has(lane.id)
    ? laneStrip({ ...lane, workers: shown }, c.state, c.now, Math.floor(c.width / 3), sonicBadge(laneSonicRunning(lane)))
    : theme.board.muted(workPhaseText(lanePhase(lane, shown, c.now)));
  const text = visualLength(left) + 2 + visualLength(right) <= c.width ? pair(left, right, c.width) : truncateAnsi(left, c.width);
  const key = targetKey({ kind: 'lane', laneId: lane.id }), muted = shown.every((w) => !currentWorker(w, c.now, c.state.prefs));
  return { text: muted ? theme.board.muted(stripAnsi(text)) : text, item: key, key };
}

/** `○ queued 3 · cache-v2/04 · export-csv/03 +1`: whole ids while they fit, then `+N`; `open` leaves the ids to the rows below. */
export function foldText(kind: FoldKind, ids: readonly string[], width: number, open = false): string {
  const glyph = kind === 'queued' ? theme.board.muted(mark('○', 'o')) : theme.board.success(mark('✓', '+'));
  const head = t(kind === 'queued' ? 'queued {n}' : 'done {n}', { n: ids.length });
  const list = (n: number) => ids.slice(0, n).map((id) => ' · ' + id).join('') + (n < ids.length ? ` +${ids.length - n}` : '');
  let n = open ? 0 : ids.length;
  while (n > 0 && visualLength(list(n)) > width - 3 - visualLength(head)) n--;
  return truncateAnsi(`${cell(glyph)} ${theme.board.muted(head + (open ? '' : list(n)))}`, width);
}

/** One fold row for the queued or the finished jobs; Enter opens it into one row per job. */
function foldRows(kind: FoldKind, jobs: readonly Job[], c: Ctx): MonitorRow[] {
  const item = `fold:${kind}`, open = c.state.home.expanded?.has(item) === true;
  const ids = jobs.map(([w, lane]) => jobId(w, lane));
  return [{ text: foldText(kind, ids, c.width, open), item, key: item }, ...(open ? jobs.flatMap(([w, lane]) => jobRow(w, lane, c)) : [])];
}

/** `lanes` in Home's order. Native lanes keep their header and cards; the rest fold as described above. */
export function jobRows(input: MonitorData, lanes: readonly WorkLane[], state: MonitorState, width: number, now: number, pool: readonly OwnerWorker[]): MonitorRow[] {
  const c: Ctx = { state, width, now, pool, idw: 0 }, folds: Record<FoldKind, Job[]> = { queued: [], done: [] };
  const groups: { lane: WorkLane; shown?: OwnerWorker[] }[] = [];
  for (const lane of lanes) {
    if (!lane.workers.length) continue;
    if (lane.identity.kind === 'native') { groups.push({ lane }); continue; }
    const shown: OwnerWorker[] = [];
    for (const w of mainLaneWorkers(lane)) {
      const fold = w.homeNeedsHuman ? undefined : foldKind(w, lane, c);
      if (fold) folds[fold].push([w, lane]);
      else if (!w.homeNeedsHuman) shown.push(w);
    }
    if (shown.length) groups.push({ lane, shown });
  }
  folds.queued.sort(([a], [b]) => (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity));
  folds.done.sort(([a], [b]) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
  // One id column for every job row on the frame (a child's id sits two cells in), so the strips line up.
  const idWidth = (w: OwnerWorker, lane: WorkLane, indent: number) => visualLength(jobId(w, lane, indent > 0)) + indent;
  const wanted = [
    ...groups.flatMap(({ lane, shown = [] }) => shown.map((w) => idWidth(w, lane, shown.length > 1 ? 2 : 0))),
    ...(['queued', 'done'] as const).flatMap((kind) => (state.home.expanded?.has(`fold:${kind}`) ? folds[kind].map(([w, lane]) => idWidth(w, lane, 0)) : [])),
  ];
  c.idw = Math.min(Math.max(MIN_ID, ...wanted), Math.max(MIN_ID, width - 3 - 2 - STRIP_CELLS - 1 - ageText(0).length));
  const rows: MonitorRow[] = [];
  for (const { lane, shown } of groups) {
    if (!shown) { rows.push(...laneRows(input, lane, state, width, now, { skipAsking: true, allWorkers: pool })); continue; }
    if (shown.length > 1) rows.push(headerRow(lane, shown, c));
    if (shown.length > 1 && state.home.foldedLanes?.has(lane.id)) continue;
    const ordered = state.home.showAll ? shown : [...shown].sort((a, b) => workerPriority(a, now) - workerPriority(b, now));
    for (const w of ordered) rows.push(...jobRow(w, lane, c, shown.length > 1 ? '  ' : ''));
  }
  for (const kind of ['queued', 'done'] as const) if (folds[kind].length) rows.push(...foldRows(kind, folds[kind], c));
  return rows;
}

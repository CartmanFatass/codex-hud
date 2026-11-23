/**
 * Classic Home's jobs (`home-compact/02`): one row per job (state glyph, ticket id, short title; role icon, model mark and
 * age on the right), a lane header only when a lane shows several jobs, one sub-row for a landing job, and the queued and
 * the finished-and-read jobs each folded into one row. Asking jobs are the Ask Slab's; failed jobs keep their card.
 */
import { targetKey, type OwnerWorker, type WorkLane } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { ageText, cardExpanded, cardMarks, flowLine, flowStepDetail, milestoneLine, pulseLine, renderWorkCard, workPhaseText, workStateGlyph, workStateInk, workStateWord } from './work-card.js';
import { lanePhase, laneRows, laneStrip, workerPriority } from './work-lanes.js';
import { activeFlow, currentWorker, unattendedFailure } from './work-visibility.js';
import { isUnreadReport, laneSonicRunning, mainLaneWorkers, routeBadge, sonicBadge, sonicChildrenRunning, workerModelBadge } from './worker-roster.js';
import { ROLE_GLYPHS } from './model-glyphs.js';
import { roleInk } from './project-view.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { stripAnsi, theme, truncateAnsi, visualLength } from './colors.js';
import { mark, minuteAge } from './workboard-rows.js';
import { t } from './i18n.js';

interface Ctx { state: MonitorState; width: number; now: number; pool: readonly OwnerWorker[] }
type FoldKind = 'queued' | 'done';
type Job = readonly [OwnerWorker, WorkLane];
/** Fewest cells the title keeps before the model mark narrows. */
const MIN_TITLE = 16;
/** The state glyph's fixed two-cell column, so ids start in the same column on every row. */
const cell = (glyph: string) => glyph + ' '.repeat(Math.max(0, 2 - visualLength(glyph)));

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

/** `land · gate[3] test:mjs · 1m`: the flow's step and the time in it, under the job's row. */
function flowRow(w: OwnerWorker, c: Ctx): string {
  const flow = w.flow!, step = flow.step ?? '';
  // A land waiting for another keeps its own line: it has a shorter form for a narrow panel.
  if (flow.kind === 'land' && flow.state === 'queued' && step.startsWith('waiting for ')) return theme.board.body(flowLine(flow, c.width, theme.board.active));
  const detail = /^(?:gate|after)\[\d+\]:/.test(step) ? monitorText(step).replace(/^(\w+\[\d+\]):\s*(?:npm run )?/, '$1 ') : flowStepDetail(step);
  const tail = [detail, minuteAge(flow.updatedAt, c.now)].filter(Boolean).join(' · ');
  const line = `${theme.board.active(mark('┃', '|'))} ${theme.board.active(t(flow.kind === 'land' ? 'land' : 'scouting'))}${tail ? theme.board.muted(` · ${tail}`) : ''}`;
  return theme.board.body(fit(line, c.width));
}

function jobRow(w: OwnerWorker, lane: WorkLane, c: Ctx, indent = ''): MonitorRow[] {
  const card = projectWorkCard(w, c.now, c.state.prefs.cardStallMinutes);
  const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: w.id });
  const open = cardExpanded(c.state, key), ink = workStateInk(card), room = c.width - indent.length;
  const prominent = open || unattendedFailure(w) || w.flow?.state === 'failed';
  const prefix = `${indent}${cell(ink(workStateGlyph(card)))} ${indent || !w.displayId ? '' : theme.board.identifier(monitorText(w.displayId)) + '  '}`;
  const title = jobTitle(w, !!indent);
  const sonic = sonicBadge(sonicChildrenRunning(c.pool, w.id)), marks = cardMarks(card, '', activeFlow(w) ? '' : workStateWord(card));
  const right = (level: 'full' | 'compact' | 'min' | '') =>
    [roleMark(card.role), level ? workerModelBadge(w, level) : '', routeBadge(w), sonic, ...marks, theme.board.muted(ageText(card.elapsedMinutes ?? 0))]
      .filter(Boolean).join(' ');
  // Narrow the model mark (name, effort, all) before the title is cut below its minimum.
  const need = visualLength(prefix) + Math.min(visualLength(title), MIN_TITLE) + 1;
  const mine = right((['full', 'compact', 'min', ''] as const).find((l) => need + visualLength(right(l)) <= c.width) ?? '');
  const line = pair(prefix + title, mine, c.width);
  const band = prominent || activeFlow(w) || isUnreadReport(w) || card.state === 'stalled';
  const rows: MonitorRow[] = [{
    text: !currentWorker(w, c.now, c.state.prefs) && !open ? theme.board.muted(stripAnsi(line)) : band ? theme.board.title(line) : line,
    item: key, key,
  }];
  const body: string[] = prominent
    ? [...renderWorkCard(card, c.state, room, card.reason ? t(card.reason) : '').slice(1)]
    : activeFlow(w) ? [flowRow(w, { ...c, width: room })] : [];
  if (open && w.state === 'working' && !w.homeNeedsHuman) {
    const milestone = milestoneLine(w, room), pulse = pulseLine(w, room);
    if (milestone) body.push(theme.board.body(milestone));
    if (pulse) body.push(theme.board.body(pulse));
  }
  return [...rows, ...body.map((text) => ({ text: indent + text, item: key, key }))];
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
  const ids = jobs.map(([w, lane]) => monitorText(w.displayId ?? lane.label));
  return [{ text: foldText(kind, ids, c.width, open), item, key: item }, ...(open ? jobs.flatMap(([w, lane]) => jobRow(w, lane, c)) : [])];
}

/** `lanes` in Home's order. Native lanes keep their header and cards; the rest fold as described above. */
export function jobRows(input: MonitorData, lanes: readonly WorkLane[], state: MonitorState, width: number, now: number, pool: readonly OwnerWorker[]): MonitorRow[] {
  const c: Ctx = { state, width, now, pool }, rows: MonitorRow[] = [], folds: Record<FoldKind, Job[]> = { queued: [], done: [] };
  for (const lane of lanes) {
    if (!lane.workers.length) continue;
    if (lane.identity.kind === 'native') {
      rows.push(...laneRows(input, lane, state, width, now, { skipAsking: true, allWorkers: pool }));
      continue;
    }
    const shown: OwnerWorker[] = [];
    for (const w of mainLaneWorkers(lane)) {
      const fold = w.homeNeedsHuman ? undefined : foldKind(w, lane, c);
      if (fold) folds[fold].push([w, lane]);
      else if (!w.homeNeedsHuman) shown.push(w);
    }
    if (!shown.length) continue;
    if (shown.length > 1) rows.push(headerRow(lane, shown, c));
    if (shown.length > 1 && state.home.foldedLanes?.has(lane.id)) continue;
    const ordered = state.home.showAll ? shown : [...shown].sort((a, b) => workerPriority(a, now) - workerPriority(b, now));
    for (const w of ordered) rows.push(...jobRow(w, lane, c, shown.length > 1 ? '  ' : ''));
  }
  folds.queued.sort(([a], [b]) => (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity));
  folds.done.sort(([a], [b]) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
  for (const kind of ['queued', 'done'] as const) if (folds[kind].length) rows.push(...foldRows(kind, folds[kind], c));
  return rows;
}

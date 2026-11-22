/**
 * Board project layout (PROJECT-UX direction B, `.scratch/project-layouts/spec.md`):
 * milestone map rows (one cell per slice, `n/m`, age, `+N` on overflow), gauges on the hub,
 * current milestone open in cell order on Progress,
 * and a one-row-per-project table on the Projects list. Works in both Split and Classic. Pure.
 */
import type { ActiveJob, LedgerSlice, ProjectSnapshot, SliceState } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { TryAction } from '../collectors/try-records.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import {
  NO_MILESTONE, PAGE_WORD, PROJECT_PAGES, asksYou, barText, briefStack, clampClean, clampLines,
  currentRows, dateText, foldRow, inFlight, inline, landedAge, landedEntries, landedInline, landedMark, ledgerText, newestTasks, taskRow, taskRows,
  meter, milestoneOrder, pageRows, pageSummary, progressSegments, projectOrder, roleInk,
  sinceText, sliceInk, sliceLedgerLine, stacked, ticketWorking, tryCount, tryDetailRows, trySelectionMark, trySentence, unlisted,
  unsliced, waitingRows, type ProjectPage,
} from './project-view.js';
import { HUB_HINTS, HUB_TRY_HINTS, LEDGER_FOCUS_HINTS, PROJECT_FILE_HINTS, TRY_ACTIONS, hubTryRows, slicePreview, type Part, type Shown } from './split-project.js';
import { diffStatRows } from './diff-stat-rows.js';
import { jobSentenceLine, labelSummary, workCardDetail } from './work-card.js';
import { boardRow, mark, minuteAge, section } from './workboard-rows.js';
import { cutWords, fit, monitorText, pair } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';

const muted = theme.board.muted;
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const padLeft = (text: string, width: number) => ' '.repeat(Math.max(0, width - visualLength(text))) + text;
const cutProse = (text: string, room: number) => {
  const body = monitorText(text);
  return room < 1 ? '' : visualLength(body) <= room ? body : cutWords(body, room);
};
const cutId = (text: string, room: number) => {
  const body = monitorText(text);
  return room < 1 ? '' : visualLength(body) <= room ? body : cutWords(body, room) || truncateAnsi(body, room);
};
/** Pack single-cell glyphs into `room` cells; overflows with `+N` rather than spilling past `room`. */
function cellStrip(cells: string[], room: number): string {
  if (room < 1 || !cells.length) return '';
  if (cells.length <= room) return cells.join('');
  let shown = Math.max(0, room - 2);
  while (shown > 0 && shown + visualLength(`+${cells.length - shown}`) > room) shown--;
  return cells.slice(0, shown).join('') + muted(truncateAnsi(`+${cells.length - shown}`, Math.max(0, room - shown)));
}

interface BoardMilestone { id: string; label: string; slices: LedgerSlice[]; accepted: number; total: number; at?: number }
/** Milestones newest first (current on top), each with its non-dropped slices in ledger cell order. */
export function boardMilestones(data: ProjectSnapshot): BoardMilestone[] {
  const buckets = new Map<string, LedgerSlice[]>();
  for (const r of data.ledger) {
    if (r.state === 'dropped') continue;
    const key = NO_MILESTONE.test(r.milestone) ? '' : r.milestone;
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  const named = [...milestoneOrder(data)].reverse();
  const order = [
    ...(data.ladder.current && buckets.has(data.ladder.current) ? [data.ladder.current] : []),
    ...named.filter((m) => m !== data.ladder.current && buckets.has(m)),
    ...(buckets.has('') ? [''] : []),
  ];
  return order.map((id) => {
    const slices = buckets.get(id) ?? [], times = slices.flatMap((s) => (s.at === undefined ? [] : [s.at]));
    return { id, label: id ? monitorText(id) : t('other'), slices, accepted: slices.filter((s) => s.state === 'accepted').length, total: slices.length, ...(times.length ? { at: Math.max(...times) } : {}) };
  });
}

const SLICE_MARK: Partial<Record<SliceState, () => string>> = { working: () => sliceInk('working')(mark('◐', '@')), blocked: () => sliceInk('blocked')(mark('◆', '!')), todo: () => muted(mark('○', '-')) };
const sliceCell = (r: LedgerSlice, tryMarks?: ReadonlyMap<string, TryAction>) =>
  r.state === 'accepted' ? sliceInk('accepted')(mark('✓', '+')) : r.state === 'try' ? landedMark(r, tryMarks?.get(r.id)) : (SLICE_MARK[r.state]?.() ?? muted(mark('○', '-')));
const mapCols = (ms: BoardMilestone[], now: number) => ({
  name: Math.min(8, Math.max(3, ...ms.map((m) => visualLength(m.label)))),
  frac: Math.max(3, ...ms.map((m) => visualLength(`${m.accepted}/${m.total}`))),
  age: Math.max(0, ...ms.map((m) => visualLength(sinceText(m.at, now)))),
});
function milestoneMapRow(m: BoardMilestone, cols: ReturnType<typeof mapCols>, width: number, now: number, tryMarks?: ReadonlyMap<string, TryAction>, extra: Partial<MonitorRow> = {}): MonitorRow {
  const right = muted(padLeft(`${m.accepted}/${m.total}`, cols.frac) + (cols.age ? ' ' + padLeft(sinceText(m.at, now), cols.age) : ''));
  const lead = ` ${fit(m.label, cols.name)} `, room = Math.max(0, width - visualLength(lead) - visualLength(right) - 1);
  return { ...extra, text: pair(lead + cellStrip(m.slices.map((r) => sliceCell(r, tryMarks)), room), right, width) };
}
function boardLegendRow(width: number): MonitorRow {
  const items = [
    `${sliceInk('accepted')(mark('✓', '+'))} ${muted(t('done'))}`, `${sliceInk('try')(mark('◇', 'o'))} ${muted(t('to try'))}`,
    `${sliceInk('working')(mark('◐', '@'))} ${muted(t('now'))}`, `${sliceInk('blocked')(mark('◆', '!'))} ${muted(t('blocked'))}`,
    muted(`${mark('○', '-')} ${t('todo')}`),
  ];
  while (items.length > 1 && visualLength(' ' + items.join(' ')) > width) items.pop();
  return plain(' ' + items.join(' '), width);
}
function boardLatestRows(data: ProjectSnapshot, state: MonitorState, width: number, now: number, tryMarks?: ReadonlyMap<string, TryAction>, split = false): MonitorRow[] {
  const newest = landedEntries(data, state.prefs.acceptance)[0];
  if (!newest) return [];
  if ('task' in newest) return split ? [] : [plain(` ${muted(t('latest'))}`, width), ...taskRows(newest.task, data, state, width, now, tryMarks, true)];
  const r = newest.r;
  return [{ text: landedInline(r, ` ${muted(t('latest'))} ${landedMark(r, tryMarks?.get(r.id))} ${monitorText(r.id)}`, landedAge(r, now), width), item: 'project:page:progress' }];
}
function unslicedRow(job: ActiveJob, width: number, now: number, selectable = false): MonitorRow {
  const lead = `  ${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}`;
  const right = job.asking ? theme.board.attention(`${t('asking')} ?`) : muted(minuteAge(job.at ?? null, now));
  const title = cutProse(job.title ?? job.package ?? '', width - visualLength(lead) - 2 - visualLength(right) - 1);
  return { text: pair(lead + (title ? '  ' + muted(title) : ''), right, width), ...(selectable ? { item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}) } : {}) };
}
function sliceRight(state: string, s: ProjectSnapshot['slices'][number] | undefined, worker: WorkboardSnapshot['workers'][number] | undefined, now: number): string {
  const reason = s?.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(s.ledgerState ?? '')) }) : s?.drift ? t(s.drift) : '';
  if (reason) return theme.board.attention(reason);
  if (state === 'blocked') return sliceInk('blocked')(t('blocked'));
  if (s?.jobId) {
    const role = worker?.role ?? s.role ?? '';
    return [role && roleInk(role)(monitorText(role)), (worker?.homeNeedsHuman ?? s.asking) ? theme.board.attention(`${t('asking')} ?`) : muted(minuteAge(s.at ?? null, now))].filter(Boolean).join(' ');
  }
  return sliceInk('working')(t(state || 'working'));
}
function boardInFlightRows(data: ProjectSnapshot, width: number, now: number, board?: WorkboardSnapshot): MonitorRow[] {
  return [
    ...inFlight(data).map((r): MonitorRow => {
      const worker = board?.workers.find((w) => w.evidence[0]?.sourceId === r.jobId);
      const lead = r.drift ? theme.board.attention('!') : r.ledgerState === 'blocked' ? sliceInk('blocked')(mark('◆', '!')) : sliceInk('working')(mark('◐', '@'));
      return { text: inline(`  ${lead} ${monitorText(r.label)}`, r.value, sliceRight(r.ledgerState ?? 'working', r, worker, now), width) };
    }),
    ...unsliced(data).map((job) => unslicedRow(job, width, now)),
  ];
}

function gaugeRow(page: ProjectPage, data: ProjectSnapshot, width: number, now: number, col: number, prefix = '', tryMarks?: ReadonlyMap<string, TryAction>, acceptance?: MonitorState['prefs']['acceptance']): MonitorRow {
  const head = `${prefix}${theme.board.title(fit(t(PAGE_WORD[page]), col))}`, space = Math.max(1, width - visualLength(head)), item = `project:page:${page}`;
  if ((page === 'progress' || page === 'tickets') && acceptance !== 'slice') {
    const facts = pageSummary(page, data, now, false, acceptance);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > space) facts.pop();
    return { item, text: fit(head + (facts.join(' · ') || muted(mark('–', '-'))), width) };
  }
  if (page === 'progress') {
    const ms = boardMilestones(data)[0];
    if (!ms) return { item, text: fit(head + muted(data.statePath ? mark('–', '-') : t('no STATE.md')), width) };
    const frac = muted(`${ms.accepted}/${ms.total}`);
    return { item, text: fit(`${head}${cellStrip(ms.slices.map((r) => sliceCell(r, tryMarks)), Math.max(0, space - visualLength(frac) - 1))} ${frac}`, width) };
  }
  if (page === 'tickets') {
    const all = data.tickets.flatMap((f) => f.tickets), done = all.filter((r) => r.state === 'done').length;
    const working = all.filter(ticketWorking).length, blocked = all.filter((r) => r.state === 'blocked').length;
    const tail = [`${meter(done, all.length, space < 26 ? 6 : 8)} ${done}/${all.length}`, working ? `${working} ${t('working')}` : '', blocked ? `${blocked} ${t('blocked')}` : ''].filter(Boolean);
    while (tail.length > 1 && visualLength(tail.join(' · ')) > space) tail.pop();
    return { item, text: fit(head + tail.join(' · '), width) };
  }
  if (page === 'tree') {
    const g = data.git, extra = unlisted(data).length;
    if (extra && !g) return { item, text: fit(head + theme.board.attention(t(extra === 1 ? '{n} unlisted worktree' : '{n} unlisted worktrees', { n: extra })), width) };
    if (!g) return { item, text: fit(head + muted(mark('–', '-')), width) };
    const dot = g.changed ? theme.board.attention(mark('●', '*')) : theme.board.success(mark('●', '*'));
    const body = `${dot} ${g.branch ? monitorText(g.branch) : muted(t('detached'))}`, warn = extra ? ` · ${theme.board.attention(`! ${extra}`)}` : '';
    return { item, text: fit(head + (visualLength(body + warn) <= space ? body + warn : truncateAnsi(body, space)), width) };
  }
  const facts = pageSummary('docs', data, now);
  while (facts.length > 1 && visualLength(facts.join(' · ')) > space) facts.pop();
  return { item, text: fit(head + (facts.join(' · ') || muted(mark('–', '-'))), width) };
}

/** Board Hub (Classic): Waiting for you, milestone map + latest + legend, In flight, page rows as gauges. */
export function boardHubRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[],
  board?: WorkboardSnapshot, room?: number, tryMarks?: ReadonlyMap<string, TryAction>
): MonitorRow[] {
  const folded = state.project.folded, many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const top: MonitorRow[] = [boardRow(''), {
    ...section(theme.board.title(monitorText(name) || t('Project')), width, many ? `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}` : ''),
    ...(many ? { item: 'project:switch' } : {}),
  }];
  const tries = tryCount(data, state.prefs.acceptance);
  const waitingBlock = (wrap: number, keep = false): MonitorRow[] => {
    if (!data.waiting.length) return [];
    const rows = [foldRow(folded, 'waiting', 'Waiting for you', width, [data.waiting.length, tries && t('{n} to try', { n: tries })].filter(Boolean).join(' · '))];
    if (!folded.has('waiting')) for (const [i, r] of data.waiting.entries()) {
      const item = waitingRows(r, i, width, now, keep && state.project.nav.cursor === `project:wait:${i}` ? Infinity : 1 + Math.max(0, wrap));
      wrap -= item.length - 1;
      rows.push(...item);
    }
    return [...rows, boardRow('')];
  };
  const milestones = boardMilestones(data), cols = mapCols(milestones, now), latest = boardLatestRows(data, state, width, now, tryMarks), legend = milestones.length ? boardLegendRow(width) : undefined;
  const progFacts = state.prefs.acceptance === 'slice' ? [data.ladder.current && monitorText(data.ladder.current), tries && t('{n} to try', { n: tries })].filter(Boolean)
    : pageSummary('progress', data, now, false, state.prefs.acceptance);
  while (state.prefs.acceptance !== 'slice' && progFacts.length > 1 && visualLength(progFacts.join(' · ')) > width - visualLength(t('Progress')) - 5) progFacts.pop();
  const progRight = progFacts.join(' · ');
  const mapRows = milestones.length ? milestones.map((m) => milestoneMapRow(m, cols, width, now, tryMarks, { item: 'project:page:progress' }))
    : [{ text: fit('  ' + muted(data.statePath ? t('none') : t('no STATE.md')), width), item: 'project:page:progress' }];
  const live = boardInFlightRows(data, width, now, board);
  const gaugePages = PROJECT_PAGES.filter((p) => p !== 'progress' && (p !== 'tickets' || data.tickets?.length));
  const col = Math.max(...gaugePages.map((p) => visualLength(t(PAGE_WORD[p])))) + 1;
  const pages = gaugePages.map((p) => gaugeRow(p, data, width, now, col, '', tryMarks, state.prefs.acceptance));
  const build = (lat: boolean, leg: boolean, cap: number, gaps: boolean, wrap = 0, keep = false) => [
    ...top, ...waitingBlock(wrap, keep),
    { ...section(t('Progress'), width, progRight), item: 'project:page:progress' }, ...mapRows,
    ...(lat ? latest : []), ...(leg && legend ? [{ ...legend, item: 'project:page:progress' }] : []), boardRow(''),
    section(t('In flight'), width, live.length ? String(live.length) : ''), ...(live.length ? live.slice(0, cap) : [boardRow('  ' + muted(t('Nothing in progress')))]), boardRow(''),
    ...pages,
  ].filter((r) => gaps || r.text !== '' || r.item);
  const tiers: [boolean, boolean, number, boolean][] = [
    [true, true, live.length, true], [true, false, live.length, true], [false, false, live.length, true],
    [false, false, Math.min(2, live.length), true], [false, false, Math.min(2, live.length), false],
  ];
  for (const [k, [lat, leg, cap, gaps]] of tiers.entries()) {
    const rows = build(lat, leg, cap, gaps);
    if (room === undefined || rows.length <= room || rows.some((r) => r.item === state.project.nav.cursor && r.item?.startsWith('project:fold:task:'))) {
      return build(lat, leg, cap, gaps, k ? 0 : room === undefined ? Infinity : Math.max(0, room - rows.length), true);
    }
  }
  return build(false, false, Math.min(2, live.length), false, 0, true);
}

/** Board Hub (Split): Waiting + gauge page rows in the list; milestone map + To try + In flight in Progress preview. */
export function boardHubPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const projects = input.projects ?? [], many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const name: MonitorRow = {
    ...section(theme.board.title(monitorText(input.projectName ?? '') || t('Project')), width,
      [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
    ...(many ? { item: 'project:switch' } : {}),
  };
  const tries = tryCount(data, state.prefs.acceptance), waitFacts = [data.waiting.length, tries ? t('{n} to try', { n: tries }) : ''].filter(Boolean).join(' · ');
  const waiting: MonitorRow[] = data.waiting.length ? [{ item: 'project:fold:waiting', text: pair(`${theme.board.attention('?')} ${theme.board.title(t('Waiting for you'))}`, muted(waitFacts), width) }] : [];
  const cur = currentRows(data), tickets = data.tickets.flatMap((f) => f.tickets);
  const mark_ = (page: ProjectPage) => page === 'progress' && cur.counts.working ? theme.board.active(mark('◐', '@'))
    : (page === 'tickets' && tickets.some(asksYou)) || (page === 'tree' && unlisted(data).length) ? theme.board.attention(page === 'tickets' ? '?' : '!')
    : page === 'tree' || page === 'docs' ? ' ' : muted(mark('○', 'o'));
  const shownPages = PROJECT_PAGES.filter((p) => p !== 'tickets' || data.tickets?.length);
  const col = Math.max(...shownPages.map((p) => visualLength(t(PAGE_WORD[p])))) + 1;
  const pages = shownPages.map((p) => gaugeRow(p, data, width, now, col, `${mark_(p)} `, input.tryMarks, state.prefs.acceptance));
  const preview = (cursor?: string): Shown => {
    if (cursor === 'project:fold:waiting') return { label: t('Waiting for you'), right: waitFacts, rows: data.waiting.flatMap((r, i) => waitingRows(r, i, width, now, Infinity)) };
    const page = /^project:page:(.+)$/.exec(cursor ?? '')?.[1] as ProjectPage | undefined;
    if (page && page !== 'progress') {
      const facts = page === 'tree' ? { ...data, gitDiff: undefined } : data;
      const body = pageRows(page, facts, state, width, now, board, input.modelEnabled, input.tryMarks).slice(1);
      return { label: t(PAGE_WORD[page]), rows: body.map(({ item: _i, files: _f, ...row }) => row) };
    }
    const milestones = boardMilestones(data), cols = mapCols(milestones, now), latest = boardLatestRows(data, state, width, now, input.tryMarks, true);
    const rows: MonitorRow[] = [...milestones.map((m) => milestoneMapRow(m, cols, width, now, input.tryMarks)), ...latest.map(({ text }) => ({ text })), ...(milestones.length ? [boardLegendRow(width)] : [])];
    const { rows: tryRows, act } = hubTryRows(data, state, width, now, input.tryMarks);
    const live = boardInFlightRows(data, width, now, board);
    if (tryRows.length) rows.push(...tryRows);
    if (live.length) rows.push(boardRow(''), plain(muted(t('In flight')), width), ...live);
    return {
      label: t('Progress'), right: tries && state.prefs.acceptance === 'slice' ? muted(t('{n} to try', { n: tries })) : '', rows,
      ...(act ? { act, hints: HUB_TRY_HINTS } : {}),
    };
  };
  return { list: [name, boardRow(''), ...waiting, ...pages], preview, start: pages.find((r) => r.item)?.item, hints: HUB_HINTS, focusHints: ['⏎ open', 'Esc back'] };
}

function boardSliceRows(r: LedgerSlice, data: ProjectSnapshot, state: MonitorState, width: number, now: number, board?: WorkboardSnapshot, modelEnabled = false, tryMarks?: ReadonlyMap<string, TryAction>): MonitorRow[] {
  const folded = state.project.folded, path = data.statePath, files = path ? { files: [path] } : {};
  const meta = '      ' + muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? dateText(r.at, now) : ''].filter(Boolean).join(' · '));
  if (r.state === 'try' || r.state === 'accepted') {
    const id = `hist:${r.id}`, item = `project:fold:${id}`, open = folded.has(id), isTry = r.state === 'try';
    const head = `  ${isTry ? trySelectionMark(state, item) : ''}${sliceCell(r, tryMarks)} ${monitorText(r.id)}`, right = muted(sinceText(r.at, now));
    const tryTarget = isTry ? { milestone: r.milestone, slices: [r] } : undefined;
    const row = (text: string, own?: string): MonitorRow => ({ text: fit(text, width), item: own ?? item, tryTarget, ...files });
    if (!isTry) return [row(pair(head, right, width)), ...(open ? [row(meta), ...clampLines(ledgerText(r), width - 6, Infinity).lines.map((l) => row('      ' + l))] : [])];
    const sentence = trySentence(r), out: MonitorRow[] = [];
    if (sentence && !open) out.push(...briefStack(head, sentence, right, width, 4).map((l) => row(l)));
    else if (sentence) out.push(row(pair(head, right, width)), row(meta), ...tryDetailRows(r, width, 4, folded.has(`ledger:${r.id}`)).map((d) => row(d.text, d.item)));
    else {
      const lines = stacked(head, ledgerText(r), right, width, 4, Infinity);
      if (open) lines.splice(1, 0, meta);
      out.push(...lines.map((l) => row(l)));
    }
    if (open) out.push(...diffStatRows(r.diff, width));
    return out;
  }
  const extra = { ...(path ? { item: `project:file:${path}:slice:${r.id}` } : {}), ...files };
  if (r.state === 'todo') return [{ text: fit(`  ${muted(mark('○', '-'))} ${monitorText(r.id)}`, width), ...extra }];
  const s = data.slices.find((x) => x.label === r.id), worker = s?.jobId ? board?.workers.find((w) => w.evidence[0]?.sourceId === s.jobId) : undefined;
  const lead = s?.drift ? theme.board.attention('!') : sliceCell(r);
  const out: MonitorRow[] = [{ text: pair(`  ${lead} ${monitorText(r.id)}`, sliceRight(r.state, s, worker, now), width), ...extra }];
  const desc = s?.value || ledgerText(r);
  if (desc) for (const l of clampLines(desc, width - 6, 2).lines) out.push({ text: fit('      ' + muted(l), width), ...extra });
  if (worker && s) {
    const sentence = modelEnabled && worker.modelSentence ? jobSentenceLine(worker.modelSentence, width - 5, (x) => x).slice(2).trimEnd() : monitorText(workCardDetail(projectWorkCard(worker, now)));
    if (sentence) out.push({ text: fit('      ' + sentence, width), ...extra });
    const labels = labelSummary(worker.labels);
    if (labels) out.push({ text: fit('      ' + labels, width), ...extra });
  }
  return out;
}

/** Board Progress (Classic): current milestone open in cell order, older milestones as map rows, jobs outside ledger, Next. */
export function boardProgressRows(data: ProjectSnapshot, state: MonitorState, width: number, now: number, board?: WorkboardSnapshot, modelEnabled = false, tryMarks?: ReadonlyMap<string, TryAction>): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = state.project.folded, path = data.statePath, files = path ? { files: [path] } : {};
  if (!path && !data.ledger.length) return [...rows, boardRow('  ' + muted(t('no STATE.md')))];
  if (data.summary && !state.project.filter?.query) for (const l of clampLines(data.summary, width - 2, 2).lines) rows.push({ text: fit('  ' + l, width), ...(path ? { item: `project:file:${path}:summary` } : {}), ...files });
  const milestones = boardMilestones(data), cols = mapCols(milestones, now), current = data.ladder.current ?? milestones[0]?.id, tasks = state.prefs.acceptance === 'slice' ? undefined : newestTasks(data), tries = tasks?.length ?? tryCount(data, 'slice');
  if (milestones.length) {
    if (rows.length > 1) rows.push(boardRow(''));
    rows.push(section(t('Milestones'), width, [String(milestones.length), tries && t('{n} to try', { n: tries })].filter(Boolean).join(' · ')));
    for (const m of milestones) {
      const foldId = `board:m:${m.id}`, open = !!state.project.filter?.query || (m.id === current ? !folded.has(foldId) : folded.has(foldId));
      rows.push(milestoneMapRow(m, cols, width, now, tryMarks, { item: `project:fold:${foldId}`, ...files }));
      if (open) for (const r of m.slices) if (!tasks || r.state !== 'try') rows.push(...boardSliceRows(r, data, state, width, now, board, modelEnabled, tryMarks));
    }
    rows.push(boardLegendRow(width));
  }
  if (tasks?.length) rows.push(...tasks.flatMap((task) => taskRows(task, data, state, width, now, tryMarks)));
  const jobs = unsliced(data);
  if (jobs.length) rows.push(boardRow(''), section(t('Outside the ledger'), width, String(jobs.length)), ...jobs.map((j) => unslicedRow(j, width, now, true)));
  if (data.next.length && !state.project.filter?.query) {
    rows.push(boardRow(''), section(t('Next'), width, String(data.next.length)));
    const all = folded.has('next'), shown = all ? data.next : data.next.slice(0, 3), more = data.next.length - 3;
    shown.forEach((r, i) => {
      const id = `next:${i}`, clip = clampLines(r.value, width - 3, 1);
      (folded.has(id) ? clampLines(r.value, width - 3, Infinity).lines : clip.lines).forEach((l, k) => rows.push({
        text: fit(`${k ? '   ' : ` ${mark('→', '>')} `}${l}`, width),
        ...(clip.more ? { item: `project:fold:${id}` } : r.path ? { item: `project:file:${r.path}:${id}` } : {}),
        ...(r.path ? { files: [r.path] } : {}),
      }));
    });
    if (more > 0) rows.push({ text: fit(` ${muted(`${all ? mark('▾', 'v') : mark('▸', '>')} ${all ? t('fewer') : t('{n} more', { n: more })}`)}`, width), item: 'project:fold:next' });
  }
  return rows;
}

/** Board Progress (Split): current milestone open in cell order + older map rows + unsliced jobs + Next; preview shows selected slice or milestone. */
export function boardProgressPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const path = data.statePath, files = path ? { files: [path] } : {}, marks = input.tryMarks;
  const milestones = boardMilestones(data), cols = mapCols(milestones, now), current = data.ladder.current ?? milestones[0]?.id, tasks = state.prefs.acceptance === 'slice' ? undefined : newestTasks(data), tries = tasks?.length ?? tryCount(data, 'slice');
  const list: MonitorRow[] = [];
  if (!path && !data.ledger.length) list.push(plain('  ' + muted(t('no STATE.md')), width));
  const addSlice = (r: LedgerSlice) => {
    const item = `project:slice:${r.id}`, lead = `  ${r.state === 'try' ? trySelectionMark(state, item) : ''}${sliceCell(r, marks)} ${monitorText(r.id)}`;
    if (r.state === 'try') {
      const sentence = trySentence(r), age = muted(sinceText(r.at, now));
      const lines = sentence ? briefStack(lead, sentence, age, width, 4) : [sliceLedgerLine(r, lead, age, width, 2)];
      for (const text of lines) list.push({ item, ...files, tryTarget: { milestone: r.milestone, slices: [r] }, text });
      return;
    }
    const s = data.slices.find((x) => x.label === r.id), worker = board.workers.find((w) => w.evidence[0]?.sourceId === s?.jobId);
    const right = r.state === 'accepted' ? muted(sinceText(r.at, now))
      : s?.drift || (r.state === 'working' && s?.jobId) ? sliceRight(r.state, s, worker, now) : '';
    list.push({ item, ...files, text: sliceLedgerLine(r, lead, right, width, 2) });
  };
  if (milestones.length) {
    list.push(section(t('Milestones'), width, [String(milestones.length), tries && t('{n} to try', { n: tries })].filter(Boolean).join(' · ')));
    for (const m of milestones) {
      list.push(milestoneMapRow(m, cols, width, now, marks, { item: `project:board:m:${m.id}`, ...files }));
      if (m.id === current || state.project.filter?.query) m.slices.filter((r) => !tasks || r.state !== 'try').forEach(addSlice);
    }
    if (!state.project.filter?.query) list.push(boardLegendRow(width));
  }
  if (tasks?.length) list.push(...tasks.map((task) => taskRow(task, data, state, width, now, marks)));
  const jobs = unsliced(data);
  if (jobs.length) list.push(boardRow(''), section(t('Outside the ledger'), width, String(jobs.length)), ...jobs.map((j) => unslicedRow(j, width, now, true)));
  if (data.next.length && !state.project.filter?.query) list.push(boardRow(''), { item: 'split:next', ...files, text: pair(`${muted(mark('→', '>'))} ${t('Next')}`, muted(String(data.next.length)), width) });
  const preview = (cursor?: string): Shown => {
    const mId = /^project:board:m:(.*)$/.exec(cursor ?? '')?.[1], m = mId !== undefined ? milestones.find((x) => x.id === mId) : undefined;
    if (m) {
      const mTries = m.slices.filter((r) => r.state === 'try');
      const ownTasks = tasks?.filter((task) => mTries.includes(task.slices[0]));
      const rows = m.slices.filter((r) => !tasks || r.state !== 'try').flatMap((r): MonitorRow[] => {
        if (r.state !== 'try') return [plain(inline(`  ${sliceCell(r, marks)} ${monitorText(r.id)}`, ledgerText(r), r.state === 'accepted' ? muted(sinceText(r.at, now)) : '', width), width)];
        const item = `project:slice:${r.id}`, sentence = trySentence(r), age = muted(sinceText(r.at, now)), body = monitorText(ledgerText(r));
        const head = `  ${trySelectionMark(state, item)}${landedMark(r, marks?.get(r.id))} ${monitorText(r.id)}`;
        const lines = sentence ? briefStack(head, sentence, age, width) : body ? [pair(head, age, width), ...clampClean(body, width - 4, Infinity).lines.map((l) => fit('    ' + muted(l), width))] : [pair(head, age, width)];
        return lines.map((text) => ({ item, ...files, tryTarget: { milestone: r.milestone, slices: [r] }, text }));
      });
      if (ownTasks) rows.push(...ownTasks.flatMap((task) => taskRows(task, data, state, width, now, marks)));
      const pending = ownTasks?.length ?? mTries.length;
      return { label: m.label, right: [`${m.accepted}/${m.total}`, pending && t('{n} to try', { n: pending })].filter(Boolean).join(' · '), rows, ...(pending ? { hints: [...TRY_ACTIONS, '⏎ details', 'Esc back'] } : {}) };
    }
    return slicePreview(input, data, state, board, width, now, cursor);
  };
  return {
    list, preview, start: list.find((r) => r.item?.startsWith('project:slice:'))?.item ?? list.find((r) => r.item)?.item,
    hints: PROJECT_FILE_HINTS, focusHints: LEDGER_FOCUS_HINTS,
  };
}

/** Board Projects list: one aligned table row per project (`project`, `ms`, `ledger`, `?`, `◉`, `age`) plus legend. */
export function boardListRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
  const ordered = projectOrder(projects), ages = ordered.map((p) => sinceText(p.overview?.at, now));
  const barCol = width >= 60 ? 12 : 6, noState = t('no STATE.md');
  const needMs = ordered.some((p) => p.overview && !p.overview.hasState) ? Math.max(0, visualLength(noState) - barCol - 1) : 0;
  const msCol = Math.min(6, Math.max(needMs, visualLength(t('ms')), ...ordered.map((p) => visualLength(monitorText(p.overview?.milestone ?? '')))));
  const waitCol = Math.max(1, ...ordered.map((p) => String(p.overview?.waiting ?? 0).length));
  const runCol = Math.max(1, ...ordered.map((p) => String(p.overview?.running ?? 0).length));
  const ageCol = Math.max(visualLength(t('age')), ...ages.map(visualLength));
  const nameCol = Math.max(6, width - (msCol + 1 + barCol + 1 + waitCol + 1 + runCol + 1 + ageCol) - 1);
  const head = [fit(t('project'), nameCol), fit(t('ms'), msCol), fit(t('ledger'), barCol), padLeft('?', waitCol), padLeft(mark('◉', '@'), runCol), padLeft(t('age'), ageCol)].join(' ');
  const rows: MonitorRow[] = [boardRow(''), plain(muted(head), width)];
  for (const [i, { root, name, overview: o }] of ordered.entries()) {
    const mid = !o ? fit(muted(mark('…', '~')), msCol + 1 + barCol)
      : !o.hasState ? fit(muted(noState), msCol + 1 + barCol)
      : `${fit(muted(monitorText(o.milestone ?? '')), msCol)} ${fit(progressSegments(o.counts, barCol).some((s) => s.width) ? barText(o, barCol) : muted(mark('–', '-')), barCol)}`;
    const wait = padLeft(o?.waiting ? theme.board.attention(String(o.waiting)) : muted(mark('·', '.')), waitCol);
    const run = padLeft(o?.running ? theme.board.active(String(o.running)) : muted(mark('·', '.')), runCol);
    rows.push({ text: fit(`${fit(cutId(name, nameCol), nameCol)} ${mid} ${wait} ${run} ${padLeft(muted(ages[i]), ageCol)}`, width), item: `project:list:${root}` });
  }
  rows.push(boardRow(''), plain(`${theme.board.attention('?')} ${muted(t('waiting for you'))}   ${theme.board.active(mark('◉', '@'))} ${muted(t('jobs running'))}`, width));
  return rows;
}

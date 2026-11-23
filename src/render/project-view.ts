/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, SETTLED_JOB_STATES, type SliceState, type ProjectSnapshot, type ProjectItem, type ProjectTicket, type TicketFeature, type LedgerSlice } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { ledgerTasks, type AcceptanceTask } from '../collectors/acceptance-tasks.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { jobSentenceRows, stemLines, workCardDetail, labelSummary } from './work-card.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { projectPage } from './monitor-state.js';
import { basename } from 'node:path';
import { boardRow, itemRow, originalRows, section, mark, minuteAge, pack } from './workboard-rows.js';
import { inboxHubRows, inboxListRows } from './inbox-project.js';
import { diffStatRows } from './diff-stat-rows.js';
import { monitorText, fit, pair, flowLines, cutWords } from './monitor-text.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { t } from './i18n.js';
export const sliceInk = (state: SliceState) => ({ working: theme.board.active, blocked: theme.board.attention,
  try: theme.board.identifier, accepted: theme.board.success, todo: theme.board.muted, dropped: theme.board.frame })[state];
/** Cumulative rounding keeps the stacked bar cell-exact, including small nonzero segments. */
export function progressSegments(counts: ProjectSnapshot['counts'], width: number, order: readonly SliceState[] = SLICE_STATES) {
  const total = order.reduce((n, state) => n + counts[state], 0);
  let count = 0, edge = 0;
  return order.map((state) => {
    count += counts[state];
    const end = total ? Math.round(count / total * width) : 0;
    const segment = { state, width: end - edge };
    edge = end;
    return segment;
  });
}
const HOME_STATES = ['accepted', 'try', 'working', 'blocked', 'todo'] as const;
const HOME_WORD = { accepted: 'accepted', try: 'to try', working: 'working', blocked: 'Stalled', todo: 'planned' };
const HOME_SHORT = { accepted: 'done', try: 'try', working: 'now', blocked: 'Stalled', todo: 'plan' };
// To try is a medium shade (▒), a step from both the full block of what is accepted and the light one of what is still to do; the
// ascii glyphs differ too, so a bar with no colour (the `none` theme) still reads.
const BAR_GLYPH: Record<SliceState, [string, string]> = { working: ['█', '#'], blocked: ['█', '#'], try: ['▒', '='], accepted: ['█', '#'], todo: ['░', '.'], dropped: ['░', '.'] };
export const barText = (data: Pick<ProjectSnapshot, 'counts'>, width: number, order?: readonly SliceState[]) => progressSegments(data.counts, width, order).map(({ state, width: cells }) =>
  sliceInk(state)(mark(...BAR_GLYPH[state]).repeat(cells))).join('');
const HOME_WAITING = 5;
const ticketTotalText = (data: ProjectSnapshot, text: string) =>
  data.ticketTotals?.partial ? `${t('Partial')} · ${text}` : text;
/** Group the collector's derived states for display; never infer activity from tracker files or jobs here. */
function homeTicketRows(data: ProjectSnapshot, width: number): MonitorRow[] {
  const totals = data.ticketTotals;
  if (!totals?.totalTickets) return [];
  const row = (text: string, key: string): MonitorRow => ({ text: fit(text, width), item: `home-progress:tickets:${key}` });
  const { doneTickets, totalTickets, doneFeatures, totalFeatures } = totals;
  const label = `  ${t('Tickets')}`, ratio = ticketTotalText(data, `${doneTickets}/${totalTickets}`);
  const closedText = t('{done}/{total} closed', { done: doneFeatures, total: totalFeatures });
  const closed = totals.partial && visualLength(`${label} ${ratio} ${closedText}`) > width ? '' : closedText;
  const cells = Math.min(8, width - visualLength(`${label}  ${ratio} ${closed}`));
  const rows = [row(pair(`${label}${cells > 0 ? ' ' + meter(doneTickets, totalTickets, cells) : ''} ${ratio}`, closed, width), 'all')];
  let planned = 0, ready = 0, queued = 0;
  const started: MonitorRow[] = [];
  let startedFeatures = 0;
  const lanes = ['working', 'try', 'you', 'blocked', 'ready', 'queued'];
  for (const { slug, tickets } of data.tickets) {
    const open = tickets.filter(r => !ticketResolved(r)), done = tickets.length - open.length;
    if (!open.length) continue;
    open.sort((a, b) => lanes.indexOf(ticketLane(a)) - lanes.indexOf(ticketLane(b)));
    const ticket = open[0], lane = ticketLane(ticket);
    if (!done && (lane === 'ready' || lane === 'queued')) {
      const waiting = open.filter(r => r.state === 'queued').length;
      planned++; ready += open.length - waiting; queued += waiting;
      continue;
    }
    startedFeatures++;
    const you = lane === 'you', word = you ? t('For you') : ticketStateWord(ticket);
    const head = `  ${you ? theme.board.attention('?') : ticketGlyph(ticket)} ${monitorText(slug)}`;
    const right = `${done}/${tickets.length} · ${open.filter(r => ticketLane(r) === lane).length} ${word}`;
    const bar = visualLength(head + right) + 6 <= width ? ' ' + meter(done, tickets.length, 4) : '';
    started.push(row(pair(head + bar, theme.board.muted(right), width), slug));
  }
  if (started.length) rows.push({ ...section(t('Active & ready'), width, featureCountText(startedFeatures)), item: 'home-progress:tickets:all' }, ...started);
  if (planned) rows.push(row(pair(`  ${mark('▸', '>')} ${t('{n} planned', { n: planned })}`,
    theme.board.muted(`${ready} ${t('ready')} · ${t('{n} queued', { n: queued })}`), width), 'planned'));
  return rows;
}
/**
 * Only whole spare rows; cards have already claimed their space. The counts are the current milestone's, as on the hub
 * (the whole ledger when there is none, and the title says so). Shrinks from the bottom up: tickets, the summary's wrapped rows,
 * legend, summary, then the bar, then the block.
 */
export function homeProgressRows(data: ProjectSnapshot | undefined, width: number, spare: number, gap = true): MonitorRow[] {
  if (!data || spare < 3 || (!data.summary && !data.ladder.current && !data.ledger.length && !data.tickets.length)) return [];
  const row = (text: string, id = 'progress'): MonitorRow => ({ text: fit(text, width), item: `home-progress:${id}` });
  const cur = currentRows(data), counts = cur.counts, states = HOME_STATES.filter(s => counts[s]);
  const legend = (words?: typeof HOME_WORD) => states.map(s => sliceInk(s)(`${mark(...PROGRESS_MARK[s])} ${counts[s]}${words ? ' ' + t(words[s]) : ''}`)).join(words === HOME_SHORT ? ' ' : '  ');
  const legendLine = [legend(HOME_WORD), legend(HOME_SHORT)].find(line => visualLength(line) <= width - 2) ?? legend();
  const fraction = `${counts.accepted}/${cur.rows.length - counts.dropped}`;
  const summary = data.summary ? clampLines(data.summary, width - 2, 3).lines : [];
  const milestone = data.ladder.current && (cur.whole && cur.rows.length ? '' : data.ladder.current);
  const head = section(t('Progress'), width, milestone ? `${t('Milestone')} ${monitorText(milestone)}` : cur.rows.length ? t('All tickets') : '');
  // What the block keeps as it shrinks: the bar and the first summary row, then the legend, then the summary's other rows.
  let room = spare - (gap ? 1 : 0) - 1;
  const bar = states.length && room > 0 ? (room--, 1) : 0, first = summary.length && room > 0 ? (room--, 1) : 0;
  const legendRows = bar && room > 0 ? [legendLine] : [];
  room -= legendRows.length;
  const more = first ? Math.min(summary.length - 1, room) : 0;
  room -= more;
  const rows = [...(gap ? [boardRow('')] : []), { ...head, item: 'home-progress:progress' },
    ...summary.slice(0, first + more).map((line) => row('  ' + line)),
    ...(bar ? [row(`  ${barText({ counts }, Math.max(0, Math.min(24, width - 3 - visualLength(fraction))), HOME_STATES)} ${theme.board.muted(fraction)}`)] : []),
    ...legendRows.map((line) => row('  ' + line))];
  if (bar && !legendRows.length) return rows;
  return room > 0 ? [...rows, ...homeTicketRows(data, width).slice(0, room)] : rows;
}
/**
 * Home's spare rows, top to bottom: STATE's waiting items (a row each) and recently accepted slices under the cards, the progress block
 * at the bottom. The block takes its rows first (its own order of shrinking is above); the two lists, waiting first, take what is left.
 */
export function homeSpareRows(data: ProjectSnapshot | undefined, width: number, spare: number, now: number, gap: boolean, state: MonitorState): MonitorRow[] {
  if (!data || spare < 1) return [];
  const progress = homeProgressRows(data, width, spare, gap), out: MonitorRow[] = [], keep = progress.length + (progress.length && !gap ? 1 : 0);
  // A list of at most `all.length` rows out of `total`; short of room it ends with `+N more` for those it does not show.
  const list = (head: MonitorRow, id: string, all: MonitorRow[][], total: number, room: number): MonitorRow[] => {
    const slots = room - 1, item = `home-progress:${id}`;
    if (slots < 1 || !all.length) return [];
    const limit = (total > all.length || all.flat().length > slots) && slots > 2 ? slots - 1 : slots;
    const shown = all.flat().slice(0, limit), hidden = total - all.filter(group => shown.includes(group[0])).length;
    return [{ ...head, item }, ...shown, ...(hidden > 0 && slots > 2 ? [{ text: fit('  ' + theme.board.muted(t('+{n} more', { n: hidden })), width), item }] : [])];
  };
  const lists = [
    (room: number) => list(section(t('Waiting for you'), width, String(data.waiting.length)), 'waiting', data.waiting.slice(0, HOME_WAITING).map((r, i) => [{
      ...itemRow(theme.board.attention('?'), monitorText(r.value), '', width), item: `home-progress:wait:${i}` },
      ...originalRows(r.original, `original:wait:${i}`, state.home.expanded.has(`original:wait:${i}`), width)]), data.waiting.length, room),
    (room: number) => {
      const landed = landedNewest(data).filter(({ r }) => r.state === 'accepted').slice(0, width < 56 ? 3 : 5).map(({ r }): MonitorRow[] => {
        const right = theme.board.muted([t('accepted'), sinceText(r.at, now)].filter(Boolean).join(' '));
        return [{ text: inline(`  ${sliceInk('accepted')(mark('✓', '+'))} ${monitorText(r.id)}`, ledgerText(r), right, width), item: 'home-progress:latest' }];
      });
      return list(section(t('Latest'), width, t('newest first')), 'latest', landed, landed.length, room);
    },
  ];
  // A blank row sets each list off from what is above it, and the last from the block (the block has its own when it was given one).
  for (const make of lists) {
    const lead = out.length || gap ? 1 : 0, block = make(spare - keep - out.length - lead);
    if (block.length) out.push(...(lead ? [boardRow('')] : []), ...block);
  }
  const fill = (rows: MonitorRow[]) => [...out, ...Array.from({ length: spare - out.length - rows.length }, () => boardRow('')), ...rows];
  return progress.length ? fill(out.length && !gap ? [boardRow(''), ...progress] : progress) : out;
}
export const PROJECT_PAGES = ['progress', 'tickets', 'tree', 'docs'] as const;
/** The hub's pages, and the page of one waiting item (`ProjectView.waiting`), which a row opens and the hub does not list. */
export type ProjectPage = (typeof PROJECT_PAGES)[number] | 'waiting';
export const PAGE_WORD: Record<ProjectPage, string> = {
  progress: 'Progress', tickets: 'Tickets', tree: 'Working tree', docs: 'Docs', waiting: 'Waiting',
};
/** The open page; none, or a name this build does not know, is the hub. */
export const projectPageOf = (state: MonitorState) => projectPage(state.project.view);
const ticketResolved = (r: ProjectTicket) => r.state === 'done' || r.state === 'dropped';
export const ticketWorking = (r: ProjectTicket) => r.state === 'working';
export const ticketStateWord = (r: ProjectTicket) => t(r.state === 'try' ? 'to try' : r.state === 'queued' ? 'Queued' : r.state === 'blocked' ? 'Stalled' : r.state);
const parts = (...p: (string | number | false | null | undefined)[]) =>
  p.filter((s): s is string => typeof s === 'string' && s !== '');
function updatedText(data: ProjectSnapshot, now: number): string {
  if (data.updatedAt === undefined) return '';
  const at = new Date(data.updatedAt), today = new Date(now), two = (n: number) => String(n).padStart(2, '0');
  return t('updated {time}', { time: at.toDateString() === today.toDateString() ? `${two(at.getHours())}:${two(at.getMinutes())}`
    : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` });
}
/** What an open page says about itself on its crumb row, widest first; the first that fits is shown. */
function pageMeta(page: ProjectPage, data: ProjectSnapshot, now: number): string[] {
  if (page === 'progress') return [updatedText(data, now)];
  if (page === 'tickets' && data.tickets?.length) {
    const text = featureCountText(data.ticketTotals?.totalFeatures ?? data.tickets.length);
    return [ticketTotalText(data, text), ...(data.ticketTotals?.partial ? [t('Partial')] : [])];
  }
  return [];
}
/** `Project › Page` for the sub-page title row (the project's name instead of `Project` when there is a switch), with the page's own facts on the right when there is room. */
export function projectCrumb(page: ProjectPage, data: ProjectSnapshot | undefined, width: number, now: number, name = '') {
  const crumb = `${name ? truncateAnsi(monitorText(name), 16) : t('Project')} ${mark('›', '>')} ${t(PAGE_WORD[page])}`;
  return { crumb, right: (data && pageMeta(page, data, now).find((r) => r && visualLength(crumb) + 4 + visualLength(r) <= width)) || '' };
}
/** One line per page, most important fact first: a row too short for all of them drops the last, not part of one. */
export function pageSummary(page: ProjectPage, data: ProjectSnapshot, now: number, showMilestone = true): string[] {
  const g = data.git;
  if (page === 'progress') {
    const tasks = ledgerTasks(data.ledger);
    const blocked = tasks.filter((task) => task.slices.some((r) => r.state === 'blocked')).length;
    const working = tasks.filter((task) => task.slices.some((r) => r.state === 'working')).length;
    const milestone = showMilestone && data.ladder.current && monitorText(data.ladder.current);
    return parts(data.ticketTotals?.partial && t('Partial'), tasks.length ? taskCountText(tasks.length) : !data.ticketTotals?.partial && t('No tickets'),
      milestone, blocked && `${blocked} ${t('blocked')}`, working && `${working} ${t('working')}`);
  }
  if (page === 'tickets') return data.tickets.length ? [ticketTotalText(data, featureCountText(data.ticketTotals?.totalFeatures ?? data.tickets.length))] : [];
  // Unlisted worktrees first: a short row keeps them and drops the facts after.
  if (page === 'tree') return parts(unlisted(data).length && t(unlisted(data).length === 1 ? '{n} unlisted worktree' : '{n} unlisted worktrees', { n: unlisted(data).length }),
    g?.branch && monitorText(g.branch), g && t('{n} changed', { n: g.changed }),
    data.worktreeCount && t(data.worktreeCount === 1 ? '{n} worktree' : '{n} worktrees', { n: data.worktreeCount }), g?.ahead && `${g.ahead} ${t('ahead')}`, g?.behind && `${g.behind} ${t('behind')}`,
    data.editing.length && `${data.editing.length} ${t('editing')}`);
  if (page === 'docs') {
    const spec = data.docs.find((r) => r.label === 'spec'), review = data.docs.find((r) => r.label === 'review');
    return parts(spec && monitorText(spec.value), review && `${t('review')} ${minuteAge(review.at ?? null, now)}`);
  }
  return [];
}
const itemRight = (r: ProjectItem, width: number, now: number) => width < 56 ? '' : r.at !== undefined ? minuteAge(r.at, now)
  : r.path ? monitorText(basename(r.path)) : '';
export const projectItem = (r: ProjectItem, i: number, glyph: string, width: number, now: number): MonitorRow => {
  const left = `${r.label ? fit(t(r.label), 10) + ' ' : ''}${monitorText(r.value)}`;
  return { ...itemRow(glyph, left, itemRight(r, width, now), width), ...(r.path ? { item: `project:file:${r.path}:${i}`, files: [r.path] } : {}) };
};
/** A waiting item (`? text`) flows onto up to `rows` lines (`Infinity`: all it needs). */
export function waitingRows(r: ProjectItem, i: number, width: number, now: number, rows = 1): MonitorRow[] {
  const glyph = theme.board.attention('?'), row = { ...projectItem(r, i, glyph, width, now), item: `project:wait:${i}` }, right = itemRight(r, width, now);
  const room = width - 2 - (right ? visualLength(right) + 1 : 0), body = monitorText(r.value);
  return rows < 2 || visualLength(body) <= room ? [row]
    : clampClean(body, room, rows).lines.map((line, k) => ({ ...row, text: k ? fit('  ' + line, width) : pair(`${glyph} ${line}`, theme.board.muted(right), width) }));
}
export function projectOriginal(source: string | undefined, id: string, folded: ReadonlySet<string>, width: number) {
  const key = `original:${id}`;
  return originalRows(source, `project:fold:${key}`, folded.has(key), width);
}
export const roleInk = (role: string) => (theme.board.roleInk as Record<string, (s: string) => string>)[role] ?? ((s: string) => s);
/** STATE's current milestone's ledger rows with their counts; a ledger that has none of them (or no current milestone) is counted whole. */
export function currentRows(data: ProjectSnapshot) {
  const mine = data.ledger.filter((r) => (r.release ?? r.milestone) === data.ladder.current), rows = mine.length ? mine : data.ledger;
  const counts = Object.fromEntries(SLICE_STATES.map((s) => [s, rows.filter((r) => r.state === s).length])) as ProjectSnapshot['counts'];
  return { rows, counts, whole: !mine.length };
}
/** Keep an accepted row's ledger text only when it fits whole beside the id and age. */
const inline = (head: string, text: string, right: string, width: number) => {
  const body = monitorText(text), room = width - visualLength(head) - 2 - (right ? visualLength(right) + 1 : 0);
  return pair(body && visualLength(body) <= room ? `${head}  ${theme.board.muted(body)}` : head, right, width);
};
/** All pending slices in the project, not just the current milestone. */
export const tryCount = (data: Pick<ProjectSnapshot, 'ledger'>) => data.ledger.filter((r) => r.state === 'try').length;
/** `3/8 accepted`: what a milestone's bar counts, in words (accepted slices of all but the dropped). */
export const acceptedText = (counts: ProjectSnapshot['counts'], rows: number) =>
  t('{done}/{total} accepted', { done: counts.accepted, total: rows - counts.dropped });
/** Jobs of this project that no slice shows: an imp working in the main checkout, say. */
export const unsliced = (data: ProjectSnapshot) => data.active.filter((a) => !data.slices.some((r) => r.jobId === a.jobId));
/** Unmanaged worktrees that have no linked ticket. */
export const unlisted = (data: ProjectSnapshot) => data.slices.filter((r) => r.drift);
export const inFlight = (data: ProjectSnapshot) => data.slices.filter((r) => !r.drift);
/** Landed slices (to try or accepted), the newest first by commit date; those with none last, the later ledger rows first. */
export const landedNewest = (data: ProjectSnapshot) => data.ledger.flatMap((r, i) =>
  r.state === 'try' || (r.state === 'accepted' && (r.landed || r.commit || r.at !== undefined)) ? [{ r, i }] : [])
  .sort((a, b) => (b.r.at ?? -1) - (a.r.at ?? -1) || b.i - a.i);
/** The Projects list is what the tab shows: asked for, with several projects to list, and no page open. */
export const projectListOpen = (state: MonitorState, projects?: unknown[]) =>
  state.project.view.kind === 'projects-list' && (projects?.length ?? 0) > 1;
/** The panel's own project first, then those with something waiting, then those with a job running, then the most recently touched. */
export function projectOrder(projects: ProjectChoice[]): ProjectChoice[] {
  const rank = (p: ProjectChoice) => p.overview?.waiting ? 0 : p.overview?.running ? 1 : 2;
  return [projects[0], ...projects.slice(1).sort((a, b) => rank(a) - rank(b) || (b.overview?.at ?? 0) - (a.overview?.at ?? 0))];
}
/** `12m`, `3h`, `4d` (`12分`, `3小时`, `4天`): how long since a project was touched. */
export function sinceText(at: number | undefined, now: number): string {
  const minutes = at === undefined ? -1 : Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 0 ? '' : minutes < 60 ? t('{n}m', { n: minutes }) : minutes < 1440 ? t('{n}h', { n: Math.floor(minutes / 60) }) : t('{n}d', { n: Math.floor(minutes / 1440) });
}
export const NO_MILESTONE = /^[—–-]*$/;
/** A ledger row's text without its commit, which the row shows beside the date: `(abc1234)` at the end or `abc1234 · ` at the start. */
export const ledgerText = (r: LedgerSlice) => r.text.replace(/\s*\((?:[0-9a-f]{7,40}(?:[,;]\s*|(?=\))))+\)\s*$/i, '')
  .replace(/^[0-9a-f]{7,40}\s*·\s*/i, '').trim();
/** `text` wrapped to `room` columns and cut to `max` rows, the last ending in an ellipsis; `more` says it was cut. */
export function clampLines(text: string, room: number, max: number) {
  return clampClean(monitorText(text), room, max);
}
/** Cut a ticket's title to `room` cells at a word end (Chinese at a character), falling back to cell cut when not even the first word fits. */
export const cutTicketTitle = (title: string, room: number) => {
  const clean = monitorText(title);
  return room > 0 ? cutWords(clean, room) || clean : clean;
};
/** `clampLines` for text already through `monitorText`. */
export function clampClean(body: string, room: number, max: number) {
  const lines = flowLines(body, Math.max(1, room)), more = lines.length > max;
  // The last row is cut at a word end (Chinese at a character), never inside a word; a single word longer than the row is cut by cell.
  const rest = lines.slice(max - 1).join(' '), last = cutWords(rest, Math.max(1, room)) || fit(rest, Math.max(1, room));
  return { more, lines: more ? [...lines.slice(0, max - 1), last] : lines };
}
/** `head` and `text` on one row when they fit beside `right` (and `one`); else `head` with `right`, and the text wrapped under it at `indent`. */
export function stacked(head: string, text: string, right: string, width: number, indent: number, max = 2, one = true): string[] {
  const body = monitorText(text);
  if (!body) return [pair(head, right, width)];
  if (one && visualLength(head) + 2 + visualLength(body) + (right ? visualLength(right) + 1 : 0) <= width) return [pair(`${head}  ${body}`, right, width)];
  return [pair(head, right, width), ...clampClean(body, width - indent, max).lines.map((line) => ' '.repeat(indent) + line)];
}
export const taskItem = (task: AcceptanceTask) => `project:fold:task:${task.key}`;
export const taskLabel = (task: AcceptanceTask) => monitorText(task.key.startsWith('slice:') ? `— ${task.slices[0].id}` : task.milestone);
const taskCountText = (n: number) => t(n === 1 ? '{n} task' : '{n} tasks', { n });
const featureCountText = (n: number) => t(n === 1 ? '{n} feature' : '{n} features', { n });
const PROGRESS_ORDER = ['blocked', 'working', 'try', 'todo', 'accepted', 'dropped'] as const;
const PROGRESS_MARK: Record<SliceState, [string, string]> = { blocked: ['◆', '!'], working: ['◐', '@'],
  try: ['◇', 'o'], todo: ['○', '-'], accepted: ['✓', '+'], dropped: ['–', '-'] };
const progressMark = (state: SliceState) => sliceInk(state)(mark(...PROGRESS_MARK[state]));
const worstState = (task: AcceptanceTask) => PROGRESS_ORDER.findIndex((s) => task.slices.some((r) => r.state === s));
export function progressTasks(data: ProjectSnapshot): AcceptanceTask[] {
  const tasks = ledgerTasks([...data.ledger].reverse().sort((a, b) => (b.at ?? -1) - (a.at ?? -1)));
  const priority = (task: AcceptanceTask) => task.slices.some((r) => r.state === 'try') ? -1 : worstState(task);
  return tasks.sort((a, b) => priority(a) - priority(b));
}
export const progressTasksHeading = (tasks: number, width: number) => section(t('Tasks'), width, String(tasks));
export function progressTaskHeader(task: AcceptanceTask, data: ProjectSnapshot, width: number, now: number): MonitorRow {
  const counts = PROGRESS_ORDER.flatMap((s) => {
    const n = task.slices.filter((r) => r.state === s).length;
    return n ? [`${progressMark(s)} ${n}`] : [];
  }).join('  ');
  const label = `  ${progressMark(PROGRESS_ORDER[worstState(task)])} ${taskLabel(task)}`;
  const oldest = task.slices.reduce<number | undefined>((n, r) => r.state !== 'try' || r.at === undefined ? n : Math.min(n ?? r.at, r.at), undefined);
  const age = sinceText(oldest, now), right = [counts, age].filter(Boolean).join('  ');
  const file = task.slices[0]?.path ?? data.statePath;
  return { item: taskItem(task), text: pair(label, visualLength(label + right) + 1 <= width ? right : counts, width), ...(file ? { files: [file] } : {}) };
}

/** Slice details shared by the existing Split slice preview and task drill-down in either panel layout. */
export function sliceDetailRows(r: LedgerSlice, data: ProjectSnapshot, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false): MonitorRow[] {
  const plain = (text: string) => boardRow(fit(text, width)), muted = theme.board.muted;
  const s = data.slices.find((x) => x.label === r.id), worker = s?.jobId ? board?.workers.find((w) => w.evidence[0]?.sourceId === s.jobId) : undefined;
  const rows = [...clampLines(ledgerText(r) || r.text, width - 2, Infinity).lines.map((l) => plain('  ' + l)),
    ...diffStatRows(r.state === 'try' ? r.diff : undefined, width)];
  if (worker && s) {
    rows.push(plain(`  ${muted(t('now:'))} ${roleInk(worker.role ?? '')(monitorText(worker.role ?? ''))} ${muted(worker.homeNeedsHuman ? `${t('asking')} ?` : minuteAge(s.at ?? null, now))}`));
    rows.push(...(modelEnabled && worker.modelSentence ? jobSentenceRows(worker.modelSentence, width, muted, true).map(plain)
      : stemLines(workCardDetail(projectWorkCard(worker, now)), width, muted, 3).map(plain)));
    const labels = labelSummary(worker.labels);
    if (labels) rows.push(plain('  ' + labels));
  } else if (r.commit || r.at !== undefined) rows.push(plain('  ' + muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? new Date(r.at).toISOString().slice(5, 10) : ''].filter(Boolean).join(' · '))));
  return rows;
}
export function progressTaskDetails(task: AcceptanceTask, data: ProjectSnapshot, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false): MonitorRow[] {
  return [...task.slices].sort((a, b) => PROGRESS_ORDER.indexOf(a.state) - PROGRESS_ORDER.indexOf(b.state)).flatMap((r) => {
    const glyph = progressMark(r.state);
    const right = theme.board.muted(t(r.state === 'try' ? 'to try' : r.state));
    return [boardRow(pair(`  ${glyph} ${monitorText(r.id)}`, right, width)), ...sliceDetailRows(r, data, width, now, board, modelEnabled)];
  });
}
/** A done/total meter `cells` wide, as thin as the panel's other meters; a started one shows at least a cell, an unfinished one never looks full. */
export function meter(done: number, total: number, cells: number): string {
  const filled = !total ? 0 : Math.min(cells - (done < total ? 1 : 0), Math.max(done ? 1 : 0, Math.round(done / total * cells)));
  return theme.board.success(mark('━', '#').repeat(filled)) + theme.board.muted(mark('─', '-').repeat(cells - filled));
}
const ASKS = /^(needs-triage|needs-info|ready-for-human)$/i;
/** A ticket that asks for the owner: it waits on an answer or a human, whatever else holds it. */
export const asksYou = (r: ProjectTicket) => (r.state === 'ready' || r.state === 'blocked') && ASKS.test(r.status);
const ticketLane = (r: ProjectTicket) => r.state === 'done' || r.state === 'dropped' ? 'done' : asksYou(r) ? 'you' : ticketWorking(r) ? 'working'
  : r.state;
const ticketGlyph = (r: ProjectTicket) => r.state === 'done' ? theme.board.success(mark('✓', '+')) : r.state === 'dropped' ? theme.board.muted(mark('–', '-'))
  : r.state === 'queued' ? theme.board.muted(mark('·', '.')) : r.state === 'try' ? sliceInk('try')(mark('◇', '*'))
  : r.state === 'blocked' ? theme.board.attention(mark('◆', '!')) : theme.board.active(ticketWorking(r) ? mark('◐', '@') : mark('●', '*'));
/** Two to four letters naming a feature on its tickets' rows: its words' initials, else the first letters of its slug, never the same for two. */
export function featureCodes(features: TicketFeature[]): Map<string, string> {
  const codes = new Map<string, string>(), used = new Set<string>();
  for (const { slug } of features) {
    const letters = slug.replace(/[^a-z0-9]/gi, ''), initials = slug.split(/[^a-z0-9]+/i).filter(Boolean).map((w) => w[0]).join('');
    const code = [initials, ...Array.from({ length: letters.length }, (_, n) => letters.slice(0, n + 1))]
      .find((c) => c.length >= 2 && !used.has(c.toLowerCase())) ?? letters;
    used.add(code.toLowerCase());
    codes.set(slug, code.toLowerCase().slice(0, 4));
  }
  return codes;
}
/**
 * The Tickets page: lanes by derived state (queued and done start folded), one row a ticket under the
 * code of its feature; the codes are listed once at the top. Enter on a ticket shows its checklist and latest comment here.
 */
export function ticketRows(data: ProjectSnapshot, folded: ReadonlySet<string>, width: number, now: number, feature?: TicketFeature, filtering = false): MonitorRow[] {
  const rows: MonitorRow[] = [], features = feature ? [feature] : data.tickets ?? [], codes = featureCodes(features);
  const all = features.flatMap((f) => f.tickets.map((ticket) => ({ ticket, feature: f })));
  if (!all.length) return rows;
  const column = Math.max(...[...codes.values()].map(visualLength)), done = data.ticketTotals?.doneTickets ?? all.filter(({ ticket }) => ticket.state === 'done').length;
  const total = data.ticketTotals?.totalTickets ?? all.length;
  if (!feature) {
    const label = ticketTotalText(data, t('{done}/{total} done', { done, total }));
    const cells = data.ticketTotals?.partial ? Math.min(16, width - 3 - visualLength(label)) : 16;
    rows.push(boardRow(fit(`  ${cells > 0 ? `${meter(done, total, cells)} ` : ''}${theme.board.muted(label)}`, width)));
    for (const line of pack(features.map((f) => `${theme.board.muted(codes.get(f.slug)!)} ${monitorText(f.slug)} ${theme.board.muted(`${f.tickets.filter(ticketResolved).length}/${f.tickets.length}`)}`), width))
      rows.push(boardRow(fit(line, width)));
  }
  const lane = (title: string, items: typeof all, fold?: string) => {
    if (!items.length) return;
    const open = !fold || folded.has(fold);
    rows.push(boardRow(''), { ...section(`${open ? '' : mark('▸', '>') + ' '}${t(title)}`, width, String(items.length)), ...(fold ? { item: `project:fold:${fold}` } : {}) });
    if (open) items.forEach((x) => ticketRow(x));
  };
  const ticketRow = ({ ticket, feature }: (typeof all)[number]) => {
    const job = ticket.job, live = !!job && !SETTLED_JOB_STATES.has(job.state), dropped = ticket.state === 'dropped', lane = ticketLane(ticket);
    const known = /^(done|closed|complete|resolved|wontfix|claimed|needs-triage|needs-info|ready-for-human|ready-for-agent)$/i.test(ticket.status);
    const target = ticket.blockers.length === 1 ? feature.tickets.find((r) => /^\d+$/.test(ticket.blockers[0]) && Number(r.number) === Number(ticket.blockers[0])) : undefined;
    const right = [
      lane === 'you' ? theme.board.attention(monitorText(ticket.status)) : '',
      ticket.blockers.length && (lane === 'blocked' || lane === 'queued') ? theme.board.muted(`${mark('←', '<')} ${monitorText(ticket.blockers.join(', '))}`) + (target ? ' ' + ticketGlyph(target) : '') : '',
      job && (live || width >= 64) ? [roleInk(job.role)(monitorText(job.role)), live ? '' : theme.board.muted(t(job.state)), theme.board.muted(minuteAge(job.at ?? null, now))].filter(Boolean).join(' ') : '',
      lane === 'working' && !live ? theme.board.active(t('working')) : '', dropped ? theme.board.muted(t('dropped')) : '',
      !known && lane !== 'you' ? theme.board.muted(monitorText(ticket.status)) : '',
      theme.board.muted(`${ticket.checked}/${ticket.total}`),
    ].filter(Boolean).join('  ');
    const lead = `  ${lane === 'you' ? theme.board.attention('?') : ticketGlyph(ticket)} ${theme.board.muted(fit(codes.get(feature.slug)!, column))} `;
    const number = monitorText(ticket.number), room = width - visualLength(lead) - visualLength(number) - 1 - (right ? visualLength(right) + 1 : 0);
    const title = `${number} ${cutTicketTitle(ticket.title, room)}`, tid = `ticket:${feature.slug}:${basename(ticket.path)}`, at = { item: `project:fold:${tid}`, files: [ticket.path] };
    rows.push({ text: pair(`${lead}${dropped ? theme.board.muted(title) : title}`, right, width), ...at });
    // For you: the latest comment is why, under the row. Enter shows what is checked and the whole comment here; o opens the file.
    const sub = (text: string) => rows.push({ text: fit(text, width), ...at });
    rows.push(...projectOriginal(ticket.originalTitle, tid, folded, width));
    if (!folded.has(tid)) return lane === 'you' && ticket.comment ? sub(`      ${theme.board.muted(`${mark('“', '"')}${clampLines(ticket.comment, width - 9, 1).lines[0]}${mark('”', '"')}`)}`) : undefined;
    for (const item of ticket.items) clampLines(item.text, width - 8, 2).lines.forEach((line, k) => sub(
      `      ${k ? '  ' : (item.done ? theme.board.success(mark('✓', '+')) : theme.board.muted(mark('○', 'o'))) + ' '}${line}`));
    if (!ticket.items.length) sub('      ' + theme.board.muted(t('no checklist')));
    if (ticket.comment) {
      const label = fit(t('comment'), 9);
      clampLines(ticket.comment, width - 6 - visualLength(label), 4).lines.forEach((line, k) =>
        sub(`      ${k ? ' '.repeat(visualLength(label)) : theme.board.muted(label)}${line}`));
    }
  };
  const by = (id: string) => all.filter(({ ticket }) => ticketLane(ticket) === id);
  lane('For you', by('you'));
  lane('Working', by('working').sort((a, b) => Number(!!b.ticket.job) - Number(!!a.ticket.job)));
  lane('to try', by('try'));
  lane('Ready', by('ready'));
  lane('Queued', by('queued'), filtering ? undefined : feature ? `lane:queued:${feature.slug}` : 'lane:queued');
  lane('Stalled', by('blocked'));
  lane('Done', by('done'), feature ? undefined : 'lane:done');
  return rows;
}
export function ticketPreview(data: ProjectSnapshot, key: string, folded: ReadonlySet<string>, width: number, now: number, filtering = false): MonitorRow[] {
  const id = `ticket:${key}`;
  return ticketRows(data, new Set([...folded, id]), width, now, undefined, filtering)
    .filter(r => r.item === `project:fold:${id}` || r.item === `project:fold:original:${id}`).slice(1)
    .map(r => r.item === `project:fold:${id}` ? { text: r.text } : r);
}
export const featureItem = (feature: TicketFeature) => `project:fold:feature:${feature.slug}`;
export function featureRow(feature: TicketFeature, width: number, open = false): MonitorRow {
  const openTickets = feature.tickets.filter((r) => r.state !== 'done' && r.state !== 'dropped');
  // Ticket numbers are ordered by creation, unlike the file mtime (last edit or mirror sync).
  const oldest = openTickets.reduce<ProjectTicket | undefined>((first, r) => !first || Number(r.number) < Number(first.number) ? r : first, undefined);
  const status = oldest && (oldest.state === 'ready' || asksYou(oldest) ? oldest.status.trim().split(/\s+/)[0] : ticketStateWord(oldest));
  const ratio = `${feature.tickets.length - openTickets.length}/${feature.tickets.length}`;
  const word = status && monitorText(t(status));
  const right = word && visualLength(word) + visualLength(ratio) + 8 <= width ? `${ratio}  ${word}` : ratio;
  return { item: featureItem(feature), text: pair(`  ${mark(open ? '▾' : '▸', open ? 'v' : '>')} ${monitorText(feature.slug)}`, theme.board.muted(right), width) };
}
/** One page: today's section content, without the section header (the crumb names the page). */
export function pageRows(
  page: ProjectPage, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = state.project.folded;
  const item = (r: ProjectItem, i: number, glyph = '') => rows.push(projectItem(r, i, glyph, width, now));
  if (page === 'progress') {
    const fileRow = (text: string, key: string, path = data.statePath) => rows.push({
      text: fit(text, width), ...(path ? { item: `project:file:${path}:${key}`, files: [path] } : {}),
    });
    const head = (label: string, right: string | number = '') => rows.push(boardRow(''), section(t(label), width, String(right)));
    if (data.summary) for (const line of clampLines(data.summary, width - 2, 2).lines) fileRow('  ' + line, 'summary');
    const tasks = progressTasks(data);
    if (tasks.length) rows.push(progressTasksHeading(tasks.length, width));
    else rows.push(boardRow('  ' + theme.board.muted(t(data.ticketTotals?.partial ? 'Partial' : 'No tickets'))));
    for (const task of tasks) {
      const row = progressTaskHeader(task, data, width, now);
      rows.push(row);
      if (folded.has(row.item!.slice('project:fold:'.length))) rows.push(...progressTaskDetails(task, data, width, now, board, modelEnabled)
        .map((detail) => ({ ...row, ...detail, item: detail.item ?? row.item })));
    }
    const jobs = unsliced(data);
    if (jobs.length) head('Now', jobs.length);
    // Jobs of this project that no slice shows: an imp working in the main checkout, say. Each row is a stop of its own
    // (so a long list pages by keyboard); Enter or `o` opens its report, else its brief.
    for (const job of jobs) {
      const right = [job.asking ? `${t('asking')} ?` : minuteAge(job.at ?? null, now)].filter(Boolean).join(' ');
      for (const line of stacked(`  ${sliceInk('working')(mark('◉', '@'))} ${monitorText(job.role || job.jobId.slice(-6))}`,
        job.title ?? job.package ?? '', theme.board.muted(right), width, 4)) rows.push({
        text: fit(line, width), item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}),
      });
    }
    if (data.next.length) head('Next', data.next.length);
    // Two bullets; Enter on the `more` row shows the rest (and `fewer` folds them again).
    const all = folded.has('next'), more = data.next.length - 2;
    (all ? data.next : data.next.slice(0, 2)).forEach((r, i) => {
      const id = `next:${i}`, clip = clampLines(r.value, width - 4, 2);
      // Folded to two rows; Enter shows the rest. A bullet that fits has nothing to show and opens STATE.md.
      for (const [k, line] of (folded.has(id) ? clampLines(r.value, width - 4, Infinity) : clip).lines.entries()) rows.push({
        text: fit(`${k ? '    ' : `  ${mark('→', '>')} `}${line}`, width),
        ...(clip.more ? { item: `project:fold:${id}` } : r.path ? { item: `project:file:${r.path}:${id}` } : {}),
        ...(r.path ? { files: [r.path] } : {}),
      });
    });
    if (more > 0) rows.push({ text: fit(`  ${theme.board.muted(`${all ? mark('▾', 'v') : mark('▸', '>')} ${all ? t('fewer') : t('{n} more', { n: more })}`)}`, width), item: 'project:fold:next' });
  } else if (page === 'waiting') {
    // One waiting item, in STATE's words and order: a line that continues a sentence flows on, a list line starts a paragraph of its own;
    // every wrapped row is a stop, so the movement keys scroll it, and `o` opens STATE.md.
    const index = state.project.view.kind === 'waiting' ? state.project.view.index : -1;
    const r = data.waiting[index], paragraphs: string[] = [];
    for (const line of (r?.text ?? r?.value ?? '').split('\n').map((l) => l.trim()).filter(Boolean))
      if (!paragraphs.length || /^([-*]|\d+[.)])\s/.test(line)) paragraphs.push(line);
      else paragraphs[paragraphs.length - 1] += ' ' + line;
    for (const [k, paragraph] of paragraphs.entries()) {
      const marker = k ? paragraph.match(/^([-*]|\d+[.)])\s+/)?.[0] ?? '' : '', hang = 2 + marker.length;
      flowLines(monitorText(paragraph.slice(marker.length)), width - hang).forEach((line, n) => rows.push({
        text: fit((n ? ' '.repeat(hang) : k ? '  ' + marker : theme.board.attention('?') + ' ') + line, width),
        item: `project:wait:${index}:${rows.length - 1}`, ...(r.path ? { files: [r.path] } : {}) }));
    }
    rows.push(...projectOriginal(r?.original, `wait:${index}`, folded, width));
  } else if (page === 'tickets') {
    for (const feature of data.tickets) {
      const open = folded.has(featureItem(feature).slice('project:fold:'.length));
      rows.push(featureRow(feature, width, open));
      if (open) rows.push(...ticketRows(data, folded, width, now, feature).slice(1));
    }
  } else if (page === 'tree') {
    if (data.git) item({ label: 'branch', value: [
      data.git.branch, t('{n} changed', { n: data.git.changed }),
      data.git.ahead === null ? '' : `${data.git.ahead} ${t('ahead')}`,
      data.git.behind ? `${data.git.behind} ${t('behind')}` : '',
    ].filter(Boolean).join(' · ') }, 0);
    rows.push(...diffStatRows(data.gitDiff, width));
    data.editing.forEach((r, i) => item(r, i, theme.board.active(mark('◉', '@'))));
    if (data.last) item({ label: 'last', value: data.last.text, at: data.last.at }, 0);
    // Worktrees with no ledger row, counted on the hub's Working tree row.
    if (unlisted(data).length) rows.push(boardRow(''), section(t('Unlisted worktrees'), width, String(unlisted(data).length)),
      ...unlisted(data).map((r) => boardRow(pair(`  ${theme.board.attention('!')} ${monitorText(r.label)}`, theme.board.muted(t('no linked ticket')), width))));
  } else if (page === 'docs') data.docs.forEach((r, i) => item(r, i));
  if (rows.length === 1) rows.push(boardRow('  ' + theme.board.muted(t('none'))));
  return rows;
}
/** The Project tab: a hub of one summary row per page, or the page the panel has open. */
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false, name = '', projects: ProjectChoice[] = [], room?: number
): MonitorRow[] {
  const page = projectPageOf(state);
  // The list reads each project's own overview; the shown project's full snapshot is not needed for it.
  if (projectListOpen(state, projects)) return inboxListRows(projects, width, now);
  if (!data) return [];
  return page ? pageRows(page, data, state, width, now, board, modelEnabled) : inboxHubRows(data, state, width, now, name, projects, board, room);
}

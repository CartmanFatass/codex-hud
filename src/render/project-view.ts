/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, SETTLED_JOB_STATES, type SliceState, type ProjectSnapshot, type ProjectItem, type ProjectTicket, type TicketFeature, type LedgerSlice, type TryBrief } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { TryAction } from '../collectors/try-records.js';
import { acceptanceTasks, ledgerTasks, type AcceptanceTask } from '../collectors/acceptance-tasks.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { jobSentenceLine, jobSentenceRows, stemLines, workCardDetail, labelSummary } from './work-card.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { activeTabState, onlyTry, projectPage } from './monitor-state.js';
import { basename } from 'node:path';
import { boardRow, itemRow, originalRows, section, mark, minuteAge, pack } from './workboard-rows.js';
import { boardHubRows, boardListRows, boardProgressRows } from './board-project.js';
import { inboxHubRows, inboxListRows, inboxProgressRows } from './inbox-project.js';
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
export const HOME_BLOCK = 60;
const HOME_TICKETS = 6, HOME_WAITING = 5;
/** Group the collector's derived states for display; never infer activity from tracker files or jobs here. */
function homeTicketRows(data: ProjectSnapshot, width: number, slices: boolean, expanded?: ReadonlySet<string>): MonitorRow[] {
  const totals = data.ticketTotals;
  if (!totals?.totalTickets) return [];
  const row = (text: string, key: string): MonitorRow => ({ text: fit(text, width), item: `home-progress:tickets:${key}` });
  const { doneTickets, totalTickets, doneFeatures, totalFeatures } = totals;
  const closed = t('{done}/{total} closed', { done: doneFeatures, total: totalFeatures });
  const label = `  ${t('Tickets')}`, ratio = `${doneTickets}/${totalTickets}`;
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
    const ticket = open[0], lane = ticketLane(ticket), waiting = open.filter(r => r.state === 'queued').length;
    if (!done && (lane === 'ready' || lane === 'queued')) {
      planned++; ready += open.length - waiting; queued += waiting;
      continue;
    }
    startedFeatures++;
    const you = lane === 'you', word = you ? t('For you') : ticketStateWord(ticket);
    const head = `  ${you ? theme.board.attention('?') : ticketGlyph(ticket)} ${monitorText(slug)}`;
    const right = `${done}/${tickets.length} · ${open.filter(r => ticketLane(r) === lane).length} ${word}`;
    const bar = visualLength(head + right) + 6 <= width ? ' ' + meter(done, tickets.length, 4) : '';
    started.push(row(pair(head + bar, theme.board.muted(right), width), slug));
    if (!slices) continue;
    const show = open.filter(r => r.state !== 'queued').slice(0, HOME_TICKETS);
    for (const r of show) {
      const lead = `  ${monitorText(r.number)} `, state = asksYou(r) ? t('For you') : ticketStateWord(r);
      started.push(row(pair(lead + cutTicketTitle(r.title, width - visualLength(lead + state) - 1), theme.board.muted(state), width), slug));
      const key = `original:ticket:${slug}:${r.number}`;
      started.push(...originalRows(r.originalTitle, key, expanded?.has(key) ?? false, width));
    }
    if (waiting) started.push(row('  ' + theme.board.muted(t('+{n} queued', { n: waiting })), slug));
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
export function homeProgressRows(data: ProjectSnapshot | undefined, width: number, spare: number, gap = true, acceptance?: MonitorState['prefs']['acceptance'], expanded?: ReadonlySet<string>): MonitorRow[] {
  if (!data || spare < 3 || (!data.summary && !data.ladder.current && !data.ledger.length && !data.tickets.length)) return [];
  const row = (text: string, id = 'progress'): MonitorRow => ({ text: fit(text, width), item: `home-progress:${id}` });
  const cur = currentRows(data), counts = cur.counts, states = HOME_STATES.filter(s => counts[s]);
  const legend = (words?: typeof HOME_WORD) => states.map(s => sliceInk(s)(`${mark(...PROGRESS_MARK[s])} ${counts[s]}${words ? ' ' + t(words[s]) : ''}`)).join(words === HOME_SHORT ? ' ' : '  ');
  const legendLine = [legend(HOME_WORD), legend(HOME_SHORT)].find(line => visualLength(line) <= width - 2) ?? legend();
  const fraction = `${counts.accepted}/${cur.rows.length - counts.dropped}`;
  const summary = data.summary ? clampLines(data.summary, width - 2, 3).lines : [];
  const milestone = data.ladder.current && (cur.whole && cur.rows.length ? '' : data.ladder.current);
  const head = section(t('Progress'), width, milestone ? `${t('Milestone')} ${monitorText(milestone)}` : cur.rows.length ? t('All slices') : '');
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
  return room > 0 ? [...rows, ...homeTicketRows(data, width, acceptance === 'slice', expanded).slice(0, room)] : rows;
}
/**
 * Home's spare rows, top to bottom: STATE's waiting items (a row each) and the newest landed slices under the cards, the progress block
 * at the bottom. The block takes its rows first (its own order of shrinking is above); the two lists, waiting first, take what is left.
 */
export function homeSpareRows(data: ProjectSnapshot | undefined, width: number, spare: number, now: number, gap: boolean, state: MonitorState, marks?: ReadonlyMap<string, TryAction>): MonitorRow[] {
  if (!data || spare < 1) return [];
  const progress = homeProgressRows(data, width, spare, gap, state.prefs.acceptance, state.home.expanded), out: MonitorRow[] = [], keep = progress.length + (progress.length && !gap ? 1 : 0);
  const pending = state.prefs.acceptance === 'slice' ? 0 : tryCount(data, state.prefs.acceptance);
  // A list of at most `all.length` rows out of `total`; short of room it ends with `+N more` for those it does not show.
  const list = (head: MonitorRow, id: string, all: MonitorRow[][], total: number, room: number): MonitorRow[] => {
    const slots = room - 1, item = `home-progress:${id}`;
    if (slots < 1 || !all.length) return [];
    const limit = (total > all.length || all.flat().length > slots) && slots > 2 ? slots - 1 : slots;
    const shown = all.flat().slice(0, limit), hidden = total - all.filter(group => shown.includes(group[0])).length;
    return [{ ...head, item }, ...shown, ...(hidden > 0 && slots > 2 ? [{ text: fit('  ' + theme.board.muted(t('+{n} more', { n: hidden })), width), item }] : [])];
  };
  const lists = [
    (room: number) => list(section(t('Waiting for you'), width, [String(data.waiting.length), pending ? t('{n} to try', { n: pending }) : ''].filter(Boolean).join(' · ')), 'waiting', data.waiting.slice(0, HOME_WAITING).map((r, i) => [{
      ...itemRow(theme.board.attention('?'), monitorText(r.value), '', width), item: `home-progress:wait:${i}` },
      ...originalRows(r.original, `original:wait:${i}`, state.home.expanded.has(`original:wait:${i}`), width)]), data.waiting.length, room),
    (room: number) => {
      const landed = landedEntries(data, state.prefs.acceptance, true).slice(0, width < 56 ? 3 : 5).map((entry): MonitorRow[] => 'task' in entry
        ? taskHeaderRows(entry.task, data, state, width, now, marks, { status: true })
        : [{ text: landedInline(entry.r, `  ${landedMark(entry.r)} ${monitorText(entry.r.id)}`, landedAge(entry.r, now), width), item: 'home-progress:latest' }]);
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
function pageMeta(page: ProjectPage, data: ProjectSnapshot, now: number, acceptance?: MonitorState['prefs']['acceptance']): string[] {
  if (page === 'progress') {
    const drift = inFlight(data).filter((r) => r.drift).length, bang = drift ? theme.board.attention(`! ${drift}`) : '';
    return [parts(updatedText(data, now), bang).join(' · '), bang];
  }
  if (page === 'tickets' && acceptance !== 'slice') return data.tickets?.length ? [featureCountText(data.ticketTotals?.totalFeatures ?? data.tickets.length)] : [];
  if (page === 'tickets') return data.tickets?.length ? [t('{features} features · {tickets} tickets', {
    features: data.ticketTotals?.totalFeatures ?? data.tickets.length, tickets: data.ticketTotals?.totalTickets ?? data.tickets.reduce((n, f) => n + f.tickets.length, 0) })] : [];
  return [];
}
/** `Project › Page` for the sub-page title row (the project's name instead of `Project` when there is a switch), with the page's own facts on the right when there is room. */
export function projectCrumb(page: ProjectPage, data: ProjectSnapshot | undefined, width: number, now: number, name = '', acceptance?: MonitorState['prefs']['acceptance']) {
  const crumb = `${name ? truncateAnsi(monitorText(name), 16) : t('Project')} ${mark('›', '>')} ${t(PAGE_WORD[page])}`;
  return { crumb, right: (data && pageMeta(page, data, now, acceptance).find((r) => r && visualLength(crumb) + 4 + visualLength(r) <= width)) || '' };
}
/** One line per page, most important fact first: a row too short for all of them drops the last, not part of one. */
export function pageSummary(page: ProjectPage, data: ProjectSnapshot, now: number, showMilestone = true, acceptance?: MonitorState['prefs']['acceptance']): string[] {
  const g = data.git;
  if (page === 'progress') {
    const pending = tryCount(data, acceptance);
    const tasks = acceptance === 'slice' ? undefined : ledgerTasks(data.ledger);
    const counts = currentRows(data).counts;
    const blocked = tasks ? tasks.filter((task) => task.slices.some((r) => r.state === 'blocked')).length : counts.blocked;
    const working = tasks ? tasks.filter((task) => task.slices.some((r) => r.state === 'working')).length : counts.working;
    const milestone = showMilestone && data.ladder.current && monitorText(data.ladder.current);
    const toTry = pending && t('{n} to try', { n: pending });
    const lead = tasks ? [toTry, tasks.length && taskCountText(tasks.length), milestone] : [milestone, toTry];
    return parts(...lead, blocked && `${blocked} ${t('blocked')}`,
      working && `${working} ${t('working')}`, !data.statePath && !data.ledger.length && t('no STATE.md'));
  }
  if (page === 'tickets') {
    if (acceptance !== 'slice') return data.tickets.length ? [featureCountText(data.ticketTotals?.totalFeatures ?? data.tickets.length)] : [];
    const tickets = data.tickets.flatMap((f) => f.tickets);
    const working = tickets.filter(ticketWorking).length, blocked = tickets.filter((r) => r.state === 'blocked').length;
    return tickets.length ? parts(t('{done}/{total} done', { done: data.ticketTotals?.doneTickets ?? tickets.filter((r) => r.state === 'done').length, total: data.ticketTotals?.totalTickets ?? tickets.length }),
      working && `${working} ${t('working')}`, blocked && `${blocked} ${t('blocked')}`) : [];
  }
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
export const foldRow = (folded: ReadonlySet<string>, id: string, label: string, width: number, right = ''): MonitorRow => ({
  ...section(`${folded.has(id) ? mark('▸', '>') + ' ' : ''}${t(label)}`, width, right), item: `project:fold:${id}`,
});
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
export function waitingPreview(r: ProjectItem, i: number, width: number, now: number, folded: ReadonlySet<string>) {
  return [...waitingRows(r, i, width, now, Infinity), ...projectOriginal(r.original, `wait:${i}`, folded, width)];
}
export const roleInk = (role: string) => (theme.board.roleInk as Record<string, (s: string) => string>)[role] ?? ((s: string) => s);
const DAY = 864e5;
/** STATE's current milestone's ledger rows with their counts; a ledger that has none of them (or no current milestone) is counted whole. */
export function currentRows(data: ProjectSnapshot) {
  const mine = data.ledger.filter((r) => (r.release ?? r.milestone) === data.ladder.current), rows = mine.length ? mine : data.ledger;
  const counts = Object.fromEntries(SLICE_STATES.map((s) => [s, rows.filter((r) => r.state === s).length])) as ProjectSnapshot['counts'];
  return { rows, counts, whole: !mine.length };
}
/** A brief's sentence cut onto a row beside its id keeps at least this many cells, or the row says the id alone: a few words and `…` tell nothing. */
const CUT_MIN = 14;
/**
 * `head` and `text` on one row when the text fits whole beside `right`; else the head alone (a hub row never wraps or cuts its text).
 * A brief's sentence (`cut`) is cut with an ellipsis instead, while a few cells of it fit.
 */
export const inline = (head: string, text: string, right: string, width: number, cut = false, gap = 2) => {
  const body = monitorText(text), room = width - visualLength(head) - gap - (right ? visualLength(right) + 1 : 0);
  return pair(body && (visualLength(body) <= room || (cut && room >= CUT_MIN)) ? `${head}${' '.repeat(gap)}${theme.board.muted(truncateAnsi(body, room))}` : head, right, width);
};
/** Split Progress: fit the ledger's prose between the id and the age or live-job facts. */
export function sliceLedgerLine(r: LedgerSlice, head: string, right: string, width: number, gap = 1): string {
  const rightWidth = visualLength(right), room = width - visualLength(head) - gap - (rightWidth ? rightWidth + 1 : 0);
  const body = monitorText(ledgerText(r));
  const text = body && room > 0 ? cutWords(body, room) || mark('…', '~') : '';
  return pair(text ? `${head}${' '.repeat(gap)}${theme.board.muted(text)}` : head, rightWidth ? right : '', width);
}
/** A brief's first sentence: up to the first `。！？` or `.!?` that ends a word, with any closing quote or bracket after it. */
export const firstSentence = (text: string): string => /^.*?(?:[。！？]|[.!?](?=\s|$))[”’」』）)\]]*/su.exec(text.trim())?.[0] ?? text.trim();
/** A to-try slice's sentence for its list row: its brief's first, or nothing (the row then says the ledger's text). */
export const trySentence = (r: LedgerSlice): string => (r.state === 'try' && r.brief ? firstSentence(r.brief.brief) : '');
/** A briefed to-try slice: its id and age on one row, with its brief's first sentence beside them when the whole of it fits, else under them (two rows at most, cut with `…`): a long id never leaves the sentence a few cells. */
export const briefStack = (head: string, sentence: string, right: string, width: number, indent = 4, max = 2): string[] => {
  const body = monitorText(sentence);
  return visualLength(head) + 2 + visualLength(body) + (right ? visualLength(right) + 1 : 0) <= width ? [pair(`${head}  ${theme.board.muted(body)}`, right, width)]
    : [pair(head, right, width), ...clampClean(body, width - indent, max).lines.map((l) => fit(' '.repeat(indent) + theme.board.muted(l), width))];
};
/** A landed slice on one row: a to-try slice's brief sentence (cut to the room), else the ledger's text, whole or not at all. */
export const landedInline = (r: LedgerSlice, head: string, right: string, width: number) => {
  const sentence = trySentence(r);
  return inline(head, sentence || ledgerText(r), right, width, !!sentence);
};
/** The whole ledger's pending acceptance count, independent of the selected milestone. */
export const tryCount = (data: Pick<ProjectSnapshot, 'ledger'>, acceptance?: MonitorState['prefs']['acceptance']) =>
  acceptance === 'slice' ? data.ledger.filter((r) => r.state === 'try').length : acceptanceTasks(data.ledger).length;
/** `3/8 accepted`: what a milestone's bar counts, in words (accepted slices of all but the dropped). */
export const acceptedText = (counts: ProjectSnapshot['counts'], rows: number) =>
  t('{done}/{total} accepted', { done: counts.accepted, total: rows - counts.dropped });
/** Jobs of this project that no slice shows: an imp working in the main checkout, say. */
export const unsliced = (data: ProjectSnapshot) => data.active.filter((a) => !data.slices.some((r) => r.jobId === a.jobId));
/** Worktrees with no ledger row: the Working tree page counts and lists them; Now is about work in flight. */
export const unlisted = (data: ProjectSnapshot) => data.slices.filter((r) => r.drift === 'not in ledger');
export const inFlight = (data: ProjectSnapshot) => data.slices.filter((r) => r.drift !== 'not in ledger');
/** Landed slices (to try or accepted), the newest first by commit date; those with none last, the later ledger rows first. */
export const landedNewest = (data: ProjectSnapshot) => data.ledger.flatMap((r, i) => r.state === 'try' || r.state === 'accepted' ? [{ r, i }] : [])
  .sort((a, b) => (b.r.at ?? -1) - (a.r.at ?? -1) || b.i - a.i);
export const newestTasks = (data: ProjectSnapshot) => acceptanceTasks(landedNewest(data).map(({ r }) => r));
/** In mixed feeds, a pending task takes the place of its newest member. Accepted entries stay per slice. */
export function landedEntries(data: ProjectSnapshot, acceptance?: MonitorState['prefs']['acceptance'], home = false): ({ r: LedgerSlice } | { task: AcceptanceTask })[] {
  // The Home read knows commit dates only for pending work, so keep ledger order for its mixed list.
  const landed = home && acceptance !== 'slice'
    ? data.ledger.filter((r) => r.state === 'try' || r.state === 'accepted').reverse().map((r) => ({ r }))
    : landedNewest(data);
  if (acceptance === 'slice') return landed;
  const tasks = new Map(acceptanceTasks(landed.map(({ r }) => r)).map((task) => [task.slices[0], task]));
  return landed.flatMap(({ r }): ({ r: LedgerSlice } | { task: AcceptanceTask })[] => {
    const task = tasks.get(r);
    return r.state === 'accepted' ? [{ r }] : task ? [{ task }] : [];
  });
}
export const trySelectionMark = (state: MonitorState, item: string) => activeTabState(state)?.trySelection?.has(item) ? `${theme.board.active(mark('▣', '*'))} ` : '';
export const landedMark = (r: LedgerSlice, action?: TryAction) => action === 'flag' ? theme.board.attention(mark('⚑', '!'))
  : r.state === 'try' && action !== 'accept' ? sliceInk('try')(mark('◇', 'o')) : sliceInk('accepted')(mark('✓', '+'));
/** The hub's Latest and Progress's History share this right side: `to try 10h`, or only the age for an accepted slice on Progress. */
export const landedAge = (r: LedgerSlice, now: number, word = true) =>
  [r.state === 'try' ? sliceInk('try')(t('to try')) : word ? theme.board.muted(t('accepted')) : '', theme.board.muted(sinceText(r.at, now))].filter(Boolean).join(' ');
/** What is in flight, a row each: who is on which slice and for how long, then the jobs no slice shows. */
export function hubNowRows(data: ProjectSnapshot, width: number, now: number, board?: WorkboardSnapshot): MonitorRow[] {
  return [...inFlight(data).map((r): MonitorRow => {
    const worker = board?.workers.find((w) => w.evidence[0]?.sourceId === r.jobId), role = worker?.role ?? r.role ?? '';
    const reason = r.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(r.ledgerState ?? '')) }) : r.drift ? t(r.drift) : '';
    const blocked = r.ledgerState === 'blocked', lead = r.drift ? theme.board.attention('!') : blocked ? sliceInk('blocked')(mark('◆', '!')) : sliceInk('working')(mark('◐', '@'));
    const who = reason ? theme.board.attention(reason) : r.jobId
      ? [role && roleInk(role)(monitorText(role)), (worker?.homeNeedsHuman ?? r.asking) ? theme.board.attention(`${t('asking')} ?`) : theme.board.muted(minuteAge(r.at ?? null, now))].filter(Boolean).join(' ')
      : sliceInk(blocked ? 'blocked' : 'working')(t(r.ledgerState ?? 'working'));
    return { text: inline(`  ${lead} ${monitorText(r.label)}`, r.value, who, width) };
  }), ...unsliced(data).map((job): MonitorRow => ({
    text: pair(`  ${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}${job.title ? '  ' + theme.board.muted(monitorText(job.title)) : ''}`,
      job.asking ? theme.board.attention(`${t('asking')} ?`) : theme.board.muted(minuteAge(job.at ?? null, now)), width),
  }))];
}
/**
 * The hub: the project's name and milestone, what waits for the owner, what is happening now (who is on which slice and for how
 * long), what landed last, then one summary row per page. A panel shorter than all that loses Latest first (to its newest rows,
 * then whole), then the Progress bar and the blank rows between blocks; Waiting for you, Now and the page rows stay.
 */
function hubRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[],
  board?: WorkboardSnapshot, room?: number, tryMarks?: ReadonlyMap<string, TryAction>
): MonitorRow[] {
  const folded = state.project.folded;
  // With more than one project the name row opens the Projects list (Enter or a click); `[` and `]` still step through them.
  const many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const top: MonitorRow[] = [boardRow(''), {
    ...section(theme.board.title(monitorText(name) || t('Project')), width,
      [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
    ...(many ? { item: 'project:switch' } : {}),
  }];
  // The header counts the items and how many of them are tries; the items flow into `wrap` spare rows, top down, and the one the cursor is on keeps its whole text.
  const tries = tryCount(data, state.prefs.acceptance);
  const waitingBlock = (wrap: number, keep = false): MonitorRow[] => {
    if (!data.waiting.length) return [];
    const rows = [foldRow(folded, 'waiting', 'Waiting for you', width, [data.waiting.length, tries && t('{n} to try', { n: tries })].filter(Boolean).join(' · '))];
    if (!folded.has('waiting')) for (const [i, r] of data.waiting.entries()) {
      const item = waitingRows(r, i, width, now, keep && state.project.nav.cursor === `project:wait:${i}` ? Infinity : 1 + Math.max(0, wrap));
      wrap -= item.length - 1;
      rows.push(...item, ...projectOriginal(r.original, `wait:${i}`, folded, width));
    }
    return [...rows, boardRow('')];
  };
  const nowRows = hubNowRows(data, width, now, board);
  // Nothing in flight is said, not left blank.
  const nowBlock: MonitorRow[] = [section(t('Now'), width, nowRows.length ? String(nowRows.length) : ''),
    ...(nowRows.length ? nowRows : [boardRow('  ' + theme.board.muted(t('Nothing in progress')))]), boardRow('')];
  const landed = landedEntries(data, state.prefs.acceptance).slice(0, width < 56 ? 3 : 5);
  const latest = (n: number): MonitorRow[] => n ? [section(t('Latest'), width), ...landed.slice(0, n).flatMap((entry): MonitorRow[] => 'task' in entry
    ? taskRows(entry.task, data, state, width, now, tryMarks, true)
    : [{ text: landedInline(entry.r, `  ${landedMark(entry.r)} ${monitorText(entry.r.id)}`, landedAge(entry.r, now), width) }]), boardRow('')] : [];
  const column = Math.max(...PROJECT_PAGES.map((p) => visualLength(t(PAGE_WORD[p])))) + 1, space = Math.max(1, width - column);
  const pages = (bar: boolean): MonitorRow[] => PROJECT_PAGES.flatMap((page) => {
    // A project with no tickets has no Tickets entry, as it had no empty section before.
    if (page === 'tickets' && !data.tickets?.length) return [];
    const facts = pageSummary(page, data, now, false, state.prefs.acceptance);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > space) facts.pop();
    const item = `project:page:${page}`, rows: MonitorRow[] = [{ text: fit(`${theme.board.title(fit(t(PAGE_WORD[page]), column))}${facts.join(' · ') || mark('–', '-')}`, width), item }];
    // The bar is the current milestone's, under its row; it opens the same page.
    const cells = Math.min(width, HOME_BLOCK), counts = currentRows(data).counts;
    if (bar && page === 'progress' && progressSegments(counts, cells).some((s) => s.width)) rows.push({ text: fit(barText({ counts }, cells), width), item });
    return rows;
  });
  const build = (n: number, bar: boolean, gaps: boolean, wrap = 0, keep = false) => [...top, ...waitingBlock(wrap, keep), ...nowBlock, ...latest(n), ...pages(bar)]
    .filter((r) => gaps || r.text !== '' || r.item);
  const tiers: [number, boolean, boolean][] = [...landed.map((_, i): [number, boolean, boolean] => [landed.length - i, true, true]), [0, true, true], [0, false, true], [0, false, false]];
  for (const [k, [n, bar, gaps]] of tiers.entries()) {
    const rows = build(n, bar, gaps);
    // Only the spare rows of the whole hub flow waiting items; a shorter panel cuts them to one row before Latest or the bar give way (the cursor's item stays whole).
    if (room === undefined || rows.length <= room || rows.some((r) => r.item === state.project.nav.cursor && r.item?.startsWith('project:fold:task:'))) {
      return build(n, bar, gaps, k ? 0 : room === undefined ? Infinity : Math.max(0, room - rows.length), true);
    }
  }
  return build(0, false, false, 0, true);
}
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
/** Two rows a project: its name, milestone and what needs you (`?`) or runs (`◉`); then what it is doing (`◐ A-ONE working`, `◇ B-TWO to try`) and how long since it was touched; a wide row keeps its bar. */
function listRows(projects: ProjectChoice[], width: number, now: number, acceptance?: MonitorState['prefs']['acceptance']): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], cells = Math.max(8, Math.min(24, width - 26));
  for (const { root, name, overview: o } of projectOrder(projects)) {
    const item = `project:list:${root}`, title = monitorText(name), milestone = o?.milestone ? monitorText(o.milestone) : '';
    const marks = [o?.waiting ? theme.board.attention(`? ${o.waiting}`) : '', o?.running ? theme.board.active(`${mark('◉', '@')} ${o.running}`) : '']
      .filter(Boolean).join('  ');
    const fits = milestone && visualLength(title) + 2 + visualLength(milestone) <= width - visualLength(marks) - (marks ? 1 : 0);
    rows.push({ text: pair(theme.board.title(title) + (fits ? '  ' + theme.board.muted(milestone) : ''), marks, width), item });
    const bar = o?.hasState && progressSegments(o.counts, cells).some((s) => s.width) ? barText(o, cells) : '';
    const last = o?.latest, glyph = !last ? '' : ({ working: sliceInk('working')(mark('◐', '@')), blocked: sliceInk('blocked')(mark('◆', '!')),
      try: sliceInk('try')(mark('◇', 'o')), accepted: sliceInk('accepted')(mark('✓', '+')) })[last.state];
    const pending = acceptance === 'slice' ? o?.counts.try : o?.tryTasks ?? o?.counts.try;
    const key = !o ? '' : pending ? sliceInk('try')(t('{n} to try', { n: pending })) : o.open ? theme.board.muted(t('{n} open', { n: o.open })) : '';
    const body = !o ? theme.board.muted(mark('…', '~'))
      : !o.hasState ? theme.board.muted([t('no STATE.md'), o.open ? t('{n} open', { n: o.open }) : ''].filter(Boolean).join(' · '))
      : last?.state === 'try' && acceptance !== 'slice' && key ? key
      : last ? `${width >= 80 && bar ? bar + '  ' : ''}${glyph} ${monitorText(last.ids.join(', '))} ${sliceInk(last.state)(t(last.state === 'try' ? 'to try' : last.state))}`
      : `${bar}${' '.repeat(Math.max(0, cells - visualLength(bar)))}${key ? '  ' + key : ''}`;
    rows.push({ text: pair(`  ${body}`, theme.board.muted(sinceText(o?.at, now)), width), item });
  }
  return rows;
}
export const NO_MILESTONE = /^[—–-]*$/;
/** Milestones in ledger order, oldest first; STATE's current one is always among them. A ledger naming none falls back to spec §5. */
export function milestoneOrder(data: ProjectSnapshot): string[] {
  const seen = new Set(data.ledger.map((r) => r.release ?? r.milestone).filter((m) => !NO_MILESTONE.test(m)));
  if (!seen.size) data.ladder.ids.forEach((id) => seen.add(id));
  if (data.ladder.current) seen.add(data.ladder.current);
  return [...seen];
}
/** A ledger row's text without its commit, which the row shows beside the date: `(abc1234)` at the end or `abc1234 · ` at the start. */
export const ledgerText = (r: LedgerSlice) => r.text.replace(/\s*\((?:[0-9a-f]{7,40}(?:[,;]\s*|(?=\))))+\)\s*$/i, '')
  .replace(/^[0-9a-f]{7,40}\s*·\s*/i, '').trim();
/** `MM-DD`, with the year when it is not this one. */
export function dateText(at: number, now: number): string {
  const day = new Date(at), two = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear() === new Date(now).getFullYear() ? '' : day.getFullYear() + '-'}${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}
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
/** A to-try slice's model brief and its numbered steps, flowed whole at `indent`. */
export function briefRows(b: TryBrief, width: number, indent = 2): string[] {
  const pad = ' '.repeat(indent);
  return [...clampLines(b.brief, width - indent, Infinity).lines.map((l) => pad + l),
    ...(b.steps.length ? [pad + theme.board.muted(t('How to try'))] : []),
    ...b.steps.flatMap((s, i) => clampLines(s, width - indent - 3, Infinity).lines.map((l, k) => pad + (k ? '   ' : `${i + 1}. `) + l))];
}
/** The row that unfolds a slice's original ledger text (`project:fold:ledger:<id>`; membership of the fold set means open). */
export const ledgerFoldItem = (r: LedgerSlice) => `project:fold:ledger:${r.id}`;
/**
 * A to-try slice laid open (Classic's expanded row, Split's preview): its brief and numbered steps, then the original ledger text
 * folded below them, which is written for agents and unfolds on Enter. With no brief nothing is folded: the text is shown whole.
 * Only the fold row carries an `item`; the caller gives the rest its own.
 */
export function tryDetailRows(r: LedgerSlice, width: number, indent: number, open: boolean): MonitorRow[] {
  const pad = ' '.repeat(indent), original = clampLines(ledgerText(r) || r.text, width - indent - 2, Infinity).lines;
  if (!r.brief) return clampLines(ledgerText(r) || r.text, width - indent, Infinity).lines.map((l) => ({ text: fit(pad + l, width) }));
  return [...briefRows(r.brief, width, indent).map((text): MonitorRow => ({ text: fit(text, width) })),
    { text: fit(pad + theme.board.muted(`${open ? mark('▾', 'v') : mark('▸', '>')} ${t('Ledger line')}`), width), item: ledgerFoldItem(r) },
    ...(open ? original.map((l): MonitorRow => ({ text: fit(`${pad}  ${theme.board.muted(l)}`, width) })) : [])];
}
export const taskItem = (task: AcceptanceTask) => `project:fold:task:${task.key}`;
export const taskLabel = (task: AcceptanceTask) => monitorText(task.key.startsWith('slice:') ? `— ${task.slices[0].id}` : task.milestone);
export const sliceCountText = (n: number) => t(n === 1 ? '{n} slice' : '{n} slices', { n });
const taskCountText = (n: number) => t(n === 1 ? '{n} task' : '{n} tasks', { n });
const featureCountText = (n: number) => t(n === 1 ? '{n} feature' : '{n} features', { n });
function withTaskSentence(row: MonitorRow, slices: LedgerSlice[], width: number): MonitorRow[] {
  const newest = slices.filter(r => r.state === 'try').sort((a, b) => (b.at ?? -1) - (a.at ?? -1))[0];
  const text = newest && trySentence(newest);
  return text ? [row, { item: row.item, text: fit('    ' + theme.board.muted(truncateAnsi(monitorText(text), width - 4)), width) }] : [row];
}
export function taskHeaderRows(task: AcceptanceTask, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  marks?: ReadonlyMap<string, TryAction>, options: { status?: boolean; indent?: number } = {}): MonitorRow[] {
  const item = taskItem(task), first = task.slices[0];
  const firstMark = marks?.get(first.id), action = task.slices.every((r) => marks?.get(r.id) === firstMark) ? firstMark : undefined;
  const head = `${' '.repeat(options.indent ?? 2)}${trySelectionMark(state, item)}${landedMark(first, action)} ${taskLabel(task)}`;
  const right = [sliceCountText(task.slices.length), options.status && t('to try'), sinceText(task.oldest, now)].filter(Boolean).join(' · ');
  const file = first.path ?? data.statePath;
  return withTaskSentence({ item, text: pair(head, theme.board.muted(right), width), tryTarget: { milestone: task.milestone, slices: task.slices },
    ...(file ? { files: [file] } : {}) }, task.slices, width);
}
export function taskDetailRows(task: AcceptanceTask, state: MonitorState, width: number, now: number, marks?: ReadonlyMap<string, TryAction>, folded = state.project.folded): MonitorRow[] {
  return task.slices.flatMap((r) => [
    boardRow(pair(`  ${landedMark(r, marks?.get(r.id))} ${monitorText(r.id)}`, theme.board.muted(sinceText(r.at, now)), width)),
    ...tryDetailRows(r, width, 4, folded.has(`ledger:${r.id}`)), ...diffStatRows(r.diff, width),
  ]);
}
export function taskRows(task: AcceptanceTask, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  marks?: ReadonlyMap<string, TryAction>, status = false, folded = state.project.folded): MonitorRow[] {
  const header = taskHeaderRows(task, data, state, width, now, marks, { status }), row = header[0];
  return folded.has(row.item!.slice('project:fold:'.length))
    ? [row, ...taskDetailRows(task, state, width, now, marks, folded).map((detail) => ({ ...row, ...detail, item: detail.item ?? row.item }))] : header;
}
const PROGRESS_ORDER = ['blocked', 'working', 'try', 'todo', 'accepted', 'dropped'] as const;
const PROGRESS_MARK: Record<SliceState, [string, string]> = { blocked: ['◆', '!'], working: ['◐', '@'],
  try: ['◇', 'o'], todo: ['○', '-'], accepted: ['✓', '+'], dropped: ['–', '-'] };
const progressMark = (state: SliceState) => sliceInk(state)(mark(...PROGRESS_MARK[state]));
const worstState = (task: AcceptanceTask) => PROGRESS_ORDER.findIndex((s) => task.slices.some((r) => r.state === s));
export function progressTasks(data: ProjectSnapshot, layout: MonitorState['prefs']['projectLayout']): AcceptanceTask[] {
  const tasks = ledgerTasks([...data.ledger].reverse().sort((a, b) => (b.at ?? -1) - (a.at ?? -1)));
  const priority = (task: AcceptanceTask) => layout === 'board' && task.milestone && task.milestone === data.ladder.current
    || layout === 'inbox' && task.slices.some((r) => r.state === 'try') ? -1 : worstState(task);
  return tasks.sort((a, b) => priority(a) - priority(b));
}
export const progressTasksHeading = (tasks: number, width: number, right = '') => section(t('Tasks'), width,
  parts(String(tasks), right).join(' · '));
export function progressTaskHeader(task: AcceptanceTask, data: ProjectSnapshot, state: MonitorState, width: number, now: number, marks?: ReadonlyMap<string, TryAction>): MonitorRow[] {
  const item = taskItem(task), tries = task.slices.filter((r) => r.state === 'try'), worst = PROGRESS_ORDER[worstState(task)];
  const flagged = tries.filter((r) => marks?.get(r.id) === 'flag').length;
  const accepted = tries.filter((r) => marks?.get(r.id) === 'accept').length;
  const counts = PROGRESS_ORDER.flatMap((s) => {
    const n = task.slices.filter((r) => r.state === s).length;
    return n ? [`${progressMark(s)} ${n}`] : [];
  }).join('  ');
  const label = `  ${trySelectionMark(state, item)}${progressMark(worst)} ${taskLabel(task)}`;
  const receipt = [flagged ? `${theme.board.attention(mark('⚑', '!'))} ${flagged}` : '', accepted ? `${theme.board.success(mark('✓', '+'))} ${accepted}` : ''].filter(Boolean).join('  ');
  const oldest = tries.reduce<number | undefined>((n, r) => r.at === undefined ? n : Math.min(n ?? r.at, r.at), undefined);
  const age = sinceText(oldest, now), right = [counts, receipt && `· ${receipt}`, age].filter(Boolean).join('  ');
  const file = task.slices[0]?.path ?? data.statePath;
  return withTaskSentence({ item, text: pair(label, visualLength(label + right) + 1 <= width ? right : [counts, receipt && `· ${receipt}`].filter(Boolean).join('  '), width),
    ...(tries.length ? { tryTarget: { milestone: task.milestone, slices: tries } } : {}), ...(file ? { files: [file] } : {}) }, tries, width);
}

/** Slice details shared by the existing Split slice preview and task drill-down in either panel layout. */
export function sliceDetailRows(r: LedgerSlice, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false): MonitorRow[] {
  const plain = (text: string) => boardRow(fit(text, width)), muted = theme.board.muted;
  const s = data.slices.find((x) => x.label === r.id), worker = s?.jobId ? board?.workers.find((w) => w.evidence[0]?.sourceId === s.jobId) : undefined;
  const rows = [...(r.brief && r.state === 'try' ? tryDetailRows(r, width, 2, state.project.folded.has(`ledger:${r.id}`))
    : clampLines(ledgerText(r) || r.text, width - 2, Infinity).lines.map((l) => plain('  ' + l))),
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
export function progressTaskDetails(task: AcceptanceTask, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false, marks?: ReadonlyMap<string, TryAction>): MonitorRow[] {
  return [...task.slices].sort((a, b) => PROGRESS_ORDER.indexOf(a.state) - PROGRESS_ORDER.indexOf(b.state)).flatMap((r) => {
    const drift = data.slices.find((s) => s.label === r.id)?.drift;
    const glyph = r.state === 'try' ? landedMark(r, marks?.get(r.id)) : progressMark(r.state);
    const right = drift ? theme.board.attention(t(drift)) : theme.board.muted(t(r.state === 'try' ? 'to try' : r.state));
    return [boardRow(pair(`  ${glyph} ${monitorText(r.id)}`, right, width)), ...sliceDetailRows(r, data, state, width, now, board, modelEnabled)];
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
    rows.push(boardRow(fit(`  ${meter(done, total, 16)} ${theme.board.muted(t('{done}/{total} done', { done, total }))}`, width)));
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
  board?: WorkboardSnapshot, modelEnabled = false, tryMarks?: ReadonlyMap<string, TryAction>, room?: number
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = state.project.folded;
  const item = (r: ProjectItem, i: number, glyph = '') => rows.push(projectItem(r, i, glyph, width, now));
  if (page === 'progress') {
    const fileRow = (text: string, key: string, path = data.statePath) => rows.push({
      text: fit(text, width), ...(path ? { item: `project:file:${path}:${key}`, files: [path] } : {}),
    });
    const head = (label: string, right: string | number = '') => rows.push(boardRow(''), section(t(label), width, String(right)));
    const taskMode = state.prefs.acceptance !== 'slice' && !onlyTry(state.project.view);
    // Landed slices as rows: each a row Enter opens (its milestone, commit and day), the milestones one row each that Enter opens into its slices.
    const landed = taskMode ? [] : landedNewest(data), recent = landed.filter(({ r }) => r.at !== undefined && now - r.at <= 7 * DAY), older = landed.filter((x) => !recent.includes(x));
    // A to-try slice with a brief is one row, its first sentence beside its id; without one it shows its whole text, and short of room
    // (`short`) the rows the cursor is not on keep two rows of it. Expanded (Enter), the brief and steps come first and the original text
    // folds under them (Enter on that row unfolds it).
    const entry = ({ r }: { r: LedgerSlice }, indent: number, right = landedAge(r, now, false), tried = false, short = false) => {
      const action = tried ? tryMarks?.get(r.id) : undefined;
      const tryTarget = tried ? { milestone: r.milestone, slices: [r] } : undefined;
      const id = `hist:${r.id}`, item = `project:fold:${id}`, selected = tried ? trySelectionMark(state, item) : '';
      const open = folded.has(id), head = `${' '.repeat(indent)}${selected}${landedMark(r, action)} ${monitorText(r.id)}`;
      const meta = ' '.repeat(indent + 4) + theme.board.muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? dateText(r.at, now) : ''].filter(Boolean).join(' · '));
      const file = r.path ?? data.statePath;
      const row = (text: string, own?: string): MonitorRow => ({ text: fit(text, width), item: own ?? item, tryTarget, ...(file ? { files: [file] } : {}) });
      if (trySentence(r) && !open) rows.push(...briefStack(head, trySentence(r), right, width, indent + 2).map((line) => row(line)));
      else if (trySentence(r)) rows.push(row(pair(head, right, width)), row(meta),
        ...tryDetailRows(r, width, indent + 4, folded.has(`ledger:${r.id}`)).map((d) => row(d.text, d.item)));
      else {
        const lines = stacked(head, ledgerText(r), right, width, indent + 4, tried && !(short && state.project.nav.cursor !== item) ? Infinity : 2);
        if (open) lines.splice(1, 0, meta);
        rows.push(...lines.map((line) => row(line)));
      }
      if (r.state === 'try' && open) rows.push(...diffStatRows(r.diff, width));
    };
    // Newest milestone first; the newest to-try milestone is selectable but stays open.
    const byMilestone = (list: typeof landed, prefix: string, tried = false, short = false) => {
      const order = milestoneOrder(data), buckets = new Map<string, typeof landed>();
      const name = (m: string) => NO_MILESTONE.test(m) ? t('other') : monitorText(m);
      for (const x of list) { const m = !tried && NO_MILESTONE.test(x.r.milestone) ? '' : x.r.milestone; buckets.set(m, [...(buckets.get(m) ?? []), x]); }
      const names = [...buckets.keys()].map(name), column = Math.min(10, Math.max(...names.map(visualLength), 0));
      for (const [at, [milestone, items]] of [...buckets].sort((a, b) => order.indexOf(b[0]) - order.indexOf(a[0])).entries()) {
        const id = `${prefix}${milestone}`, newest = tried && !at, open = newest || folded.has(id);
        const action = (r: LedgerSlice) => tried ? tryMarks?.get(r.id) : undefined;
        const accepted = items.filter(({ r }) => r.state === 'accepted' || action(r) === 'accept').length;
        const flagged = items.filter(({ r }) => action(r) === 'flag').length, tries = items.length - accepted - flagged;
        const days = items.flatMap(({ r }) => r.at === undefined ? [] : [Math.floor((now - r.at) / DAY)]), lo = Math.min(...days), hi = Math.max(...days);
        const span = !days.length ? '' : lo === hi ? t('{n}d', { n: lo }) : `${lo}–${t('{n}d', { n: hi })}`;
        // The filter heading names the to-try state; keep words for exceptions and in mixed History.
        const counts = (words: boolean) => [accepted && sliceInk('accepted')(`${mark('✓', '+')} ${accepted}${words ? ' ' + t('accepted') : ''}`),
          flagged && theme.board.attention(`${mark('⚑', '!')} ${flagged}${words ? ' ' + t('flagged') : ''}`),
          tries && sliceInk('try')(`${mark('◇', 'o')} ${tries}${words && !tried ? ' ' + t('to try') : ''}`)].filter(Boolean).join('  ');
        const item = newest ? `project:${id}` : `project:fold:${id}`, selected = tried ? trySelectionMark(state, item) : '';
        const lead = `  ${selected}${open ? mark('▾', 'v') : mark('▸', '>')} ${fit(name(milestone), column)} `, words = visualLength(lead + counts(true)) + visualLength(span) + 1 <= width;
        const tryTarget = tried ? { milestone, slices: items.map(({ r }) => r) } : undefined;
        rows.push({ text: pair(lead + counts(words), theme.board.muted(span), width), item, tryTarget });
        if (open) items.forEach((x) => entry(x, 4, tried ? theme.board.muted(sinceText(x.r.at, now)) : undefined, tried, short));
      }
    };
    if (!data.statePath && !data.ledger.length) rows.push(boardRow('  ' + theme.board.muted(t('no STATE.md'))));
    else if (onlyTry(state.project.view)) {
      const tasks = state.prefs.acceptance === 'slice' ? undefined : newestTasks(data);
      // Only what the ledger says is `try`, whatever the milestone: the header is the way back (Enter, a click or `t`).
      const tries = landed.filter(({ r }) => r.state === 'try');
      rows.push({ ...section(t('Only to try'), width, String(tasks?.length ?? tries.length)), item: 'project:try', ...(data.statePath ? { files: [data.statePath] } : {}) });
      if (tasks?.length) return [...rows, ...tasks.flatMap((task) => taskRows(task, data, state, width, now, tryMarks))];
      if (!tries.length) rows.push(boardRow('  ' + theme.board.muted(t('Nothing to try'))));
      const from = rows.length;
      byMilestone(tries, 'try:m:', true);
      if (room !== undefined && rows.length > room) { rows.length = from; byMilestone(tries, 'try:m:', true, true); }
      return rows;
    } else if (taskMode) {
      if (data.summary) for (const line of clampLines(data.summary, width - 2, 2).lines) fileRow('  ' + line, 'summary');
      const tries = tryCount(data, state.prefs.acceptance);
      const tasks = progressTasks(data, state.prefs.projectLayout);
      if (tasks.length) rows.push({ ...progressTasksHeading(tasks.length, width, tries ? t('{n} to try', { n: tries }) : ''),
        ...(tries ? { item: 'project:try', ...(data.statePath ? { files: [data.statePath] } : {}) } : {}) });
      for (const task of tasks) {
        const header = progressTaskHeader(task, data, state, width, now, tryMarks), row = header[0];
        rows.push(...header);
        if (folded.has(row.item!.slice('project:fold:'.length))) rows.push(...progressTaskDetails(task, data, state, width, now, board, modelEnabled, tryMarks)
          .map((detail) => ({ ...row, ...detail, item: detail.item ?? row.item })));
      }
    } else if (state.prefs.projectLayout === 'board') {
      return boardProgressRows(data, state, width, now, board, modelEnabled, tryMarks);
    } else if (state.prefs.projectLayout === 'inbox') {
      return inboxProgressRows(data, state, width, now, board, modelEnabled, tryMarks);
    } else {
      if (data.summary) for (const line of clampLines(data.summary, width - 2, 2).lines) fileRow('  ' + line, 'summary');
      // The current milestone: its bar with accepted/total, its counts, and what the earlier ones accepted in all.
      const cur = currentRows(data), total = cur.rows.length - cur.counts.dropped;
      if (cur.rows.length) {
        const label = cur.whole || !data.ladder.current ? '' : ` ${monitorText(data.ladder.current)} `, frac = acceptedText(cur.counts, cur.rows.length);
        const cells = Math.max(6, Math.min(24, width - 3 - visualLength(label) - visualLength(frac) - 2));
        fileRow(`  ${label ? theme.board.title(label) + ' ' : ''}${barText({ counts: cur.counts }, cells)} ${theme.board.muted(frac)}`, 'bar');
        const counts = cur.counts;
        const words = SLICE_STATES.filter((s) => s !== 'accepted' && counts[s]).map((s) => sliceInk(s)(`${counts[s]} ${t(s === 'try' ? 'to try' : s)}`));
        // The to-try count is the way into the to-try filter; `o` still opens STATE.md from it.
        for (const line of pack(words, width)) counts.try ? rows.push({ text: fit(line, width), item: 'project:try', ...(data.statePath ? { files: [data.statePath] } : {}) }) : fileRow(line, 'counts');
        const order = milestoneOrder(data), before = order.slice(0, Math.max(0, order.indexOf(data.ladder.current ?? ''))), earlier = data.ledger.filter((r) => r.state === 'accepted' && before.includes(r.milestone));
        const places = new Set(earlier.map((r) => r.milestone)).size;
        if (!cur.whole && earlier.length) fileRow(`  ${sliceInk('accepted')(mark('✓', '+'))} ${theme.board.muted(t(places === 1 ? '{n} accepted in {m} earlier milestone' : '{n} accepted in {m} earlier milestones', { n: earlier.length, m: places }))}`, 'earlier');
      }
    }
    const ledgerIds = taskMode ? new Set(data.ledger.map((r) => r.id)) : undefined;
    const jobs = unsliced(data), slices = inFlight(data).filter((r) => !ledgerIds?.has(r.label));
    if (slices.length + jobs.length) head('Now', slices.length + jobs.length);
    for (const [i, r] of slices.entries()) {
      const path = r.path ?? data.statePath;
      const reason = r.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(r.ledgerState ?? '')) })
        : r.drift ? t(r.drift) : '';
      const glyph = r.drift ? theme.board.attention('!') : r.ledgerState === 'blocked'
        ? sliceInk('blocked')(mark('◆', '!')) : sliceInk('working')(mark('◐', '@'));
      for (const line of stacked(`  ${glyph} ${monitorText(r.label)}`, r.value, reason ? theme.board.attention(reason) : '', width, 4))
        fileRow(line, `slice:${i}`, path);
      if (!r.jobId) continue;
      const worker = board?.workers.find((w) => w.evidence[0]?.sourceId === r.jobId);
      const asking = worker?.homeNeedsHuman ?? r.asking;
      const right = [monitorText(worker?.role ?? r.role ?? ''), asking ? `${t('asking')} ?`
        : minuteAge(r.at ?? null, now)].filter(Boolean).join(' ');
      const prefix = `    ${t('now:')} `, room = Math.max(1, width - visualLength(prefix) - visualLength(right) - 1);
      const sentence = worker ? modelEnabled && worker.modelSentence
        // Reuse Home's keyword painting and word cut, without its two-cell stem.
        ? jobSentenceLine(worker.modelSentence, room + 3, (s) => s).slice(2).trimEnd()
        : monitorText(workCardDetail(projectWorkCard(worker, now))) : '';
      fileRow(pair(prefix + sentence, right, width), `slice:${i}:now`, path);
      const labels = labelSummary(worker?.labels);
      if (labels) fileRow('    ' + labels, `slice:${i}:labels`, path);
    }
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
    // History: the last seven days in full, newest first (`recent`); everything older, and whatever has no commit date, one row a milestone.
    if (landed.length) head('History');
    recent.forEach((x) => entry(x, 2));
    byMilestone(older, 'hist:m:');
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
    if (state.prefs.acceptance === 'slice') rows.push(...ticketRows(data, folded, width, now, undefined, !!state.project.filter?.query));
    else for (const feature of data.tickets) {
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
    // Worktrees with no ledger row: the ones that left the hub's Now, counted on its Working tree row.
    if (unlisted(data).length) rows.push(boardRow(''), section(t('Unlisted worktrees'), width, String(unlisted(data).length)),
      ...unlisted(data).map((r) => boardRow(pair(`  ${theme.board.attention('!')} ${monitorText(r.label)}`, theme.board.muted(t('not in ledger')), width))));
  } else if (page === 'docs') data.docs.forEach((r, i) => item(r, i));
  if (rows.length === 1) rows.push(boardRow('  ' + theme.board.muted(t('none'))));
  return rows;
}
/** The Project tab: a hub of one summary row per page, or the page the panel has open. */
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false, name = '', projects: ProjectChoice[] = [], room?: number,
  tryMarks?: ReadonlyMap<string, TryAction>
): MonitorRow[] {
  const page = projectPageOf(state);
  // The list reads each project's own overview; the shown project's full snapshot is not needed for it.
  if (projectListOpen(state, projects)) return state.prefs.projectLayout === 'board' ? boardListRows(projects, width, now) : state.prefs.projectLayout === 'inbox' ? inboxListRows(projects, width, now, state.prefs.acceptance) : listRows(projects, width, now, state.prefs.acceptance);
  if (!data) return [];
  if (!page && state.prefs.projectLayout === 'board') return boardHubRows(data, state, width, now, name, projects, board, room, tryMarks);
  if (!page && state.prefs.projectLayout === 'inbox') return inboxHubRows(data, state, width, now, name, projects, board, room, tryMarks);
  return page ? pageRows(page, data, state, width, now, board, modelEnabled, tryMarks, room) : hubRows(data, state, width, now, name, projects, board, room, tryMarks);
}

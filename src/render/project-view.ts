/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, SETTLED_JOB_STATES, type SliceState, type ProjectSnapshot, type ProjectItem, type ProjectTicket, type TicketFeature, type LedgerSlice, type TryBrief } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { TryAction } from '../collectors/try-records.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { jobSentenceLine, workCardDetail, labelSummary } from './work-card.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { basename } from 'node:path';
import { boardRow, itemRow, section, mark, minuteAge, pack } from './workboard-rows.js';
import { boardHubRows, boardListRows, boardProgressRows } from './board-project.js';
import { inboxHubRows, inboxListRows, inboxProgressRows } from './inbox-project.js';
import { diffStatRows } from './diff-stat-rows.js';
import { monitorText, fit, pair, flowLines, cutWords } from './monitor-text.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { t } from './i18n.js';
export const sliceInk = (state: SliceState) => ({ working: theme.board.active, blocked: theme.board.attention,
  try: theme.board.identifier, accepted: theme.board.success, todo: theme.board.muted, dropped: theme.board.frame })[state];
/** Cumulative rounding keeps the stacked bar cell-exact, including small nonzero segments. */
export function progressSegments(counts: ProjectSnapshot['counts'], width: number) {
  const total = SLICE_STATES.reduce((n, state) => n + counts[state], 0);
  let count = 0, edge = 0;
  return SLICE_STATES.map((state) => {
    count += counts[state];
    const end = total ? Math.round(count / total * width) : 0;
    const segment = { state, width: end - edge };
    edge = end;
    return segment;
  });
}
const legendItem = (counts: ProjectSnapshot['counts'], s: SliceState) =>
  sliceInk(s)(`${mark('●', '*')} ${t(s === 'try' ? 'landed, to try' : s)} ${counts[s]}`);
// To try is a medium shade (▒), a step from both the full block of what is accepted and the light one of what is still to do; the
// ascii glyphs differ too, so a bar with no colour (the `none` theme) still reads.
const BAR_GLYPH: Record<SliceState, [string, string]> = { working: ['█', '#'], blocked: ['█', '#'], try: ['▒', '='], accepted: ['█', '#'], todo: ['░', '.'], dropped: ['░', '.'] };
export const barText = (data: Pick<ProjectSnapshot, 'counts'>, width: number) => progressSegments(data.counts, width).map(({ state, width: cells }) =>
  sliceInk(state)(mark(...BAR_GLYPH[state]).repeat(cells))).join('');
export const HOME_BLOCK = 60;
const HOME_TICKETS = 6, HOME_WAITING = 5;
/** Legend entries as a grid of aligned columns, in the fewest rows that fit `room`: a split never leaves one entry alone. */
function legendGrid(entries: string[], room: number): { lines: string[]; width: number } {
  const widths = entries.map(visualLength);
  for (let rows = 1; entries.length; rows++) {
    const cols = Math.ceil(entries.length / rows);
    const wide = Array.from({ length: cols }, (_, c) => Math.max(...widths.filter((_, i) => i % cols === c)));
    const total = wide.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
    if (total <= room || cols === 1) return { width: total, lines: Array.from({ length: Math.ceil(entries.length / cols) }, (_, r) =>
      entries.slice(r * cols, (r + 1) * cols).map((e, c) => e + ' '.repeat(wide[c] - widths[r * cols + c])).join('   ')) };
  }
  return { lines: [], width: 0 };
}
/**
 * Only whole spare rows; cards and decisions have already claimed their space. The counts are the current milestone's, as on the hub
 * (the whole ledger when there is none, and the title says so). Shrinks from the bottom up: tickets, the summary's wrapped rows,
 * legend, summary, then the bar, then the block.
 */
export function homeProgressRows(data: ProjectSnapshot | undefined, width: number, spare: number, gap = true): MonitorRow[] {
  if (!data || spare < 3 || (!data.summary && !data.ladder.current && !data.tickets.length)) return [];
  const row = (text: string, id = 'progress'): MonitorRow => ({ text: fit(text, width), item: `home-progress:${id}` });
  const cur = currentRows(data), counts = cur.counts, states = SLICE_STATES.filter((s) => counts[s]);
  const legend = legendGrid(states.map((s) => legendItem(counts, s)), Math.min(width - 2, HOME_BLOCK));
  const summary = data.summary ? clampLines(data.summary, width - 2, 3).lines : [];
  const milestone = data.ladder.current && (cur.whole && cur.rows.length ? '' : data.ladder.current);
  const head = section(t('Progress'), width, milestone ? `${t('Milestone')} ${monitorText(milestone)}` : cur.rows.length ? t('All slices') : '');
  // What the block keeps as it shrinks: the bar and the first summary row, then the legend, then the summary's other rows.
  let room = spare - (gap ? 1 : 0) - 1;
  const bar = states.length && room > 0 ? (room--, 1) : 0, first = summary.length && room > 0 ? (room--, 1) : 0;
  const legendRows = bar && legend.lines.length <= room ? legend.lines : [];
  room -= legendRows.length;
  const more = first ? Math.min(summary.length - 1, room) : 0;
  room -= more;
  const rows = [...(gap ? [boardRow('')] : []), { ...head, item: 'home-progress:progress' },
    ...summary.slice(0, first + more).map((line) => row('  ' + line)),
    ...(bar ? [row('  ' + barText({ counts }, Math.max(0, Math.min(width - 2, Math.max(24, legend.width)))))] : []),
    ...legendRows.map((line) => row('  ' + line))];
  if (bar && !legendRows.length) return rows;
  const rank = { working: 0, ready: 1, blocked: 2 } as Record<string, number>;
  for (const feature of data.tickets) {
    const open = feature.tickets.filter((r) => r.state in rank).sort((a, b) => rank[a.state] - rank[b.state]);
    const slots = Math.min(HOME_TICKETS, spare - rows.length - 1);
    if (!open.length || slots < 1) continue;
    const id = `tickets:${feature.slug}`, done = feature.tickets.filter((r) => r.state === 'done').length;
    rows.push({ ...section(`${t('Tickets')} · ${monitorText(feature.slug)}`, width,
      t('{done}/{total} done', { done, total: feature.tickets.length })), item: `home-progress:${id}` });
    const cut = open.length > slots && slots > 2, shown = open.slice(0, cut ? slots - 1 : slots);
    for (const ticket of shown) {
      const right = theme.board.muted(t(ticket.state)), lead = `  ${monitorText(ticket.number)} `;
      const room = width - visualLength(lead) - visualLength(right) - 1;
      rows.push(row(pair(`${lead}${cutTicketTitle(ticket.title, room)}`, right, width), id));
    }
    if (cut) rows.push(row('  ' + theme.board.muted(t('+{n} more', { n: open.length - shown.length })), id));
  }
  return rows;
}
/**
 * Home's spare rows, top to bottom: STATE's waiting items (a row each) and the newest landed slices under the cards, the progress block
 * at the bottom. The block takes its rows first (its own order of shrinking is above); the two lists, waiting first, take what is left.
 */
export function homeSpareRows(data: ProjectSnapshot | undefined, width: number, spare: number, now: number, gap = true): MonitorRow[] {
  if (!data || spare < 1) return [];
  const progress = homeProgressRows(data, width, spare, gap), out: MonitorRow[] = [], keep = progress.length + (progress.length && !gap ? 1 : 0);
  // A list of at most `all.length` rows out of `total`; short of room it ends with `+N more` for those it does not show.
  const list = (head: MonitorRow, id: string, all: MonitorRow[], total: number, room: number): MonitorRow[] => {
    const slots = room - 1, item = `home-progress:${id}`;
    if (slots < 1 || !all.length) return [];
    const shown = all.slice(0, total > Math.min(slots, all.length) && slots > 2 ? slots - 1 : slots), hidden = total - shown.length;
    return [{ ...head, item }, ...shown, ...(hidden > 0 && slots > 2 ? [{ text: fit('  ' + theme.board.muted(t('+{n} more', { n: hidden })), width), item }] : [])];
  };
  const lists = [
    (room: number) => list(section(t('Waiting for you'), width, String(data.waiting.length)), 'waiting', data.waiting.slice(0, HOME_WAITING).map((r, i): MonitorRow => ({
      ...itemRow(theme.board.attention('?'), monitorText(r.value), '', width), item: `home-progress:wait:${i}` })), data.waiting.length, room),
    (room: number) => {
      const landed = landedNewest(data).slice(0, width < 56 ? 3 : 5).map(({ r }): MonitorRow => ({
        text: landedInline(r, `  ${landedMark(r)} ${monitorText(r.id)}`, landedAge(r, now), width), item: 'home-progress:latest' }));
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
/** The hub's pages, and the page of one waiting item (`MonitorState.projectWait`), which a row opens and the hub does not list. */
export type ProjectPage = (typeof PROJECT_PAGES)[number] | 'waiting';
export const PAGE_WORD: Record<ProjectPage, string> = {
  progress: 'Progress', tickets: 'Tickets', tree: 'Working tree', docs: 'Docs', waiting: 'Waiting',
};
/** The open page; none, or a name this build does not know, is the hub. */
export const projectPageOf = (state: MonitorState) => [...PROJECT_PAGES, 'waiting' as const].find((p) => p === state.projectPage);
export const projectFoldedSet = (state: MonitorState): ReadonlySet<string> => state.projectFolded ?? new Set();
export const ticketWorking = (r: ProjectTicket) => !['done', 'dropped', 'blocked'].includes(r.state)
  && (r.state === 'working' || (!!r.job && !SETTLED_JOB_STATES.has(r.job.state)));
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
  if (page === 'progress') {
    const drift = inFlight(data).filter((r) => r.drift).length, bang = drift ? theme.board.attention(`! ${drift}`) : '';
    return [parts(updatedText(data, now), bang).join(' · '), bang];
  }
  if (page === 'tickets') return data.tickets?.length ? [t('{features} features · {tickets} tickets', {
    features: data.tickets.length, tickets: data.tickets.reduce((n, f) => n + f.tickets.length, 0) })] : [];
  return [];
}
/** `Project › Page` for the sub-page title row (the project's name instead of `Project` when there is a switch), with the page's own facts on the right when there is room. */
export function projectCrumb(page: ProjectPage, data: ProjectSnapshot | undefined, width: number, now: number, name = '') {
  const crumb = `${name ? truncateAnsi(monitorText(name), 16) : t('Project')} ${mark('›', '>')} ${t(PAGE_WORD[page])}`;
  return { crumb, right: (data && pageMeta(page, data, now).find((r) => r && visualLength(crumb) + 4 + visualLength(r) <= width)) || '' };
}
/** One line per page, most important fact first: a row too short for all of them drops the last, not part of one. */
export function pageSummary(page: ProjectPage, data: ProjectSnapshot, now: number): string[] {
  const c = currentRows(data).counts, tickets = data.tickets.flatMap((f) => f.tickets), g = data.git;
  // What the owner acts on first: the slices to try (the ledger's whole count, as Waiting says it), then what is blocked, then what works.
  if (page === 'progress') return parts(data.ladder.current && monitorText(data.ladder.current),
    tryCount(data) && t('{n} to try', { n: tryCount(data) }), c.blocked && `${c.blocked} ${t('blocked')}`,
    c.working && `${c.working} ${t('working')}`, !data.statePath && t('no STATE.md'));
  if (page === 'tickets') {
    const working = tickets.filter(ticketWorking).length, blocked = tickets.filter((r) => r.state === 'blocked').length;
    return tickets.length ? parts(t('{done}/{total} done', { done: tickets.filter((r) => r.state === 'done').length, total: tickets.length }),
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
export const roleInk = (role: string) => (theme.board.roleInk as Record<string, (s: string) => string>)[role] ?? ((s: string) => s);
const DAY = 864e5;
/** STATE's current milestone's ledger rows with their counts; a ledger that has none of them (or no current milestone) is counted whole. */
export function currentRows(data: ProjectSnapshot) {
  const mine = data.ledger.filter((r) => r.milestone === data.ladder.current), rows = mine.length ? mine : data.ledger;
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
/** What the owner still tries: every slice the ledger says is `try`, whatever its milestone. The Waiting and Progress rows and the Projects list all say this number. */
export const tryCount = (data: Pick<ProjectSnapshot, 'ledger'>) => data.ledger.filter((r) => r.state === 'try').length;
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
export const trySelectionMark = (state: MonitorState, item: string) => state.trySelection?.has(item) ? `${theme.board.active(mark('▣', '*'))} ` : '';
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
  board?: WorkboardSnapshot, room?: number
): MonitorRow[] {
  const folded = projectFoldedSet(state);
  // With more than one project the name row opens the Projects list (Enter or a click); `[` and `]` still step through them.
  const many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.projectRoot));
  const top: MonitorRow[] = [boardRow(''), {
    ...section(theme.board.title(monitorText(name) || t('Project')), width,
      [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
    ...(many ? { item: 'project:switch' } : {}),
  }];
  // The header counts the items and how many of them are tries; the items flow into `wrap` spare rows, top down, and the one the cursor is on keeps its whole text.
  const tries = tryCount(data);
  const waitingBlock = (wrap: number, keep = false): MonitorRow[] => {
    if (!data.waiting.length) return [];
    const rows = [foldRow(folded, 'waiting', 'Waiting for you', width, [data.waiting.length, tries && t('{n} to try', { n: tries })].filter(Boolean).join(' · '))];
    if (!folded.has('waiting')) for (const [i, r] of data.waiting.entries()) {
      const item = waitingRows(r, i, width, now, keep && state.projectCursor === `project:wait:${i}` ? Infinity : 1 + Math.max(0, wrap));
      wrap -= item.length - 1;
      rows.push(...item);
    }
    return [...rows, boardRow('')];
  };
  const nowRows = hubNowRows(data, width, now, board);
  // Nothing in flight is said, not left blank.
  const nowBlock: MonitorRow[] = [section(t('Now'), width, nowRows.length ? String(nowRows.length) : ''),
    ...(nowRows.length ? nowRows : [boardRow('  ' + theme.board.muted(t('Nothing in progress')))]), boardRow('')];
  const landed = landedNewest(data).slice(0, width < 56 ? 3 : 5).map(({ r }): MonitorRow => ({
    text: landedInline(r, `  ${landedMark(r)} ${monitorText(r.id)}`, landedAge(r, now), width),
  }));
  const latest = (n: number): MonitorRow[] => n ? [section(t('Latest'), width, t('newest first')), ...landed.slice(0, n), boardRow('')] : [];
  const column = Math.max(...PROJECT_PAGES.map((p) => visualLength(t(PAGE_WORD[p])))) + 1, space = Math.max(1, width - column);
  const pages = (bar: boolean): MonitorRow[] => PROJECT_PAGES.flatMap((page) => {
    // A project with no tickets has no Tickets entry, as it had no empty section before.
    if (page === 'tickets' && !data.tickets?.length) return [];
    const facts = pageSummary(page, data, now);
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
    if (room === undefined || rows.length <= room) return build(n, bar, gaps, k ? 0 : room === undefined ? Infinity : room - rows.length, true);
  }
  return build(0, false, false, 0, true);
}
/** The Projects list is what the tab shows: asked for, with several projects to list, and no page open. */
export const projectListOpen = (state: MonitorState, projects?: unknown[]) =>
  state.projectList === true && !projectPageOf(state) && (projects?.length ?? 0) > 1;
/** The panel's own project first, then those with something waiting, then those with a job running, then the most recently touched. */
export function projectOrder(projects: ProjectChoice[]): ProjectChoice[] {
  const rank = (p: ProjectChoice) => p.overview?.waiting ? 0 : p.overview?.running ? 1 : 2;
  return [projects[0], ...projects.slice(1).sort((a, b) => rank(a) - rank(b) || (b.overview?.at ?? 0) - (a.overview?.at ?? 0))];
}
/** `12m`, `3h`, `4d` (`12分钟`, `3小时`, `4天`): how long since a project was touched. */
export function sinceText(at: number | undefined, now: number): string {
  const minutes = at === undefined ? -1 : Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 0 ? '' : minutes < 60 ? t('{n}m', { n: minutes }) : minutes < 1440 ? t('{n}h', { n: Math.floor(minutes / 60) }) : t('{n}d', { n: Math.floor(minutes / 1440) });
}
/** Two rows a project: its name, milestone and what needs you (`?`) or runs (`◉`); then what it is doing (`◐ A-ONE working`, `◇ B-TWO to try`) and how long since it was touched; a wide row keeps its bar. */
function listRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
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
    const key = !o ? '' : o.counts.try ? sliceInk('try')(t('{n} to try', { n: o.counts.try })) : o.open ? theme.board.muted(t('{n} open', { n: o.open })) : '';
    const body = !o ? theme.board.muted(mark('…', '~'))
      : !o.hasState ? theme.board.muted([t('no STATE.md'), o.open ? t('{n} open', { n: o.open }) : ''].filter(Boolean).join(' · '))
      : last ? `${width >= 80 && bar ? bar + '  ' : ''}${glyph} ${monitorText(last.ids.join(', '))} ${sliceInk(last.state)(t(last.state === 'try' ? 'to try' : last.state))}`
      : `${bar}${' '.repeat(Math.max(0, cells - visualLength(bar)))}${key ? '  ' + key : ''}`;
    rows.push({ text: pair(`  ${body}`, theme.board.muted(sinceText(o?.at, now)), width), item });
  }
  return rows;
}
export const NO_MILESTONE = /^[—–-]*$/;
/** Milestones in ledger order, oldest first; STATE's current one is always among them. A ledger naming none falls back to spec §5. */
export function milestoneOrder(data: ProjectSnapshot): string[] {
  const seen = new Set(data.ledger.map((r) => r.milestone).filter((m) => !NO_MILESTONE.test(m)));
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
/** A done/total meter `cells` wide, as thin as the panel's other meters; a started one shows at least a cell, an unfinished one never looks full. */
export function meter(done: number, total: number, cells: number): string {
  const filled = !total ? 0 : Math.min(cells - (done < total ? 1 : 0), Math.max(done ? 1 : 0, Math.round(done / total * cells)));
  return theme.board.success(mark('━', '#').repeat(filled)) + theme.board.muted(mark('─', '-').repeat(cells - filled));
}
const ASKS = /^(needs-triage|needs-info|ready-for-human)$/i;
/** A ticket that asks for the owner: it waits on an answer or a human, whatever else holds it. */
export const asksYou = (r: ProjectTicket) => r.state !== 'done' && r.state !== 'dropped' && ASKS.test(r.status);
const ticketLane = (r: ProjectTicket) => r.state === 'done' || r.state === 'dropped' ? 'done' : asksYou(r) ? 'you' : ticketWorking(r) ? 'working'
  : r.state === 'blocked' ? 'blocked' : 'ready';
const ticketGlyph = (r: ProjectTicket) => r.state === 'done' ? theme.board.success(mark('✓', '+')) : r.state === 'dropped' ? theme.board.muted(mark('–', '-'))
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
 * The Tickets page: lanes by state across features (For you, Working, Ready, Blocked, Done folded), one row a ticket under the
 * code of its feature; the codes are listed once at the top. Enter on a ticket shows its checklist and latest comment here.
 */
export function ticketRows(data: ProjectSnapshot, folded: ReadonlySet<string>, width: number, now: number): MonitorRow[] {
  const rows: MonitorRow[] = [], features = data.tickets ?? [], codes = featureCodes(features);
  const all = features.flatMap((f) => f.tickets.map((ticket) => ({ ticket, feature: f })));
  if (!all.length) return rows;
  const column = Math.max(...[...codes.values()].map(visualLength)), done = all.filter(({ ticket }) => ticket.state === 'done').length;
  rows.push(boardRow(fit(`  ${meter(done, all.length, 16)} ${theme.board.muted(t('{done}/{total} done', { done, total: all.length }))}`, width)));
  for (const line of pack(features.map((f) => `${theme.board.muted(codes.get(f.slug)!)} ${monitorText(f.slug)} ${theme.board.muted(`${f.tickets.filter((r) => r.state === 'done').length}/${f.tickets.length}`)}`), width))
    rows.push(boardRow(fit(line, width)));
  const lane = (id: string, title: string, items: typeof all, right: string, open = true) => {
    if (!items.length) return;
    rows.push(boardRow(''), id === 'done' ? { ...section(`${open ? '' : mark('▸', '>') + ' '}${t(title)}`, width, right), item: 'project:fold:lane:done' } : section(t(title), width, right));
    if (open) items.forEach((x) => ticketRow(x));
  };
  const ticketRow = ({ ticket, feature }: (typeof all)[number]) => {
    const job = ticket.job, live = !!job && !SETTLED_JOB_STATES.has(job.state), dropped = ticket.state === 'dropped', lane = ticketLane(ticket);
    const known = /^(done|closed|complete|resolved|wontfix|claimed|needs-triage|needs-info|ready-for-human|ready-for-agent)$/i.test(ticket.status);
    const target = ticket.blockers.length === 1 ? feature.tickets.find((r) => /^\d+$/.test(ticket.blockers[0]) && Number(r.number) === Number(ticket.blockers[0])) : undefined;
    const right = [
      lane === 'you' ? theme.board.attention(monitorText(ticket.status)) : '',
      lane === 'blocked' ? theme.board.muted(`${mark('←', '<')} ${monitorText(ticket.blockers.join(', '))}`) + (target ? ' ' + ticketGlyph(target) : '') : '',
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
  lane('you', 'For you', by('you'), theme.board.attention(String(by('you').length)));
  lane('working', 'Working', by('working').sort((a, b) => Number(!!b.ticket.job) - Number(!!a.ticket.job)), String(by('working').length));
  lane('ready', 'Ready', by('ready'), String(by('ready').length));
  lane('blocked', 'Blocked', by('blocked'), String(by('blocked').length));
  // Membership opens it: Done starts folded.
  lane('done', 'Done', by('done'), String(by('done').length), folded.has('lane:done'));
  return rows;
}
/** One page: today's section content, without the section header (the crumb names the page). */
export function pageRows(
  page: ProjectPage, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false, tryMarks?: ReadonlyMap<string, TryAction>, room?: number
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = projectFoldedSet(state);
  const item = (r: ProjectItem, i: number, glyph = '') => rows.push(projectItem(r, i, glyph, width, now));
  if (page === 'progress') {
    const fileRow = (text: string, key: string, path = data.statePath) => rows.push({
      text: fit(text, width), ...(path ? { item: `project:file:${path}:${key}`, files: [path] } : {}),
    });
    const head = (label: string, right: string | number) => rows.push(boardRow(''), section(t(label), width, String(right)));
    // Landed slices as rows: each a row Enter opens (its milestone, commit and day), the milestones one row each that Enter opens into its slices.
    const landed = landedNewest(data), recent = landed.filter(({ r }) => r.at !== undefined && now - r.at <= 7 * DAY), older = landed.filter((x) => !recent.includes(x));
    // A to-try slice with a brief is one row, its first sentence beside its id; without one it shows its whole text, and short of room
    // (`short`) the rows the cursor is not on keep two rows of it. Expanded (Enter), the brief and steps come first and the original text
    // folds under them (Enter on that row unfolds it).
    const entry = ({ r }: { r: LedgerSlice }, indent: number, right = landedAge(r, now, false), tried = false, short = false) => {
      const action = tried ? tryMarks?.get(r.id) : undefined;
      const tryTarget = tried ? { milestone: r.milestone, slices: [r] } : undefined;
      const id = `hist:${r.id}`, item = `project:fold:${id}`, selected = tried ? trySelectionMark(state, item) : '';
      const open = folded.has(id), head = `${' '.repeat(indent)}${selected}${landedMark(r, action)} ${monitorText(r.id)}`;
      const meta = ' '.repeat(indent + 4) + theme.board.muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? dateText(r.at, now) : ''].filter(Boolean).join(' · '));
      const row = (text: string, own?: string): MonitorRow => ({ text: fit(text, width), item: own ?? item, tryTarget, ...(data.statePath ? { files: [data.statePath] } : {}) });
      if (trySentence(r) && !open) rows.push(...briefStack(head, trySentence(r), right, width, indent + 2).map((line) => row(line)));
      else if (trySentence(r)) rows.push(row(pair(head, right, width)), row(meta),
        ...tryDetailRows(r, width, indent + 4, folded.has(`ledger:${r.id}`)).map((d) => row(d.text, d.item)));
      else {
        const lines = stacked(head, ledgerText(r), right, width, indent + 4, tried && !(short && state.projectCursor !== item) ? Infinity : 2);
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
        // Counts with their words; a row too short for them keeps the marks and the numbers.
        const counts = (words: boolean) => [accepted && sliceInk('accepted')(`${mark('✓', '+')} ${accepted}${words ? ' ' + t('accepted') : ''}`),
          flagged && theme.board.attention(`${mark('⚑', '!')} ${flagged}${words ? ' ' + t('flagged') : ''}`),
          tries && sliceInk('try')(`${mark('◇', 'o')} ${tries}${words ? ' ' + t('to try') : ''}`)].filter(Boolean).join('  ');
        const item = newest ? `project:${id}` : `project:fold:${id}`, selected = tried ? trySelectionMark(state, item) : '';
        const lead = `  ${selected}${open ? mark('▾', 'v') : mark('▸', '>')} ${fit(name(milestone), column)} `, words = visualLength(lead + counts(true)) + visualLength(span) + 1 <= width;
        const tryTarget = tried ? { milestone, slices: items.map(({ r }) => r) } : undefined;
        rows.push({ text: pair(lead + counts(words), theme.board.muted(span), width), item, tryTarget });
        if (open) items.forEach((x) => entry(x, 4, tried ? theme.board.muted(sinceText(x.r.at, now)) : undefined, tried, short));
      }
    };
    if (!data.statePath) rows.push(boardRow('  ' + theme.board.muted(t('no STATE.md'))));
    else if (state.projectTry) {
      // Only what the ledger says is `try`, whatever the milestone: the header is the way back (Enter, a click or `t`).
      const tries = landed.filter(({ r }) => r.state === 'try');
      rows.push({ ...section(t('Only to try'), width, String(tries.length)), item: 'project:try', files: [data.statePath] });
      if (!tries.length) rows.push(boardRow('  ' + theme.board.muted(t('Nothing to try'))));
      const from = rows.length;
      byMilestone(tries, 'try:m:', true);
      if (room !== undefined && rows.length > room) { rows.length = from; byMilestone(tries, 'try:m:', true, true); }
      return rows;
    } else if (state.projectLayout === 'board') {
      return boardProgressRows(data, state, width, now, board, modelEnabled, tryMarks);
    } else if (state.projectLayout === 'inbox') {
      return inboxProgressRows(data, state, width, now, board, modelEnabled, tryMarks);
    } else {
      if (data.summary) for (const line of clampLines(data.summary, width - 2, 2).lines) fileRow('  ' + line, 'summary');
      // The current milestone: its bar with accepted/total, its counts, and what the earlier ones accepted in all.
      const cur = currentRows(data), total = cur.rows.length - cur.counts.dropped;
      if (cur.rows.length) {
        const label = cur.whole || !data.ladder.current ? '' : ` ${monitorText(data.ladder.current)} `, frac = acceptedText(cur.counts, cur.rows.length);
        const cells = Math.max(6, Math.min(24, width - 3 - visualLength(label) - visualLength(frac) - 2));
        fileRow(`  ${label ? theme.board.title(label) + ' ' : ''}${barText({ counts: cur.counts }, cells)} ${theme.board.muted(frac)}`, 'bar');
        const words = SLICE_STATES.filter((s) => s !== 'accepted' && cur.counts[s]).map((s) => sliceInk(s)(`${cur.counts[s]} ${t(s === 'try' ? 'to try' : s)}`));
        // The to-try count is the way into the to-try filter; `o` still opens STATE.md from it.
        for (const line of pack(words, width)) cur.counts.try ? rows.push({ text: fit(line, width), item: 'project:try', files: [data.statePath] }) : fileRow(line, 'counts');
        const order = milestoneOrder(data), before = order.slice(0, Math.max(0, order.indexOf(data.ladder.current ?? ''))), earlier = data.ledger.filter((r) => r.state === 'accepted' && before.includes(r.milestone));
        const places = new Set(earlier.map((r) => r.milestone)).size;
        if (!cur.whole && earlier.length) fileRow(`  ${sliceInk('accepted')(mark('✓', '+'))} ${theme.board.muted(t(places === 1 ? '{n} accepted in {m} earlier milestone' : '{n} accepted in {m} earlier milestones', { n: earlier.length, m: places }))}`, 'earlier');
      }
    }
    const jobs = unsliced(data), slices = inFlight(data);
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
    if (landed.length) head('History', t('newest first'));
    recent.forEach((x) => entry(x, 2));
    byMilestone(older, 'hist:m:');
  } else if (page === 'waiting') {
    // One waiting item, in STATE's words and order: a line that continues a sentence flows on, a list line starts a paragraph of its own;
    // every wrapped row is a stop, so the movement keys scroll it, and `o` opens STATE.md.
    const r = data.waiting[state.projectWait ?? -1], paragraphs: string[] = [];
    for (const line of (r?.text ?? r?.value ?? '').split('\n').map((l) => l.trim()).filter(Boolean))
      if (!paragraphs.length || /^([-*]|\d+[.)])\s/.test(line)) paragraphs.push(line);
      else paragraphs[paragraphs.length - 1] += ' ' + line;
    for (const [k, paragraph] of paragraphs.entries()) {
      const marker = k ? paragraph.match(/^([-*]|\d+[.)])\s+/)?.[0] ?? '' : '', hang = 2 + marker.length;
      flowLines(monitorText(paragraph.slice(marker.length)), width - hang).forEach((line, n) => rows.push({
        text: fit((n ? ' '.repeat(hang) : k ? '  ' + marker : theme.board.attention('?') + ' ') + line, width),
        item: `project:wait:${state.projectWait}:${rows.length - 1}`, ...(r.path ? { files: [r.path] } : {}) }));
    }
  } else if (page === 'tickets') {
    rows.push(...ticketRows(data, folded, width, now));
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
  if (projectListOpen(state, projects)) return state.projectLayout === 'board' ? boardListRows(projects, width, now) : state.projectLayout === 'inbox' ? inboxListRows(projects, width, now) : listRows(projects, width, now);
  if (!data) return [];
  if (!page && state.projectLayout === 'board') return boardHubRows(data, state, width, now, name, projects, board, room, tryMarks);
  if (!page && state.projectLayout === 'inbox') return inboxHubRows(data, state, width, now, name, projects, board, room, tryMarks);
  return page ? pageRows(page, data, state, width, now, board, modelEnabled, tryMarks, room) : hubRows(data, state, width, now, name, projects, board, room);
}

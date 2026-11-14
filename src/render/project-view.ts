/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, SETTLED_JOB_STATES, type SliceState, type ProjectSnapshot, type ProjectItem, type ProjectTicket, type TicketFeature, type LedgerSlice } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { jobSentenceLine, workCardDetail, labelSummary } from './work-card.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { basename } from 'node:path';
import { boardRow, itemRow, section, mark, minuteAge, kvRows, pack } from './workboard-rows.js';
import { controlRows, pickerRows } from './control-view.js';
import { pickOf } from './model-input.js';
import { monitorText, fit, pair, flowLines } from './monitor-text.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { t } from './i18n.js';
const sliceInk = (state: SliceState) => ({ working: theme.board.active, blocked: theme.board.attention,
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
const legendItem = (data: ProjectSnapshot, s: SliceState) =>
  sliceInk(s)(`${mark('●', '*')} ${t(s === 'try' ? 'landed, to try' : s)} ${data.counts[s]}`);
const barText = (data: Pick<ProjectSnapshot, 'counts'>, width: number) => progressSegments(data.counts, width).map(({ state, width: cells }) =>
  sliceInk(state)(mark(state === 'todo' || state === 'dropped' ? '░' : state === 'try' ? '▓' : '█', '#').repeat(cells))).join('');
const HOME_BLOCK = 60, HOME_TICKETS = 6;
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
/** Only whole spare rows; cards and decisions have already claimed their space. Shrinks from the bottom up: tickets, legend, bar, summary. */
export function homeProgressRows(data: ProjectSnapshot | undefined, width: number, spare: number, gap = true): MonitorRow[] {
  if (!data || spare < 3 || (!data.summary && !data.ladder.current && !data.tickets.length)) return [];
  const row = (text: string, id = 'progress'): MonitorRow => ({ text: fit(text, width), item: `home-progress:${id}` });
  const states = SLICE_STATES.filter((s) => data.counts[s]);
  const legend = legendGrid(states.map((s) => legendItem(data, s)), Math.min(width - 2, HOME_BLOCK));
  const rows = [...(gap ? [boardRow('')] : []),
    { ...section(t('Progress'), width, data.ladder.current ? `${t('Milestone')} ${monitorText(data.ladder.current)}` : ''), item: 'home-progress:progress' },
    ...(data.summary ? [row('  ' + monitorText(data.summary))] : []),
    ...(states.length ? [row('  ' + barText(data, Math.max(0, Math.min(width - 2, Math.max(24, legend.width)))))] : [])].slice(0, spare);
  if (rows.length + legend.lines.length > spare) return rows;
  rows.push(...legend.lines.map((line) => row('  ' + line)));
  const rank = { working: 0, ready: 1, blocked: 2 } as Record<string, number>;
  for (const feature of data.tickets) {
    const open = feature.tickets.filter((r) => r.state in rank).sort((a, b) => rank[a.state] - rank[b.state]);
    const slots = Math.min(HOME_TICKETS, spare - rows.length - 1);
    if (!open.length || slots < 1) continue;
    const id = `tickets:${feature.slug}`, done = feature.tickets.filter((r) => r.state === 'done').length;
    rows.push({ ...section(`${t('Tickets')} · ${monitorText(feature.slug)}`, width,
      t('{done}/{total} done', { done, total: feature.tickets.length })), item: `home-progress:${id}` });
    const cut = open.length > slots && slots > 2, shown = open.slice(0, cut ? slots - 1 : slots);
    for (const ticket of shown) rows.push(row(pair(
      `  ${monitorText(ticket.number + ' ' + ticket.title)}`, theme.board.muted(t(ticket.state)), width), id));
    if (cut) rows.push(row('  ' + theme.board.muted(t('+{n} more', { n: open.length - shown.length })), id));
  }
  return rows;
}
export const PROJECT_PAGES = ['progress', 'tickets', 'tree', 'docs', 'control'] as const;
export type ProjectPage = (typeof PROJECT_PAGES)[number];
const PAGE_WORD: Record<ProjectPage, string> = {
  progress: 'Progress', tickets: 'Tickets', tree: 'Working tree', docs: 'Docs', control: 'Control plane',
};
/** The open page; none, or a name this build does not know, is the hub. */
export const projectPageOf = (state: MonitorState) => PROJECT_PAGES.find((p) => p === state.projectPage);
/** What starts folded: the Control plane's healthy roles, its files and the native-agents list (a page's own header is its crumb). */
export const projectFoldedSet = (state: MonitorState): ReadonlySet<string> => state.projectFolded ?? new Set(['agents', 'healthy', 'files']);
const ticketWorking = (r: ProjectTicket) => !['done', 'dropped', 'blocked'].includes(r.state)
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
    const drift = data.slices.filter((r) => r.drift).length, bang = drift ? theme.board.attention(`! ${drift}`) : '';
    return [parts(updatedText(data, now), bang).join(' · '), bang];
  }
  if (page === 'tickets') return data.tickets?.length ? [t('{features} features · {tickets} tickets', {
    features: data.tickets.length, tickets: data.tickets.reduce((n, f) => n + f.tickets.length, 0) })] : [];
  if (page === 'control') return [`${data.roleCount} ${t('roles')} · ${data.agents.length} ${t('agents')}`, `${data.roleCount} ${t('roles')}`];
  return [];
}
/** `Project › Page` for the sub-page title row (the project's name instead of `Project` when there is a switch), with the page's own facts on the right when there is room. */
export function projectCrumb(page: ProjectPage, data: ProjectSnapshot | undefined, width: number, now: number, name = '') {
  const crumb = `${name ? truncateAnsi(monitorText(name), 16) : t('Project')} ${mark('›', '>')} ${t(PAGE_WORD[page])}`;
  return { crumb, right: (data && pageMeta(page, data, now).find((r) => r && visualLength(crumb) + 4 + visualLength(r) <= width)) || '' };
}
/** One line per page, most important fact first: a row too short for all of them drops the last, not part of one. */
function pageSummary(page: ProjectPage, data: ProjectSnapshot, now: number): string[] {
  const c = currentRows(data).counts, tickets = data.tickets.flatMap((f) => f.tickets), g = data.git;
  if (page === 'progress') return parts(data.ladder.current && monitorText(data.ladder.current),
    c.working && `${c.working} ${t('working')}`, c.try && t('{n} to try', { n: c.try }),
    c.blocked && `${c.blocked} ${t('blocked')}`, !data.statePath && t('no STATE.md'));
  if (page === 'tickets') {
    const working = tickets.filter(ticketWorking).length, blocked = tickets.filter((r) => r.state === 'blocked').length;
    return tickets.length ? parts(t('{done}/{total} done', { done: tickets.filter((r) => r.state === 'done').length, total: tickets.length }),
      working && `${working} ${t('working')}`, blocked && `${blocked} ${t('blocked')}`) : [];
  }
  if (page === 'tree') return parts(g?.branch && monitorText(g.branch), g && t('{n} changed', { n: g.changed }),
    data.worktreeCount && t(data.worktreeCount === 1 ? '{n} worktree' : '{n} worktrees', { n: data.worktreeCount }), g?.ahead && `${g.ahead} ${t('ahead')}`, g?.behind && `${g.behind} ${t('behind')}`,
    data.editing.length && `${data.editing.length} ${t('editing')}`);
  if (page === 'docs') {
    const spec = data.docs.find((r) => r.label === 'spec'), review = data.docs.find((r) => r.label === 'review');
    return parts(spec && monitorText(spec.value), review && `${t('review')} ${minuteAge(review.at ?? null, now)}`);
  }
  const limit = data.roles.filter((r) => r.places.some((p) => p.state === 'exhausted')).length;
  return parts(limit && theme.board.attention(t('{n} at limit', { n: limit })), `${data.roleCount} ${t('roles')}`, data.keys.length && `${t('keys')} ${data.keys.filter((k) => k[1]).length}/${data.keys.length}`,
    `${t('browser')} ${mark(data.browser ? '✓' : '−', data.browser ? '+' : '-')}`);
}
const foldRow = (folded: ReadonlySet<string>, id: string, label: string, width: number, right = ''): MonitorRow => ({
  ...section(`${folded.has(id) ? mark('▸', '>') + ' ' : ''}${t(label)}`, width, right), item: `project:fold:${id}`,
});
const projectItem = (r: ProjectItem, i: number, glyph: string, width: number, now: number): MonitorRow => {
  const left = `${r.label ? fit(t(r.label), 10) + ' ' : ''}${monitorText(r.value)}`;
  const right = width < 56 ? '' : r.at !== undefined ? minuteAge(r.at, now)
    : r.path ? monitorText(basename(r.path)) : '';
  return { ...itemRow(glyph, left, right, width), ...(r.path ? { item: `project:file:${r.path}:${i}`, files: [r.path] } : {}) };
};
const roleInk = (role: string) => (theme.board.roleInk as Record<string, (s: string) => string>)[role] ?? ((s: string) => s);
const DAY = 864e5;
/** STATE's current milestone's ledger rows with their counts; a ledger that has none of them (or no current milestone) is counted whole. */
function currentRows(data: ProjectSnapshot) {
  const mine = data.ledger.filter((r) => r.milestone === data.ladder.current), rows = mine.length ? mine : data.ledger;
  const counts = Object.fromEntries(SLICE_STATES.map((s) => [s, rows.filter((r) => r.state === s).length])) as ProjectSnapshot['counts'];
  return { rows, counts, whole: !mine.length };
}
/** `head` and `text` on one row when the text fits whole beside `right`; else the head alone (a hub row never wraps or cuts its text). */
const inline = (head: string, text: string, right: string, width: number) => {
  const body = monitorText(text);
  return pair(body && visualLength(head) + 2 + visualLength(body) + (right ? visualLength(right) + 1 : 0) <= width ? `${head}  ${theme.board.muted(body)}` : head, right, width);
};
/** Jobs of this project that no slice shows: an imp working in the main checkout, say. */
const unsliced = (data: ProjectSnapshot) => data.active.filter((a) => !data.slices.some((r) => r.jobId === a.jobId));
/** Landed slices (to try or accepted), the newest first by commit date; those with none last, the later ledger rows first. */
const landedNewest = (data: ProjectSnapshot) => data.ledger.flatMap((r, i) => r.state === 'try' || r.state === 'accepted' ? [{ r, i }] : [])
  .sort((a, b) => (b.r.at ?? -1) - (a.r.at ?? -1) || b.i - a.i);
const landedMark = (r: LedgerSlice) => r.state === 'try' ? sliceInk('try')(mark('◇', 'o')) : sliceInk('accepted')(mark('✓', '+'));
/** The hub's Latest and Progress's History share this right side: `to try 10h`, or only the age for an accepted slice on Progress. */
const landedAge = (r: LedgerSlice, now: number, word = true) =>
  [r.state === 'try' ? sliceInk('try')(t('to try')) : word ? theme.board.muted(t('accepted')) : '', theme.board.muted(sinceText(r.at, now))].filter(Boolean).join(' ');
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
      [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
    ...(many ? { item: 'project:switch' } : {}),
  }];
  const waiting: MonitorRow[] = [];
  if (data.waiting.length) {
    waiting.push(foldRow(folded, 'waiting', 'Waiting for you', width, String(data.waiting.length)));
    if (!folded.has('waiting')) data.waiting.forEach((r, i) => waiting.push(projectItem(r, i, theme.board.attention('?'), width, now)));
    waiting.push(boardRow(''));
  }
  const nowRows: MonitorRow[] = [...data.slices.map((r): MonitorRow => {
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
  const nowBlock: MonitorRow[] = nowRows.length ? [section(t('Now'), width, String(nowRows.length)), ...nowRows, boardRow('')] : [];
  const landed = landedNewest(data).slice(0, width < 56 ? 3 : 5).map(({ r }): MonitorRow => ({
    text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now), width),
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
  const build = (n: number, bar: boolean, gaps: boolean) => [...top, ...waiting, ...nowBlock, ...latest(n), ...pages(bar)]
    .filter((r) => gaps || r.text !== '' || r.item);
  const tiers: [number, boolean, boolean][] = [...landed.map((_, i): [number, boolean, boolean] => [landed.length - i, true, true]), [0, true, true], [0, false, true], [0, false, false]];
  for (const [n, bar, gaps] of tiers) {
    const rows = build(n, bar, gaps);
    if (room === undefined || rows.length <= room) return rows;
  }
  return build(0, false, false);
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
function sinceText(at: number | undefined, now: number): string {
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
const NO_MILESTONE = /^[—–-]*$/;
/** Milestones in ledger order, oldest first; STATE's current one is always among them. A ledger naming none falls back to spec §5. */
function milestoneOrder(data: ProjectSnapshot): string[] {
  const seen = new Set(data.ledger.map((r) => r.milestone).filter((m) => !NO_MILESTONE.test(m)));
  if (!seen.size) data.ladder.ids.forEach((id) => seen.add(id));
  if (data.ladder.current) seen.add(data.ladder.current);
  return [...seen];
}
/** A ledger row's text without its commit, which the row shows beside the date: `(abc1234)` at the end or `abc1234 · ` at the start. */
const ledgerText = (r: LedgerSlice) => r.text.replace(/\s*\((?:[0-9a-f]{7,40}(?:[,;]\s*|(?=\))))+\)\s*$/i, '')
  .replace(/^[0-9a-f]{7,40}\s*·\s*/i, '').trim();
/** `MM-DD`, with the year when it is not this one. */
function dateText(at: number, now: number): string {
  const day = new Date(at), two = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear() === new Date(now).getFullYear() ? '' : day.getFullYear() + '-'}${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}
/** `text` wrapped to `room` columns and cut to `max` rows, the last ending in an ellipsis; `more` says it was cut. */
function clampLines(text: string, room: number, max: number) {
  return clampClean(monitorText(text), room, max);
}
/** `clampLines` for text already through `monitorText`. */
function clampClean(body: string, room: number, max: number) {
  const lines = flowLines(body, Math.max(1, room)), more = lines.length > max;
  return { more, lines: more ? [...lines.slice(0, max - 1), fit(lines.slice(max - 1).join(' '), Math.max(1, room))] : lines };
}
/** `head` and `text` on one row when they fit beside `right` (and `one`); else `head` with `right`, and the text wrapped under it at `indent`. */
function stacked(head: string, text: string, right: string, width: number, indent: number, max = 2, one = true): string[] {
  const body = monitorText(text);
  if (!body) return [pair(head, right, width)];
  if (one && visualLength(head) + 2 + visualLength(body) + (right ? visualLength(right) + 1 : 0) <= width) return [pair(`${head}  ${body}`, right, width)];
  return [pair(head, right, width), ...clampClean(body, width - indent, max).lines.map((line) => ' '.repeat(indent) + line)];
}
/** A done/total meter `cells` wide, as thin as the panel's other meters; a started one shows at least a cell, an unfinished one never looks full. */
function meter(done: number, total: number, cells: number): string {
  const filled = !total ? 0 : Math.min(cells - (done < total ? 1 : 0), Math.max(done ? 1 : 0, Math.round(done / total * cells)));
  return theme.board.success(mark('━', '#').repeat(filled)) + theme.board.muted(mark('─', '-').repeat(cells - filled));
}
const ASKS = /^(needs-triage|needs-info|ready-for-human)$/i;
/** A ticket that asks for the owner: it waits on an answer or a human, whatever else holds it. */
const asksYou = (r: ProjectTicket) => r.state !== 'done' && r.state !== 'dropped' && ASKS.test(r.status);
const ticketLane = (r: ProjectTicket) => r.state === 'done' || r.state === 'dropped' ? 'done' : asksYou(r) ? 'you' : ticketWorking(r) ? 'working'
  : r.state === 'blocked' ? 'blocked' : 'ready';
const ticketGlyph = (r: ProjectTicket) => r.state === 'done' ? theme.board.success(mark('✓', '+')) : r.state === 'dropped' ? theme.board.muted(mark('–', '-'))
  : r.state === 'blocked' ? theme.board.attention(mark('◆', '!')) : theme.board.active(ticketWorking(r) ? mark('◐', '@') : mark('●', '*'));
/** Two to four letters naming a feature on its tickets' rows: its words' initials, else the first letters of its slug, never the same for two. */
function featureCodes(features: TicketFeature[]): Map<string, string> {
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
function ticketRows(data: ProjectSnapshot, folded: ReadonlySet<string>, width: number, now: number): MonitorRow[] {
  const rows: MonitorRow[] = [], features = data.tickets ?? [], codes = featureCodes(features);
  const all = features.flatMap((f) => f.tickets.map((ticket) => ({ ticket, feature: f })));
  if (!all.length) return rows;
  const column = Math.max(...[...codes.values()].map(visualLength)), done = all.filter(({ ticket }) => ticket.state === 'done').length;
  rows.push(boardRow(fit(`  ${meter(done, all.length, 16)} ${theme.board.muted(`${done}/${all.length}`)}`, width)));
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
    const title = monitorText(`${ticket.number} ${ticket.title}`), tid = `ticket:${feature.slug}:${basename(ticket.path)}`, at = { item: `project:fold:${tid}`, files: [ticket.path] };
    rows.push({ text: pair(`  ${lane === 'you' ? theme.board.attention('?') : ticketGlyph(ticket)} ${theme.board.muted(fit(codes.get(feature.slug)!, column))} ${dropped ? theme.board.muted(title) : title}`, right, width), ...at });
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
function pageRows(
  page: ProjectPage, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = projectFoldedSet(state);
  const item = (r: ProjectItem, i: number, glyph = '') => rows.push(projectItem(r, i, glyph, width, now));
  if (page === 'progress') {
    const fileRow = (text: string, key: string, path = data.statePath) => rows.push({
      text: fit(text, width), ...(path ? { item: `project:file:${path}:${key}`, files: [path] } : {}),
    });
    const head = (label: string, right: string | number) => rows.push(boardRow(''), section(t(label), width, String(right)));
    if (!data.statePath) rows.push(boardRow('  ' + theme.board.muted(t('no STATE.md'))));
    else {
      if (data.summary) for (const line of clampLines(data.summary, width - 2, 2).lines) fileRow('  ' + line, 'summary');
      // The current milestone: its bar with accepted/total, its counts, and what the earlier ones accepted in all.
      const cur = currentRows(data), total = cur.rows.length - cur.counts.dropped;
      if (cur.rows.length) {
        const label = cur.whole || !data.ladder.current ? '' : ` ${monitorText(data.ladder.current)} `, frac = `${cur.counts.accepted}/${total}`;
        const cells = Math.max(6, Math.min(24, width - 3 - visualLength(label) - visualLength(frac) - 2));
        fileRow(`  ${label ? theme.board.title(label) + ' ' : ''}${barText({ counts: cur.counts }, cells)} ${theme.board.muted(frac)}`, 'bar');
        const words = SLICE_STATES.filter((s) => s !== 'accepted' && cur.counts[s]).map((s) => sliceInk(s)(`${cur.counts[s]} ${t(s === 'try' ? 'to try' : s)}`));
        for (const line of pack(words, width)) fileRow(line, 'counts');
        const order = milestoneOrder(data), before = order.slice(0, Math.max(0, order.indexOf(data.ladder.current ?? ''))), earlier = data.ledger.filter((r) => r.state === 'accepted' && before.includes(r.milestone));
        const places = new Set(earlier.map((r) => r.milestone)).size;
        if (!cur.whole && earlier.length) fileRow(`  ${sliceInk('accepted')(mark('✓', '+'))} ${theme.board.muted(t(places === 1 ? '{n} accepted in {m} earlier milestone' : '{n} accepted in {m} earlier milestones', { n: earlier.length, m: places }))}`, 'earlier');
      }
    }
    const jobs = unsliced(data);
    if (data.slices.length + jobs.length) head('Now', data.slices.length + jobs.length);
    for (const [i, r] of data.slices.entries()) {
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
    // History: the last seven days in full, newest first, each landed slice a row that Enter opens (its milestone, commit and day);
    // everything older, and whatever has no commit date, one row a milestone that Enter opens into its slices.
    const landed = landedNewest(data), recent = landed.filter(({ r }) => r.at !== undefined && now - r.at <= 7 * DAY), older = landed.filter((x) => !recent.includes(x));
    if (landed.length) head('History', t('newest first'));
    const entry = ({ r }: { r: LedgerSlice }, indent: number) => {
      const id = `hist:${r.id}`, lines = stacked(`${' '.repeat(indent)}${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now, false), width, indent + 4, 2);
      if (folded.has(id)) lines.splice(1, 0, ' '.repeat(indent + 4) + theme.board.muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? dateText(r.at, now) : ''].filter(Boolean).join(' · ')));
      for (const line of lines) rows.push({ text: fit(line, width), item: `project:fold:${id}`, ...(data.statePath ? { files: [data.statePath] } : {}) });
    };
    recent.forEach((x) => entry(x, 2));
    const order = milestoneOrder(data), buckets = new Map<string, typeof landed>();
    for (const x of older) buckets.set(NO_MILESTONE.test(x.r.milestone) ? '' : x.r.milestone, [...(buckets.get(NO_MILESTONE.test(x.r.milestone) ? '' : x.r.milestone) ?? []), x]);
    const names = [...buckets.keys()].map((m) => m || t('other')), column = Math.min(10, Math.max(...names.map(visualLength), 0));
    for (const [milestone, items] of [...buckets].sort((a, b) => order.indexOf(b[0]) - order.indexOf(a[0]))) {
      const id = `hist:m:${milestone}`, open = folded.has(id), accepted = items.filter(({ r }) => r.state === 'accepted').length, tries = items.length - accepted;
      const days = items.flatMap(({ r }) => r.at === undefined ? [] : [Math.floor((now - r.at) / DAY)]), lo = Math.min(...days), hi = Math.max(...days);
      const span = !days.length ? '' : lo === hi ? t('{n}d', { n: lo }) : `${lo}–${t('{n}d', { n: hi })}`;
      // Counts with their words; a row too short for them keeps the marks and the numbers.
      const counts = (words: boolean) => [accepted && sliceInk('accepted')(`${mark('✓', '+')} ${accepted}${words ? ' ' + t('accepted') : ''}`),
        tries && sliceInk('try')(`${mark('◇', 'o')} ${tries}${words ? ' ' + t('to try') : ''}`)].filter(Boolean).join('  ');
      const lead = `  ${open ? mark('▾', 'v') : mark('▸', '>')} ${fit(monitorText(milestone) || t('other'), column)} `, words = visualLength(lead + counts(true)) + visualLength(span) + 1 <= width;
      rows.push({ text: pair(lead + counts(words), theme.board.muted(span), width), item: `project:fold:${id}` });
      if (open) items.forEach((x) => entry(x, 4));
    }
  } else if (page === 'tickets') {
    rows.push(...ticketRows(data, folded, width, now));
  } else if (page === 'tree') {
    if (data.git) item({ label: 'branch', value: [
      data.git.branch, t('{n} changed', { n: data.git.changed }),
      data.git.ahead === null ? '' : `${data.git.ahead} ${t('ahead')}`,
      data.git.behind ? `${data.git.behind} ${t('behind')}` : '',
    ].filter(Boolean).join(' · ') }, 0);
    data.editing.forEach((r, i) => item(r, i, theme.board.active(mark('◉', '@'))));
    if (data.last) item({ label: 'last', value: data.last.text, at: data.last.at }, 0);
  } else if (page === 'docs') data.docs.forEach((r, i) => item(r, i));
  else {
    rows.push(...controlRows(data, width, now, !folded.has('healthy')));
    // Files: the role definitions and instruction files, the native agents, keys and browser; one row of keys while folded.
    const files = data.control.filter((r) => r.label !== 'invalid'), open = !folded.has('files'), have = data.keys.filter((k) => k[1]).length;
    rows.push(boardRow(''), foldRow(folded, 'files', 'Files', width, String(files.length + data.agents.length)));
    if (!open) {
      const missing = data.keys.filter((k) => !k[1]).map((k) => k[0].replace(/_API_KEY$/, ''));
      rows.push({ text: fit('  ' + theme.board.muted(parts(data.keys.length && `${t('keys')} ${have}/${data.keys.length}`,
        `${t('browser')} ${mark(data.browser ? '✓' : '−', data.browser ? '+' : '-')}`, missing.length && `${t('missing')} ${monitorText(missing.join(' '))}`).join(' · ')), width), item: 'project:fold:files' });
    } else {
      files.forEach((r, i) => item(r.label === 'convention' ? { ...r, value: t(r.value) + ' · ' + basename(r.path!) } : r, i));
      rows.push(foldRow(folded, 'agents', 'agents', width, String(data.agents.length)));
      if (!folded.has('agents')) data.agents.forEach((r, i) => item(r, i));
      rows.push(...kvRows('keys', data.keys.map(([name, present]) =>
        `${name} ${mark(present ? '✓' : '−', present ? '+' : '-')}`).join('  '), width));
      item({ label: 'browser', value: mark(data.browser ? '✓' : '−', data.browser ? '+' : '-') }, 0);
    }
  }
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
  if (projectListOpen(state, projects)) return listRows(projects, width, now);
  if (!data) return [];
  // The model picker is the Control plane while it is open.
  if (page === 'control' && state.projectInput && pickOf(data, state.projectInput)) return pickerRows(data, state.projectInput, width, room ?? 24);
  return page ? pageRows(page, data, state, width, now, board, modelEnabled) : hubRows(data, state, width, now, name, projects, board, room);
}

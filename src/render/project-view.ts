/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, SETTLED_JOB_STATES, ownerRequestKey, type ProjectSnapshot, type ProjectItem, type ProjectTicket, type TicketFeature } from '../collectors/project-board.js';
import type { TicketActivity } from '../collectors/execution.js';
import { roleInk } from './work-job-row.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { projectPage, type ProjectSubPage } from './monitor-state.js';
import { basename } from 'node:path';
import { ticketRowKey } from '../collectors/ticket-evidence.js';
import { boardRow, itemRow, section, mark, minuteAge, pack } from './workboard-rows.js';
import { projectOverviewRows, projectListRows } from './inbox-project.js';
import { unlinkedFeatureRows } from './project-objectives.js';
import { diffStatRows } from './diff-stat-rows.js';
import { worktreeRows } from './monitor-panes.js';
import type { WorktreesSnapshot } from '../collectors/worktrees.js';
import { monitorText, fit, pair, flowLines, cutWords, clampClean } from './monitor-text.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { t } from './i18n.js';
import { sliceInk } from './progress-bar.js';
export { barText, progressSegments, sliceInk } from './progress-bar.js';
export { clampClean } from './monitor-text.js';
const ticketTotalText = (data: ProjectSnapshot, text: string) =>
  data.ticketTotals?.partial ? `${t('Partial')} · ${text}` : text;
export type ProjectPage = ProjectSubPage | 'waiting';
export const PAGE_WORD: Record<ProjectPage, string> = {
  tickets: 'Tickets', tree: 'Working tree', docs: 'Docs', waiting: 'Waiting', unlinked: 'Unlinked',
};
/** The open page; none, or a name this build does not know, is the hub. */
export const projectPageOf = (state: MonitorState) => projectPage(state.project.view);
const ticketResolved = (r: ProjectTicket) => r.state === 'done' || r.state === 'dropped';
export const ticketWorking = (r: ProjectTicket) => r.state === 'working';
export const ticketStateWord = (r: ProjectTicket) => t(r.state === 'try' ? 'to try' : r.state === 'queued' ? 'Queued' : r.state === 'blocked' ? 'Stalled' : r.state);
/** What an open page says about itself on its crumb row, widest first; the first that fits is shown. */
function pageMeta(page: ProjectPage, data: ProjectSnapshot): string[] {
  if (page === 'tickets' && data.tickets?.length) {
    const text = featureCountText(data.ticketTotals?.totalFeatures ?? data.tickets.length);
    return [ticketTotalText(data, text), ...(data.ticketTotals?.partial ? [t('Partial')] : [])];
  }
  return [];
}
/** `Project › Page` for the sub-page title row (the project's name instead of `Project` when there is a switch), with the page's own facts on the right when there is room. */
export function projectCrumb(page: ProjectPage, data: ProjectSnapshot | undefined, width: number, name = '') {
  const crumb = `${name ? truncateAnsi(monitorText(name), 16) : t('Project')} ${mark('›', '>')} ${t(PAGE_WORD[page])}`;
  return { crumb, right: (data && pageMeta(page, data).find((r) => r && visualLength(crumb) + 4 + visualLength(r) <= width)) || '' };
}
const itemRight = (r: ProjectItem, width: number, now: number) => width < 56 ? '' : r.at !== undefined ? minuteAge(r.at, now)
  : r.path ? monitorText(basename(r.path)) : '';
export const projectItem = (r: ProjectItem, i: number, glyph: string, width: number, now: number): MonitorRow => {
  const left = `${r.label ? fit(t(r.label), 10) + ' ' : ''}${monitorText(r.value)}`;
  return { ...itemRow(glyph, left, itemRight(r, width, now), width), ...(r.path ? { item: `project:file:${r.path}:${i}`, files: [r.path] } : {}) };
};
export { roleInk }; // Also used by the Project list and previews.
/** STATE's current milestone's ledger rows with their counts; a ledger that has none of them (or no current milestone) is counted whole. */
export function currentRows(data: ProjectSnapshot) {
  const mine = data.ledger.filter((r) => (r.release ?? r.milestone) === data.ladder.current), rows = mine.length ? mine : data.ledger;
  const counts = Object.fromEntries(SLICE_STATES.map((s) => [s, rows.filter((r) => r.state === s).length])) as ProjectSnapshot['counts'];
  return { rows, counts, whole: !mine.length };
}
/** All pending slices in the project, not just the current milestone. */
export const tryCount = (data: Pick<ProjectSnapshot, 'ledger'>) => data.ledger.filter((r) => r.state === 'try').length;
export const ACCEPT_ALL = 'project:accept-all';
/** Explicit action in ticket diagnostics, not an owner request on the Project hub. */
export function ticketAcceptRows(data: ProjectSnapshot, width: number): MonitorRow[] {
  const n = tryCount(data);
  if (!n) return [];
  const label = t('Accept all'), count = t('{n} to try', { n });
  const partial = data.ticketTotals?.partial ? t('Partial') : '';
  const facts = [partial, count].filter(Boolean).join(' · ');
  const right = [facts, partial].find((text) => visualLength(label) + 1 + visualLength(text) <= width) ?? '';
  return [{ item: ACCEPT_ALL, text: pair(theme.board.active(label), theme.board.muted(right), width) }];
}
/** Unmanaged worktrees that have no linked ticket. */
export const unlisted = (data: ProjectSnapshot) => data.slices.filter((r) => r.drift);
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
/** `text` wrapped to `room` columns and cut to `max` rows, the last ending in an ellipsis; `more` says it was cut. */
export function clampLines(text: string, room: number, max: number) {
  return clampClean(monitorText(text), room, max);
}
/** Cut a ticket's title to `room` cells at a word end (Chinese at a character), falling back to cell cut when not even the first word fits. */
export const cutTicketTitle = (title: string, room: number) => {
  const clean = monitorText(title);
  return room > 0 ? cutWords(clean, room) || clean : clean;
};
const featureCountText = (n: number) => t(n === 1 ? '{n} feature' : '{n} features', { n });
/** A done/total meter `cells` wide, as thin as the panel's other meters; a started one shows at least a cell, an unfinished one never looks full. */
export function meter(done: number, total: number, cells: number): string {
  const filled = !total ? 0 : Math.min(cells - (done < total ? 1 : 0), Math.max(done ? 1 : 0, Math.round(done / total * cells)));
  return theme.board.success(mark('━', '#').repeat(filled)) + theme.board.muted(mark('─', '-').repeat(cells - filled));
}
const ASKS = /^(needs-triage|needs-info|ready-for-human)$/i;
/** A ticket that asks for the owner: it waits on an answer or a human, whatever else holds it. */
export const asksYou = (r: ProjectTicket) => r.state === 'triage' || ((r.state === 'ready' || r.state === 'blocked') && ASKS.test(r.status));
const ticketLane = (r: ProjectTicket) => r.state === 'done' || r.state === 'dropped' ? 'done' : asksYou(r) ? 'you' : ticketWorking(r) ? 'working'
  : r.state;
export const ticketGlyph = (r: ProjectTicket) => r.state === 'done' ? theme.board.success(mark('✓', '+')) : r.state === 'dropped' ? theme.board.muted(mark('–', '-'))
  : r.state === 'queued' ? theme.board.muted(mark('·', '.')) : r.state === 'try' ? sliceInk('try')(mark('◇', '*'))
  : r.state === 'blocked' ? theme.board.attention(mark('◆', '!')) : r.state === 'triage' ? theme.board.attention('?')
  : theme.board.active(ticketWorking(r) ? mark('◐', '@') : mark('●', '*'));
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
    const title = `${number} ${cutTicketTitle(ticket.title, room)}`, tid = `ticket:${feature.slug}:${ticketRowKey(ticket)}`, at = { item: `project:fold:${tid}`, files: [ticket.path] };
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
    .filter(r => r.item === `project:fold:${id}`).slice(1)
    .map(r => ({ text: r.text }));
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
  return { item: featureItem(feature), featureTarget: { root: '', slug: feature.slug }, text: pair(`  ${mark(open ? '▾' : '▸', open ? 'v' : '>')} ${monitorText(feature.slug)}`, theme.board.muted(right), width) };
}
/** One page: today's section content, without the section header (the crumb names the page). */
export function pageRows(
  page: ProjectPage, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  worktrees?: WorktreesSnapshot | null
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = state.project.folded;
  const item = (r: ProjectItem, i: number, glyph = '') => rows.push(projectItem(r, i, glyph, width, now));
  if (page === 'waiting') {
    // One waiting item, in STATE's words and order: a line that continues a sentence flows on, a list line starts a paragraph of its own;
    // every wrapped row is a stop, so the movement keys scroll it, and `o` opens STATE.md.
    const view = state.project.view;
    const index = view.kind === 'waiting' ? view.index : -1;
    const r = view.kind === 'waiting' ? data.waiting.find((item) => ownerRequestKey(item) === view.request) : undefined;
    const paragraphs: string[] = [];
    for (const line of (r?.text ?? r?.value ?? '').split('\n').map((l) => l.trim()).filter(Boolean))
      if (!paragraphs.length || /^([-*]|\d+[.)])\s/.test(line)) paragraphs.push(line);
      else paragraphs[paragraphs.length - 1] += ' ' + line;
    for (const [k, paragraph] of paragraphs.entries()) {
      const marker = k ? paragraph.match(/^([-*]|\d+[.)])\s+/)?.[0] ?? '' : '', hang = 2 + marker.length;
      flowLines(monitorText(paragraph.slice(marker.length)), width - hang).forEach((line, n) => rows.push({
        text: fit((n ? ' '.repeat(hang) : k ? '  ' + marker : theme.board.attention('?') + ' ') + line, width),
        item: `project:wait:${index}:${rows.length - 1}`, ...(r?.path ? { files: [r.path] } : {}) }));
    }
  } else if (page === 'tickets') {
    for (const feature of data.tickets) {
      const open = folded.has(featureItem(feature).slice('project:fold:'.length));
      rows.push(featureRow(feature, width, open));
      if (open) rows.push(...ticketRows(data, folded, width, now, feature).slice(1));
    }
    rows.push(...ticketAcceptRows(data, width));
  } else if (page === 'tree') {
    if (worktrees) rows.push(...worktreeRows(worktrees, width, now));
    if ((!worktrees || worktrees.error) && data.git) item({ label: 'branch', value: [
      data.git.branch, t('{n} changed', { n: data.git.changed }),
      data.git.ahead === null ? '' : `${data.git.ahead} ${t('ahead')}`,
      data.git.behind ? `${data.git.behind} ${t('behind')}` : '',
    ].filter(Boolean).join(' · ') }, 0);
    rows.push(...diffStatRows(data.gitDiff, width));
    if (data.last) item({ label: 'last', value: data.last.text, at: data.last.at }, 0);
    // Worktrees with no linked ticket.
    if (unlisted(data).length) rows.push(boardRow(''), section(t('Unlisted worktrees'), width, String(unlisted(data).length)),
      ...unlisted(data).map((r) => boardRow(pair(`  ${theme.board.attention('!')} ${monitorText(r.label)}`, theme.board.muted(t('no linked ticket')), width))));
  } else if (page === 'docs') {
    if (data.statePath) rows.push({ text: fit('  STATE.md', width), item: `project:file:${data.statePath}:state`, files: [data.statePath] });
    data.docs.forEach((r, i) => item(r, i));
  } else if (page === 'unlinked') rows.push(...unlinkedFeatureRows(data.unlinked ?? [], width));
  if (rows.length === 1) rows.push(boardRow('  ' + theme.board.muted(t('none'))));
  return rows;
}

/** The Project tab: its overview, or the page the panel has open. */
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number,
  projects: ProjectChoice[] = [], worktrees?: WorktreesSnapshot | null, activity?: readonly TicketActivity[]
): MonitorRow[] {
  const page = projectPageOf(state);
  // The list reads each project's own overview; the shown project's full snapshot is not needed for it.
  if (projectListOpen(state, projects)) return projectListRows(projects, width, now);
  if (!data) return [];
  return page ? pageRows(page, data, state, width, now, worktrees) : projectOverviewRows(data, state, width, now, activity);
}

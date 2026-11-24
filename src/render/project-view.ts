/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, SETTLED_JOB_STATES, blockedObjectives, ownerRequestKey, type SliceState, type ProjectSnapshot, type ProjectItem, type ProjectTicket, type TicketFeature, type LedgerSlice } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { OBJECTIVE_STATES } from '../collectors/objectives.js';
import { ledgerTasks, type AcceptanceTask } from '../collectors/acceptance-tasks.js';
import { projectWorkJob } from '../collectors/work-job.js';
import { stemLines, workJobDetail } from './work-job-detail.js';
import { roleInk } from './work-job-row.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { projectPage } from './monitor-state.js';
import { basename, dirname } from 'node:path';
import { boardRow, itemRow, section, mark, minuteAge, pack } from './workboard-rows.js';
import { projectOverviewRows, projectListRows } from './inbox-project.js';
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
export function updatedText(atMs: number | undefined, now: number): string {
  if (atMs === undefined) return '';
  const at = new Date(atMs), today = new Date(now), two = (n: number) => String(n).padStart(2, '0');
  return t('updated {time}', { time: at.toDateString() === today.toDateString() ? `${two(at.getHours())}:${two(at.getMinutes())}`
    : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` });
}
/** What an open page says about itself on its crumb row, widest first; the first that fits is shown. */
function pageMeta(page: ProjectPage, data: ProjectSnapshot, now: number): string[] {
  if (page === 'progress') return [updatedText(data.updatedAt, now)];
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
export { roleInk }; // Also used by the Project list and previews.
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
/** `3/8 accepted`: what a milestone's bar counts, in words (accepted slices of all but the dropped). */
export const acceptedText = (counts: ProjectSnapshot['counts'], rows: number) =>
  t('{done}/{total} accepted', { done: counts.accepted, total: rows - counts.dropped });
/** Jobs of this project that no slice shows: an imp working in the main checkout, say. */
export const unsliced = (data: ProjectSnapshot) => data.active.filter((a) => !data.slices.some((r) => r.jobId === a.jobId));
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

/** Slice details in the Project task drill-down. */
export function sliceDetailRows(r: LedgerSlice, data: ProjectSnapshot, width: number, now: number,
  board?: WorkboardSnapshot): MonitorRow[] {
  const plain = (text: string) => boardRow(fit(text, width)), muted = theme.board.muted;
  const s = data.slices.find((x) => x.label === r.id), worker = s?.jobId ? board?.workers.find((w) => w.evidence[0]?.sourceId === s.jobId) : undefined;
  const rows = [...clampLines(ledgerText(r) || r.text, width - 2, Infinity).lines.map((l) => plain('  ' + l)),
    ...diffStatRows(r.state === 'try' ? r.diff : undefined, width)];
  if (worker && s) {
    rows.push(plain(`  ${muted(t('now:'))} ${roleInk(worker.role ?? '')(monitorText(worker.role ?? ''))} ${muted(worker.homeNeedsHuman ? `${t('asking')} ?` : minuteAge(s.at ?? null, now))}`));
    rows.push(...stemLines(workJobDetail(projectWorkJob(worker, now)), width, muted, 3).map(plain));
  } else if (r.commit || r.at !== undefined) rows.push(plain('  ' + muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? new Date(r.at).toISOString().slice(5, 10) : ''].filter(Boolean).join(' · '))));
  return rows;
}
export function progressTaskDetails(task: AcceptanceTask, data: ProjectSnapshot, width: number, now: number,
  board?: WorkboardSnapshot): MonitorRow[] {
  return [...task.slices].sort((a, b) => PROGRESS_ORDER.indexOf(a.state) - PROGRESS_ORDER.indexOf(b.state)).flatMap((r) => {
    const glyph = progressMark(r.state);
    const right = theme.board.muted(t(r.state === 'try' ? 'to try' : r.state));
    return [boardRow(pair(`  ${glyph} ${monitorText(r.id)}`, right, width)), ...sliceDetailRows(r, data, width, now, board)];
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
  return { item: featureItem(feature), text: pair(`  ${mark(open ? '▾' : '▸', open ? 'v' : '>')} ${monitorText(feature.slug)}`, theme.board.muted(right), width) };
}
/** One page: today's section content, without the section header (the crumb names the page). */
export function pageRows(
  page: ProjectPage, data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, worktrees?: WorktreesSnapshot | null
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
      if (folded.has(row.item!.slice('project:fold:'.length))) rows.push(...progressTaskDetails(task, data, width, now, board)
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
    data.editing.forEach((r, i) => item(r, i, theme.board.active(mark('◉', '@'))));
    if (data.last) item({ label: 'last', value: data.last.text, at: data.last.at }, 0);
    // Worktrees with no ledger row, counted on the hub's Working tree row.
    if (unlisted(data).length) rows.push(boardRow(''), section(t('Unlisted worktrees'), width, String(unlisted(data).length)),
      ...unlisted(data).map((r) => boardRow(pair(`  ${theme.board.attention('!')} ${monitorText(r.label)}`, theme.board.muted(t('no linked ticket')), width))));
  } else if (page === 'docs') data.docs.forEach((r, i) => item(r, i));
  if (rows.length === 1) rows.push(boardRow('  ' + theme.board.muted(t('none'))));
  return rows;
}
export function objectiveRows(data: ProjectSnapshot, width: number): MonitorRow[] {
  const record = data.objectives;
  if (!record) return [];
  const rows = [boardRow(''), section(t('Objectives'), width, String(record.objectives.length))];
  const root = dirname(dirname(record.path)), blockedIds = blockedObjectives(data.waiting);
  for (const state of OBJECTIVE_STATES) for (const objective of record.objectives.filter((item) => item.state === state)) {
    const { id, title, result, next, features } = objective;
    const blocked = blockedIds.has(id);
    const at = { item: `project:objective:${root}:${id}`, files: [record.path], objectiveTarget: { root, objective, blocked } };
    const ink = state === 'active' ? theme.board.active : state === 'done' ? theme.board.success : theme.board.muted;
    let status = ink(t(state));
    if (blocked) {
      const reason = theme.board.attention(t('blocked'));
      status = visualLength(status) + visualLength(reason) + 6 <= width ? `${status} · ${reason}` : reason;
    }
    rows.push({ ...at, text: pair(`  ${monitorText(id)}: ${monitorText(title)}`, status, width) });
    if (state === 'done') continue;
    for (const [label, value] of [['Result', result], ['Next', next]] as const) {
      if (!value) continue;
      const text = t('{label}: {value}', { label: t(label), value: monitorText(value) });
      rows.push(...clampClean(text, width - 4, 2).lines.map((line) => ({ ...at, text: fit(`    ${line}`, width) })));
    }
    const checks = [...new Set(features)].flatMap((slug) => {
      const n = record.acceptance[slug];
      return n?.total ? [`${monitorText(slug)} ${n.checked}/${n.total}`] : [];
    }).filter((text) => visualLength(text) <= width - 4);
    for (const line of pack(checks, Math.max(1, width - 2))) rows.push({ ...at, text: fit(`  ${theme.board.muted(line)}`, width) });
  }
  if (record.diagnostics.length) rows.push(boardRow(fit(`  ${theme.board.attention(t('Some objectives could not be read'))}`, width)));
  return rows;
}

/** The Project tab: a hub of one summary row per page, or the page the panel has open. */
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, name = '', projects: ProjectChoice[] = [], worktrees?: WorktreesSnapshot | null
): MonitorRow[] {
  const page = projectPageOf(state);
  // The list reads each project's own overview; the shown project's full snapshot is not needed for it.
  if (projectListOpen(state, projects)) return projectListRows(projects, width, now);
  if (!data) return [];
  return page ? pageRows(page, data, state, width, now, board, worktrees) : projectOverviewRows(data, state, width, now, name, projects);
}

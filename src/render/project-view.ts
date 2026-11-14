/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, SETTLED_JOB_STATES, type SliceState, type ProjectSnapshot, type ProjectItem, type ProjectTicket, type LedgerSlice } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { jobSentenceLine, workCardDetail, labelSummary } from './work-card.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { basename } from 'node:path';
import { boardRow, itemRow, section, mark, minuteAge, kvRows } from './workboard-rows.js';
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
function pack(parts: string[], width: number, max = Infinity): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    if (line && visualLength(line + '  ' + part) > width) { lines.push(line); line = ''; }
    line += '  ' + part;
  }
  if (line) lines.push(line);
  return lines.slice(0, max);
}
const legendItem = (data: ProjectSnapshot, s: SliceState) =>
  sliceInk(s)(`${mark('●', '*')} ${t(s === 'try' ? 'landed, to try' : s)} ${data.counts[s]}`);
const barText = (data: Pick<ProjectSnapshot, 'counts'>, width: number) => progressSegments(data.counts, width).map(({ state, width: cells }) =>
  sliceInk(state)(mark(state === 'todo' || state === 'dropped' ? '░' : state === 'try' ? '▓' : '█', '#').repeat(cells))).join('');
function progressBarRows(data: ProjectSnapshot, width: number): MonitorRow[] {
  const rows: MonitorRow[] = [];
  if (progressSegments(data.counts, width).some((s) => s.width)) rows.push(boardRow(barText(data, width)));
  return [...rows, ...pack(SLICE_STATES.map((s) => legendItem(data, s)), width).map((line) => boardRow(fit(line, width)))];
}
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
/** Only the native-agents list starts folded: a page's own header is its crumb. */
export const projectFoldedSet = (state: MonitorState): ReadonlySet<string> => state.projectFolded ?? new Set(['agents']);
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
  const c = data.counts, tickets = data.tickets.flatMap((f) => f.tickets), g = data.git;
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
  return parts(`${data.roleCount} ${t('roles')}`, data.keys.length && `${t('keys')} ${data.keys.filter((k) => k[1]).length}/${data.keys.length}`,
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
/** The hub: the project's name, what waits for the owner, then one summary row per page. */
function hubRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[]
): MonitorRow[] {
  const folded = projectFoldedSet(state);
  // With more than one project the name row opens the Projects list (Enter or a click); `[` and `]` still step through them.
  const many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.projectRoot));
  const rows: MonitorRow[] = [boardRow(''), {
    ...section(theme.board.title(monitorText(name) || t('Project')), width,
      many ? `${mark('▾', 'v')} ${at + 1}/${projects.length}` : ''),
    ...(many ? { item: 'project:switch' } : {}),
  }];
  if (data.waiting.length) {
    rows.push(foldRow(folded, 'waiting', 'Waiting for you', width, String(data.waiting.length)));
    if (!folded.has('waiting')) data.waiting.forEach((r, i) => rows.push(projectItem(r, i, theme.board.attention('?'), width, now)));
    rows.push(boardRow(''));
  }
  const column = Math.max(...PROJECT_PAGES.map((p) => visualLength(t(PAGE_WORD[p])))) + 1, room = Math.max(1, width - column);
  for (const page of PROJECT_PAGES) {
    // A project with no tickets has no Tickets entry, as it had no empty section before.
    if (page === 'tickets' && !data.tickets?.length) continue;
    const facts = pageSummary(page, data, now);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > room) facts.pop();
    const item = `project:page:${page}`;
    rows.push({ text: fit(`${theme.board.title(fit(t(PAGE_WORD[page]), column))}${facts.join(' · ') || mark('–', '-')}`, width), item });
    // The bar sits under its row and opens the same page.
    const bar = Math.min(width, HOME_BLOCK);
    if (page === 'progress' && progressSegments(data.counts, bar).some((s) => s.width)) rows.push({ text: fit(barText(data, bar), width), item });
  }
  return rows;
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
/** Two rows a project: its name, milestone and what needs you (`?`) or runs (`◉`); then its bar, one key count and the last activity. */
function listRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], cells = Math.max(8, Math.min(24, width - 26));
  for (const { root, name, overview: o } of projectOrder(projects)) {
    const item = `project:list:${root}`, title = monitorText(name), milestone = o?.milestone ? monitorText(o.milestone) : '';
    const marks = [o?.waiting ? theme.board.attention(`? ${o.waiting}`) : '', o?.running ? theme.board.active(`${mark('◉', '@')} ${o.running}`) : '']
      .filter(Boolean).join('  ');
    const fits = milestone && visualLength(title) + 2 + visualLength(milestone) <= width - visualLength(marks) - (marks ? 1 : 0);
    rows.push({ text: pair(theme.board.title(title) + (fits ? '  ' + theme.board.muted(milestone) : ''), marks, width), item });
    const key = !o ? '' : o.counts.try ? sliceInk('try')(t('{n} to try', { n: o.counts.try })) : o.open ? theme.board.muted(t('{n} open', { n: o.open })) : '';
    const body = !o ? theme.board.muted(mark('…', '~')) : !o.hasState ? theme.board.muted(t('no STATE.md'))
      : progressSegments(o.counts, cells).some((s) => s.width) ? barText(o, cells) : '';
    rows.push({ text: pair(`  ${body}${' '.repeat(Math.max(0, cells - visualLength(body)))}${key ? '  ' + key : ''}`, theme.board.muted(sinceText(o?.at, now)), width), item });
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
/** One state's ledger rows by milestone: the newest milestone first, rows with none last, the newest row first in each. */
function ledgerGroups(data: ProjectSnapshot, state: SliceState) {
  const order = milestoneOrder(data), groups = new Map<string, [number, LedgerSlice][]>();
  data.ledger.forEach((r, i) => {
    if (r.state !== state) return;
    const milestone = NO_MILESTONE.test(r.milestone) ? '' : r.milestone;
    const list = groups.get(milestone) ?? [];
    groups.set(milestone, list);
    list.push([i, r]);
  });
  return [...groups].map(([milestone, rows]) => ({ milestone, rows: rows.reverse() }))
    .sort((a, b) => order.indexOf(b.milestone) - order.indexOf(a.milestone));
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
    const head = (label: string, count: number) => rows.push(boardRow(''), section(t(label), width, String(count)));
    const group = (id: string, label: string, count: number, closed: boolean) => rows.push({
      text: pair(`  ${closed ? mark('▸', '>') + ' ' : ''}${label}`, theme.board.muted(String(count)), width), item: `project:fold:${id}` });
    if (!data.statePath) rows.push(boardRow('  ' + theme.board.muted(t('no STATE.md'))));
    else {
      if (data.summary) for (const line of clampLines(data.summary, width - 2, 2).lines) fileRow('  ' + line, 'summary');
      rows.push(...progressBarRows(data, width));
      const ids = milestoneOrder(data), index = ids.indexOf(data.ladder.current ?? '');
      const chips = pack(ids.map((id, i) => {
        const safe = monitorText(id);
        return index < 0 ? safe : i < index ? theme.board.success(`[${safe}]`)
          : i === index ? theme.board.title(`(${safe})`) : theme.board.muted(safe);
      }), width);
      // Too many for two rows: the oldest go, never the current one at the end.
      const kept = chips.slice(-2);
      if (chips.length > 2) kept[0] = kept[0].replace(/^ {2}/, mark('…', '~') + ' ');
      kept.forEach((line) => fileRow(line, 'chips'));
    }
    const jobs = data.active.filter((a) => !data.slices.some((r) => r.jobId === a.jobId));
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
    data.next.forEach((r, i) => {
      const id = `next:${i}`, clip = clampLines(r.value, width - 4, 2);
      // Folded to two rows; Enter shows the rest. A bullet that fits has nothing to show and opens STATE.md.
      for (const [k, line] of (folded.has(id) ? clampLines(r.value, width - 4, Infinity) : clip).lines.entries()) rows.push({
        text: fit(`${k ? '    ' : `  ${mark('→', '>')} `}${line}`, width),
        ...(clip.more ? { item: `project:fold:${id}` } : r.path ? { item: `project:file:${r.path}:${id}` } : {}),
        ...(r.path ? { files: [r.path] } : {}),
      });
    });
    const tries = ledgerGroups(data, 'try'), done = ledgerGroups(data, 'accepted');
    for (const [title, state, groups] of [['To try', 'try', tries], ['Done', 'accepted', done]] as const) {
      if (groups.length) head(title, groups.reduce((n, g) => n + g.rows.length, 0));
      for (const [gi, g] of groups.entries()) {
        // Membership toggles the default: To try opens its newest milestone, Done opens none.
        const id = `${state === 'try' ? 'try' : 'done'}:${g.milestone}`, closed = folded.has(id) !== (state === 'try' ? gi > 0 : true);
        group(id, g.milestone ? monitorText(g.milestone) : t('other'), g.rows.length, closed);
        if (closed) continue;
        for (const [i, r] of g.rows) {
          const date = r.at !== undefined ? dateText(r.at, now) : '';
          const meta = state === 'try' ? [date, r.commit?.slice(0, 7)].filter(Boolean).join(' ') : '';
          const lines = state === 'try'
            ? stacked(`    ${theme.board.title(monitorText(r.id))}${meta ? theme.board.muted(' · ' + meta) : ''}`, ledgerText(r), '', width, 6, 2, false)
            : stacked(`    ${monitorText(r.id)}`, ledgerText(r), theme.board.muted(date), width, 6);
          for (const line of lines) fileRow(line, `${state}:${i}`);
        }
      }
    }
  } else if (page === 'tickets') {
    for (const feature of data.tickets ?? []) {
      const done = feature.tickets.filter((r) => r.state === 'done').length, id = `tickets:${feature.slug}`;
      // Membership toggles the default: completed features start folded, others open.
      const closed = folded.has(id) !== (done === feature.tickets.length);
      const count = width < 56 ? `${done}/${feature.tickets.length}` : t('{done}/{total} done', { done, total: feature.tickets.length });
      rows.push({ text: pair(`  ${closed ? mark('▸', '>') + ' ' : ''}${monitorText(feature.slug)}`,
        `${meter(done, feature.tickets.length, width < 56 ? 6 : 10)} ${theme.board.muted(count)}`, width), item: `project:fold:${id}` });
      if (closed) continue;
      for (const ticket of feature.tickets) {
        const job = ticket.job, dropped = ticket.state === 'dropped';
        const literal = /^(needs-triage|needs-info|ready-for-human)$/i.test(ticket.status);
        const ink = ticket.state === 'done' ? theme.board.success : dropped || ticket.state === 'blocked' ? theme.board.muted : theme.board.active;
        const glyph = ticket.state === 'done' ? mark('✓', '+') : dropped ? mark('–', '-') : ticket.state === 'blocked' ? mark('○', 'o') : ticketWorking(ticket) ? mark('◐', '@') : mark('●', '*');
        const status = ticket.state === 'blocked' ? t('blocked by {tickets}', { tickets: monitorText(ticket.blockers.join(', ')) })
          : literal ? monitorText(ticket.status) : t(ticket.state);
        const unknown = !/^(done|closed|complete|resolved|wontfix|claimed|needs-triage|needs-info|ready-for-human|ready-for-agent)$/i.test(ticket.status);
        const jobText = job ? [monitorText(job.role), monitorText(t(job.state)), minuteAge(job.at ?? null, now)].filter(Boolean).join(' ') : '';
        const detail = [status, unknown ? monitorText(ticket.status) : '', jobText && width >= 64 ? jobText : ''].filter(Boolean).join(' · ');
        const total = `${ticket.checked}/${ticket.total}`, room = Math.max(1, width - visualLength(total) - 2);
        const left = `    ${ink(glyph)} ${dropped ? theme.board.muted(monitorText(ticket.number + ' ' + ticket.title)) : monitorText(ticket.number + ' ' + ticket.title)}`;
        // A title the status would cut keeps its own row; the status goes under it.
        const long = visualLength(left) + 1 + visualLength(detail) > room;
        const tid = `ticket:${feature.slug}:${basename(ticket.path)}`, at = { item: `project:fold:${tid}`, files: [ticket.path] };
        rows.push({ text: long ? pair(left, theme.board.muted(total), width)
          : pair(pair(left, theme.board.muted(detail), room), theme.board.muted(total), width), ...at });
        if (long) rows.push({ text: fit('      ' + theme.board.muted(detail), width), ...at });
        // Enter on a ticket shows what is checked and the latest comment here; o opens the file.
        if (!folded.has(tid)) continue;
        const sub = (text: string) => rows.push({ text: fit(text, width), ...at });
        for (const item of ticket.items) clampLines(item.text, width - 8, 2).lines.forEach((line, k) => sub(
          `      ${k ? '  ' : (item.done ? theme.board.success(mark('✓', '+')) : theme.board.muted(mark('○', 'o'))) + ' '}${line}`));
        if (!ticket.items.length) sub('      ' + theme.board.muted(t('no checklist')));
        if (ticket.comment) {
          const label = fit(t('comment'), 9);
          clampLines(ticket.comment, width - 6 - visualLength(label), 4).lines.forEach((line, k) =>
            sub(`      ${k ? ' '.repeat(visualLength(label)) : theme.board.muted(label)}${line}`));
        }
      }
    }
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
    data.control.forEach((r, i) => item(r.label === 'convention'
      ? { ...r, value: t(r.value) + ' · ' + basename(r.path!) } : r, i));
    rows.push(foldRow(folded, 'agents', 'agents', width, String(data.agents.length)));
    if (!folded.has('agents')) data.agents.forEach((r, i) => item(r, i));
    rows.push(...kvRows('keys', data.keys.map(([name, present]) =>
      `${name} ${mark(present ? '✓' : '−', present ? '+' : '-')}`).join('  '), width));
    item({ label: 'browser', value: mark(data.browser ? '✓' : '−', data.browser ? '+' : '-') }, 0);
  }
  if (rows.length === 1) rows.push(boardRow('  ' + theme.board.muted(t('none'))));
  return rows;
}
/** The Project tab: a hub of one summary row per page, or the page the panel has open. */
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false, name = '', projects: ProjectChoice[] = []
): MonitorRow[] {
  const page = projectPageOf(state);
  // The list reads each project's own overview; the shown project's full snapshot is not needed for it.
  if (projectListOpen(state, projects)) return listRows(projects, width, now);
  if (!data) return [];
  return page ? pageRows(page, data, state, width, now, board, modelEnabled) : hubRows(data, state, width, now, name, projects);
}

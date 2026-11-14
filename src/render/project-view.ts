/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, type SliceState, type ProjectSnapshot, type ProjectItem, type ProjectTicket } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { jobSentenceLine, workCardDetail, labelSummary } from './work-card.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { basename } from 'node:path';
import { boardRow, itemRow, section, mark, minuteAge, kvRows } from './workboard-rows.js';
import { monitorText, fit, pair } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
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
const barText = (data: ProjectSnapshot, width: number) => progressSegments(data.counts, width).map(({ state, width: cells }) =>
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
const SETTLED = ['done', 'closed', 'complete', 'failed', 'stopped', 'idle_grace'];
const ticketWorking = (r: ProjectTicket) => !['done', 'dropped', 'blocked'].includes(r.state)
  && (r.state === 'working' || (!!r.job && !SETTLED.includes(r.job.state)));
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
/** `Project › Page` for the sub-page title row, with the page's own facts on the right when there is room. */
export function projectCrumb(page: ProjectPage, data: ProjectSnapshot | undefined, width: number, now: number) {
  const crumb = `${t('Project')} ${mark('›', '>')} ${t(PAGE_WORD[page])}`;
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
    g?.ahead && `${g.ahead} ${t('ahead')}`, g?.behind && `${g.behind} ${t('behind')}`,
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
function hubRows(data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string): MonitorRow[] {
  const folded = projectFoldedSet(state);
  const rows: MonitorRow[] = [boardRow(''), section(theme.board.title(monitorText(name) || t('Project')), width)];
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
    if (data.summary) fileRow(`  ${monitorText(data.summary)}`, 'summary');
    rows.push(...progressBarRows(data, width));
    const { ids, current } = data.ladder, index = ids.indexOf(current ?? '');
    for (const [i, line] of pack(ids.map((id, i) => {
      const safe = monitorText(id);
      return index < 0 ? safe : i < index ? theme.board.success(`[${safe}]`)
        : i === index ? theme.board.title(`(${safe})`) : theme.board.muted(safe);
    }), width, 2).entries()) fileRow(line, `chips:${i}`);
    for (const [i, r] of data.slices.entries()) {
      const path = r.path ?? data.statePath;
      const reason = r.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(r.ledgerState ?? '')) })
        : r.drift ? t(r.drift) : '';
      const glyph = r.drift ? theme.board.attention('!') : r.ledgerState === 'blocked'
        ? sliceInk('blocked')(mark('◆', '!')) : sliceInk('working')(mark('◐', '@'));
      fileRow(pair(`  ${glyph} ${monitorText(r.label)}${r.value ? '  ' + monitorText(r.value) : ''}`,
        reason ? theme.board.attention(reason) : '', width), `slice:${i}`, path);
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
    data.next.slice(0, 4).forEach((r, i) => fileRow(
      `${i ? ' '.repeat(13) : `${mark('→', '>')} ${fit(t('next'), 10)} `}${monitorText(r.value)}`, `next:${i}`, r.path));
    if (data.next.length > 4) rows.push(boardRow(fit(`${' '.repeat(13)}+${data.next.length - 4}`, width)));
  } else if (page === 'tickets') {
    for (const feature of data.tickets ?? []) {
      const done = feature.tickets.filter((r) => r.state === 'done').length, id = `tickets:${feature.slug}`;
      // Membership toggles the default: completed features start folded, others open.
      const closed = folded.has(id) !== (done === feature.tickets.length);
      rows.push({ text: pair(`  ${closed ? mark('▸', '>') + ' ' : ''}${monitorText(feature.slug)}`,
        theme.board.muted(t('{done}/{total} done', { done, total: feature.tickets.length })), width), item: `project:fold:${id}` });
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
        const count = `${ticket.checked}/${ticket.total}`, room = Math.max(1, width - visualLength(count) - 2);
        rows.push({ text: pair(pair(`    ${ink(glyph)} ${dropped ? theme.board.muted(monitorText(ticket.number + ' ' + ticket.title)) : monitorText(ticket.number + ' ' + ticket.title)}`,
          theme.board.muted(detail), room), theme.board.muted(count), width),
          item: `project:file:${ticket.path}:ticket`, files: [ticket.path] });
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
  board?: WorkboardSnapshot, modelEnabled = false, name = ''
): MonitorRow[] {
  const page = projectPageOf(state);
  if (!data) return [];
  return page ? pageRows(page, data, state, width, now, board, modelEnabled) : hubRows(data, state, width, now, name);
}

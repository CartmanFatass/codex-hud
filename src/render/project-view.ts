/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, type SliceState, type ProjectSnapshot, type ProjectItem } from '../collectors/project-board.js';
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
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false
): MonitorRow[] {
  if (!data) return [];
  const rows: MonitorRow[] = [boardRow('')], folded = state.projectFolded ?? new Set(['control', 'agents']);
  const header = (id: string, label: string, right = '') => {
    rows.push({
      ...section(`${folded.has(id) ? mark('▸', '>') + ' ' : ''}${t(label)}`, width, right),
      item: `project:fold:${id}`,
    });
    return !folded.has(id);
  };
  const item = (r: ProjectItem, i: number, glyph = '') => {
    const left = `${r.label ? fit(t(r.label), 10) + ' ' : ''}${monitorText(r.value)}`;
    const right = width < 56 ? '' : r.at !== undefined ? minuteAge(r.at, now)
      : r.path ? monitorText(basename(r.path)) : '';
    rows.push({
      ...itemRow(glyph, left, right, width),
      ...(r.path ? { item: `project:file:${r.path}:${i}`, files: [r.path] } : {}),
    });
  };
  if (data.waiting.length) {
    if (header('waiting', 'Waiting for you', String(data.waiting.length)))
      data.waiting.forEach((r, i) => item(r, i, theme.board.attention('?')));
    rows.push(boardRow(''));
  }
  let updated = '';
  if (data.updatedAt !== undefined) {
    const at = new Date(data.updatedAt), today = new Date(now);
    const time = at.toDateString() === today.toDateString()
      ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    updated = t('updated {time}', { time });
  }
  const drift = data.slices.filter((r) => r.drift).length;
  if (header('progress', 'Progress', [updated, drift ? theme.board.attention(`! ${drift}`) : ''].filter(Boolean).join(' · '))) {
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
  }
  rows.push(boardRow(''));
  if (data.tickets?.length) {
    if (header('tickets', 'Tickets', t('{features} features · {tickets} tickets', {
      features: data.tickets.length, tickets: data.tickets.reduce((n, f) => n + f.tickets.length, 0),
    }))) for (const feature of data.tickets) {
      const done = feature.tickets.filter((r) => r.state === 'done').length, id = `tickets:${feature.slug}`;
      // Membership toggles the default: completed features start folded, others open.
      const closed = folded.has(id) !== (done === feature.tickets.length);
      rows.push({ text: pair(`  ${closed ? mark('▸', '>') + ' ' : ''}${monitorText(feature.slug)}`,
        theme.board.muted(t('{done}/{total} done', { done, total: feature.tickets.length })), width), item: `project:fold:${id}` });
      if (closed) continue;
      for (const ticket of feature.tickets) {
        const job = ticket.job, working = job && !['done', 'closed', 'complete', 'failed', 'stopped', 'idle_grace'].includes(job.state);
        const dropped = ticket.state === 'dropped', literal = /^(needs-triage|needs-info|ready-for-human)$/i.test(ticket.status);
        const ink = ticket.state === 'done' ? theme.board.success : dropped || ticket.state === 'blocked' ? theme.board.muted : theme.board.active;
        const glyph = ticket.state === 'done' ? mark('✓', '+') : dropped ? mark('–', '-') : ticket.state === 'blocked' ? mark('○', 'o') : ticket.state === 'working' || working ? mark('◐', '@') : mark('●', '*');
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
    rows.push(boardRow(''));
  }
  if (header('tree', 'Working tree')) {
    if (data.git) item({ label: 'branch', value: [
      data.git.branch, t('{n} changed', { n: data.git.changed }),
      data.git.ahead === null ? '' : `${data.git.ahead} ${t('ahead')}`,
      data.git.behind ? `${data.git.behind} ${t('behind')}` : '',
    ].filter(Boolean).join(' · ') }, 0);
    data.editing.forEach((r, i) => item(r, i, theme.board.active(mark('◉', '@'))));
    if (data.last) item({ label: 'last', value: data.last.text, at: data.last.at }, 0);
  }
  rows.push(boardRow(''));
  if (header('docs', 'Docs')) data.docs.forEach((r, i) => item(r, i));
  rows.push(boardRow(''));
  if (header('control', 'Control plane', `${data.roleCount} ${t('roles')} · ${data.agents.length} ${t('agents')}`)) {
    data.control.forEach((r, i) => item(r.label === 'convention'
      ? { ...r, value: t(r.value) + ' · ' + basename(r.path!) } : r, i));
    if (header('agents', 'agents', String(data.agents.length))) data.agents.forEach((r, i) => item(r, i));
    rows.push(...kvRows('keys', data.keys.map(([name, present]) =>
      `${name} ${mark(present ? '✓' : '−', present ? '+' : '-')}`).join('  '), width));
    item({ label: 'browser', value: mark(data.browser ? '✓' : '−', data.browser ? '+' : '-') }, 0);
  }
  return rows;
}

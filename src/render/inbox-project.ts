/**
 * Project Inbox (PROJECT-UX direction C):
 * Ranked Needs you, Running, last accepted, page links and the accept-all action on the hub.
 * Needs you / Running / Quiet on the Projects list.
 * Role alerts link to Control. Pure.
 */
import type { ActiveJob, ProjectSnapshot } from '../collectors/project-board.js';
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import {
  PAGE_WORD, PROJECT_PAGES, acceptedText, asksYou, barText, clampClean, clampLines,
  currentRows, featureCodes, inFlight, landedNewest, pageRows, pageSummary, progressSegments, projectOrder,
  sinceText, sliceInk, ticketPreview, projectOriginal, tryCount, unlisted, unsliced, waitingRows, type ProjectPage,
} from './project-view.js';
import { glyph, roleName } from './control-view.js';
import { HUB_HINTS, inboxRolePreview, slicePreview, type Part, type Shown } from './split-project.js';
import { jobTitle, roleInk } from './work-job-row.js';
import { sonicBadge, sonicChildrenRunning } from './worker-roster.js';
import { boardRow, mark, minuteAge, section } from './workboard-rows.js';
import { cutWords, fit, monitorText, pair } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { basename } from 'node:path';
import { t } from './i18n.js';

const muted = (text: string) => theme.board.muted(text);
const NEEDS_CAP = 7;
const bare = (rows: MonitorRow[]): MonitorRow[] => rows.map(({ item: _i, files: _f, ...row }) => row);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const cutText = (b: string, room: number) => room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room);
const cutProse = (text: string, room: number) => cutText(monitorText(text), room);
const cutId = (text: string, room: number) => { const b = monitorText(text); return room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room) || truncateAnsi(b, room); };
const mins = (until: number, now: number) => t('{n}m', { n: Math.max(1, Math.ceil((until - now) / 60000)) });
export const ACCEPT_ALL = 'project:accept-all';
const acceptAllRow = (data: ProjectSnapshot, width: number): MonitorRow[] => {
  const n = tryCount(data);
  if (!n) return [];
  const label = t('Accept all'), count = t('{n} to try', { n });
  const partial = data.ticketTotals?.partial ? t('Partial') : '';
  const facts = [partial, count].filter(Boolean).join(' · ');
  const right = [facts, partial].find((text) => visualLength(label) + 1 + visualLength(text) <= width) ?? '';
  return [{ item: ACCEPT_ALL, text: pair(theme.board.active(label), muted(right), width) }];
};
const workerOf = (jobId: string | undefined, board?: WorkboardSnapshot) => jobId ? board?.workers.find((w) => w.evidence[0]?.sourceId === jobId) : undefined;
const sliceAsking = (s: ProjectSnapshot['slices'][number], board?: WorkboardSnapshot) => workerOf(s.jobId, board)?.homeNeedsHuman ?? !!s.asking;
const jobAsking = (j: ActiveJob, board?: WorkboardSnapshot) => workerOf(j.jobId, board)?.homeNeedsHuman ?? j.asking;

/** A job's row: role, title (the ticket's heading when the board knows the job, as on Home), then `⚡N` for its running sonic children and its age. */
function unslicedRow(job: ActiveJob, width: number, now: number, selectable = false, worker?: OwnerWorker, sonic = 0): MonitorRow {
  const lead = `  ${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}`;
  const right = job.asking ? theme.board.attention(`${t('asking')} ?`) : [sonicBadge(sonic), muted(minuteAge(job.at ?? null, now))].filter(Boolean).join(' ');
  const title = cutText((worker && jobTitle(worker, false)) || monitorText(job.title ?? job.package ?? ''), width - visualLength(lead) - 2 - visualLength(right) - 1);
  return { text: pair(lead + (title ? '  ' + muted(title) : ''), right, width), ...(selectable ? { item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}) } : {}) };
}

type NeedEntry = { rows: MonitorRow[]; askTarget?: string };
/** Ranked Needs-you entries: asking jobs, STATE waiting items, asking tickets, blocked slices, roles at limit. */
function buildNeeds(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, mode: 'classic' | 'split',
  board?: WorkboardSnapshot,
): NeedEntry[] {
  const out: NeedEntry[] = [], path = data.statePath, files = path ? { files: [path] } : {};
  const asking = new Set<string>();
  for (const s of inFlight(data)) if (sliceAsking(s, board)) {
    asking.add(s.label);
    out.push({
      askTarget: `project:slice:${s.label}`,
      rows: [{ item: `inbox:ask:${s.jobId ?? s.label}`, ...(s.path ? { files: [s.path] } : {}), text: pair(`  ${theme.board.attention('?')} ${monitorText(s.label)}`, theme.board.attention(t('asking')), width) }],
    });
  }
  for (const job of unsliced(data)) if (jobAsking(job, board)) {
    const lead = `  ${theme.board.attention('?')} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}`, right = theme.board.attention(t('asking'));
    const title = cutProse(job.title ?? job.package ?? '', width - visualLength(lead) - 2 - visualLength(right) - 1);
    out.push({ askTarget: `project:job:${job.jobId}`, rows: [{ item: `inbox:ask:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}), text: pair(lead + (title ? '  ' + muted(title) : ''), right, width) }] });
  }
  for (const [i, r] of data.waiting.entries()) {
    const item = `project:wait:${i}`, lines = clampClean(monitorText(r.value), width - 4, mode === 'classic' && state.project.nav.cursor === item ? Infinity : 1).lines;
    out.push({ rows: [...lines.map((l, k) => ({ item, ...(r.path ? { files: [r.path] } : files), text: fit(`${k ? '    ' : `  ${theme.board.attention('?')} `}${l}`, width) })),
      ...(mode === 'classic' ? projectOriginal(r.original, `wait:${i}`, state.project.folded, width) : [])] });
  }
  const features = data.tickets ?? [], codes = featureCodes(features), shownTickets = new Set<string>();
  for (const f of features) for (const tk of f.tickets.filter(asksYou)) {
    shownTickets.add(tk.path);
    const right = theme.board.attention(monitorText(t(tk.status))), prefix = `  ${theme.board.attention('?')} ${muted(codes.get(f.slug)!)} ${monitorText(tk.number)} `;
    const key = `${f.slug}:${basename(tk.path)}`;
    out.push({ rows: [{ item: `inbox:tk:${key}`, files: [tk.path], text: pair(prefix + cutProse(tk.title, width - visualLength(prefix) - visualLength(right) - 1), right, width) },
      ...(mode === 'classic' ? projectOriginal(tk.originalTitle, `ticket:${key}`, state.project.folded, width) : [])] });
  }
  for (const r of data.ledger.filter((s) => s.state === 'blocked' && !asking.has(s.id) && !(s.path && shownTickets.has(s.path)))) {
    const item = mode === 'split' ? `project:slice:${r.id}` : r.path ? `project:file:${r.path}:slice:${r.id}` : undefined;
    out.push({ rows: [{ ...(item ? { item } : {}), ...(r.path ? { files: [r.path] } : {}), text: pair(`  ${sliceInk('blocked')(mark('◆', '!'))} ${monitorText(r.id)}`, sliceInk('blocked')(t('blocked')), width) }] });
  }
  for (const role of data.roles) {
    const dead = role.places.find((p) => p.state === 'exhausted');
    if (!dead) continue;
    const tag = theme.board.attention(`${t('{place} out', { place: monitorText(dead.label) })}${dead.until === undefined ? '' : ' ' + mins(dead.until, now)}`);
    out.push({ rows: [{ item: `inbox:role:${role.role}`, files: [role.path], text: pair(`  ${glyph('exhausted')} ${monitorText(roleName(role))}`, tag, width) }] });
  }
  return out;
}
function needsBlock(needs: NeedEntry[], expanded: boolean, cap: number, data: ProjectSnapshot, width: number): MonitorRow[] {
  const shown = expanded ? needs : needs.slice(0, cap), more = needs.length - shown.length;
  const tail = more > 0 ? [{ item: 'project:fold:inbox:more', text: fit(`  ${muted(`${mark('▸', '>')} ${t('{n} more', { n: more })}`)}`, width) }]
    : expanded && needs.length > NEEDS_CAP ? [{ item: 'project:fold:inbox:more', text: fit(`  ${muted(`${mark('▾', 'v')} ${t('fewer')}`)}`, width) }] : [];
  return [section(t('Needs you'), width, String(data.waiting.length)), ...(needs.length ? [...shown.flatMap((n) => n.rows), ...tail] : [plain('  ' + muted(t('Nothing needs you')), width)])];
}
/** One row per running job: slices and worktrees are not rows, and a sonic child folds into its running parent's `⚡N`, as on Home. */
function runningRows(data: ProjectSnapshot, width: number, now: number, selectable: boolean, board?: WorkboardSnapshot): MonitorRow[] {
  const parents = new Set(data.active.flatMap((j) => workerOf(j.jobId, board)?.id ?? []));
  return data.active.flatMap((j) => {
    const worker = workerOf(j.jobId, board);
    if (jobAsking(j, board) || (worker?.parentJobId && parents.has(worker.parentJobId))) return [];
    return [unslicedRow(j, width, now, selectable, worker, worker && board ? sonicChildrenRunning(board.workers, worker.id) : 0)];
  });
}
function lastAcceptedRow(data: ProjectSnapshot, width: number, now: number, selectable = false): MonitorRow | undefined {
  const last = landedNewest(data).find(({ r }) => r.state === 'accepted')?.r;
  if (!last) return undefined;
  const head = `  ${sliceInk('accepted')(mark('✓', '+'))} ${muted(t('last accepted'))} ${monitorText(last.id)}`, age = muted(sinceText(last.at, now));
  const text = visualLength(head) + (age ? 1 + visualLength(age) : 0) <= width ? fit(`${head}${age ? ' ' + age : ''}`, width) : pair(head, age, width);
  return { text, ...(selectable ? { item: `project:slice:${last.id}`, ...(last.path ? { files: [last.path] } : {}) } : {}) };
}
function hubPageRows(data: ProjectSnapshot, width: number, now: number, withMarks: boolean): MonitorRow[] {
  const cur = currentRows(data), tickets = data.tickets.flatMap((f) => f.tickets);
  const shown = PROJECT_PAGES.filter((p) => p !== 'tickets' || data.tickets?.length);
  const col = Math.max(...shown.map((p) => visualLength(t(PAGE_WORD[p])))) + 1, space = Math.max(1, width - col - (withMarks ? 2 : 0));
  const markOf = (page: ProjectPage) => !withMarks ? '' : (page === 'progress' && cur.counts.working ? theme.board.active(mark('◐', '@'))
    : (page === 'tickets' && tickets.some(asksYou)) || (page === 'tree' && unlisted(data).length) ? theme.board.attention(page === 'tickets' ? '?' : '!')
    : page === 'tree' || page === 'docs' ? ' ' : muted(mark('○', 'o'))) + ' ';
  return shown.map((page) => {
    const facts = pageSummary(page, data, now, !withMarks);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > space) facts.pop();
    return { item: `project:page:${page}`, text: fit(`${markOf(page)}${theme.board.title(fit(t(PAGE_WORD[page]), col))}${facts.join(' · ') || mark('–', '-')}`, width) };
  });
}

/** Inbox Hub (Classic): Needs you (ranked, capped with `▸ N more`), Running + `last accepted`, page rows. */
export function inboxHubRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[],
  board?: WorkboardSnapshot, room?: number,
): MonitorRow[] {
  const expanded = state.project.folded.has('inbox:more'), many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const top: MonitorRow[] = [boardRow(''), { ...section(theme.board.title(monitorText(name) || t('Project')), width, many ? `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}` : ''), ...(many ? { item: 'project:switch' } : {}) }];
  const needs = buildNeeds(data, state, width, now, 'classic', board), live = runningRows(data, width, now, false, board), last = lastAcceptedRow(data, width, now);
  const pages = hubPageRows(data, width, now, false), accept = acceptAllRow(data, width);
  const build = (cap: number, runCap: number, showLast: boolean, gaps: boolean) => [
    ...top, ...needsBlock(needs, expanded, cap, data, width), boardRow(''),
    section(t('Running'), width, live.length ? String(live.length) : ''),
    ...(live.length ? live.slice(0, runCap) : [boardRow('  ' + muted(t('Nothing in progress')))]),
    ...(showLast && last ? [last] : []), boardRow(''), ...pages, ...accept,
  ].filter((r) => gaps || r.text !== '' || r.item);
  const tiers: [number, number, boolean, boolean][] = [
    [NEEDS_CAP, live.length, true, true], [NEEDS_CAP, live.length, false, true], [NEEDS_CAP, Math.min(2, live.length), false, true],
    [4, Math.min(2, live.length), false, true], [4, Math.min(2, live.length), false, false],
  ];
  for (const [cap, runCap, showLast, gaps] of tiers) {
    const rows = build(cap, runCap, showLast, gaps);
    if (room === undefined || rows.length <= room) return rows;
  }
  return build(4, Math.min(2, live.length), false, false);
}

/** Inbox Hub (Split): Needs you + Running + `last accepted` + page rows in the list; selected row explained in the preview. */
export function inboxHubPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const projects = input.projects ?? [], many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const folded = state.project.folded, expanded = folded.has('inbox:more');
  const name: MonitorRow = {
    ...section(theme.board.title(monitorText(input.projectName ?? '') || t('Project')), width,
      [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
    ...(many ? { item: 'project:switch' } : {}),
  };
  const needs = buildNeeds(data, state, width, now, 'split', board), live = runningRows(data, width, now, true, board), last = lastAcceptedRow(data, width, now, true);
  const list = [
    name, boardRow(''), ...needsBlock(needs, expanded, NEEDS_CAP, data, width), boardRow(''),
    section(t('Running'), width, live.length ? String(live.length) : ''), ...(live.length ? live : [plain('  ' + muted(t('Nothing in progress')), width)]), ...(last ? [last] : []),
    boardRow(''), ...hubPageRows(data, width, now, true), ...acceptAllRow(data, width),
  ];
  const preview = (cursor?: string): Shown => {
    if (cursor === ACCEPT_ALL) return { label: t('Accept all'), rows: [], hints: ['⏎ accept all', '[ ] project'] };
    const waitMatch = /^project:wait:(\d+)$/.exec(cursor ?? '');
    if (waitMatch) {
      const i = Number(waitMatch[1]), r = data.waiting[i];
      return { label: t('Waiting for you'), right: String(data.waiting.length), rows: r ? [...bare(waitingRows(r, i, width, now, Infinity)), ...projectOriginal(r.original, `wait:${i}`, folded, width)] : [] };
    }
    if (cursor?.startsWith('inbox:ask:')) {
      const target = needs.find((n) => n.rows[0]?.item === cursor)?.askTarget;
      if (target) return slicePreview(input, data, board, width, now, target);
    }
    const tkKey = /^inbox:tk:(.+)$/.exec(cursor ?? '')?.[1];
    if (tkKey) {
      const ticket = data.tickets.flatMap((f) => f.tickets.map((x) => ({ x, key: `${f.slug}:${basename(x.path)}` }))).find((o) => o.key === tkKey)?.x;
      if (!ticket) return { label: '', rows: [] };
      const rows = ticketPreview(data, tkKey, folded, width, now);
      return { label: monitorText(`${ticket.number} ${ticket.title}`), right: monitorText(t(ticket.status)), rows, hints: ['⏎ open file', '[ ] project'] };
    }
    const roleId = /^inbox:role:(.+)$/.exec(cursor ?? '')?.[1];
    if (roleId) {
      const shownRole = inboxRolePreview(data, width, now)(`project:role:${roleId}`);
      return { ...shownRole, rows: bare(shownRole.rows), hints: ['o file', '⏎ Control', '[ ] project'] };
    }
    if (cursor === 'project:fold:inbox:more') return { label: t('Needs you'), right: String(data.waiting.length), rows: bare(needs.slice(NEEDS_CAP).flatMap((n) => n.rows)) };
    if (cursor?.startsWith('project:slice:') || cursor?.startsWith('project:job:')) return slicePreview(input, data, board, width, now, cursor);
    const page = /^project:page:(.+)$/.exec(cursor ?? '')?.[1] as ProjectPage | undefined;
    if (page && page !== 'progress') {
      const facts = page === 'tree' ? { ...data, gitDiff: undefined } : data;
      return { label: t(PAGE_WORD[page]), rows: bare(pageRows(page, facts, state, width, now, board, input.modelEnabled).slice(1)) };
    }
    const cur = currentRows(data), cells = Math.max(6, Math.min(60, width - 16));
    const rows: MonitorRow[] = [
      ...(data.summary ? clampLines(data.summary, width - 2, 2).lines.map((l) => plain('  ' + l, width)) : []),
      ...(progressSegments(cur.counts, cells).some((s) => s.width) ? [plain(`  ${barText({ counts: cur.counts }, cells)} ${muted(acceptedText(cur.counts, cur.rows.length))}`, width)] : []),
      ...(live.length ? [boardRow(''), plain(muted(t('Running')), width), ...bare(live)] : []), ...(last ? [plain(last.text, width)] : []),
    ];
    return { label: t('Progress'), rows };
  };
  return {
    list, preview, start: list.find((r) => r.item && r.item !== 'project:switch')?.item ?? list.find((r) => r.item)?.item,
    hints: HUB_HINTS,
  };
}

/** Inbox Projects list: grouped into Needs you, Running and Quiet (a quiet project is one row). */
export function inboxListRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
  const pendingOf = (p: ProjectChoice) => p.overview?.counts.try ?? 0;
  const ordered = projectOrder(projects), needs = ordered.filter((p) => (p.overview?.waiting ?? 0) > 0 || pendingOf(p) > 0);
  const running = ordered.filter((p) => !needs.includes(p) && (p.overview?.running ?? 0) > 0), quiet = ordered.filter((p) => !needs.includes(p) && !running.includes(p));
  const rows: MonitorRow[] = [boardRow('')], gap = () => { if (rows.length > 1) rows.push(boardRow('')); };
  const headRow = (p: ProjectChoice, right: string): MonitorRow => {
    const ms = p.overview?.milestone ? monitorText(p.overview.milestone) : '', max = Math.max(1, width - (right ? visualLength(right) + 1 : 0)), title = cutId(p.name, max);
    return { item: `project:list:${p.root}`, text: pair(theme.board.title(title) + (ms && visualLength(title) + 2 + visualLength(ms) <= max ? '  ' + muted(ms) : ''), right, width) };
  };
  if (needs.length) {
    rows.push(section(t('Needs you'), width, String(needs.length)));
    for (const p of needs) {
      const o = p.overview!, item = `project:list:${p.root}`, age = muted(sinceText(o.at, now)), pending = pendingOf(p);
      rows.push(headRow(p, o.waiting ? theme.board.attention(t('{n} waiting', { n: o.waiting })) : sliceInk('try')(t('{n} to try', { n: pending }))));
      const parts = [o.waiting && pending ? sliceInk('try')(t('{n} to try', { n: pending })) : '', o.running ? theme.board.active(t('{n} running', { n: o.running })) : '', !pending && !o.running && o.open ? muted(t('{n} open', { n: o.open })) : ''].filter(Boolean);
      while (parts.length > 1 && visualLength('  ' + parts.join(' · ')) + (age ? visualLength(age) + 1 : 0) > width) parts.pop();
      rows.push({ item, text: pair(parts.length ? '  ' + parts.join(muted(' · ')) : '', age, width) });
    }
  }
  if (running.length) {
    gap();
    rows.push(section(t('Running'), width, String(running.length)));
    for (const p of running) {
      const o = p.overview!, item = `project:list:${p.root}`;
      rows.push(headRow(p, theme.board.active(`${mark('◉', '@')} ${o.running}`)), { item, text: pair('  ' + theme.board.active(t('{n} running', { n: o.running })), muted(sinceText(o.at, now)), width) });
    }
  }
  if (quiet.length) {
    gap();
    rows.push(section(t('Quiet'), width, String(quiet.length)));
    for (const p of quiet) {
      const o = p.overview, age = muted(sinceText(o?.at, now)), tag = !o ? muted(mark('…', '~')) : !o.hasState ? muted(t('no STATE.md')) : o.milestone ? muted(monitorText(o.milestone)) : '';
      const room = Math.max(1, width - 2 - (age ? visualLength(age) + 1 : 0) - (tag ? visualLength(tag) + 2 : 0));
      rows.push({ item: `project:list:${p.root}`, text: pair(`  ${theme.board.title(cutId(p.name, room))}${tag ? '  ' + tag : ''}`, age, width) });
    }
  }
  return rows;
}

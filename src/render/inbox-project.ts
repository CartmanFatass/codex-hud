/**
 * Project Inbox (PROJECT-UX direction C):
 * Ranked Needs you, Running, last accepted and page links on the hub.
 * Needs you / Running / Quiet on the Projects list.
 * Role alerts link to Control. Pure.
 */
import type { ActiveJob, ProjectSnapshot } from '../collectors/project-board.js';
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import {
  PAGE_WORD, PROJECT_PAGES, asksYou, clampClean,
  featureCodes, inFlight, landedNewest, pageSummary, projectOrder,
  sinceText, sliceInk, projectOriginal, unsliced,
} from './project-view.js';
import { glyph, roleName } from './control-view.js';
import { jobTitle, roleInk } from './work-job-row.js';
import { sonicBadge, sonicChildrenRunning } from './worker-roster.js';
import { boardRow, mark, minuteAge, section } from './workboard-rows.js';
import { cutWords, fit, monitorText, pair } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { basename } from 'node:path';
import { t } from './i18n.js';

const muted = (text: string) => theme.board.muted(text);
const NEEDS_CAP = 7;
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const cutText = (b: string, room: number) => room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room);
const cutProse = (text: string, room: number) => cutText(monitorText(text), room);
const cutId = (text: string, room: number) => { const b = monitorText(text); return room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room) || truncateAnsi(b, room); };
const mins = (until: number, now: number) => t('{n}m', { n: Math.max(1, Math.ceil((until - now) / 60000)) });
const workerOf = (jobId: string | undefined, board?: WorkboardSnapshot) => jobId ? board?.workers.find((w) => w.evidence[0]?.sourceId === jobId) : undefined;
const sliceAsking = (s: ProjectSnapshot['slices'][number], board?: WorkboardSnapshot) => workerOf(s.jobId, board)?.homeNeedsHuman ?? !!s.asking;
const jobAsking = (j: ActiveJob, board?: WorkboardSnapshot) => workerOf(j.jobId, board)?.homeNeedsHuman ?? j.asking;

/** A job's row: role, title (the ticket's heading when the board knows the job, as on Home), then `⚡N` for its running sonic children and its age. */
function unslicedRow(job: ActiveJob, width: number, now: number, worker?: OwnerWorker, sonic = 0): MonitorRow {
  const lead = `  ${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}`;
  const right = job.asking ? theme.board.attention(`${t('asking')} ?`) : [sonicBadge(sonic), muted(minuteAge(job.at ?? null, now))].filter(Boolean).join(' ');
  const title = cutText((worker && jobTitle(worker, false)) || monitorText(job.title ?? job.package ?? ''), width - visualLength(lead) - 2 - visualLength(right) - 1);
  return { text: pair(lead + (title ? '  ' + muted(title) : ''), right, width) };
}

type NeedEntry = { rows: MonitorRow[] };
/** Ranked Needs-you entries: asking jobs, STATE waiting items, asking tickets, blocked slices, roles at limit. */
function buildNeeds(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, board?: WorkboardSnapshot,
): NeedEntry[] {
  const out: NeedEntry[] = [], path = data.statePath, files = path ? { files: [path] } : {};
  const asking = new Set<string>();
  for (const s of inFlight(data)) if (sliceAsking(s, board)) {
    asking.add(s.label);
    out.push({
      rows: [{ item: `inbox:ask:${s.jobId ?? s.label}`, ...(s.path ? { files: [s.path] } : {}), text: pair(`  ${theme.board.attention('?')} ${monitorText(s.label)}`, theme.board.attention(t('asking')), width) }],
    });
  }
  for (const job of unsliced(data)) if (jobAsking(job, board)) {
    const lead = `  ${theme.board.attention('?')} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}`, right = theme.board.attention(t('asking'));
    const title = cutProse(job.title ?? job.package ?? '', width - visualLength(lead) - 2 - visualLength(right) - 1);
    out.push({ rows: [{ item: `inbox:ask:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}), text: pair(lead + (title ? '  ' + muted(title) : ''), right, width) }] });
  }
  for (const [i, r] of data.waiting.entries()) {
    const item = `project:wait:${i}`, lines = clampClean(monitorText(r.value), width - 4, state.project.nav.cursor === item ? Infinity : 1).lines;
    out.push({ rows: [...lines.map((l, k) => ({ item, ...(r.path ? { files: [r.path] } : files), text: fit(`${k ? '    ' : `  ${theme.board.attention('?')} `}${l}`, width) })),
      ...projectOriginal(r.original, `wait:${i}`, state.project.folded, width)] });
  }
  const features = data.tickets ?? [], codes = featureCodes(features), shownTickets = new Set<string>();
  for (const f of features) for (const tk of f.tickets.filter(asksYou)) {
    shownTickets.add(tk.path);
    const right = theme.board.attention(monitorText(t(tk.status))), prefix = `  ${theme.board.attention('?')} ${muted(codes.get(f.slug)!)} ${monitorText(tk.number)} `;
    const key = `${f.slug}:${basename(tk.path)}`;
    out.push({ rows: [{ item: `inbox:tk:${key}`, files: [tk.path], text: pair(prefix + cutProse(tk.title, width - visualLength(prefix) - visualLength(right) - 1), right, width) },
      ...projectOriginal(tk.originalTitle, `ticket:${key}`, state.project.folded, width)] });
  }
  for (const r of data.ledger.filter((s) => s.state === 'blocked' && !asking.has(s.id) && !(s.path && shownTickets.has(s.path)))) {
    const item = r.path ? `project:file:${r.path}:slice:${r.id}` : undefined;
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
function runningRows(data: ProjectSnapshot, width: number, now: number, board?: WorkboardSnapshot): MonitorRow[] {
  const parents = new Set(data.active.flatMap((j) => workerOf(j.jobId, board)?.id ?? []));
  return data.active.flatMap((j) => {
    const worker = workerOf(j.jobId, board);
    if (jobAsking(j, board) || (worker?.parentJobId && parents.has(worker.parentJobId))) return [];
    return [unslicedRow(j, width, now, worker, worker && board ? sonicChildrenRunning(board.workers, worker.id) : 0)];
  });
}
function lastAcceptedRow(data: ProjectSnapshot, width: number, now: number): MonitorRow | undefined {
  const last = landedNewest(data).find(({ r }) => r.state === 'accepted')?.r;
  if (!last) return undefined;
  const head = `  ${sliceInk('accepted')(mark('✓', '+'))} ${muted(t('last accepted'))} ${monitorText(last.id)}`, age = muted(sinceText(last.at, now));
  const text = visualLength(head) + (age ? 1 + visualLength(age) : 0) <= width ? fit(`${head}${age ? ' ' + age : ''}`, width) : pair(head, age, width);
  return { text };
}
function hubPageRows(data: ProjectSnapshot, width: number, now: number): MonitorRow[] {
  const shown = PROJECT_PAGES.filter((p) => p !== 'tickets' || data.tickets?.length);
  const col = Math.max(...shown.map((p) => visualLength(t(PAGE_WORD[p])))) + 1;
  return shown.map((page) => {
    const facts = pageSummary(page, data, now);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > Math.max(1, width - col)) facts.pop();
    return { item: `project:page:${page}`, text: fit(`${theme.board.title(fit(t(PAGE_WORD[page]), col))}${facts.join(' · ') || mark('–', '-')}`, width) };
  });
}

/** Inbox Hub: Needs you (ranked, capped with `▸ N more`), Running + `last accepted`, page rows. */
export function inboxHubRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[],
  board?: WorkboardSnapshot, room?: number,
): MonitorRow[] {
  const expanded = state.project.folded.has('inbox:more'), many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const top: MonitorRow[] = [boardRow(''), { ...section(theme.board.title(monitorText(name) || t('Project')), width, many ? `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}` : ''), ...(many ? { item: 'project:switch' } : {}) }];
  const needs = buildNeeds(data, state, width, now, board), live = runningRows(data, width, now, board), last = lastAcceptedRow(data, width, now);
  const pages = hubPageRows(data, width, now);
  const build = (cap: number, runCap: number, showLast: boolean, gaps: boolean) => [
    ...top, ...needsBlock(needs, expanded, cap, data, width), boardRow(''),
    section(t('Running'), width, live.length ? String(live.length) : ''),
    ...(live.length ? live.slice(0, runCap) : [boardRow('  ' + muted(t('Nothing in progress')))]),
    ...(showLast && last ? [last] : []), boardRow(''), ...pages,
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

/** Inbox Projects list: grouped into Needs you, Running and Quiet (a quiet project is one row). */
export function inboxListRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
  const ordered = projectOrder(projects), needs = ordered.filter((p) => (p.overview?.waiting ?? 0) > 0);
  const running = ordered.filter((p) => !needs.includes(p) && (p.overview?.running ?? 0) > 0), quiet = ordered.filter((p) => !needs.includes(p) && !running.includes(p));
  const rows: MonitorRow[] = [boardRow('')], gap = () => { if (rows.length > 1) rows.push(boardRow('')); };
  const headRow = (p: ProjectChoice, right: string): MonitorRow => {
    const ms = p.overview?.milestone ? monitorText(p.overview.milestone) : '', max = Math.max(1, width - (right ? visualLength(right) + 1 : 0)), title = cutId(p.name, max);
    return { item: `project:list:${p.root}`, text: pair(theme.board.title(title) + (ms && visualLength(title) + 2 + visualLength(ms) <= max ? '  ' + muted(ms) : ''), right, width) };
  };
  if (needs.length) {
    rows.push(section(t('Needs you'), width, String(needs.length)));
    for (const p of needs) {
      const o = p.overview!, item = `project:list:${p.root}`, age = muted(sinceText(o.at, now));
      rows.push(headRow(p, theme.board.attention(t('{n} waiting', { n: o.waiting }))));
      const status = o.running ? theme.board.active(t('{n} running', { n: o.running })) : o.open ? muted(t('{n} open', { n: o.open })) : '';
      rows.push({ item, text: pair(status ? '  ' + status : '', age, width) });
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

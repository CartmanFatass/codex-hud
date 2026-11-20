/**
 * Inbox project layout (PROJECT-UX direction C, `.scratch/project-layouts/spec.md`):
 * ranked Needs you, Running, `last accepted` line and page rows on the hub; To try (every milestone, newest first),
 * Blocked, Working, Next and Done folded to one row on Progress; Needs you / Running / Quiet on the Projects list.
 * Tickets stay Timeline's; role alerts link to Control. Pure.
 */
import { SLICE_STATES, type ActiveJob, type LedgerSlice, type ProjectSnapshot } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { TryAction } from '../collectors/try-records.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import {
  NO_MILESTONE, PAGE_WORD, PROJECT_PAGES, acceptedText, asksYou, barText, briefStack, clampClean, clampLines,
  currentRows, dateText, featureCodes, inFlight, inline, landedAge, landedMark, landedNewest, ledgerText, pageRows,
  pageSummary, progressSegments, projectFoldedSet, projectOrder, roleInk, sinceText, sliceInk, sliceLedgerLine, stacked, ticketRows,
  tryCount, tryDetailRows, trySelectionMark, trySentence, unlisted, unsliced, waitingRows, type ProjectPage,
} from './project-view.js';
import { glyph, roleName } from './control-view.js';
import { HUB_HINTS, HUB_TRY_HINTS, LEDGER_FOCUS_HINTS, PROJECT_FILE_HINTS, TRY_ACTIONS, inboxRolePreview, hubTryRows, slicePreview, type Part, type Shown } from './split-project.js';
import { diffStatRows } from './diff-stat-rows.js';
import { jobSentenceLine, labelSummary, workCardDetail } from './work-card.js';
import { boardRow, mark, minuteAge, pack, section } from './workboard-rows.js';
import { cutWords, fit, monitorText, pair } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { basename } from 'node:path';
import { t } from './i18n.js';

const muted = theme.board.muted, NEEDS_CAP = 7;
const bare = (rows: MonitorRow[]): MonitorRow[] => rows.map(({ item: _i, files: _f, ...row }) => row);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const cutProse = (text: string, room: number) => { const b = monitorText(text); return room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room); };
const cutId = (text: string, room: number) => { const b = monitorText(text); return room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room) || truncateAnsi(b, room); };
const mins = (until: number, now: number) => t('{n}m', { n: Math.max(1, Math.ceil((until - now) / 60000)) });
const waitFacts = (data: ProjectSnapshot) => [data.waiting.length, tryCount(data) && t('{n} to try', { n: tryCount(data) })].filter(Boolean).join(' · ');
const workerOf = (jobId: string | undefined, board?: WorkboardSnapshot) => jobId ? board?.workers.find((w) => w.evidence[0]?.sourceId === jobId) : undefined;
const sliceAsking = (s: ProjectSnapshot['slices'][number], board?: WorkboardSnapshot) => workerOf(s.jobId, board)?.homeNeedsHuman ?? !!s.asking;
const jobAsking = (j: ActiveJob, board?: WorkboardSnapshot) => workerOf(j.jobId, board)?.homeNeedsHuman ?? j.asking;

function unslicedRow(job: ActiveJob, width: number, now: number, selectable = false): MonitorRow {
  const lead = `  ${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}`;
  const right = job.asking ? theme.board.attention(`${t('asking')} ?`) : muted(minuteAge(job.at ?? null, now));
  const title = cutProse(job.title ?? job.package ?? '', width - visualLength(lead) - 2 - visualLength(right) - 1);
  return { text: pair(lead + (title ? '  ' + muted(title) : ''), right, width), ...(selectable ? { item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}) } : {}) };
}
function sliceRight(s: ProjectSnapshot['slices'][number] | undefined, worker: WorkboardSnapshot['workers'][number] | undefined, now: number, fallback = ''): string {
  const reason = s?.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(s.ledgerState ?? '')) }) : s?.drift ? t(s.drift) : '';
  if (reason) return theme.board.attention(reason);
  if (!s?.jobId) return fallback;
  const role = worker?.role ?? s.role ?? '';
  return [role && roleInk(role)(monitorText(role)), (worker?.homeNeedsHuman ?? s.asking) ? theme.board.attention(`${t('asking')} ?`) : muted(minuteAge(s.at ?? null, now))].filter(Boolean).join(' ');
}
function tryClassicRows(r: LedgerSlice, right: string, data: ProjectSnapshot, state: MonitorState, width: number, now: number, tryMarks?: ReadonlyMap<string, TryAction>): MonitorRow[] {
  const folded = projectFoldedSet(state), id = `hist:${r.id}`, item = `project:fold:${id}`, open = folded.has(id);
  const files = data.statePath ? { files: [data.statePath] } : {}, tryTarget = { milestone: r.milestone, slices: [r] };
  const head = `  ${trySelectionMark(state, item)}${landedMark(r, tryMarks?.get(r.id))} ${monitorText(r.id)}`;
  const meta = '      ' + muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? dateText(r.at, now) : ''].filter(Boolean).join(' · '));
  const row = (text: string, own?: string): MonitorRow => ({ text: fit(text, width), item: own ?? item, tryTarget, ...files });
  const sentence = trySentence(r), out: MonitorRow[] = [];
  if (sentence && !open) out.push(...briefStack(head, sentence, right, width, 4).map((l) => row(l)));
  else if (sentence) out.push(row(pair(head, right, width)), row(meta), ...tryDetailRows(r, width, 4, folded.has(`ledger:${r.id}`)).map((d) => row(d.text, d.item)));
  else {
    const lines = stacked(head, ledgerText(r), right, width, 4, Infinity);
    if (open) lines.splice(1, 0, meta);
    out.push(...lines.map((l) => row(l)));
  }
  if (open) out.push(...diffStatRows(r.diff, width));
  return out;
}

type NeedEntry = { rows: MonitorRow[]; askTarget?: string };
/** Ranked Needs-you entries: asking jobs, STATE waiting items, to-try slices newest first, asking tickets, blocked slices, roles at limit. */
function buildNeeds(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, mode: 'classic' | 'split',
  board?: WorkboardSnapshot, tryMarks?: ReadonlyMap<string, TryAction>,
): NeedEntry[] {
  const out: NeedEntry[] = [], path = data.statePath, files = path ? { files: [path] } : {};
  for (const s of inFlight(data)) if (sliceAsking(s, board)) out.push({
    askTarget: `project:slice:${s.label}`,
    rows: [{ item: `inbox:ask:${s.jobId ?? s.label}`, ...(s.path ? { files: [s.path] } : files), text: pair(`  ${theme.board.attention('?')} ${monitorText(s.label)}`, theme.board.attention(t('asking')), width) }],
  });
  for (const job of unsliced(data)) if (jobAsking(job, board)) {
    const lead = `  ${theme.board.attention('?')} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}`, right = theme.board.attention(t('asking'));
    const title = cutProse(job.title ?? job.package ?? '', width - visualLength(lead) - 2 - visualLength(right) - 1);
    out.push({ askTarget: `project:job:${job.jobId}`, rows: [{ item: `inbox:ask:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}), text: pair(lead + (title ? '  ' + muted(title) : ''), right, width) }] });
  }
  for (const [i, r] of data.waiting.entries()) {
    const item = `project:wait:${i}`, lines = clampClean(monitorText(r.value), width - 4, mode === 'classic' && state.projectCursor === item ? Infinity : 1).lines;
    out.push({ rows: lines.map((l, k) => ({ item, ...(r.path ? { files: [r.path] } : files), text: fit(`${k ? '    ' : `  ${theme.board.attention('?')} `}${l}`, width) })) });
  }
  for (const { r } of landedNewest(data).filter(({ r }) => r.state === 'try')) {
    const right = landedAge(r, now);
    if (mode === 'classic') out.push({ rows: tryClassicRows(r, right, data, state, width, now, tryMarks) });
    else {
      const item = `project:slice:${r.id}`, sentence = trySentence(r), head = `  ${trySelectionMark(state, item)}${landedMark(r, tryMarks?.get(r.id))} ${monitorText(r.id)}`;
      out.push({ rows: (sentence ? briefStack(head, sentence, right, width, 4) : [pair(head, right, width)]).map((text) => ({ item, ...files, tryTarget: { milestone: r.milestone, slices: [r] }, text })) });
    }
  }
  const features = data.tickets ?? [], codes = featureCodes(features);
  for (const f of features) for (const tk of f.tickets.filter(asksYou)) {
    const right = theme.board.attention(monitorText(t(tk.status))), prefix = `  ${theme.board.attention('?')} ${muted(codes.get(f.slug)!)} ${monitorText(tk.number)} `;
    out.push({ rows: [{ item: `inbox:tk:${f.slug}:${basename(tk.path)}`, files: [tk.path], text: pair(prefix + cutProse(tk.title, width - visualLength(prefix) - visualLength(right) - 1), right, width) }] });
  }
  for (const r of data.ledger.filter((s) => s.state === 'blocked')) {
    const item = mode === 'split' ? `project:slice:${r.id}` : path ? `project:file:${path}:slice:${r.id}` : undefined;
    out.push({ rows: [{ ...(item ? { item } : {}), ...files, text: pair(`  ${sliceInk('blocked')(mark('◆', '!'))} ${monitorText(r.id)}`, sliceInk('blocked')(t('blocked')), width) }] });
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
  return [section(t('Needs you'), width, waitFacts(data)), ...(needs.length ? [...shown.flatMap((n) => n.rows), ...tail] : [plain('  ' + muted(t('Nothing needs you')), width)])];
}
function runningRows(data: ProjectSnapshot, width: number, now: number, selectable: boolean, board?: WorkboardSnapshot): MonitorRow[] {
  const files = data.statePath ? { files: [data.statePath] } : {};
  return [
    ...inFlight(data).filter((r) => r.ledgerState !== 'blocked' && !sliceAsking(r, board)).map((r): MonitorRow => {
      const lead = r.drift ? theme.board.attention('!') : sliceInk('working')(mark('◐', '@'));
      const right = sliceRight(r, workerOf(r.jobId, board), now, sliceInk('working')(t(r.ledgerState ?? 'working')));
      return { ...(selectable ? { item: `project:slice:${r.label}` } : {}), ...(r.path ? { files: [r.path] } : files), text: inline(`  ${lead} ${monitorText(r.label)}`, r.value, right, width) };
    }),
    ...unsliced(data).filter((j) => !jobAsking(j, board)).map((j) => unslicedRow(j, width, now, selectable)),
  ];
}
function lastAcceptedRow(data: ProjectSnapshot, width: number, now: number, selectable = false): MonitorRow | undefined {
  const last = landedNewest(data).find(({ r }) => r.state === 'accepted')?.r;
  if (!last) return undefined;
  const head = `  ${sliceInk('accepted')(mark('✓', '+'))} ${muted(t('last accepted'))} ${monitorText(last.id)}`, age = muted(sinceText(last.at, now));
  const text = visualLength(head) + (age ? 1 + visualLength(age) : 0) <= width ? fit(`${head}${age ? ' ' + age : ''}`, width) : pair(head, age, width);
  return { text, ...(selectable ? { item: `project:slice:${last.id}`, ...(data.statePath ? { files: [data.statePath] } : {}) } : {}) };
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
  board?: WorkboardSnapshot, room?: number, tryMarks?: ReadonlyMap<string, TryAction>,
): MonitorRow[] {
  const expanded = projectFoldedSet(state).has('inbox:more'), many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.projectRoot));
  const top: MonitorRow[] = [boardRow(''), { ...section(theme.board.title(monitorText(name) || t('Project')), width, many ? `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}` : ''), ...(many ? { item: 'project:switch' } : {}) }];
  const needs = buildNeeds(data, state, width, now, 'classic', board, tryMarks), live = runningRows(data, width, now, false, board), last = lastAcceptedRow(data, width, now);
  const pages = hubPageRows(data, width, now, false);
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

/** Inbox Hub (Split): Needs you + Running + `last accepted` + page rows in the list; selected row explained in the preview. */
export function inboxHubPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const projects = input.projects ?? [], many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.projectRoot));
  const folded = projectFoldedSet(state), expanded = folded.has('inbox:more');
  const name: MonitorRow = {
    ...section(theme.board.title(monitorText(input.projectName ?? '') || t('Project')), width,
      [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
    ...(many ? { item: 'project:switch' } : {}),
  };
  const needs = buildNeeds(data, state, width, now, 'split', board, input.tryMarks), live = runningRows(data, width, now, true, board), last = lastAcceptedRow(data, width, now, true);
  const list = [
    name, boardRow(''), ...needsBlock(needs, expanded, NEEDS_CAP, data, width), boardRow(''),
    section(t('Running'), width, live.length ? String(live.length) : ''), ...(live.length ? live : [plain('  ' + muted(t('Nothing in progress')), width)]), ...(last ? [last] : []),
    boardRow(''), ...hubPageRows(data, width, now, true),
  ];
  const preview = (cursor?: string): Shown => {
    const waitMatch = /^project:wait:(\d+)$/.exec(cursor ?? '');
    if (waitMatch) {
      const i = Number(waitMatch[1]), r = data.waiting[i];
      return { label: t('Waiting for you'), right: waitFacts(data), rows: r ? bare(waitingRows(r, i, width, now, Infinity)) : [] };
    }
    if (cursor?.startsWith('inbox:ask:')) {
      const target = needs.find((n) => n.rows[0]?.item === cursor)?.askTarget;
      if (target) return slicePreview(input, data, state, board, width, now, target);
    }
    const tkKey = /^inbox:tk:(.+)$/.exec(cursor ?? '')?.[1];
    if (tkKey) {
      const ticket = data.tickets.flatMap((f) => f.tickets.map((x) => ({ x, key: `${f.slug}:${basename(x.path)}` }))).find((o) => o.key === tkKey)?.x;
      if (!ticket) return { label: '', rows: [] };
      const rows = ticketRows(data, new Set([...folded, `ticket:${tkKey}`]), width, now).filter((r) => r.item === `project:fold:ticket:${tkKey}`).slice(1);
      return { label: monitorText(`${ticket.number} ${ticket.title}`), right: monitorText(t(ticket.status)), rows: bare(rows), hints: ['⏎ open file', '[ ] project'] };
    }
    const roleId = /^inbox:role:(.+)$/.exec(cursor ?? '')?.[1];
    if (roleId) {
      const shownRole = inboxRolePreview(data, width, now)(`project:role:${roleId}`);
      return { ...shownRole, rows: bare(shownRole.rows), hints: ['o file', '⏎ Control', '[ ] project'] };
    }
    if (cursor === 'project:fold:inbox:more') return { label: t('Needs you'), right: waitFacts(data), rows: bare(needs.slice(NEEDS_CAP).flatMap((n) => n.rows)) };
    if (cursor?.startsWith('project:slice:') || cursor?.startsWith('project:job:')) {
      const shownSlice = slicePreview(input, data, state, board, width, now, cursor);
      const isTry = data.ledger.some((r) => `project:slice:${r.id}` === cursor && r.state === 'try');
      return { ...shownSlice, ...(isTry ? { hints: [...TRY_ACTIONS, '⏎ details', '[ ] project'] } : {}) };
    }
    const page = /^project:page:(.+)$/.exec(cursor ?? '')?.[1] as ProjectPage | undefined;
    if (page && page !== 'progress') {
      const facts = page === 'tree' ? { ...data, gitDiff: undefined } : data;
      return { label: t(PAGE_WORD[page]), rows: bare(pageRows(page, facts, state, width, now, board, input.modelEnabled, input.tryMarks).slice(1)) };
    }
    const cur = currentRows(data), cells = Math.max(6, Math.min(60, width - 16)), tries = hubTryRows(data, state, width, now, input.tryMarks);
    const rows: MonitorRow[] = [
      ...(data.summary ? clampLines(data.summary, width - 2, 2).lines.map((l) => plain('  ' + l, width)) : []),
      ...(progressSegments(cur.counts, cells).some((s) => s.width) ? [plain(`  ${barText({ counts: cur.counts }, cells)} ${muted(acceptedText(cur.counts, cur.rows.length))}`, width)] : []),
      ...tries.rows, ...(live.length ? [boardRow(''), plain(muted(t('Running')), width), ...bare(live)] : []), ...(last ? [plain(last.text, width)] : []),
    ];
    return { label: t('Progress'), rows, ...(tries.act ? { act: tries.act, hints: HUB_TRY_HINTS } : {}) };
  };
  return {
    list, preview, start: list.find((r) => r.item && r.item !== 'project:switch')?.item ?? list.find((r) => r.item)?.item,
    hints: HUB_HINTS, focusHints: LEDGER_FOCUS_HINTS,
  };
}

const progressBarText = (data: ProjectSnapshot, width: number) => {
  const cur = currentRows(data);
  if (!cur.rows.length) return '';
  const label = cur.whole || !data.ladder.current ? '' : ` ${monitorText(data.ladder.current)} `, frac = acceptedText(cur.counts, cur.rows.length);
  const cells = Math.max(6, Math.min(24, width - 3 - visualLength(label) - visualLength(frac) - 2));
  return `  ${label ? theme.board.title(label) + ' ' : ''}${barText({ counts: cur.counts }, cells)} ${muted(frac)}`;
};
const progressBuckets = (data: ProjectSnapshot) => ({
  tries: landedNewest(data).filter(({ r }) => r.state === 'try'), accepted: landedNewest(data).filter(({ r }) => r.state === 'accepted'),
  blocked: data.ledger.filter((r) => r.state === 'blocked'), working: data.ledger.filter((r) => r.state === 'working'), jobs: unsliced(data),
});

/** Inbox Progress (Classic): To try (every milestone, newest first), Blocked, Working, Next, Done folded to one row. */
export function inboxProgressRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false, tryMarks?: ReadonlyMap<string, TryAction>,
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = projectFoldedSet(state), path = data.statePath, files = path ? { files: [path] } : {};
  if (!path && !data.ledger.length) return [...rows, boardRow('  ' + muted(t('no STATE.md')))];
  const fileRow = (text: string, key: string, p = path) => rows.push({ text: fit(text, width), ...(p ? { item: `project:file:${p}:${key}`, files: [p] } : {}) });
  const gap = () => { if (rows.length > 1) rows.push(boardRow('')); };
  if (!state.filterQuery) {
    if (data.summary) for (const l of clampLines(data.summary, width - 2, 2).lines) fileRow('  ' + l, 'summary');
    const bar = progressBarText(data, width);
    if (bar) {
      fileRow(bar, 'bar');
      const cur = currentRows(data), words = SLICE_STATES.filter((s) => s !== 'accepted' && cur.counts[s]).map((s) => sliceInk(s)(`${cur.counts[s]} ${t(s === 'try' ? 'to try' : s)}`));
      for (const line of pack(words, width)) cur.counts.try ? rows.push({ text: fit(line, width), item: 'project:try', ...files }) : fileRow(line, 'counts');
    }
  }
  const { tries, accepted, blocked, working, jobs } = progressBuckets(data);
  if (tries.length) {
    gap();
    rows.push(section(t('To try'), width, String(tries.length)));
    for (const { r } of tries) rows.push(...tryClassicRows(r, muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), sinceText(r.at, now)].filter(Boolean).join(' ')), data, state, width, now, tryMarks));
  }
  if (blocked.length) {
    gap();
    rows.push(section(t('Blocked'), width, String(blocked.length)));
    for (const r of blocked) {
      const s = data.slices.find((x) => x.label === r.id), desc = s?.value || ledgerText(r), extra = { ...(path ? { item: `project:file:${path}:slice:${r.id}` } : {}), ...files };
      rows.push({ text: pair(`  ${sliceInk('blocked')(mark('◆', '!'))} ${monitorText(r.id)}`, sliceRight(s, undefined, now), width), ...extra });
      if (desc) for (const l of clampLines(desc, width - 4, 2).lines) rows.push({ text: fit('    ' + muted(l), width), ...extra });
    }
  }
  if (working.length + jobs.length) {
    gap();
    rows.push(section(t('Working'), width, String(working.length + jobs.length)));
    for (const r of working) {
      const s = data.slices.find((x) => x.label === r.id), worker = workerOf(s?.jobId, board), extra = { ...(path ? { item: `project:file:${path}:slice:${r.id}` } : {}), ...files };
      rows.push({ text: pair(`  ${s?.drift ? theme.board.attention('!') : sliceInk('working')(mark('◐', '@'))} ${monitorText(r.id)}`, sliceRight(s, worker, now), width), ...extra });
      if (worker && s) {
        const sentence = modelEnabled && worker.modelSentence ? jobSentenceLine(worker.modelSentence, width - 3, (x) => x).slice(2).trimEnd() : monitorText(workCardDetail(projectWorkCard(worker, now)));
        if (sentence) rows.push({ text: fit('    ' + muted(sentence), width), ...extra });
        const labels = labelSummary(worker.labels);
        if (labels) rows.push({ text: fit('    ' + labels, width), ...extra });
      } else if (s?.value || ledgerText(r)) for (const l of clampLines(s?.value || ledgerText(r), width - 4, 2).lines) rows.push({ text: fit('    ' + muted(l), width), ...extra });
    }
    for (const j of jobs) rows.push(unslicedRow(j, width, now, true));
  }
  if (data.next.length && !state.filterQuery) {
    gap();
    rows.push(section(t('Next'), width, String(data.next.length)));
    const all = folded.has('next'), shown = all ? data.next : data.next.slice(0, 2), more = data.next.length - 2;
    shown.forEach((r, i) => {
      const id = `next:${i}`, clip = clampLines(r.value, width - 4, 1);
      (folded.has(id) ? clampLines(r.value, width - 4, Infinity).lines : clip.lines).forEach((l, k) => rows.push({
        text: fit(`${k ? '    ' : `  ${mark('→', '>')} `}${l}`, width), ...(clip.more ? { item: `project:fold:${id}` } : r.path ? { item: `project:file:${r.path}:${id}` } : {}), ...(r.path ? { files: [r.path] } : {}),
      }));
    });
    if (more > 0) rows.push({ text: fit(`  ${muted(`${all ? mark('▾', 'v') : mark('▸', '>')} ${all ? t('fewer') : t('{n} more', { n: more })}`)}`, width), item: 'project:fold:next' });
  }
  if (accepted.length) {
    gap();
    const open = !!state.filterQuery || folded.has('inbox:done'), newest = accepted[0].r;
    rows.push({ ...section(`${open ? '' : mark('▸', '>') + ' '}${t('Done')}`, width, String(accepted.length)), item: 'project:fold:inbox:done', ...files });
    if (!open) {
      const lead = `  ${sliceInk('accepted')(mark('✓', '+'))} ${muted(t('{n} accepted', { n: accepted.length }))}`;
      const full = `${lead} ${muted('·')} ${muted(`${t('latest')} ${monitorText(newest.id)}${newest.at !== undefined ? ' ' + sinceText(newest.at, now) : ''}`)}`;
      rows.push({ text: fit(visualLength(full) <= width ? full : lead, width), item: 'project:fold:inbox:done', ...files });
    } else for (const { r } of accepted) rows.push({ text: inline(`  ${sliceInk('accepted')(mark('✓', '+'))} ${monitorText(r.id)}`, ledgerText(r), muted(sinceText(r.at, now)), width), ...(path ? { item: `project:file:${path}:slice:${r.id}` } : {}), ...files });
  }
  return rows;
}

/** Inbox Progress (Split): To try (every milestone, newest first), Blocked, Working, Next, Done folded to one row; preview shows selected item. */
export function inboxProgressPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const path = data.statePath, files = path ? { files: [path] } : {}, marks = input.tryMarks, list: MonitorRow[] = [];
  const gap = () => { if (list.length) list.push(boardRow('')); };
  const bar = !state.filterQuery ? progressBarText(data, width) : '';
  if (bar) list.push(plain(bar, width));
  else if (!path && !data.ledger.length) list.push(plain('  ' + muted(t('no STATE.md')), width));
  const { tries, accepted, blocked, working, jobs } = progressBuckets(data);
  if (tries.length) {
    gap();
    list.push(section(t('To try'), width, String(tries.length)));
    for (const { r } of tries) {
      const item = `project:slice:${r.id}`, sentence = trySentence(r), head = `  ${trySelectionMark(state, item)}${landedMark(r, marks?.get(r.id))} ${monitorText(r.id)}`;
      const right = muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), sinceText(r.at, now)].filter(Boolean).join(' '));
      for (const text of sentence ? briefStack(head, sentence, right, width, 4) : [sliceLedgerLine(r, head, right, width, 2)]) list.push({ item, ...files, tryTarget: { milestone: r.milestone, slices: [r] }, text });
    }
  }
  if (blocked.length) {
    gap();
    list.push(section(t('Blocked'), width, String(blocked.length)));
    for (const r of blocked) list.push({ item: `project:slice:${r.id}`, ...files, text: sliceLedgerLine(r, `  ${sliceInk('blocked')(mark('◆', '!'))} ${monitorText(r.id)}`, sliceRight(data.slices.find((x) => x.label === r.id), undefined, now), width, 2) });
  }
  if (working.length + jobs.length) {
    gap();
    list.push(section(t('Working'), width, String(working.length + jobs.length)));
    for (const r of working) {
      const s = data.slices.find((x) => x.label === r.id);
      list.push({ item: `project:slice:${r.id}`, ...files, text: sliceLedgerLine(r, `  ${s?.drift ? theme.board.attention('!') : sliceInk('working')(mark('◐', '@'))} ${monitorText(r.id)}`, sliceRight(s, workerOf(s?.jobId, board), now), width, 2) });
    }
    for (const j of jobs) list.push(unslicedRow(j, width, now, true));
  }
  if (data.next.length && !state.filterQuery) { gap(); list.push({ item: 'split:next', ...files, text: pair(`${muted(mark('→', '>'))} ${t('Next')}`, muted(String(data.next.length)), width) }); }
  if (accepted.length) {
    gap();
    const newest = accepted[0].r, age = newest.at !== undefined ? ' ' + sinceText(newest.at, now) : '';
    const left = `${muted(mark('▸', '>'))} ${t('Done')}  ${sliceInk('accepted')(mark('✓', '+'))} ${muted(String(accepted.length))}`;
    const full = muted(`${t('latest')} ${monitorText(newest.id)}${age}`), brief = muted(`${monitorText(newest.id)}${age}`);
    list.push({ item: 'split:done', ...files, text: pair(left, visualLength(left) + 1 + visualLength(full) <= width ? full : visualLength(left) + 1 + visualLength(brief) <= width ? brief : '', width) });
  }
  const preview = (cursor?: string): Shown => cursor === 'split:done'
    ? { label: t('Done'), right: t('{n} accepted', { n: accepted.length }), rows: accepted.map(({ r }) => ({ text: inline(`  ${sliceInk('accepted')(mark('✓', '+'))} ${monitorText(r.id)}`, ledgerText(r), muted(sinceText(r.at, now)), width) })) }
    : slicePreview(input, data, state, board, width, now, cursor);
  return { list, preview, start: list.find((r) => r.item)?.item, hints: PROJECT_FILE_HINTS, focusHints: LEDGER_FOCUS_HINTS };
}

/** Inbox Projects list: grouped into Needs you, Running and Quiet (a quiet project is one row). */
export function inboxListRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
  const ordered = projectOrder(projects), needs = ordered.filter((p) => (p.overview?.waiting ?? 0) > 0 || (p.overview?.counts.try ?? 0) > 0);
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
      rows.push(headRow(p, o.waiting ? theme.board.attention(t('{n} waiting', { n: o.waiting })) : sliceInk('try')(t('{n} to try', { n: o.counts.try }))));
      const parts = [o.waiting && o.counts.try ? sliceInk('try')(t('{n} to try', { n: o.counts.try })) : '', o.running ? theme.board.active(t('{n} running', { n: o.running })) : '', !o.counts.try && !o.running && o.open ? muted(t('{n} open', { n: o.open })) : ''].filter(Boolean);
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

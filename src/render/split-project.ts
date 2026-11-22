/**
 * Split Project: the hub and each page as a list over a preview of the cursor row. The hub lists Waiting for you and the pages
 * (Progress previews Now, To try and Latest, so the common question needs no Enter); Progress is one ledger list with the cursor
 * slice explained underneath. The standalone Control tab also uses the shared list/preview machinery here.
 * Rows keep Classic's item ids where Classic acts on them (a page, a waiting item, a file, a place), so Enter, `o` and the place
 * keys are the ones Classic has.
 */
import type { LedgerSlice, SliceState, ProjectSnapshot } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import type { ClassicSplitNav } from './monitor-state.js';
import { PROJECT_PAGES, PAGE_WORD, HOME_BLOCK, acceptedText, asksYou, barText, briefStack, clampClean, clampLines, currentRows, cutTicketTitle, hubNowRows, inFlight, inline, landedAge, landedInline, landedMark, landedNewest,
  ledgerText, ledgerFoldItem, newestTasks, pageRows, pageSummary, progressSegments, roleInk, sinceText, sliceInk, sliceLedgerLine, tryCount, trySentence, ticketRows, unlisted, unsliced, waitingRows, projectItem, trySelectionMark, taskDetailRows, taskItem, taskLabel, taskRows,
  progressTasks, progressTaskRow, progressTaskDetails, progressTasksHeading, sliceDetailRows, featureItem, featureRow,
  type ProjectPage } from './project-view.js';
import { glyph, placeRows, placeTarget, radarFacts, roleToday } from './control-view.js';
import { boardHubPart, boardProgressPart } from './board-project.js';
import { inboxHubPart, inboxProgressPart } from './inbox-project.js';
import type { TryAction } from '../collectors/try-records.js';
import { diffStatRows } from './diff-stat-rows.js';
import { splitItems, type SplitScene } from './split-frame.js';
import { boardRow, kvRows, mark, minuteAge, section } from './workboard-rows.js';
import { fit, flowLines, monitorText, pair } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { basename } from 'node:path';

export type Shown = { label: string; right?: string; rows: MonitorRow[]; act?: string; /** The footer while the keys are in the list, where the row's own keys differ from the page's. */ hints?: readonly string[] };
export interface Part { list: MonitorRow[]; start?: string; preview: (cursor?: string) => Shown; hints: readonly string[]; focusHints?: readonly string[] }
export const TRY_ACTIONS = ['Space mark', 'y accept', 'n flag'] as const;
export const HUB_HINTS = ['⏎ open', '[ ] project'] as const;
export const HUB_TRY_HINTS = [...TRY_ACTIONS, ...HUB_HINTS];
export const PROJECT_FILE_HINTS = ['⏎ open file', 'Esc back'] as const;
export const LEDGER_FOCUS_HINTS = ['⏎ fold / unfold the ledger line', 'Esc back'] as const;
const muted = theme.board.muted, DAY = 864e5;
const bare = (rows: MonitorRow[]): MonitorRow[] => rows.map(({ item: _item, files: _files, ...row }) => row);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const indent = (text: string, width: number, max: number) => clampLines(text, width - 2, max).lines.map((l) => plain('  ' + l, width));
const tryTotals = (n: number) => (n ? t('{n} to try', { n }) : '');

/** To-try rows for a Split hub preview (shared by Timeline and Board): `Space`/`y`/`n` act on `act` or the focused row. */
export function hubTryRows(data: ProjectSnapshot, state: MonitorState, width: number, now: number, marks?: ReadonlyMap<string, TryAction>) {
  if (state.prefs.acceptance !== 'slice') {
    const tasks = newestTasks(data), pending = (task: typeof tasks[number]) => task.slices.some((r) => !marks?.get(r.id));
    const todo = tasks.filter(pending), done = tasks.filter((task) => !pending(task));
    return {
      rows: tasks.length ? [boardRow(''), plain(muted(t('To try')), width), ...[...todo, ...done].flatMap((task) => taskRows(task, data, state, width, now, marks))] : [],
      act: todo.length ? taskItem(todo[0]) : undefined,
    };
  }
  const queue = landedNewest(data).filter(({ r }) => r.state === 'try');
  const todo = queue.filter(({ r }) => !marks?.get(r.id)), done = queue.filter(({ r }) => marks?.get(r.id));
  const tryRows = ({ r }: { r: LedgerSlice }, act: boolean): MonitorRow[] => {
    const item = `project:try:${r.id}`, sentence = trySentence(r);
    const head = `  ${trySelectionMark(state, item)}${landedMark(r, marks?.get(r.id))} ${monitorText(r.id)}`, age = muted(sinceText(r.at, now)), body = monitorText(ledgerText(r));
    const fits = visualLength(head) + 2 + visualLength(body) + visualLength(age) + 1 <= width;
    const lines = sentence ? briefStack(head, sentence, age, width) : fits && body ? [pair(`${head}  ${muted(body)}`, age, width)]
      : [pair(head, age, width), ...clampClean(body, width - 4, Infinity).lines.map((l) => fit('    ' + muted(l), width))];
    return lines.map((text) => ({ item, ...(data.statePath ? { files: [data.statePath] } : {}), ...(act ? { tryTarget: { milestone: r.milestone, slices: [r] } } : {}), text }));
  };
  return {
    rows: queue.length ? [boardRow(''), plain(muted(t('To try')), width), ...todo.flatMap((x) => tryRows(x, true)), ...done.flatMap((x) => tryRows(x, false))] : [],
    act: todo.length ? `project:try:${todo[0].r.id}` : undefined,
  };
}

function hubPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const projects = input.projects ?? [], many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const name: MonitorRow = { ...section(theme.board.title(monitorText(input.projectName ?? '') || t('Project')), width,
    [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
  ...(many ? { item: 'project:switch' } : {}) };
  const waitFacts = [data.waiting.length, tryTotals(tryCount(data, state.prefs.acceptance))].filter(Boolean).join(' · ');
  const waiting: MonitorRow[] = data.waiting.length ? [{ item: 'project:fold:waiting', text: pair(`${theme.board.attention('?')} ${theme.board.title(t('Waiting for you'))}`, muted(waitFacts), width) }] : [];
  const cur = currentRows(data), tickets = data.tickets.flatMap((f) => f.tickets);
  const mark_ = (page: ProjectPage) => page === 'progress' && cur.counts.working ? theme.board.active(mark('◐', '@'))
    : (page === 'tickets' && tickets.some(asksYou)) || (page === 'tree' && unlisted(data).length) ? theme.board.attention(page === 'tickets' ? '?' : '!')
    : page === 'tree' || page === 'docs' ? ' ' : muted(mark('○', 'o'));
  const pages = PROJECT_PAGES.filter((p) => p !== 'tickets' || data.tickets?.length).map((page): MonitorRow => {
    const facts = pageSummary(page, data, now, false, state.prefs.acceptance), room = width - 2 - 14 - 1;
    while (facts.length > 1 && visualLength(facts.join(' · ')) > room) facts.pop();
    return { item: `project:page:${page}`, text: fit(`${mark_(page)} ${theme.board.title(fit(t(PAGE_WORD[page]), 14))}${facts.join(' · ') || mark('–', '-')}`, width) };
  });
  const preview = (cursor?: string): Shown => {
    if (cursor === 'project:fold:waiting') return { label: t('Waiting for you'), right: waitFacts, rows: data.waiting.flatMap((r, i) => waitingRows(r, i, width, now, Infinity)) };
    const page = /^project:page:(.+)$/.exec(cursor ?? '')?.[1] as ProjectPage | undefined;
    if (page && page !== 'progress') {
      const facts = page === 'tree' ? { ...data, gitDiff: undefined } : data;
      return { label: t(PAGE_WORD[page]), rows: bare(pageRows(page, facts, state, width, now, board, input.modelEnabled, input.tryMarks).slice(1)) };
    }
    const rows: MonitorRow[] = [...indent(data.summary, width, 2)];
    const cells = Math.max(6, Math.min(HOME_BLOCK, width - 16));
    if (progressSegments(cur.counts, cells).some((s) => s.width)) rows.push(plain(`  ${barText({ counts: cur.counts }, cells)} ${muted(acceptedText(cur.counts, cur.rows.length))}`, width));
    const landed = landedNewest(data), tries = hubTryRows(data, state, width, now, input.tryMarks);
    if (tries.rows.length) rows.push(...tries.rows);
    if (inFlight(data).length || unsliced(data).length) rows.push(boardRow(''), plain(muted(t('Now')), width), ...hubNowRows(data, width, now, board));
    const accepted = landed.filter(({ r }) => r.state === 'accepted').slice(0, 3);
    if (accepted.length) rows.push(boardRow(''), plain(muted(t('Latest accepted')), width), ...accepted.map(({ r }): MonitorRow => ({ text: landedInline(r, `  ${landedMark(r)} ${monitorText(r.id)}`, muted(sinceText(r.at, now)), width) })));
    return { label: t('Progress'), rows, ...(tries.act ? { act: tries.act, hints: HUB_TRY_HINTS } : {}) };
  };
  return { list: [name, boardRow(''), ...waiting, ...pages], preview,
    start: pages.find((r) => r.item)?.item, hints: HUB_HINTS, focusHints: ['⏎ open', 'Esc back'] };
}

const PROGRESS_FOLD_HINTS = [...TRY_ACTIONS, '⏎ details', 'Esc back', 'o file'];
const TRY_HINTS = [...TRY_ACTIONS, ...PROJECT_FILE_HINTS];
const SLICE_MARK: Partial<Record<SliceState, () => string>> = { working: () => sliceInk('working')(mark('◐', '@')), blocked: () => sliceInk('blocked')(mark('◆', '!')), todo: () => muted(mark('○', '-')) };
/** Preview for a slice, Next, or unsliced job on Split Progress (shared by Timeline and Board). */
export function slicePreview(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number, cursor?: string): Shown {
  if (cursor?.startsWith('project:fold:task:')) {
    const task = newestTasks(data).find((group) => taskItem(group) === cursor);
    if (task) {
      const rows = taskDetailRows(task, state, width, now, input.tryMarks);
      return { label: taskLabel(task), rows, hints: rows.some((r) => r.item) ? PROGRESS_FOLD_HINTS : [...TRY_ACTIONS, 'Esc back', 'o file'] };
    }
  }
  const id = /^project:slice:(.+)$/.exec(cursor ?? '')?.[1], r = data.ledger.find((x) => x.id === id);
  if (r) {
    const rows = sliceDetailRows(r, data, state, width, now, board, input.modelEnabled);
    return { label: monitorText(r.id), right: `${t(r.state === 'try' ? 'to try' : r.state)}${NO_MILESTONE.test(r.milestone) ? '' : ' · ' + monitorText(r.milestone)}`, rows,
      ...(r.state !== 'try' ? {} : { hints: rows.some((x) => x.item === ledgerFoldItem(r)) ? PROGRESS_FOLD_HINTS : TRY_HINTS }) };
  }
  if (cursor === 'split:next') return { label: t('Next'), right: String(data.next.length), rows: data.next.flatMap((n) => clampLines(n.value, width - 4, 2).lines.map((l, k) => plain(`${k ? '    ' : `  ${mark('→', '>')} `}${l}`, width))) };
  const job = unsliced(data).find((j) => `project:job:${j.jobId}` === cursor);
  return { label: monitorText(job?.role ?? ''), rows: job ? indent(job.title ?? job.package ?? '', width, 3) : [] };
}

function progressPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const cur = currentRows(data), marks = input.tryMarks, path = data.statePath, files = path ? { files: [path] } : {};
  const list: MonitorRow[] = [];
  const label = cur.whole || !data.ladder.current ? '' : ` ${monitorText(data.ladder.current)} `, frac = acceptedText(cur.counts, cur.rows.length);
  if (cur.rows.length) list.push(plain(`  ${label ? theme.board.title(label) + ' ' : ''}${barText({ counts: cur.counts }, Math.max(6, Math.min(24, width - 3 - visualLength(label) - visualLength(frac) - 2)))} ${muted(frac)}`, width), boardRow(''));
  else if (!path) list.push(plain('  ' + muted(t('no STATE.md')), width));
  const slices = cur.whole || state.project.filter?.query ? data.ledger : [...cur.rows, ...data.ledger.filter((r) => r.state === 'try' && (r.release ?? r.milestone) !== data.ladder.current)];
  const ids = slices.map((r) => visualLength(monitorText(r.id))), col = Math.max(8, Math.min(14, Math.max(0, ...ids)));
  const info = (r: LedgerSlice) => data.slices.find((s) => s.label === r.id), workerOf = (r: LedgerSlice) => board.workers.find((w) => w.evidence[0]?.sourceId === info(r)?.jobId);
  for (const st of ['working', 'blocked', 'try', 'todo'] as const) {
    for (const r of slices.filter((x) => x.state === st)) {
      const s = info(r), role = workerOf(r)?.role ?? s?.role ?? '';
      const right = s?.drift ? theme.board.attention(t(s.drift)) : st === 'working' && s?.jobId ? `${role ? roleInk(role)(monitorText(role)) + ' ' : ''}${muted(minuteAge(s.at ?? null, now))}` : st === 'try' ? muted(sinceText(r.at, now)) : '';
      const item = `project:slice:${r.id}`;
      // Keep a stored brief's first sentence; otherwise give the room to the ledger text.
      const head = `${trySelectionMark(state, item)}${st === 'try' ? landedMark(r, marks?.get(r.id)) : SLICE_MARK[st]!()} ${fit(monitorText(r.id), col)}`, sentence = trySentence(r);
      for (const text of sentence ? briefStack(head, sentence, right, width, 2) : [sliceLedgerLine(r, head, right, width)])
        list.push({ item, ...files, ...(st === 'try' ? { tryTarget: { milestone: r.milestone, slices: [r] } } : {}), text });
    }
  }
  list.push(...looseJobRows(data, width, now));
  const landed = landedNewest(data), recent = landed.filter(({ r }) => r.at !== undefined && now - r.at <= 7 * DAY);
  const block = (item: string, left: string, right: string): MonitorRow => ({ item, ...files, text: pair(left, muted(right), width) });
  if (cur.counts.accepted) list.push(block('split:accepted', `${sliceInk('accepted')(mark('✓', '+'))} ${muted(t('{n} accepted', { n: cur.counts.accepted }))}  ${muted(mark('▸', '>'))}`, ''));
  if (data.next.length) list.push(block('split:next', `${muted(mark('→', '>'))} ${t('Next')}`, String(data.next.length)));
  if (landed.length) list.push(block('split:history', `${muted(mark('▸', '>'))} ${t('History')}`, `${t('{n} landed in 7 days', { n: recent.length })} · ${landed.length - recent.length} ${t('older')}`));
  const preview = (cursor?: string): Shown => {
    if (cursor === 'split:accepted') return { label: t('accepted'), right: String(cur.counts.accepted), rows: landed.filter(({ r }) => r.state === 'accepted' && cur.rows.includes(r))
      .map(({ r }): MonitorRow => ({ text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now, false), width) })) };
    if (cursor === 'split:history') {
      const old = landed.filter((x) => !recent.includes(x)), by = new Map<string, number>();
      for (const { r } of old) by.set(r.milestone, (by.get(r.milestone) ?? 0) + 1);
      return { label: t('History'), rows: [...recent.map(({ r }): MonitorRow => ({ text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now, false), width) })),
        ...[...by].map(([m, n]) => plain(`  ${muted(mark('▸', '>'))} ${NO_MILESTONE.test(m) ? t('other') : monitorText(m)}  ${sliceInk('accepted')(`${mark('✓', '+')} ${n}`)}`, width))] };
    }
    return slicePreview(input, data, state, board, width, now, cursor);
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: PROJECT_FILE_HINTS, focusHints: LEDGER_FOCUS_HINTS };
}
const NO_MILESTONE = /^[—–-]*$/;
const looseJobRows = (data: ProjectSnapshot, width: number, now: number): MonitorRow[] => unsliced(data).map((job) => ({
  item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}),
  text: pair(`${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))} ${muted(monitorText(job.title ?? job.package ?? ''))}`,
    job.asking ? theme.board.attention(`${t('asking')} ?`) : muted(minuteAge(job.at ?? null, now)), width),
}));
function progressTaskPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const tasks = progressTasks(data, state.prefs.projectLayout), marks = input.tryMarks;
  const pending = tasks.filter((task) => task.slices.some((r) => r.state === 'try')).length;
  const list: MonitorRow[] = tasks.length ? [progressTasksHeading(tasks.length, width, tryTotals(pending)), ...tasks.map((task) => progressTaskRow(task, data, state, width, now, marks))]
    : [plain('  ' + muted(t(data.statePath ? 'none' : 'no STATE.md')), width)];
  list.push(...looseJobRows(data, width, now));
  if (data.next.length) list.push({ item: 'split:next', ...(data.statePath ? { files: [data.statePath] } : {}),
    text: pair(`${muted(mark('→', '>'))} ${t('Next')}`, muted(String(data.next.length)), width) });
  const preview = (cursor?: string): Shown => {
    const task = tasks.find((g) => taskItem(g) === cursor);
    if (!task) return slicePreview(input, data, state, board, width, now, cursor);
    const rows = progressTaskDetails(task, data, state, width, now, board, input.modelEnabled, marks);
    const tries = task.slices.some((r) => r.state === 'try');
    return { label: taskLabel(task), rows, hints: [...(tries ? TRY_ACTIONS : []), ...(rows.some((r) => r.item) ? ['⏎ details'] : []), 'Esc back', 'o file'] };
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: PROJECT_FILE_HINTS,
    focusHints: [...TRY_ACTIONS, ...LEDGER_FOCUS_HINTS] };
}

/** Keep Inbox's role-alert preview as it was; Enter on the alert now goes to Control. */
export function inboxRolePreview(data: ProjectSnapshot, width: number, now: number): (cursor?: string) => Shown {
  const mins = (until: number) => t('{n}m', { n: Math.max(1, Math.ceil((until - now) / 60000)) });
  const radar = radarFacts(data.radar);
  return (cursor?: string): Shown => {
    const role = data.roles.find((r) => `project:role:${r.role}` === cursor);
    if (!role) return { label: '', rows: [] };
    const place = (i: number): MonitorRow[] => {
      const p = role.places[i], tag = p.state === 'exhausted' ? theme.board.attention(`${t('exhausted')}${p.until === undefined ? '' : ' ' + mins(p.until)}`) : p.state === 'missing' ? muted(t('not installed')) : p.state === 'off' ? muted(t('Switched off'))
        : p.state === 'active' && role.places.findIndex((x) => x.state === 'active') === i ? theme.board.active(t('next job')) : '';
      return placeRows(`  ${glyph(p.state)} `, p, width, '  ', tag, placeTarget(role, i, data), p.state === 'active' ? undefined : muted, false);
    };
    const today = radar.roles.find(([name]) => name === role.role)?.[1];
    return { label: monitorText(role.role), right: [t('{n} places', { n: role.places.length }), role.preset === undefined ? '' : `${t('preset')}: ${monitorText(role.preset ?? t('custom'))}`].filter(Boolean).join(' · '),
      rows: [...role.places.flatMap((_, i) => place(i)), boardRow(''), ...kvRows('source file', `${t(role.source)} · ${basename(role.path)}`, width, undefined, 11),
        ...(today ? kvRows('today', roleToday(today), width, undefined, 6) : [])] };
  };
}

/** Tickets: a ticket a row under its lane (as Classic), the cursor ticket's checklist and latest comment below; Enter opens its file. */
function ticketsPart(data: ProjectSnapshot, state: MonitorState, width: number, now: number): Part {
  const folded = state.project.folded, seen = new Set<string>(), prefix = 'project:fold:ticket:';
  if (state.prefs.acceptance !== 'slice') {
    const list = data.tickets.map((feature) => featureRow(feature, width));
    const preview = (cursor?: string): Shown => {
      const feature = data.tickets.find((f) => featureItem(f) === cursor);
      return feature ? { label: monitorText(feature.slug), rows: ticketRows(data, folded, width, now, feature).slice(1) } : { label: '', rows: [] };
    };
    return { list, preview, start: list[0]?.item, hints: ['⏎ details', 'Esc back'], focusHints: ['⏎ details', 'Esc back', 'o file'] };
  }
  const filtering = !!state.project.filter?.query;
  const list = [...ticketRows(data, folded, width, now, undefined, filtering).filter((r) => !r.item || (!seen.has(r.item) && seen.add(r.item)))
    .map((r) => (r.item?.startsWith(prefix) ? { ...r, item: `project:tk:${r.item.slice(prefix.length)}` } : r))];
  const preview = (cursor?: string): Shown => {
    const key = /^project:tk:(.+)$/.exec(cursor ?? '')?.[1];
    const ticket = data.tickets.flatMap((f) => f.tickets.map((x) => ({ x, key: `${f.slug}:${basename(x.path)}` }))).find((o) => o.key === key)?.x;
    if (!key || !ticket) return { label: '', rows: [] };
    const rows = ticketRows(data, new Set([...folded, `ticket:${key}`]), width, now, undefined, filtering).filter((r) => r.item === prefix + key).slice(1);
    const number = monitorText(ticket.number), right = monitorText(ticket.status);
    const room = width - visualLength(number) - 1 - (right ? visualLength(right) + 2 : 1);
    return { label: `${number} ${cutTicketTitle(ticket.title, room)}`, right, rows: bare(rows) };
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: PROJECT_FILE_HINTS };
}

/** Working tree and Docs: each fact a row, its whole text, path and age underneath. */
function factsPart(page: 'tree' | 'docs', data: ProjectSnapshot, width: number, now: number): Part {
  const git = data.git, facts = page === 'docs' ? data.docs : [
    ...(git ? [{ label: 'branch', value: [git.branch, t('{n} changed', { n: git.changed }), git.ahead === null ? '' : `${git.ahead} ${t('ahead')}`, git.behind ? `${git.behind} ${t('behind')}` : ''].filter(Boolean).join(' · ') }] : []),
    ...data.editing, ...(data.last ? [{ label: 'last', value: data.last.text, at: data.last.at }] : []),
    ...unlisted(data).map((r) => ({ label: '!', value: `${r.label} · ${t('not in ledger')}` }))];
  const list = [...facts.map((r, i) => ({ ...projectItem(r, i, '', width, now), item: `project:row:${i}` }))];
  const preview = (cursor?: string): Shown => {
    const r = facts[Number(/^project:row:(\d+)$/.exec(cursor ?? '')?.[1])];
    return !r ? { label: '', rows: [] } : { label: r.label === '!' ? t('Unlisted worktrees') : t(r.label), right: 'at' in r && r.at !== undefined ? minuteAge(r.at, now) : '',
      rows: [...flowLines(monitorText(r.value), width - 2).map((l) => plain('  ' + l, width)),
        ...diffStatRows(page === 'tree' && r.label === 'branch' ? data.gitDiff : undefined, width),
        ...('path' in r && r.path ? [plain('  ' + muted(basename(r.path)), width)] : [])] };
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: PROJECT_FILE_HINTS };
}

/** The scene of a Project page the layout draws; `undefined` for the pages Classic keeps (one waiting item's text, the Projects list). */
export function projectScene(input: MonitorData, state: MonitorState, board: WorkboardSnapshot, page: ProjectPage | undefined, width: number, now: number): SplitScene | undefined {
  const data = input.project;
  if (!data || page === 'waiting') return undefined;
  const layout = state.prefs.projectLayout;
  const part = !page ? (layout === 'board' ? boardHubPart(input, data, state, board, width, now) : layout === 'inbox' ? inboxHubPart(input, data, state, board, width, now) : hubPart(input, data, state, board, width, now))
    : page === 'progress' ? (state.prefs.acceptance !== 'slice' ? progressTaskPart(input, data, state, board, width, now) : layout === 'board' ? boardProgressPart(input, data, state, board, width, now) : layout === 'inbox' ? inboxProgressPart(input, data, state, board, width, now) : progressPart(input, data, state, board, width, now))
    : page === 'tickets' ? ticketsPart(data, state, width, now) : factsPart(page, data, width, now);
  const scene = projectSplitScene(state.project.nav, part, `project|${page ?? 'hub'}|${state.selectedProject ?? ''}`);
  return (input.projects?.length ?? 0) > 1 ? scene : { ...scene, hints: scene.hints.filter((hint) => hint !== '[ ] project') };
}

/** Shared cursor/preview machinery; each view supplies its own navigation and rows. */
export function projectSplitScene(nav: ClassicSplitNav, part: Part, view: string): SplitScene & { hints: readonly string[] } {
  const { split } = nav;
  const items = splitItems(part.list), wait = (at?: string) => (at?.startsWith('project:wait:') && items.includes('project:fold:waiting') ? 'project:fold:waiting' : at);
  let focus = split.focus === 'preview', cursor = wait(focus ? split.listCursor : nav.cursor);
  cursor = cursor && items.includes(cursor) ? cursor : part.start;
  let shown = part.preview(cursor), previewCursor = split.previewCursor;
  // Classic moved the cursor: to another row of this preview (a place added or moved), or off it (a page opened, a project switched).
  if (focus && nav.cursor !== previewCursor) {
    if (splitItems(shown.rows).includes(nav.cursor ?? '')) previewCursor = nav.cursor;
    else { focus = false; cursor = wait(nav.cursor); cursor = cursor && items.includes(cursor) ? cursor : part.start; shown = part.preview(cursor); }
  }
  const scope = `${view}|${cursor}`;
  const sub = focus && shown.rows.some((row) => row.item === previewCursor) ? previewCursor : undefined;
  const hints = !sub ? shown.hints ?? part.hints : shown.act ? [...TRY_ACTIONS, 'Esc back'] : part.focusHints ?? part.hints;
  return { list: part.list, cursor, rule: { label: shown.label, right: shown.right }, preview: shown.rows, sub, act: sub ? undefined : shown.act,
    scope, hints, nav: { ...nav, cursor: sub ?? cursor, split: { ...split, focus: sub ? 'preview' : 'list', listCursor: cursor, previewCursor,
      previewFor: scope, previewScroll: split.previewFor === scope ? split.previewScroll : 0 } } };
}

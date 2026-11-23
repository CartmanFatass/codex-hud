/** Split Project and shared list/preview navigation for Project and Control. */
import type { LedgerSlice, ProjectSnapshot } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import type { ClassicSplitNav } from './monitor-state.js';
import { briefStack, clampClean, clampLines, cutTicketTitle, landedMark, landedNewest, ledgerText, ledgerFoldItem, newestTasks, roleInk, sinceText,
  sliceInk, trySentence, ticketRows, unlisted, unsliced, ticketPreview, projectItem, trySelectionMark, taskDetailRows, taskItem, taskLabel,
  progressTasks, progressTaskHeader, progressTaskDetails, progressTasksHeading, sliceDetailRows, featureItem, featureRow,
  type ProjectPage } from './project-view.js';
import { glyph, placeRows, placeTarget, radarFacts, roleToday } from './control-view.js';
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
export const TRY_ACTIONS = ['Space mark', 'y accept', 'n flag', 'm request land'] as const;
export const HUB_HINTS = ['⏎ open', '[ ] project'] as const;
export const HUB_TRY_HINTS = [...TRY_ACTIONS, ...HUB_HINTS];
export const PROJECT_FILE_HINTS = ['⏎ open file', 'Esc back'] as const;
export const LEDGER_FOCUS_HINTS = ['⏎ fold / unfold the ledger line', 'Esc back'] as const;
const muted = (text: string) => theme.board.muted(text);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const indent = (text: string, width: number, max: number) => clampLines(text, width - 2, max).lines.map((l) => plain('  ' + l, width));
const tryTotals = (n: number) => (n ? t('{n} to try', { n }) : '');

/** To-try slices for the hub's Progress preview: `Space`/`y`/`n` act on `act` or the focused row. */
export function hubTryRows(data: ProjectSnapshot, state: MonitorState, width: number, now: number, marks?: ReadonlyMap<string, TryAction>) {
  const queue = landedNewest(data).filter(({ r }) => r.state === 'try');
  const todo = queue.filter(({ r }) => !marks?.get(r.id)), done = queue.filter(({ r }) => marks?.get(r.id));
  const tryRows = ({ r }: { r: LedgerSlice }, act: boolean): MonitorRow[] => {
    const item = `project:try:${r.id}`, sentence = trySentence(r);
    const head = `  ${trySelectionMark(state, item)}${landedMark(r, marks?.get(r.id))} ${monitorText(r.id)}`, age = muted(sinceText(r.at, now)), body = monitorText(ledgerText(r));
    const fits = visualLength(head) + 2 + visualLength(body) + visualLength(age) + 1 <= width;
    const lines = sentence ? briefStack(head, sentence, age, width) : fits && body ? [pair(`${head}  ${muted(body)}`, age, width)]
      : [pair(head, age, width), ...clampClean(body, width - 4, Infinity).lines.map((l) => fit('    ' + muted(l), width))];
    const file = r.path ?? data.statePath;
    return lines.map((text) => ({ item, ...(file ? { files: [file] } : {}), ...(act ? { tryTarget: { milestone: r.milestone, slices: [r] } } : {}), text }));
  };
  return {
    rows: queue.length ? [boardRow(''), plain(muted(t('To try')), width), ...todo.flatMap((x) => tryRows(x, true)), ...done.flatMap((x) => tryRows(x, false))] : [],
    act: todo.length ? `project:try:${todo[0].r.id}` : undefined,
  };
}

const PROGRESS_FOLD_HINTS = [...TRY_ACTIONS, '⏎ details', 'Esc back', 'o file'];
const TRY_HINTS = [...TRY_ACTIONS, ...PROJECT_FILE_HINTS];
/** Preview for a slice, Next, or unsliced job on Split Project. */
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
  const job = data.active.find((j) => `project:job:${j.jobId}` === cursor);
  return { label: monitorText(job?.role ?? ''), rows: job ? indent(job.title ?? job.package ?? '', width, 3) : [] };
}

const NO_MILESTONE = /^[—–-]*$/;
const looseJobRows = (data: ProjectSnapshot, width: number, now: number): MonitorRow[] => unsliced(data).map((job) => ({
  item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}),
  text: pair(`${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))} ${muted(monitorText(job.title ?? job.package ?? ''))}`,
    job.asking ? theme.board.attention(`${t('asking')} ?`) : muted(minuteAge(job.at ?? null, now)), width),
}));
function progressTaskPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const tasks = progressTasks(data), marks = input.tryMarks;
  const pending = tasks.filter((task) => task.slices.some((r) => r.state === 'try')).length;
  const list: MonitorRow[] = tasks.length ? [progressTasksHeading(tasks.length, width, tryTotals(pending)), ...tasks.flatMap((task) => progressTaskHeader(task, data, state, width, now, marks))]
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
  const list = [...ticketRows(data, folded, width, now, undefined, filtering).filter(r => !r.item?.startsWith('project:fold:original:')).filter((r) => !r.item || (!seen.has(r.item) && seen.add(r.item)))
    .map((r) => (r.item?.startsWith(prefix) ? { ...r, item: `project:tk:${r.item.slice(prefix.length)}` } : r))];
  const preview = (cursor?: string): Shown => {
    const key = /^project:tk:(.+)$/.exec(cursor ?? '')?.[1];
    const ticket = data.tickets.flatMap((f) => f.tickets.map((x) => ({ x, key: `${f.slug}:${basename(x.path)}` }))).find((o) => o.key === key)?.x;
    if (!key || !ticket) return { label: '', rows: [] };
    const rows = ticketPreview(data, key, folded, width, now, filtering);
    const number = monitorText(ticket.number), right = monitorText(ticket.status);
    const room = width - visualLength(number) - 1 - (right ? visualLength(right) + 2 : 1);
    return { label: `${number} ${cutTicketTitle(ticket.title, room)}`, right, rows };
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
  const part = !page ? inboxHubPart(input, data, state, board, width, now)
    : page === 'progress' ? (state.prefs.acceptance !== 'slice' ? progressTaskPart(input, data, state, board, width, now) : inboxProgressPart(input, data, state, board, width, now))
    : page === 'tickets' ? ticketsPart(data, state, width, now) : factsPart(page, data, width, now);
  const scene = projectSplitScene(state.project.nav, part, `project|${page ?? 'hub'}|${state.selectedProject ?? ''}`);
  return (input.projects?.length ?? 0) > 1 ? scene : { ...scene, hints: scene.hints.filter((hint) => hint !== '[ ] project') };
}

/** Shared cursor/preview machinery; each view supplies its own navigation and rows. */
export function projectSplitScene(nav: ClassicSplitNav, part: Part, view: string): SplitScene & { hints: readonly string[] } {
  const { split } = nav;
  const items = splitItems(part.list);
  let focus = split.focus === 'preview', cursor = focus ? split.listCursor : nav.cursor;
  cursor = cursor && items.includes(cursor) ? cursor : part.start;
  let shown = part.preview(cursor), previewCursor = split.previewCursor;
  // Classic moved the cursor: to another row of this preview (a place added or moved), or off it (a page opened, a project switched).
  if (focus && nav.cursor !== previewCursor) {
    if (splitItems(shown.rows).includes(nav.cursor ?? '')) previewCursor = nav.cursor;
    else { focus = false; cursor = nav.cursor; cursor = cursor && items.includes(cursor) ? cursor : part.start; shown = part.preview(cursor); }
  }
  const scope = `${view}|${cursor}`;
  const sub = focus && shown.rows.some((row) => row.item === previewCursor) ? previewCursor : undefined;
  const hints = !sub ? shown.hints ?? part.hints : shown.act ? [...TRY_ACTIONS, 'Esc back'] : part.focusHints ?? part.hints;
  return { list: part.list, cursor, rule: { label: shown.label, right: shown.right }, preview: shown.rows, sub, act: sub ? undefined : shown.act,
    scope, hints, nav: { ...nav, cursor: sub ?? cursor, split: { ...split, focus: sub ? 'preview' : 'list', listCursor: cursor, previewCursor,
      previewFor: scope, previewScroll: split.previewFor === scope ? split.previewScroll : 0 } } };
}

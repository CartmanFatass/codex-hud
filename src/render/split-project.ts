/** Split Project and shared list/preview navigation for Project and Control. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import type { ClassicSplitNav } from './monitor-state.js';
import { clampLines, roleInk, sliceInk, ticketRows, unlisted, unsliced, projectItem, taskItem, taskLabel,
  progressTasks, progressTaskHeader, progressTaskDetails, progressTasksHeading, sliceDetailRows, featureItem, featureRow,
  type ProjectPage } from './project-view.js';
import { glyph, placeRows, placeTarget, radarFacts, roleToday } from './control-view.js';
import { inboxHubPart } from './inbox-project.js';
import { diffStatRows } from './diff-stat-rows.js';
import { splitItems, type SplitScene } from './split-frame.js';
import { boardRow, kvRows, mark, minuteAge, section } from './workboard-rows.js';
import { fit, flowLines, monitorText, pair } from './monitor-text.js';
import { theme } from './colors.js';
import { t } from './i18n.js';
import { basename } from 'node:path';

export type Shown = { label: string; right?: string; rows: MonitorRow[]; /** The footer while the keys are in the list, where the row's own keys differ from the page's. */ hints?: readonly string[] };
export interface Part { list: MonitorRow[]; start?: string; preview: (cursor?: string) => Shown; hints: readonly string[]; focusHints?: readonly string[] }
export const HUB_HINTS = ['⏎ open', '[ ] project'] as const;
const PROJECT_FILE_HINTS = ['⏎ open file', 'Esc back'] as const;
const muted = (text: string) => theme.board.muted(text);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const indent = (text: string, width: number, max: number) => clampLines(text, width - 2, max).lines.map((l) => plain('  ' + l, width));

/** Preview for a slice, Next, or unsliced job on Split Project. */
export function slicePreview(input: MonitorData, data: ProjectSnapshot, board: WorkboardSnapshot, width: number, now: number, cursor?: string): Shown {
  const id = /^project:slice:(.+)$/.exec(cursor ?? '')?.[1], r = data.ledger.find((x) => x.id === id);
  if (r) {
    const rows = sliceDetailRows(r, data, width, now, board, input.modelEnabled);
    return { label: monitorText(r.id), right: `${t(r.state === 'try' ? 'to try' : r.state)}${NO_MILESTONE.test(r.milestone) ? '' : ' · ' + monitorText(r.milestone)}`, rows };
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
function progressTaskPart(input: MonitorData, data: ProjectSnapshot, board: WorkboardSnapshot, width: number, now: number): Part {
  const tasks = progressTasks(data);
  const list: MonitorRow[] = tasks.length ? [progressTasksHeading(tasks.length, width), ...tasks.map((task) => progressTaskHeader(task, data, width, now))]
    : [plain('  ' + muted(t(data.statePath ? 'none' : 'no STATE.md')), width)];
  list.push(...looseJobRows(data, width, now));
  if (data.next.length) list.push({ item: 'split:next', ...(data.statePath ? { files: [data.statePath] } : {}),
    text: pair(`${muted(mark('→', '>'))} ${t('Next')}`, muted(String(data.next.length)), width) });
  const preview = (cursor?: string): Shown => {
    const task = tasks.find((g) => taskItem(g) === cursor);
    if (!task) return slicePreview(input, data, board, width, now, cursor);
    return { label: taskLabel(task), rows: progressTaskDetails(task, data, width, now, board, input.modelEnabled), hints: ['Esc back', 'o file'] };
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: PROJECT_FILE_HINTS };
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

/** Tickets: select a feature to see its tickets by state; Enter moves into the preview. */
function ticketsPart(data: ProjectSnapshot, state: MonitorState, width: number, now: number): Part {
  const list = data.tickets.map((feature) => featureRow(feature, width));
  const preview = (cursor?: string): Shown => {
    const feature = data.tickets.find((f) => featureItem(f) === cursor);
    return feature ? { label: monitorText(feature.slug), rows: ticketRows(data, state.project.folded, width, now, feature).slice(1) } : { label: '', rows: [] };
  };
  return { list, preview, start: list[0]?.item, hints: ['⏎ details', 'Esc back'], focusHints: ['⏎ details', 'Esc back', 'o file'] };
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
    : page === 'progress' ? progressTaskPart(input, data, board, width, now)
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
  const hints = !sub ? shown.hints ?? part.hints : part.focusHints ?? part.hints;
  return { list: part.list, cursor, rule: { label: shown.label, right: shown.right }, preview: shown.rows, sub,
    scope, hints, nav: { ...nav, cursor: sub ?? cursor, split: { ...split, focus: sub ? 'preview' : 'list', listCursor: cursor, previewCursor,
      previewFor: scope, previewScroll: split.previewFor === scope ? split.previewScroll : 0 } } };
}

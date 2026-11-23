/** The Project Progress and Tickets filter. Typing owns printable keys. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { ledgerTasks } from '../collectors/acceptance-tasks.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { activeFilter, projectPage, type ViewFilter } from './monitor-state.js';
import { boardRow, mark, type FooterHints } from './workboard-rows.js';
import { monitorText, pair } from './monitor-text.js';
import { theme } from './colors.js';
import { t } from './i18n.js';

const FILTER_MAX = 48;
export function filterScope(state: MonitorState): string | undefined {
  if (state.help || state.subpage || state.activeTab !== 'project') return undefined;
  const page = projectPage(state.project.view);
  return page === 'progress' || page === 'tickets' ? `${page}|${state.selectedProject ?? ''}` : undefined;
}
export function clearFilter(state: MonitorState): MonitorState {
  if (state.project.filter) return { ...state, project: { ...state.project, filter: undefined } };
  return state;
}
const has = (needle: string, ...fields: (string | null | undefined)[]) => fields.some((f) => !!f && f.toLowerCase().includes(needle));

/** Progress: ledger slices by id, milestone, text and state, worktree slices and loose jobs by their label, role and state. Tickets: by feature, number, title, status and blocker. */
export function filterProject(data: ProjectSnapshot, page: 'progress' | 'tickets', needle: string): { data: ProjectSnapshot; count: number } {
  if (page === 'tickets') {
    const match = (f: ProjectSnapshot['tickets'][number], r: ProjectSnapshot['tickets'][number]['tickets'][number]) => has(needle, f.slug, r.number, r.title, r.status, ...r.blockers);
    const tickets = data.tickets.filter((f) => f.tickets.some((r) => match(f, r)));
    return { data: { ...data, tickets }, count: tickets.length };
  }
  // A worktree slice and its ledger row match together; jobs outside any slice are matched alone.
  const matchedLabels = new Set(data.slices.filter((s) => has(needle, s.label, s.value, s.role, s.ledgerState, s.drift, s.ledgerState && t(s.ledgerState))).map((s) => s.label));
  const matching = data.ledger.filter((r) => matchedLabels.has(r.id) || has(needle, r.id, r.milestone, r.text, r.state, t(r.state === 'try' ? 'to try' : r.state)));
  // A matching member reveals its whole task.
  const matched = new Set(matching), tasks = ledgerTasks(data.ledger).filter((task) => task.slices.some((r) => matched.has(r)));
  for (const task of tasks) for (const r of task.slices) matched.add(r);
  const ledger = data.ledger.filter((r) => matched.has(r));
  const ledgerIds = new Set(ledger.map((r) => r.id));
  const slices = data.slices.filter((s) => matchedLabels.has(s.label) || ledgerIds.has(s.label));
  const loose = data.active.filter((a) => !data.slices.some((s) => s.jobId === a.jobId) && has(needle, a.role, a.title, a.package, a.state));
  const count = tasks.length + loose.length;
  return { data: { ...data, ledger, slices, active: loose, next: [], summary: '' }, count };
}

/** The bar: `/ query▌` and how many rows match (not before something is typed). */
export function filterRow(state: MonitorState, count: number | undefined, width: number): MonitorRow {
  const filter = activeFilter(state)!;
  const left = `${theme.board.active('/')} ${monitorText(filter.query)}${filter.editing ? theme.board.active(mark('▌', '_')) : ''}`;
  const right = count === undefined ? '' : [t(count === 1 ? '{n} match' : '{n} matches', { n: count }), !filter.editing && t('esc clear')].filter(Boolean).join(' · ');
  return boardRow(pair(left, theme.board.muted(right), width));
}
/** `/ filter` is a page action; while typing only the filter's own keys are relevant. */
export function filterHints(state: MonitorState, hints: FooterHints): FooterHints {
  if ('modal' in hints || !filterScope(state)) return hints;
  if (activeFilter(state)?.editing) return { modal: ['type to filter', '⏎ keep', 'Esc stop'] };
  return [...hints, '/ filter'];
}

/**
 * `/` opens the bar; while it is open every printable key is the query's (so `g`, `X`, `w`, `r`, digits, `=`, `-` and `q` do nothing
 * else), Backspace edits, Enter keeps the filter and stops typing, Esc stops typing, and Esc again clears it. Left, Right and Tab
 * wait while typing; the arrows move over the matches. Null for every other input.
 */
export function filterInput(state: MonitorState, input: WorkbenchInput): MonitorOutcome | null {
  if (input.type !== 'key' || !filterScope(state)) return null;
  const to = (filter?: ViewFilter): MonitorOutcome => ({
    state: { ...state, project: { ...state.project, filter } }, close: false,
  });
  const filter = state.project.filter, query = [...(filter?.query ?? '')];
  if (filter?.editing) {
    if (input.text !== undefined) return to({ editing: true, query: [...query, ...input.text].slice(0, FILTER_MAX).join('') });
    if (input.key === 'backspace') return to({ editing: true, query: query.slice(0, -1).join('') });
    if (input.key === 'enter' || input.key === 'escape') return to(filter.query ? { ...filter, editing: false } : undefined);
    return ['left', 'right', 'tab', 'shift-tab'].includes(input.key) ? { state, close: false } : null;
  }
  if (input.text === '/') return to({ query: filter?.query ?? '', editing: true });
  if (input.key === 'escape' && filter?.query) return to();
  return null;
}

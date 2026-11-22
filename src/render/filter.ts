/**
 * The `/` filter (spec §2.2): a one-row bar under the header on Home (either layout) and on Project's Progress and Tickets pages.
 * A pure, case-insensitive substring over the fields each view names. The views draw only the rows that match, so the cursor,
 * Enter and Split's preview move over those. Typing owns every printable key; Enter keeps the filter, Esc stops typing and then
 * clears it; leaving the view (tab, page, project, Help, Inspector) clears it. Home and Project each own their filter.
 */
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { ledgerTasks } from '../collectors/acceptance-tasks.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import type { MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { activeFilter, activeTabState, projectPage, type ViewFilter } from './monitor-state.js';
import { failed } from './work-card.js';
import { boardRow, mark, type FooterHints } from './workboard-rows.js';
import { monitorText, pair } from './monitor-text.js';
import { theme } from './colors.js';
import { t } from './i18n.js';

const FILTER_MAX = 48;
/** Where a filter can be: Home, or the shown project's Progress or Tickets page. Another scope clears it. */
export function filterScope(state: MonitorState): string | undefined {
  if (state.help || state.subpage) return undefined;
  if (state.activeTab === 'home') return 'home';
  if (state.activeTab !== 'project') return undefined;
  const page = projectPage(state.project.view);
  return page === 'progress' || page === 'tickets' ? `${page}|${state.selectedProject ?? ''}` : undefined;
}
export function clearFilter(state: MonitorState): MonitorState {
  if (state.activeTab === 'home' && state.home.filter) return { ...state, home: { ...state.home, filter: undefined } };
  if (state.activeTab === 'project' && state.project.filter) return { ...state, project: { ...state.project, filter: undefined } };
  return state;
}
const has = (needle: string, ...fields: (string | null | undefined)[]) => fields.some((f) => !!f && f.toLowerCase().includes(needle));

/** Home: package, title, role, harness, status, worker summary or model-sentence keywords. */
export function homeMatcher(board: WorkboardSnapshot, needle: string, now: number, stall?: number) {
  const label = new Map(board.lanes.map((l) => [l.id, l.label]));
  const own = (w: OwnerWorker) => {
    const card = projectWorkCard(w, now, stall), { plain, spans } = keywordMarks(monitorText(w.modelSentence ?? ''));
    const word = failed(card) ? 'failed' : w.state === 'stopped' ? 'stopped' : card.state === 'needs-you' ? 'asking'
      : card.state === 'stalled' ? 'stalled' : card.state === 'in-progress' ? 'working' : 'done';
    return has(needle, label.get(w.laneId), card.title, card.role, w.harness, word, t(word), w.reportMeta?.summary,
      w.flow?.kind, w.flow?.state, w.flow?.step, ...(w.flow?.steps.flatMap((s) => [s.key, t(s.key)]) ?? []),
      ...spans.map((s) => plain.slice(s.start, s.end)));
  };
  // A sonic child that matches brings its parent, which it is drawn under.
  return (w: OwnerWorker) => own(w) || board.workers.some((c) => c.parentJobId === w.id && own(c));
}

/** Progress: ledger slices by id, milestone, text and state, worktree slices and loose jobs by their label, role and state. Tickets: by feature, number, title, status and blocker. */
export function filterProject(data: ProjectSnapshot, page: 'progress' | 'tickets', needle: string, acceptance?: MonitorState['prefs']['acceptance'], onlyTry = false): { data: ProjectSnapshot; count: number } {
  if (page === 'tickets') {
    const match = (f: ProjectSnapshot['tickets'][number], r: ProjectSnapshot['tickets'][number]['tickets'][number]) => has(needle, f.slug, r.number, r.title, r.status, ...r.blockers);
    if (acceptance !== 'slice') {
      const tickets = data.tickets.filter((f) => f.tickets.some((r) => match(f, r)));
      return { data: { ...data, tickets }, count: tickets.length };
    }
    const tickets = data.tickets.map((f) => ({ ...f, tickets: f.tickets.filter((r) => match(f, r)) })).filter((f) => f.tickets.length);
    return { data: { ...data, tickets }, count: tickets.reduce((n, f) => n + f.tickets.length, 0) };
  }
  // A worktree slice and its ledger row match together; jobs outside any slice are matched alone.
  const matchedLabels = new Set(data.slices.filter((s) => has(needle, s.label, s.value, s.role, s.ledgerState, s.drift, s.ledgerState && t(s.ledgerState))).map((s) => s.label));
  const matching = data.ledger.filter((r) => matchedLabels.has(r.id) || has(needle, r.id, r.milestone, r.text, r.state, t(r.state === 'try' ? 'to try' : r.state)));
  // A matching member reveals the task, never a partial acceptance target.
  const matched = new Set(matching), tasks = acceptance === 'slice' ? undefined : ledgerTasks(data.ledger).filter((task) =>
    (!onlyTry || task.slices.some((r) => r.state === 'try')) && task.slices.some((r) => matched.has(r)));
  for (const task of tasks ?? []) for (const r of task.slices) matched.add(r);
  const ledger = tasks ? data.ledger.filter((r) => matched.has(r)) : matching;
  const ledgerIds = new Set(ledger.map((r) => r.id));
  const slices = data.slices.filter((s) => matchedLabels.has(s.label) || ledgerIds.has(s.label));
  const loose = data.active.filter((a) => !data.slices.some((s) => s.jobId === a.jobId) && has(needle, a.role, a.title, a.package, a.state));
  const count = tasks ? tasks.length + (onlyTry ? 0 : loose.length) : ledger.length + loose.length + slices.filter((s) => !ledgerIds.has(s.label)).length;
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
  const at = hints.indexOf('a all');
  return at < 0 ? [...hints, '/ filter'] : [...hints.slice(0, at), '/ filter', ...hints.slice(at)];
}

/**
 * `/` opens the bar; while it is open every printable key is the query's (so `g`, `X`, `w`, `r`, digits, `=`, `-` and `q` do nothing
 * else), Backspace edits, Enter keeps the filter and stops typing, Esc stops typing, and Esc again clears it. Left, Right and Tab
 * wait while typing; the arrows move over the matches. Null for every other input.
 */
export function filterInput(state: MonitorState, input: WorkbenchInput): MonitorOutcome | null {
  const tab = activeTabState(state);
  if (input.type !== 'key' || !tab || !filterScope(state) || state.overlay?.kind === 'confirm-stop') return null;
  const to = (filter?: ViewFilter): MonitorOutcome => ({
    state: { ...state, [state.activeTab]: { ...tab, filter } }, close: false,
  });
  const filter = tab.filter, query = [...(filter?.query ?? '')];
  if (filter?.editing) {
    if (input.text !== undefined) return to({ editing: true, query: [...query, ...input.text].slice(0, FILTER_MAX).join('') });
    if (input.key === 'backspace') return to({ editing: true, query: query.slice(0, -1).join('') });
    if (input.key === 'enter' || input.key === 'escape') return to(filter.query ? { ...filter, editing: false } : undefined);
    return ['left', 'right', 'tab', 'shift-tab'].includes(input.key) ? { state, close: false } : null;
  }
  if (input.text === '/') return to({ query: filter?.query ?? '', editing: true });
  // Split's preview gives Esc back to the list first; then it clears the filter before the page is left.
  const split = 'split' in tab ? tab.split : tab.nav.split;
  if (input.key === 'escape' && filter?.query && !(state.prefs.panelLayout === 'split' && split.focus === 'preview')) return to();
  return null;
}

/**
 * The `/` filter (spec §2.2): a one-row bar under the header on Home (either layout) and on Project's Progress and Tickets pages.
 * A pure, case-insensitive substring over the fields each view names. The views draw only the rows that match, so the cursor,
 * Enter and Split's preview move over those. Typing owns every printable key; Enter keeps the filter, Esc stops typing and then
 * clears it; leaving the view (tab, page, project, Help, Inspector) clears it. The state is `MonitorState.filterQuery`/`filterOpen`.
 */
import type { DecisionRecord, OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import type { MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { projectPageOf } from './project-view.js';
import { failed } from './work-card.js';
import { boardRow, mark } from './workboard-rows.js';
import { monitorText, pair } from './monitor-text.js';
import { theme } from './colors.js';
import { t } from './i18n.js';

const FILTER_MAX = 48;
/** Where a filter can be: Home, or the shown project's Progress or Tickets page. Another scope clears it. */
export function filterScope(state: MonitorState): string | undefined {
  if (state.help || state.focus !== 'agents') return undefined;
  if (state.mainTab !== 'project') return 'home';
  const page = projectPageOf(state);
  return page === 'progress' || page === 'tickets' ? `${page}|${state.projectRoot ?? ''}` : undefined;
}
export const filterNeedle = (state: MonitorState) => (state.filterQuery ?? '').toLowerCase();
const has = (needle: string, ...fields: (string | null | undefined)[]) => fields.some((f) => !!f && f.toLowerCase().includes(needle));

/** Home: a card matches on its package, title, role, harness, the keywords of its model sentence or its status word; a decision on its package or title. */
export function homeMatcher(board: WorkboardSnapshot, needle: string, now: number, stall?: number) {
  const label = new Map(board.lanes.map((l) => [l.id, l.label]));
  const own = (w: OwnerWorker) => {
    const card = projectWorkCard(w, now, stall), { plain, spans } = keywordMarks(monitorText(w.modelSentence ?? ''));
    const word = failed(card) ? 'failed' : w.state === 'stopped' ? 'stopped' : card.state === 'needs-you' ? 'asking'
      : card.state === 'stalled' ? 'stalled' : card.state === 'in-progress' ? 'working' : 'done';
    return has(needle, label.get(w.laneId), card.title, card.role, w.harness, word, t(word), ...spans.map((s) => plain.slice(s.start, s.end)));
  };
  return {
    // A sonic child that matches brings its parent, which it is drawn under.
    worker: (w: OwnerWorker) => own(w) || board.workers.some((c) => c.parentJobId === w.id && own(c)),
    decision: (d: DecisionRecord) => has(needle, label.get(d.laneId), d.title, d.modelTitle),
  };
}

/** Progress: ledger slices by id, milestone, text and state, worktree slices and loose jobs by their label, role and state. Tickets: by feature, number, title, status and blocker. */
export function filterProject(data: ProjectSnapshot, page: 'progress' | 'tickets', needle: string): { data: ProjectSnapshot; count: number } {
  if (page === 'tickets') {
    const tickets = data.tickets.map((f) => ({ ...f, tickets: f.tickets.filter((r) => has(needle, f.slug, r.number, r.title, r.status, ...r.blockers)) })).filter((f) => f.tickets.length);
    return { data: { ...data, tickets }, count: tickets.reduce((n, f) => n + f.tickets.length, 0) };
  }
  // A worktree slice and its ledger row match together; jobs outside any slice are matched alone.
  const matchedLabels = new Set(data.slices.filter((s) => has(needle, s.label, s.value, s.role, s.ledgerState, s.drift, s.ledgerState && t(s.ledgerState))).map((s) => s.label));
  const ledger = data.ledger.filter((r) => matchedLabels.has(r.id) || has(needle, r.id, r.milestone, r.text, r.state, t(r.state === 'try' ? 'to try' : r.state)));
  const ledgerIds = new Set(ledger.map((r) => r.id));
  const slices = data.slices.filter((s) => matchedLabels.has(s.label) || ledgerIds.has(s.label));
  const loose = data.active.filter((a) => !data.slices.some((s) => s.jobId === a.jobId) && has(needle, a.role, a.title, a.package, a.state));
  return { data: { ...data, ledger, slices, active: loose, next: [], summary: '' }, count: ledger.length + loose.length + slices.filter((s) => !ledgerIds.has(s.label)).length };
}

/** The bar: `/ query▌` and how many rows match (not before something is typed). */
export function filterRow(state: MonitorState, count: number | undefined, width: number): MonitorRow {
  const left = `${theme.board.active('/')} ${monitorText(state.filterQuery ?? '')}${state.filterOpen ? theme.board.active(mark('▌', '_')) : ''}`;
  const right = count === undefined ? '' : [t(count === 1 ? '{n} match' : '{n} matches', { n: count }), !state.filterOpen && t('esc clear')].filter(Boolean).join(' · ');
  return boardRow(pair(left, theme.board.muted(right), width));
}
/** The footer's hints (already in the language) with `/ filter` after `? help`, which stays where it was; while typing, the keys the bar takes. */
export function filterHints(state: MonitorState, hints: string): string {
  if (!filterScope(state)) return hints;
  if (state.filterOpen) return t('type to filter  ⏎ keep  esc stop  ↑↓ move');
  const parts = hints.split('  '), at = parts.findIndex((p) => p.startsWith('?'));
  parts.splice(at < 0 ? parts.length : at + 1, 0, `/ ${t('filter')}`);
  return parts.join('  ');
}

/**
 * `/` opens the bar; while it is open every printable key is the query's (so `g`, `X`, `w`, `r`, digits, `=`, `-` and `q` do nothing
 * else), Backspace edits, Enter keeps the filter and stops typing, Esc stops typing, and Esc again clears it. Left, Right and Tab
 * wait while typing; the arrows move over the matches. Null for every other input.
 */
export function filterInput(state: MonitorState, input: WorkbenchInput): MonitorOutcome | null {
  if (input.type !== 'key') return null;
  const to = (patch: Partial<MonitorState>): MonitorOutcome => {
    const next = { ...state, tree: { ...state.tree }, modes: { ...state.modes }, scroll: { ...state.scroll }, ...patch };
    if (!next.filterQuery) next.filterQuery = next.filterOpen ? '' : undefined;
    return { state: next, close: false };
  };
  const query = [...(state.filterQuery ?? '')];
  if (state.filterOpen) {
    if (input.text !== undefined) return to({ filterQuery: [...query, ...input.text].slice(0, FILTER_MAX).join('') });
    if (input.key === 'backspace') return to({ filterQuery: query.slice(0, -1).join('') });
    if (input.key === 'enter' || input.key === 'escape') return to({ filterOpen: undefined });
    return ['left', 'right', 'tab', 'shift-tab'].includes(input.key) ? to({}) : null;
  }
  if (!filterScope(state) || state.reply || state.confirmStop) return null;
  if (input.text === '/') return to({ filterOpen: true });
  // Split's preview gives Esc back to the list first; then it clears the filter before the page is left.
  if (input.key === 'escape' && state.filterQuery && !(state.panelLayout === 'split' && state.splitFocus === 'preview')) return to({ filterQuery: undefined });
  return null;
}

/**
 * The panel's delegation view (design §3.1, §3.4, §4.2, §4.6; rulings B10B-s2):
 * the agents pane drawn from `data.delegation` alone whenever it is non-null.
 *
 * Rows, top to bottom: the parent row (only when the viewpoint root is someone's
 * child, pinned with the summary), the summary row (the pane's heading: counts,
 * chips, workers, put away, spend), then the tree. Compact draws segment 1's rows
 * with a two-line micro card under the selected node; rich draws cards
 * (`cards.ts`). Pure: `nowMs` comes in; the only state is the 30 second stamp of
 * an unreadable ledger, which `nowMs` drives.
 */

import { colors, theme, visualLength } from '../colors.js';
import type { CountsText } from '../control-bar.js';
import { language } from '../i18n.js';
import { palette } from '../palette.js';
import type { MonitorRow } from '../monitor.js';
import type { DelegationViewModel } from '../../core/link/view-model.js';
import { slotsAlert } from './alerts.js';
import { countParts } from './bar.js';
import { glyphSet, type GlyphSet } from './glyphs.js';
import { delegationLine, focusLine, focusText, hasDelegationLine, parentRow } from './lines.js';
import { projectDelegation, spendText, type DelegationProjection, type PNode } from './projection.js';
import {
  clip,
  exact,
  planRows,
  PLAIN_INK,
  PUT_AWAY_MS,
  renderRow,
  type PlannedRow,
  type RenderContext,
  type RowPlan,
} from './rows.js';
import { richRows } from './cards.js';
import { destinationsOf, mixedDestinations, type Destinations } from './selection.js';
import type { SubagentTreeNode } from '../../types.js';
import { panelSay, W, type Say } from './style.js';

export interface DelegationPanelOptions {
  width: number;
  nowMs: number;
  style: 'rich' | 'compact';
  /** The panel's selection; a key that is not a planned row's selects nothing (rulings B10B-s2 Q6). */
  selectedId?: string | null;
  collapsed?: ReadonlySet<string>;
  showHistory?: boolean;
  sortByCreation?: boolean;
  ascii?: boolean;
  say?: Say;
  /** The rows the agents pane shows, pinned ones included: rich folds cards to fit it (§3.5). Absent: no limit. */
  viewport?: number;
  /** What to say when there is no viewpoint root but the ledger is readable (the legacy empty lines). */
  empty?: () => MonitorRow[];
}

/** What the agents pane is made of this frame: the projection, the plan, and the rows the selection can stand on. */
export interface DelegationView {
  vm: DelegationViewModel;
  proj: DelegationProjection;
  plan: RowPlan;
  dest: Destinations;
  style: 'rich' | 'compact';
  nowMs: number;
}

export type PlanOptions = Pick<DelegationPanelOptions, 'nowMs' | 'collapsed' | 'showHistory' | 'sortByCreation'>;

const ordinaryKeys = new WeakMap<DelegationViewModel, readonly string[]>();
/** Called by reconciliation with exactly the ordinary rows eligible for this frame. */
export function rememberMixedDestinations(vm: DelegationViewModel, keys: readonly string[]): void {
  ordinaryKeys.set(vm, keys);
}
/** Suppress only the ordinary copy of an exact legacy identity, retaining its children. */
export function mixedOrdinaryNodes(nodes: SubagentTreeNode[], vm: DelegationViewModel): SubagentTreeNode[] {
  const hasJobs = (items: SubagentTreeNode[]): boolean =>
    items.some((node) => !!node.job || node.id.startsWith('job-root:') || hasJobs(node.children));
  if (!hasJobs(nodes)) return [];
  const keys = new Set(vm.tree.nodes.map((node) => node.key));
  const suppress = (items: SubagentTreeNode[]): SubagentTreeNode[] =>
    items.flatMap((node) => (keys.has(node.id) ? suppress(node.children) : [node]));
  return suppress(nodes);
}
/** Keep one heading/summary; row presentation remains the existing renderers'. */
export function mixedAgentsRows(legacy: MonitorRow[], ordinary: MonitorRow[]): MonitorRow[] {
  if (!ordinary.some((row) => row.item)) return legacy;
  const a = legacy.find((row) => row.counts);
  const b = ordinary.find((row) => row.counts);
  return [
    ...legacy.map((row) =>
      row === a && a?.counts && b?.counts
        ? {
            ...row,
            counts: (words: boolean, figure: boolean) =>
              [a.counts!(words, figure), b.counts!(words, figure)].filter(Boolean).join('  '),
          }
        : row
    ),
    ...ordinary.filter((row) => !row.counts),
  ];
}

/** The view of a view model: the same memoised projection and plan the rows are drawn from. */
export function delegationView(
  vm: DelegationViewModel,
  options: PlanOptions & { style: 'rich' | 'compact' }
): DelegationView {
  const proj = projectDelegation(vm);
  const plan = planRows(proj, {
    nowMs: options.nowMs,
    collapsed: options.collapsed,
    showHistory: options.showHistory,
    sortByCreation: options.sortByCreation,
  });
  const dest = mixedDestinations(destinationsOf(plan, options.style), ordinaryKeys.get(vm) ?? []);
  return { vm, proj, plan, dest, style: options.style, nowMs: options.nowMs };
}

/**
 * What the `older` button counts: the rows the tree would put away with history hidden, as today's button does. It
 * is read while history is shown too (the button then offers to hide them); the plan it asks for is kept beside the
 * drawn one (`planRows` keeps one per option set), so the drawn plan is not evicted.
 */
export function delegationPutAway(vm: DelegationViewModel, options: PlanOptions): number {
  return planRows(projectDelegation(vm), {
    nowMs: options.nowMs,
    collapsed: options.collapsed,
    showHistory: false,
    sortByCreation: options.sortByCreation,
  }).putAway;
}

// ---------------------------------------------------------------------------
// The summary row (§4.2; rulings B10B-s2 Q4)

/** A non-busy degraded ledger turns its chip from muted to warning after this long (§7 #14). */
export const LEDGER_WARN_MS = 30_000;
let degradedSince: number | null = null;

/** Forgets the unreadable-ledger stamp (tests). */
export function resetLedgerStamp(): void {
  degradedSince = null;
}

/** The one coverage chip (precedence: unavailable > busy > partial > not loaded), and its role. */
export function coverageChip(
  proj: DelegationProjection,
  nowMs: number,
  say: Say
): { text: string; warning: boolean } | null {
  const tree = proj.vm.tree;
  const ledger = tree.ledger;
  if (proj.vm.nativeCalls && ledger.reason === 'legacy_ledger_not_used')
    return { text: say('tree partial'), warning: false };
  if (ledger.state === 'degraded' && ledger.reason !== 'ledger_busy') {
    if (degradedSince === null || degradedSince > nowMs) degradedSince = nowMs;
    return { text: say('ledger unavailable'), warning: nowMs - degradedSince >= LEDGER_WARN_MS };
  }
  degradedSince = null;
  if (ledger.state === 'degraded') return { text: say('ledger busy'), warning: false };
  const unloaded = tree.counts.knownUnloaded + tree.counts.omitted + proj.omittedConflictRows;
  if (unloaded > 0) return { text: say('{n} not loaded', { n: unloaded }), warning: false };
  if (tree.coverage.state !== 'complete' || tree.counts.unknownDescendants)
    return { text: say('tree partial'), warning: false };
  return null;
}

/** Whether a node sits inside a put-away subtree (a finished subtree past its linger window, §3.2). */
function putAway(pn: PNode, nowMs: number): boolean {
  for (let at: PNode | null = pn; at && at.parent; at = at.parent) {
    const finish = at.sub.youngestFinish;
    if (at.sub.allFinished && finish !== null && nowMs - finish >= PUT_AWAY_MS) return true;
  }
  return false;
}

/** Workers and jobs on the list: delegated sessions, intents and conflict children (one per child), and jobs. */
export function listedWorkers(
  proj: DelegationProjection,
  nowMs: number,
  showHistory: boolean
): { workers: number; jobs: number } {
  let workers = 0;
  let jobs = 0;
  const conflicts = new Set<string>();
  for (const pn of proj.nodes) {
    if (pn.proj.isRoot || pn.proj.isNative) continue;
    if (!showHistory && putAway(pn, nowMs)) continue;
    if (pn.node === null || pn.proj.detail.conflictCount > 0) {
      const child = pn.node === null ? pn.relation!.childKey : pn.key;
      if (conflicts.has(child)) continue;
      conflicts.add(child);
      workers++;
      continue;
    }
    if (pn.proj.detail.idKind === 'job') jobs++;
    else workers++;
  }
  return { workers, jobs };
}

/**
 * The summary row's text in its four forms (`CountsText`): counts and chips always; then `N put away`, `N workers,
 * N jobs` and the spend are shed in that order. `figure` false drops the workers, `words` false the put-away chip;
 * both false the spend too.
 */
export function summaryCounts(
  proj: DelegationProjection,
  plan: RowPlan,
  nowMs: number,
  g: GlyphSet,
  say: Say,
  showHistory: boolean
): CountsText {
  const counts = countParts(proj.counts, g).join(' ');
  const chips: string[] = [];
  const slots = slotsAlert(proj);
  if (slots) chips.push(theme.warning(`${say(W.slots)} ${slots.held}/${slots.limit}`));
  const coverage = coverageChip(proj, nowMs, say);
  if (coverage) chips.push(coverage.warning ? theme.warning(coverage.text) : colors.dim(coverage.text));
  const { workers, jobs } = listedWorkers(proj, nowMs, showHistory);
  const who = [
    workers > 0 ? say(workers === 1 ? '{n} worker' : '{n} workers', { n: workers }) : '',
    jobs > 0 ? say(jobs === 1 ? '{n} job' : '{n} jobs', { n: jobs }) : '',
  ]
    .filter(Boolean)
    .join(', ');
  const away = plan.putAway > 0 ? say('{n} put away', { n: plan.putAway }) : '';
  const spend = spendText(proj.spend, g.marker.flag === '@');
  const sep = ` ${colors.dim(g.sep)} `;
  return (words, figure) => {
    const level = (figure ? 0 : 2) + (words ? 0 : 1);
    return [
      counts,
      ...chips,
      level < 2 && who ? colors.dim(who) : '',
      level < 1 && away ? colors.dim(away) : '',
      level < 3 && spend ? colors.dim(spend) : '',
    ]
      .filter(Boolean)
      .join(sep);
  };
}

/** The summary row of a plan, kept while nothing it says changes (the plan is redrawn once a second). */
const summaryMemo = new WeakMap<RowPlan, { key: string; row: MonitorRow }>();

function summaryRow(
  proj: DelegationProjection,
  plan: RowPlan,
  nowMs: number,
  width: number,
  g: GlyphSet,
  say: Say,
  showHistory: boolean
): MonitorRow {
  // The chip is read every time: it keeps the unreadable ledger's 30 second stamp.
  const chip = coverageChip(proj, nowMs, say);
  const key = `${width}|${showHistory ? 1 : 0}|${chip ? `${chip.text}|${chip.warning ? 1 : 0}` : ''}|${g.marker.flag}|${sayKey(say)}|${language()}|${palette().name}`;
  const hit = summaryMemo.get(plan);
  if (hit && hit.key === key) return hit.row;
  const counts = summaryCounts(proj, plan, nowMs, g, say, showHistory);
  // The row's own text is the fullest form that fits (the pane's heading picks its own form the same way).
  const forms = [counts(true, true), counts(false, true), counts(true, false), counts(false, false)];
  const head = forms.find((form) => visualLength(form) <= width - 1) ?? forms[forms.length - 1];
  const row: MonitorRow = { text: exact(head ? ' ' + head : '', width), counts };
  summaryMemo.set(plan, { key, row });
  return row;
}

const sayKeys = new WeakMap<Say, number>();
let nextSayKey = 1;
function sayKey(say: Say): number {
  let id = sayKeys.get(say);
  if (id === undefined) {
    id = nextSayKey++;
    sayKeys.set(say, id);
  }
  return id;
}

/** A tree row whose text is drawn when the pane reads it (§6 #5): rows scrolled out of view cost no string. */
class PlanRowText implements MonitorRow {
  private value: string | undefined;
  readonly item: string;
  readonly key: string;
  constructor(
    private readonly row: PlannedRow,
    private readonly ctx: RenderContext
  ) {
    this.item = row.key;
    this.key = row.key;
  }
  get text(): string {
    return (this.value ??= renderRow(this.row, this.ctx));
  }
}

// ---------------------------------------------------------------------------
// Compact (§3.4)

/** The micro card's lead: the selection's rule, the row's tree columns carried down, two columns in. */
function microLead(row: PlannedRow, g: GlyphSet): { text: string; width: number } {
  let out = '';
  for (const cont of row.ancestors) out += cont ? `${g.edge.line} ` : '  ';
  out += row.tee === 'tee' ? `${g.edge.line} ` : row.tee === 'none' ? ' ' : '  ';
  out += '  ';
  return { text: theme.accent(g.edge.line) + colors.dim(out), width: 1 + visualLength(out) };
}

/** The two lines under the selected node: its delegation line, then its focus line; each only when it has data. */
export function microCard(
  row: PlannedRow,
  proj: DelegationProjection,
  width: number,
  nowMs: number,
  g: GlyphSet,
  say: Say
): string[] {
  const pn = row.pn!;
  const lead = microLead(row, g);
  const room = width - lead.width;
  if (room < 4) return [];
  const lines: string[] = [];
  if (hasDelegationLine(pn)) {
    const text = delegationLine(pn, proj, room, nowMs, g, say, PLAIN_INK, width);
    if (text) lines.push(text);
  }
  const focus = focusLine(pn, nowMs, g, say);
  if (focus) lines.push(focusText(focus, room, width, g, PLAIN_INK));
  return lines.map((text) => exact(lead.text + clip(text, room, g), width));
}

function compactRows(
  proj: DelegationProjection,
  plan: RowPlan,
  ctx: RenderContext,
  g: GlyphSet,
  say: Say
): MonitorRow[] {
  const rows: MonitorRow[] = [];
  for (const row of plan.rows) {
    rows.push(new PlanRowText(row, ctx));
    if (row.kind === 'node' && row.key === ctx.selectedKey)
      for (const text of microCard(row, proj, ctx.width, ctx.nowMs, g, say))
        rows.push({ text, item: row.key, key: row.key });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The view

/**
 * The agents view's rows for a delegation view model: [parent row,] summary row, then the tree (compact) or the
 * cards (rich). Each row is exactly `width` columns.
 */
export function delegationAgentsRows(vm: DelegationViewModel, options: DelegationPanelOptions): MonitorRow[] {
  const proj = projectDelegation(vm);
  const g = glyphSet(options.ascii);
  const say = options.say ?? panelSay;
  const { width, nowMs } = options;
  const plan = planRows(proj, {
    nowMs,
    collapsed: options.collapsed,
    showHistory: options.showHistory,
    sortByCreation: options.sortByCreation,
  });
  const selectedKey = options.selectedId && plan.index.has(options.selectedId) ? options.selectedId : null;
  const rows: MonitorRow[] = [];
  const parent = parentRow(proj, width, nowMs, g, say);
  if (parent !== null) rows.push({ text: parent, lead: true });
  rows.push(summaryRow(proj, plan, nowMs, width, g, say, options.showHistory === true));
  if (proj.roots.length === 0) {
    if (vm.tree.ledger.state !== 'degraded' && options.empty) rows.push(...options.empty());
    return rows;
  }
  const ctx: RenderContext = { proj, width, nowMs, ascii: options.ascii, say, selectedKey, coarse: plan.coarse };
  if (options.style === 'rich')
    rows.push(
      ...richRows(proj, plan, ctx, g, say, options.viewport === undefined ? undefined : options.viewport - rows.length)
    );
  else rows.push(...compactRows(proj, plan, ctx, g, say));
  return rows;
}

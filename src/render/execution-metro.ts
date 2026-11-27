/**
 * Hairline metro-map layout, rendering and navigation for Execution workflows.
 * Pure; no I/O. Uses collector `run.metro` + `reduceMetroLanes`; width fitting, glyph placement and hit geometry live here.
 */
import {
  reduceMetroLanes,
  type MetroEdge as CollectorMetroEdge,
  type MetroFlow as CollectorMetroFlow,
  type MetroJunction,
  type MetroRepair as CollectorMetroRepair,
  type MetroStation as CollectorMetroStation,
  type ReducedMetroMap,
} from '../collectors/execution-metro.js';
import type { ExecutionRun, ExecutionRunJobTarget, ExecutionRunTicket, RunStepState } from '../collectors/execution-runs.js';
import type { WorkBatch } from '../collectors/workboard-types.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { roleIcon } from './model-glyphs.js';
import type { MetroEdgeTarget, MetroStationTarget, MonitorRow } from './monitor.js';
import type { MetroStationInspect } from './monitor-state.js';
import { fit, monitorText } from './monitor-text.js';
import { PROJECT_STRIP_MORE } from './project-strip.js';
import { asciiBoard, boardRow } from './workboard-rows.js';

export type MetroFlowKind = 'queue' | 'batch' | 'council' | 'prewalk' | 'land' | 'graph';
export type MetroFlowState = 'running' | 'paused';
export type MetroStationKind = 'worker' | 'review' | 'accept' | 'synth' | 'summary' | 'pool' | 'group';
export type MetroStationState =
  | 'waiting' | 'working' | 'done' | 'asking' | 'held'
  | 'failed' | 'lease' | 'stalled' | 'stopped' | 'unknown';

export interface MetroGate {
  /** 1-based active or failed gate command index. */
  readonly k: number;
  /** Total gate commands. */
  readonly n: number;
  readonly state: 'working' | 'failed' | 'lease';
  readonly command?: string;
}

export interface MetroRepair {
  readonly id?: string;
  readonly state: MetroStationState;
  readonly round: string;
  readonly title?: string;
  readonly role?: string;
  readonly since?: number;
  readonly changedAt?: number;
  readonly reason?: string;
  readonly jobId?: string;
  readonly execJob?: ExecutionRunJobTarget;
}

export interface MetroPoolCounts {
  readonly done?: number;
  readonly working?: number;
  readonly asking?: number;
  readonly held?: number;
  readonly failed?: number;
  readonly lease?: number;
  readonly stalled?: number;
  readonly waiting?: number;
  readonly stopped?: number;
  readonly unknown?: number;
}

export interface MetroStation {
  readonly id: string;
  readonly num?: string;
  readonly kind: MetroStationKind;
  readonly state: MetroStationState;
  /** Optional detail-line state word override (e.g. `'settled'`). */
  readonly stateWord?: string;
  readonly title?: string;
  readonly label?: string;
  readonly role?: string;
  readonly deps?: readonly string[];
  readonly blockers?: readonly string[];
  readonly waits?: string;
  readonly since?: number;
  readonly changedAt?: number;
  readonly gate?: MetroGate;
  readonly repair?: MetroRepair;
  /** Ordered repair rounds on this station's repair line (round 1, round 2, ...). */
  readonly repairs?: readonly MetroRepair[];
  readonly counts?: MetroPoolCounts;
  readonly count?: number;
  readonly groupedIds?: readonly string[];
  readonly holdTag?: string;
  readonly reason?: string;
  readonly jobId?: string;
  readonly execJob?: ExecutionRunJobTarget;
}

export interface MetroEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * Typed input model for one open workflow's Hairline metro map.
 * Collectors provide `run.metro`; `metroFlowFromRun` adds display titles and falls back to wave inference only for legacy runs without `metro`.
 */
export interface MetroFlow {
  readonly flow: string;
  readonly kind: MetroFlowKind;
  readonly name: string;
  readonly state: MetroFlowState;
  readonly createdAt: number | null;
  readonly slots?: string;
  readonly batch?: WorkBatch;
  readonly stations: readonly MetroStation[];
  readonly edges?: readonly MetroEdge[];
  /** Optional explicit station ID that changed last (overrides `changedAt` inference). */
  readonly lastChangedId?: string;
}

export const runItem = (flow: string) => `project:exec-run:${flow}`;
export const metroStationItem = (flow: string, stationId: string) => `project:exec-run:${flow}:${stationId}`;

/* ───────────────────────── glyphs & style helpers ───────────────────────── */

type FgRole = 'text' | 'muted' | 'frame' | 'active' | 'opinion' | 'attention' | 'danger' | 'stalled' | 'titleEdge' | 'selectedEdge';
type BgRole = 'ask' | 'selected' | 'title';
interface Cell {
  ch: string;
  fg?: FgRole;
  bg?: BgRole;
  bold?: boolean;
}

const LANES = 3;
const FAMILY: Record<Exclude<MetroStationKind, 'pool' | 'group'>, readonly [string, string, string]> = {
  worker: ['○', '◉', '●'],
  summary: ['○', '◉', '●'],
  review: ['◇', '◈', '◆'],
  accept: ['☆', '✪', '★'],
  synth: ['☆', '✪', '★'],
};
const ASCII_FAMILY: Record<Exclude<MetroStationKind, 'pool' | 'group'>, readonly [string, string, string]> = {
  worker: ['o', '@', '+'],
  summary: ['o', '@', '+'],
  review: ['r', 'R', '+'],
  accept: ['a', 'A', '+'],
  synth: ['a', 'A', '+'],
};
const SPECIAL: Partial<Record<MetroStationState, readonly [string, string]>> = {
  asking: ['?', '?'],
  held: ['!', '!'],
  failed: ['✗', 'x'],
  lease: ['◷', '~'],
  stalled: ['◍', 'z'],
  stopped: ['⊘', '/'],
  unknown: ['◌', 'u'],
};
const LIGHT_BOX: Readonly<Record<string, string>> = {
  '0001': '╷', '0010': '╵', '0011': '│', '0100': '╶', '0101': '╭',
  '0110': '╰', '0111': '├', '1000': '╴', '1001': '╮', '1010': '╯',
  '1011': '┤', '1100': '─', '1101': '┬', '1110': '┴', '1111': '┼',
};
const POOL_STATES: readonly MetroStationState[] = [
  'done', 'working', 'asking', 'held', 'failed', 'lease', 'stalled', 'waiting', 'stopped', 'unknown',
];
const URGENCY: Record<MetroStationState, number> = {
  asking: 0, held: 0, failed: 1, stalled: 2, working: 3, lease: 3, waiting: 4, stopped: 4, unknown: 4, done: 5,
};
const KIND_WORD: Record<MetroFlowKind, string> = {
  queue: 'Queue', batch: 'Batch', council: 'Council', prewalk: 'Scouting', land: 'Land', graph: 'Graph',
};

function stationChar(kind: MetroStationKind, state: MetroStationState, ascii: boolean): string {
  const special = SPECIAL[state];
  if (special) return special[ascii ? 1 : 0];
  const fam = kind === 'pool' || kind === 'group' ? 'worker' : kind;
  const idx = state === 'done' ? 2 : state === 'working' ? 1 : 0;
  return (ascii ? ASCII_FAMILY : FAMILY)[fam][idx];
}

function stateStyle(state: MetroStationState): Pick<Cell, 'fg' | 'bg' | 'bold'> {
  if (state === 'asking' || state === 'held') return { bg: 'ask', bold: true };
  if (state === 'failed') return { fg: 'danger', bold: true };
  if (state === 'working') return { fg: 'active', bold: true };
  if (state === 'stalled') return { fg: 'stalled', bold: true };
  if (state === 'lease') return { fg: 'text', bold: true };
  if (state === 'done') return { fg: 'text' };
  return { fg: 'muted' };
}

function metroAge(minutes: number): string {
  if (minutes < 60) return t('{n}m', { n: minutes });
  return t('{h}h{mm}m', { h: Math.floor(minutes / 60), mm: String(minutes % 60).padStart(2, '0') });
}

function elapsedMinutes(since: number | null | undefined, now: number): number | undefined {
  if (since === null || since === undefined || !Number.isFinite(since)) return undefined;
  return Math.max(0, Math.floor((now - since) / 60_000));
}

function gateSegments(gate: MetroGate): Array<'passed' | 'pending' | MetroGate['state']> {
  const n = Math.max(1, gate.n);
  const k = Math.max(1, Math.min(n, gate.k));
  const shown = Math.min(n, 5);
  const at = n <= 5 ? k - 1 : Math.min(shown - 1, Math.floor(((k - 1) / n) * shown));
  return Array.from({ length: shown }, (_, i) => (i < at ? 'passed' : i === at ? gate.state : 'pending'));
}

function poolParts(counts?: MetroPoolCounts): Array<[MetroStationState, number]> {
  const out: Array<[MetroStationState, number]> = [];
  if (counts) {
    for (const state of POOL_STATES) {
      const n = counts[state];
      if (n && n > 0) out.push([state, n]);
    }
  }
  return out;
}

/* ───────────────────────── cell canvas ───────────────────────── */

function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x0300 ? 1 : cp < 0x1100 ? (cp >= 0x0300 && cp <= 0x036f ? 0 : 1) : visualLength(ch);
}

class Canvas {
  readonly rows: Cell[][] = [];
  constructor(readonly width: number) {}
  row(): Cell[] {
    const r = Array.from({ length: this.width }, (): Cell => ({ ch: ' ' }));
    this.rows.push(r);
    return r;
  }
  put(r: Cell[], x: number, ch: string, style: Pick<Cell, 'fg' | 'bg' | 'bold'> = {}): number {
    const w = cellWidth(ch);
    if (w <= 0) return x;
    if (x < 0 || x + w > this.width) return x + w;
    // If overwriting the trailing half of a wide glyph, clear its leading cell.
    if (r[x]!.ch === '' && x > 0) r[x - 1] = { ch: ' ' };
    // If overwriting the leading half of a wide glyph with a narrow one, clear its trailing cell.
    if (w === 1 && x + 1 < this.width && r[x + 1]!.ch === '') r[x + 1] = { ch: ' ' };
    r[x] = { ch, ...style };
    if (w === 2) r[x + 1] = { ch: '', ...style };
    return x + w;
  }
  text(r: Cell[], x: number, s: string, style: Pick<Cell, 'fg' | 'bg' | 'bold'> = {}): number {
    for (const c of s) x = this.put(r, x, c, style);
    return x;
  }
}

function paintFg(text: string, fg: FgRole | undefined, bold: boolean | undefined): string {
  const b = theme.board;
  let out = fg === 'text' ? b.text(text)
    : fg === 'muted' ? b.muted(text)
    : fg === 'frame' ? b.frame(text)
    : fg === 'active' ? b.active(text)
    : fg === 'opinion' ? b.opinion(text)
    : fg === 'attention' ? b.attention(text)
    : fg === 'danger' ? b.danger(text)
    : fg === 'stalled' ? b.stalled(text)
    : fg === 'titleEdge' ? b.titleEdge(text)
    : fg === 'selectedEdge' ? b.selectedEdge(text)
    : text;
  if (bold) out = theme.bold(out);
  return out;
}

function paintRow(row: readonly Cell[], noColour: boolean): string {
  if (noColour) {
    let plain = '';
    for (const c of row) plain += c.ch;
    return plain;
  }
  const b = theme.board;
  let out = '';
  let i = 0;
  const n = row.length;
  while (i < n) {
    const bg = row[i]!.bg;
    let j = i + 1;
    while (j < n && row[j]!.bg === bg) j++;
    if (bg === 'ask') {
      let chunk = '';
      let bold = false;
      for (let k = i; k < j; k++) {
        chunk += row[k]!.ch;
        bold ||= Boolean(row[k]!.bold);
      }
      const styled = b.askTitle(chunk);
      out += bold ? theme.bold(styled) : styled;
    } else {
      let inner = '';
      let k = i;
      while (k < j) {
        const fg = row[k]!.fg;
        const bold = Boolean(row[k]!.bold);
        let m = k + 1;
        while (m < j && row[m]!.fg === fg && Boolean(row[m]!.bold) === bold) m++;
        let seg = '';
        for (let p = k; p < m; p++) seg += row[p]!.ch;
        inner += paintFg(seg, fg, bold);
        k = m;
      }
      out += bg === 'selected' ? b.selected(inner) : bg === 'title' ? b.title(inner) : inner;
    }
    i = j;
  }
  return out;
}

/* ───────────────────────── layout: reduceMetroLanes, width folding, glyph placement ───────────────────────── */

interface WorkNode extends MetroStation {
  compact?: boolean;
  inlineRepair?: boolean;
  spur?: boolean;
  host?: WorkNode;
  round?: string;
  col: number;
  lane: number;
  x: number;
  w: number;
}

interface LayoutEdge {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly sx: number;
  readonly ex: number;
  readonly bend: number | null;
  readonly merge: boolean;
  readonly lit: boolean;
  readonly spur: boolean;
}

interface LayoutJunction {
  readonly lane: number;
  readonly jx: number;
  readonly minLane: number;
  readonly maxLane: number;
  readonly incoming: readonly WorkNode[];
  readonly outgoing: readonly WorkNode[];
}

interface LayoutSpur {
  readonly host: WorkNode;
  readonly lane: number;
  readonly a: number;
  readonly b: number;
  readonly nodes: readonly WorkNode[];
}

export interface MetroLayout {
  readonly nodes: readonly WorkNode[];
  readonly edges: readonly LayoutEdge[];
  readonly junctions: readonly LayoutJunction[];
  readonly spurs: readonly LayoutSpur[];
  readonly lanes: number;
  readonly width: number;
}

interface FoldStep {
  readonly done?: boolean;
  readonly keep?: number;
  readonly compact?: boolean;
}

function stationRepairs(station: Pick<MetroStation, 'repair' | 'repairs'>): readonly MetroRepair[] {
  if (station.repairs?.length) return station.repairs;
  return station.repair ? [station.repair] : [];
}

function repairStationId(hostId: string, repair: MetroRepair, index: number): string {
  return repair.id ?? (index === 0 ? `${hostId}↻` : `${hostId}↻${index + 1}`);
}

function nodeWidth(node: Pick<MetroStation, 'kind' | 'counts' | 'count' | 'gate'> & { compact?: boolean }, ascii: boolean): number {
  if (node.kind === 'group') return visualLength(`●${ascii ? '' : '×'}${node.count ?? 0}`);
  if (node.kind === 'pool') {
    const parts = poolParts(node.counts);
    if (!parts.length) return 3;
    return 2 + parts.reduce((sum, [, c], i) =>
      sum + (i ? 1 : 0) + 1 + (ascii ? 0 : 1) + String(c).length, 0);
  }
  if (node.gate) return gateSegments(node.gate).length + (node.compact ? 0 : 2);
  return 1;
}

interface PreparedGraph {
  readonly stations: readonly MetroStation[];
  readonly edges: readonly CollectorMetroEdge[];
  readonly inlineIds: ReadonlySet<string>;
  readonly hostByRepairId: ReadonlyMap<string, string>;
}

function prepareGraph(flow: MetroFlow): PreparedGraph {
  const edges: CollectorMetroEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string) => {
    const key = `${from}\0${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to });
  };
  for (const s of flow.stations) {
    for (const dep of s.deps ?? []) addEdge(dep, s.id);
  }
  for (const e of flow.edges ?? []) addEdge(e.from, e.to);
  return { stations: flow.stations, edges, inlineIds: new Set(), hostByRepairId: new Map() };
}

function toCollectorFlow(graph: PreparedGraph): CollectorMetroFlow {
  const stations: CollectorMetroStation[] = graph.stations.map((s) => {
    const reps = stationRepairs(s);
    const collectorRepairs: CollectorMetroRepair[] = reps.map((r, i) => ({
      id: repairStationId(s.id, r, i),
      round: i + 1,
      total: Math.max(reps.length, 2),
      state: r.state,
      ...(r.changedAt !== undefined || r.since !== undefined ? { changedAt: r.changedAt ?? r.since } : {}),
    }));
    return {
      id: s.id,
      kind: s.kind === 'group' ? 'pool' : s.kind,
      state: s.state,
      ...(s.changedAt !== undefined || s.since !== undefined ? { changedAt: s.changedAt ?? s.since } : {}),
      ...(s.blockers?.length ? { blockers: s.blockers } : {}),
      ...(collectorRepairs.length ? { repair: collectorRepairs.at(-1), repairs: collectorRepairs } : {}),
      ...(s.counts ? { pool: s.counts } : {}),
      ...(s.count !== undefined ? { count: s.count } : {}),
    };
  });
  return { stations, edges: graph.edges };
}

interface FoldedGraph {
  readonly columns: WorkNode[][];
  readonly edges: Array<{ from: string; to: string; viaJunction?: true }>;
  readonly junctions: MetroJunction[];
  readonly lanes: number;
}

function isPlainWorker(n: WorkNode): boolean {
  return n.kind === 'worker' && !n.gate && !n.inlineRepair && !stationRepairs(n).length;
}

function isFoldableState(n: WorkNode, target: 'done' | 'waiting'): boolean {
  if (isPlainWorker(n) && n.state === target) return true;
  if (n.kind === 'pool' && n.groupedIds?.length && n.state === target && n.counts) {
    return Object.entries(n.counts).every(([k, v]) => !v || k === target);
  }
  return false;
}

function memberCountOf(n: WorkNode): number {
  return n.groupedIds?.length ? (n.count ?? n.groupedIds.length) : 1;
}

function memberIdsOf(n: WorkNode): readonly string[] {
  return n.groupedIds?.length ? n.groupedIds : [n.id];
}

function rewireAfterCollapse(
  edges: Array<{ from: string; to: string; viaJunction?: true }>,
  junctions: MetroJunction[],
  goneIds: ReadonlySet<string>,
  groupId: string,
  startCol: number,
  removedCols: number,
): { edges: Array<{ from: string; to: string; viaJunction?: true }>; junctions: MetroJunction[] } {
  const nextEdges: Array<{ from: string; to: string; viaJunction?: true }> = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const from = goneIds.has(e.from) ? groupId : e.from;
    const to = goneIds.has(e.to) ? groupId : e.to;
    if (from === to) continue;
    const key = `${from}\0${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nextEdges.push(e.viaJunction ? { from, to, viaJunction: true } : { from, to });
  }
  const nextJunctions: MetroJunction[] = [];
  for (const j of junctions) {
    if (j.afterColumn >= startCol && j.afterColumn < startCol + removedCols) continue;
    const incoming = [...new Set(j.incoming.map((id) => (goneIds.has(id) ? groupId : id)))];
    const outgoing = [...new Set(j.outgoing.map((id) => (goneIds.has(id) ? groupId : id)))];
    if (incoming.every((id) => id === groupId) && outgoing.every((id) => id === groupId)) continue;
    const afterColumn = j.afterColumn >= startCol + removedCols ? j.afterColumn - removedCols : j.afterColumn;
    nextJunctions.push({ ...j, afterColumn, incoming, outgoing });
  }
  return { edges: nextEdges, junctions: nextJunctions };
}

function foldReduced(
  reduced: ReducedMetroMap,
  renderById: ReadonlyMap<string, MetroStation>,
  inlineIds: ReadonlySet<string>,
  hostByRepairId: ReadonlyMap<string, string>,
  step: FoldStep,
): FoldedGraph {
  let columns: WorkNode[][] = reduced.columns.map((col, c) =>
    col.map((ls) => {
      const orig = renderById.get(ls.station.id);
      if (orig) {
        return {
          ...orig,
          ...(ls.blockers?.length ? { blockers: ls.blockers } : {}),
          compact: step.compact,
          ...(inlineIds.has(orig.id) ? { inlineRepair: true } : {}),
          col: c,
          lane: ls.lane,
          x: 0,
          w: 1,
        };
      }
      // Overflow pool created by reduceMetroLanes for >3 parallel stations.
      return {
        id: ls.station.id,
        kind: 'pool',
        state: ls.station.state,
        counts: ls.station.pool,
        count: ls.station.count ?? ls.groupedIds?.length ?? 0,
        ...(ls.station.changedAt !== undefined ? { changedAt: ls.station.changedAt } : {}),
        ...(ls.blockers?.length ? { blockers: ls.blockers } : {}),
        ...(ls.groupedIds?.length ? { groupedIds: ls.groupedIds } : {}),
        title: t('{n} more items', { n: ls.station.count ?? ls.groupedIds?.length ?? 0 }),
        compact: step.compact,
        col: c,
        lane: ls.lane,
        x: 0,
        w: 1,
      };
    }),
  );
  const byAll = new Map(columns.flat().map((n) => [n.id, n]));
  for (const [repairId, hostId] of hostByRepairId) {
    const r = byAll.get(repairId);
    const h = byAll.get(hostId);
    if (r && h) r.host = h;
  }

  let edges: Array<{ from: string; to: string; viaJunction?: true }> = reduced.edges.map((e) =>
    e.viaJunction ? { from: e.from, to: e.to, viaJunction: true } : { from: e.from, to: e.to },
  );
  let junctions: MetroJunction[] = [...reduced.junctions];
  let lanes = reduced.lanes;
  const trunk = reduced.trunk;

  if (step.done) {
    let prefixCols = 0;
    while (prefixCols < columns.length && columns[prefixCols]!.every((n) => isFoldableState(n, 'done'))) {
      prefixCols++;
    }
    const gone = columns.slice(0, prefixCols).flat();
    const totalDone = gone.reduce((sum, n) => sum + memberCountOf(n), 0);
    if (prefixCols > 0 && totalDone > 1) {
      const goneIds = new Set(gone.map((n) => n.id));
      const group: WorkNode = {
        id: 'done×', kind: 'group', state: 'done', count: totalDone,
        groupedIds: gone.flatMap(memberIdsOf),
        compact: step.compact, col: 0, lane: trunk, x: 0, w: 1,
      };
      columns = [[group], ...columns.slice(prefixCols)];
      ({ edges, junctions } = rewireAfterCollapse(edges, junctions, goneIds, group.id, 0, prefixCols - 1));
    }
  }

  if (step.keep !== undefined) {
    const waitingCols: number[] = [];
    for (let c = 0; c < columns.length; c++) {
      if (columns[c]!.every((n) => isFoldableState(n, 'waiting'))) waitingCols.push(c);
    }
    const toFold = waitingCols.slice(step.keep);
    if (toFold.length > 0) {
      // Collapse the contiguous run of foldable waiting columns starting at `toFold[0]`.
      const startCol = toFold[0]!;
      let endCol = startCol;
      for (let i = 1; i < toFold.length && toFold[i] === endCol + 1; i++) endCol = toFold[i]!;
      const gone = columns.slice(startCol, endCol + 1).flat();
      const totalWait = gone.reduce((sum, n) => sum + memberCountOf(n), 0);
      if (totalWait > 1) {
        const goneIds = new Set(gone.map((n) => n.id));
        const group: WorkNode = {
          id: 'wait×', kind: 'group', state: 'waiting', count: totalWait,
          groupedIds: gone.flatMap(memberIdsOf),
          compact: step.compact, col: startCol, lane: trunk, x: 0, w: 1,
        };
        columns = [...columns.slice(0, startCol), [group], ...columns.slice(endCol + 1)];
        ({ edges, junctions } = rewireAfterCollapse(edges, junctions, goneIds, group.id, startCol, endCol - startCol));
      }
    }
  }

  // Re-index columns and compact lanes if width folding eliminated the only multi-lane columns.
  for (let c = 0; c < columns.length; c++) {
    for (const n of columns[c]!) n.col = c;
  }
  const usedLanes = [...new Set(columns.flat().map((n) => n.lane))].sort((a, b) => a - b);
  if (usedLanes.length > 0 && usedLanes.length < lanes) {
    const laneMap = new Map(usedLanes.map((l, i) => [l, i]));
    for (const n of columns.flat()) n.lane = laneMap.get(n.lane)!;
    junctions = junctions.map((j) => ({ ...j, lane: laneMap.get(j.lane) ?? 0 }));
    lanes = usedLanes.length;
  }

  return { columns, edges, junctions, lanes };
}

function buildRepairWorkNode(host: WorkNode, repair: MetroRepair, index: number, lane: number, x: number, spur: boolean): WorkNode {
  return {
    id: repairStationId(host.id, repair, index),
    num: host.num,
    kind: 'worker',
    state: repair.state,
    title: repair.title ?? host.title,
    role: repair.role,
    since: repair.since,
    changedAt: repair.changedAt,
    reason: repair.reason,
    jobId: repair.jobId,
    execJob: repair.execJob,
    round: repair.round,
    host,
    col: host.col,
    lane,
    x,
    w: 1,
    ...(spur ? { spur: true } : { inlineRepair: true }),
  };
}

function inlineRepairGraph(graph: PreparedGraph, host: WorkNode): PreparedGraph {
  const reps = stationRepairs(host);
  const hostId = host.id;
  const repairStations: MetroStation[] = reps.map((rep, idx) => ({
    id: repairStationId(hostId, rep, idx),
    num: host.num,
    kind: 'worker',
    state: rep.state,
    title: rep.title ?? host.title,
    role: rep.role,
    since: rep.since,
    changedAt: rep.changedAt,
    reason: rep.reason,
    jobId: rep.jobId,
    execJob: rep.execJob,
    blockers: idx === 0 ? [hostId] : [repairStationId(hostId, reps[idx - 1]!, idx - 1)],
  }));
  const lastId = repairStations.at(-1)!.id;
  const stations: MetroStation[] = [];
  for (const s of graph.stations) {
    if (s.id === hostId) {
      stations.push({ ...s, repair: undefined, repairs: undefined, state: 'done' });
      stations.push(...repairStations);
    } else {
      stations.push(s);
    }
  }
  const edges: CollectorMetroEdge[] = [];
  for (const e of graph.edges) {
    edges.push(e.from === hostId ? { from: lastId, to: e.to } : e);
  }
  let prev = hostId;
  for (const rs of repairStations) {
    edges.push({ from: prev, to: rs.id });
    prev = rs.id;
  }
  const inlineIds = new Set(graph.inlineIds);
  const hostByRepairId = new Map(graph.hostByRepairId);
  const roundById = new Map<string, string>();
  reps.forEach((rep, idx) => {
    const rid = repairStations[idx]!.id;
    inlineIds.add(rid);
    hostByRepairId.set(rid, hostId);
    roundById.set(rid, rep.round);
  });
  const withRounds = stations.map((s) => roundById.has(s.id) ? ({ ...s, label: s.label ?? roundById.get(s.id) }) : s);
  return { stations: withRounds, edges, inlineIds, hostByRepairId };
}

function placeLayout(
  graph: PreparedGraph,
  reduced: ReducedMetroMap,
  step: FoldStep,
  gap: number,
  ascii: boolean,
): { layout: MetroLayout; inlineHost?: WorkNode } {
  const renderById = new Map(graph.stations.map((s) => [s.id, s]));
  const folded = foldReduced(reduced, renderById, graph.inlineIds, graph.hostByRepairId, step);
  if (!folded.columns.length) {
    return { layout: { nodes: [], edges: [], junctions: [], spurs: [], lanes: 0, width: 0 } };
  }

  let x = 2;
  for (const col of folded.columns) {
    const w = Math.max(...col.map((n) => nodeWidth(n, ascii)));
    for (const n of col) {
      n.w = nodeWidth(n, ascii);
      n.x = x + Math.floor((w - n.w) / 2);
      if (n.inlineRepair && !n.round && n.label) n.round = n.label;
    }
    x += w + gap;
  }
  let width = x - gap + 1;
  const allNodes = folded.columns.flat();
  const by = new Map(allNodes.map((n) => [n.id, n]));

  const inDegree = new Map<string, number>();
  for (const e of folded.edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);

  const coveredByJunction = new Set<string>();
  const junctions: LayoutJunction[] = [];
  for (const j of folded.junctions) {
    const incoming = j.incoming.map((id) => by.get(id)).filter((n): n is WorkNode => Boolean(n));
    const outgoing = j.outgoing.map((id) => by.get(id)).filter((n): n is WorkNode => Boolean(n));
    if (!incoming.length || !outgoing.length) continue;
    const gapLeft = Math.max(...incoming.map((u) => u.x + u.w));
    const gapRight = Math.min(...outgoing.map((v) => v.x - 1));
    const jx = Math.floor((gapLeft + gapRight) / 2);
    const allLanes = [...incoming, ...outgoing].map((n) => n.lane);
    junctions.push({
      lane: j.lane,
      jx,
      minLane: Math.min(...allLanes, j.lane),
      maxLane: Math.max(...allLanes, j.lane),
      incoming,
      outgoing,
    });
    for (const u of incoming) {
      for (const v of outgoing) coveredByJunction.add(`${u.id}\0${v.id}`);
    }
  }

  const edges: LayoutEdge[] = [];
  for (const e of folded.edges) {
    if (coveredByJunction.has(`${e.from}\0${e.to}`)) continue;
    const u = by.get(e.from);
    const n = by.get(e.to);
    if (!u || !n) continue;
    const sx = u.x + u.w;
    const ex = n.x - 1;
    const merge = (inDegree.get(n.id) ?? 0) > 1;
    const bend: number | null = u.lane === n.lane ? null : merge ? Math.max(sx, ex - 1) : Math.min(ex, sx + 1);
    edges.push({
      id: `${e.from}>${e.to}`, from: u.lane, to: n.lane, sx, ex, bend, merge,
      lit: u.state === 'done', spur: Boolean(n.inlineRepair),
    });
  }

  let lanes = folded.lanes;
  const spurs: LayoutSpur[] = [];
  for (const n of allNodes) {
    const reps = stationRepairs(n);
    if (!reps.length) continue;
    const a = n.x - 2;
    const minSpan = reps.length === 1 ? n.w + 2 : Math.max(n.w + 2, 2 * reps.length + 1);
    const b = Math.max(n.x + n.w + 1, a + minSpan + 1);
    const free = (lane: number) => lane >= 0 && lane < LANES
      && !allNodes.some((m) => m.lane === lane && m.x <= b && m.x + m.w > a)
      && !edges.some((e) => (e.from === lane && e.sx <= b && (e.bend ?? e.ex) >= a)
        || (e.to === lane && e.ex >= a && (e.bend ?? e.sx) <= b))
      && !junctions.some((j) => lane >= j.minLane && lane <= j.maxLane && j.jx >= a && j.jx <= b);
    const lane = [n.lane + 1, n.lane - 1].find(free);
    if (lane === undefined || a < 2) return { layout: { nodes: allNodes, edges, junctions, spurs, lanes, width }, inlineHost: n };
    const interior = b - a - 1;
    const xs = reps.length === 1
      ? [Math.floor((a + b) / 2)]
      : reps.length === 2 && interior >= 7
        ? [a + 3, b - 2]
        : Array.from({ length: reps.length }, (_, i) => Math.round((a + 2) + (i * ((b - 2) - (a + 2))) / (reps.length - 1)));
    const spurNodes = reps.map((rep, i) => buildRepairWorkNode(n, rep, i, lane, xs[i]!, true));
    spurs.push({ host: n, lane, a, b, nodes: spurNodes });
    lanes = Math.max(lanes, lane + 1);
    width = Math.max(width, b + 1);
  }

  return { layout: { nodes: allNodes, edges, junctions, spurs, lanes, width } };
}

function resolveInlineRepairs(graph: PreparedGraph, step: FoldStep, gap: number, ascii: boolean, initialReduced: ReducedMetroMap): MetroLayout {
  let curGraph = graph;
  let curReduced = initialReduced;
  for (let guard = 0; guard < 8; guard++) {
    const res = placeLayout(curGraph, curReduced, step, gap, ascii);
    if (!res.inlineHost) return res.layout;
    curGraph = inlineRepairGraph(curGraph, res.inlineHost);
    curReduced = reduceMetroLanes(toCollectorFlow(curGraph), LANES);
  }
  return { nodes: [], edges: [], junctions: [], spurs: [], lanes: 0, width: 0 };
}

/** First fit wins: generous spacing, then folds in order, then compact gate and tighter spacing. */
export function layoutMetroFlow(flow: MetroFlow, width: number, ascii = asciiBoard()): MetroLayout {
  const graph = prepareGraph(flow);
  const reduced = reduceMetroLanes(toCollectorFlow(graph), LANES);
  if (!reduced.columns.length) return { nodes: [], edges: [], junctions: [], spurs: [], lanes: 0, width: 0 };

  const steps: ReadonlyArray<[FoldStep, number, number]> = [
    [{}, 7, 4],
    [{ done: true }, 6, 4],
    [{ done: true, keep: 1 }, 6, 4],
    [{ done: true, keep: 0 }, 5, 4],
    [{ done: true, keep: 0, compact: true }, 4, 3],
    [{ done: true, keep: 0, compact: true }, 2, 1],
  ];
  for (const [step, widest, narrowest] of steps) {
    for (let gap = widest; gap >= narrowest; gap--) {
      const m = resolveInlineRepairs(graph, step, gap, ascii, reduced);
      if (m.width <= width) return m;
    }
  }
  return resolveInlineRepairs(graph, { done: true, keep: 0, compact: true }, 1, ascii, reduced);
}

/* ───────────────────────── Hairline drawing ───────────────────────── */

function drawHairlineLines(cv: Canvas, rows: Cell[][], m: MetroLayout, ascii: boolean): void {
  type Arm = 'L' | 'R' | 'U' | 'D';
  type LineEdge = { lit: boolean; spur: boolean };
  const cells = new Map<string, { lane: number; x: number; arms: Partial<Record<Arm, LineEdge[]>> }>();
  const add = (lane: number, x: number, arms: readonly Arm[], edge: LineEdge) => {
    if (lane < 0 || lane >= rows.length || x < 0 || x >= cv.width) return;
    const key = `${lane},${x}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = { lane, x, arms: {} });
    for (const a of arms) (cell.arms[a] ??= []).push(edge);
  };
  const LR: readonly Arm[] = ['L', 'R'];
  const UD: readonly Arm[] = ['U', 'D'];
  for (const e of m.edges) {
    if (e.bend === null) {
      for (let x = e.sx; x <= e.ex; x++) add(e.from, x, LR, e);
      continue;
    }
    const down = e.to > e.from;
    for (let x = e.sx; x < e.bend; x++) add(e.from, x, LR, e);
    add(e.from, e.bend, ['L', down ? 'D' : 'U'], e);
    for (let l = Math.min(e.from, e.to) + 1; l < Math.max(e.from, e.to); l++) add(l, e.bend, UD, e);
    add(e.to, e.bend, [down ? 'U' : 'D', 'R'], e);
    for (let x = e.bend + 1; x <= e.ex; x++) add(e.to, x, LR, e);
  }
  for (const j of m.junctions) {
    for (const u of j.incoming) {
      const edge: LineEdge = { lit: u.state === 'done', spur: false };
      for (let x = u.x + u.w; x < j.jx; x++) add(u.lane, x, LR, edge);
      if (u.lane === j.lane) {
        add(j.lane, j.jx, ['L'], edge);
      } else {
        const down = j.lane > u.lane;
        add(u.lane, j.jx, ['L', down ? 'D' : 'U'], edge);
        for (let l = Math.min(u.lane, j.lane) + 1; l < Math.max(u.lane, j.lane); l++) add(l, j.jx, UD, edge);
        add(j.lane, j.jx, [down ? 'U' : 'D'], edge);
      }
    }
    const outEdge: LineEdge = { lit: j.incoming.every((u) => u.state === 'done'), spur: false };
    for (const v of j.outgoing) {
      if (v.lane === j.lane) {
        add(j.lane, j.jx, ['R'], outEdge);
      } else {
        const down = v.lane > j.lane;
        add(j.lane, j.jx, [down ? 'D' : 'U'], outEdge);
        for (let l = Math.min(j.lane, v.lane) + 1; l < Math.max(j.lane, v.lane); l++) add(l, j.jx, UD, outEdge);
        add(v.lane, j.jx, [down ? 'U' : 'D', 'R'], outEdge);
      }
      for (let x = j.jx + 1; x < v.x; x++) add(v.lane, x, LR, outEdge);
    }
  }
  for (const s of m.spurs) {
    if (!s.nodes.length) continue;
    const down = s.lane > s.host.lane;
    const away: Arm = down ? 'D' : 'U';
    const back: Arm = down ? 'U' : 'D';
    const first = s.nodes[0]!;
    const last = s.nodes.at(-1)!;
    const out: LineEdge = { spur: true, lit: true };
    const ret: LineEdge = { spur: true, lit: last.state === 'done' };
    add(s.host.lane, s.a, [away], out);
    add(s.lane, s.a, [back, 'R'], out);
    for (let x = s.a + 1; x < first.x; x++) add(s.lane, x, LR, out);
    for (let i = 0; i + 1 < s.nodes.length; i++) {
      for (let x = s.nodes[i]!.x + 1; x < s.nodes[i + 1]!.x; x++) add(s.lane, x, LR, out);
    }
    for (let x = last.x + 1; x < s.b; x++) add(s.lane, x, LR, ret);
    add(s.lane, s.b, ['L', back], ret);
    add(s.host.lane, s.b, [away], ret);
  }

  for (const cell of cells.values()) {
    const all: LineEdge[] = [];
    let anyLit = false;
    for (const a of ['L', 'R', 'U', 'D'] as const) {
      const es = cell.arms[a];
      if (!es) continue;
      all.push(...es);
      if (es.every((e) => e.lit)) anyLit = true;
    }
    const spur = all.length > 0 && all.every((e) => e.spur);
    const has = (a: Arm) => Boolean(cell.arms[a]);
    let ch: string;
    if (ascii) {
      const vertical = has('U') || has('D');
      ch = !vertical ? (anyLit ? '=' : '-')
        : !has('L') && !has('R') ? (anyLit ? '|' : ':')
        : has('U') && has('D') ? '|'
        : has('D') ? '.' : '\'';
    } else {
      const key = `${has('L') ? 1 : 0}${has('R') ? 1 : 0}${has('U') ? 1 : 0}${has('D') ? 1 : 0}`;
      ch = LIGHT_BOX[key] ?? '─';
      if (!anyLit) ch = key === '1100' ? '╌' : key === '0011' ? '╎' : ch;
    }
    const fg: FgRole = spur ? (anyLit ? 'stalled' : 'frame') : anyLit ? 'muted' : 'frame';
    cv.put(rows[cell.lane]!, cell.x, ch, { fg });
  }
}

function drawStation(cv: Canvas, rows: Cell[][], node: WorkNode, ascii: boolean, noColour: boolean, selected: boolean): void {
  const r = rows[node.lane];
  if (!r) return;
  const ink = stateStyle(node.state);
  let x = node.x;
  if (node.kind === 'group') {
    cv.text(r, x, `${stationChar('worker', node.state, ascii)}${ascii ? '' : '×'}${node.count ?? 0}`, ink);
  } else if (node.kind === 'pool') {
    const bg: BgRole = selected ? 'selected' : 'title';
    const edgeFg: FgRole = selected ? 'selectedEdge' : 'titleEdge';
    const plain = noColour || ascii;
    const parts = poolParts(node.counts);
    x = cv.put(r, x, plain ? '(' : '▐', plain ? {} : { fg: edgeFg });
    if (!parts.length) {
      x = cv.put(r, x, stationChar('worker', 'unknown', ascii), { bg, ...stateStyle('unknown') });
    } else {
      parts.forEach(([state, n], i) => {
        if (i) x = cv.put(r, x, ' ', { bg });
        const own = stateStyle(state);
        x = cv.put(r, x, stationChar('worker', state, ascii), { bg, ...own });
        x = cv.text(r, x, `${ascii ? '' : '×'}${n}`, { bg, fg: state === 'waiting' ? 'muted' : 'text' });
      });
    }
    cv.put(r, x, plain ? ')' : '▌', plain ? {} : { fg: edgeFg });
  } else if (node.gate) {
    if (!node.compact) x = cv.put(r, x, ascii ? '{' : '‹', { fg: 'muted' });
    for (const seg of gateSegments(node.gate)) {
      if (seg === 'passed') x = cv.put(r, x, ascii ? '#' : '▮', { fg: 'text' });
      else if (seg === 'pending') x = cv.put(r, x, ascii ? '.' : '▯', { fg: 'muted' });
      else x = cv.put(r, x, stationChar('worker', seg, ascii),
        seg === 'working' ? { fg: 'opinion', bold: true } : stateStyle(seg));
    }
    if (!node.compact) cv.put(r, x, ascii ? '}' : '›', { fg: 'muted' });
  } else {
    cv.put(r, x, stationChar(node.kind, node.state, ascii), ink);
  }
}

/* ───────────────────────── default / changed-last station ───────────────────────── */

function allLogicalStations(flow: MetroFlow): WorkNode[] {
  const all: WorkNode[] = [];
  for (const s of flow.stations) {
    const host: WorkNode = { ...s, col: 0, lane: 0, x: 0, w: 1 };
    all.push(host);
    stationRepairs(s).forEach((rep, idx) => {
      all.push(buildRepairWorkNode(host, rep, idx, 0, 0, false));
    });
  }
  return all;
}

function defaultDetailStation(flow: MetroFlow, all: readonly WorkNode[]): WorkNode | undefined {
  if (!all.length) return undefined;
  if (flow.lastChangedId) {
    const explicit = all.find((n) => n.id === flow.lastChangedId);
    if (explicit) return explicit;
  }
  // Prefer the newest explicit changedAt, then newest since, else most urgent / latest active station.
  let best: WorkNode | undefined;
  let bestChanged = -Infinity;
  for (const n of all) {
    if (n.changedAt !== undefined && n.changedAt > bestChanged) {
      bestChanged = n.changedAt;
      best = n;
    }
  }
  if (best) return best;
  let bestSince = -Infinity;
  for (const n of all) {
    if (n.since !== undefined && n.since > bestSince) {
      bestSince = n.since;
      best = n;
    }
  }
  if (best) return best;
  return [...all].sort((a, b) => URGENCY[a.state] - URGENCY[b.state])[0];
}

/* ───────────────────────── rows: header, map, detail, legend ───────────────────────── */

function renderHeaderRow(flow: MetroFlow, selected: boolean, width: number, now: number, ascii: boolean, noColour: boolean): MonitorRow {
  const cv = new Canvas(width);
  const r = cv.row();
  const [glyph, glyphFg]: [string, FgRole] = flow.state === 'paused'
    ? [ascii ? '=' : '‖', 'attention']
    : [ascii ? '@' : '◉', 'active'];
  if (selected) cv.put(r, 0, ascii ? '>' : '▸', { fg: 'active' });
  let x = cv.put(r, 2, glyph, { fg: glyphFg, bold: true }) + 1;
  x = cv.text(r, x, t(KIND_WORD[flow.kind]), { fg: 'muted', bold: true });
  const status = flow.slots ? t('slots {text}', { text: monitorText(flow.slots) }) : t(flow.state);
  const name = monitorText(flow.name);
  const mins = elapsedMinutes(flow.createdAt, now);
  const since = mins !== undefined ? metroAge(mins) : '';
  const full = [status, since].filter(Boolean).join(' ');
  const compact = flow.state === 'paused' ? status : (since || status);
  const forms = full === compact ? [full] : [full, compact];
  const right = forms.find((f) => x + 1 + visualLength(name) + 1 + visualLength(f) <= width) ?? forms[forms.length - 1]!;
  const rightWidth = visualLength(right);
  const nameRoom = Math.max(0, width - x - 1 - rightWidth - 1);
  if (nameRoom > 0) cv.text(r, x + 1, truncateAnsi(name, nameRoom), { fg: 'text', bold: true });
  if (rightWidth <= width) cv.text(r, Math.max(0, width - rightWidth), right, { fg: 'muted' });
  return {
    item: runItem(flow.flow),
    execRun: flow.flow,
    ...(flow.batch ? { batch: flow.batch } : {}),
    text: fit(paintRow(r, noColour), width),
  };
}

function stationStateWord(node: WorkNode, flow: MetroFlow): string {
  const state = node.gate ? node.gate.state : node.state;
  if (node.host && node.round) return `${t('repair')}${state === 'failed' ? ` ${t('failed')}` : ''} ${monitorText(node.round)}`;
  if (node.gate) {
    if (state === 'lease') return t('lease wait');
    return `${t('gate')}${state === 'failed' ? ` ${t('failed')}` : ''} ${node.gate.k}/${node.gate.n}`;
  }
  if (node.stateWord) return t(node.stateWord);
  if (node.kind === 'worker' && state === 'done' && flow.kind === 'queue' && !node.host) return t('landed');
  const map: Record<MetroStationState, string> = {
    waiting: 'not started',
    working: 'working',
    done: 'done',
    asking: 'asking',
    held: 'held for you',
    failed: 'failed',
    lease: 'lease wait',
    stalled: 'stalled',
    stopped: 'stopped',
    unknown: 'unknown',
  };
  return t(map[state]);
}

function stationDefaultLabel(node: WorkNode, flow: MetroFlow): string {
  if (node.kind === 'group') {
    return node.state === 'done'
      ? (flow.kind === 'queue' ? t('{n} landed', { n: node.count ?? 0 }) : t('{n} done', { n: node.count ?? 0 }))
      : t('{n} not started', { n: node.count ?? 0 });
  }
  if (node.title) return monitorText(node.title);
  if (node.host?.title) return monitorText(node.host.title);
  if (node.kind === 'pool' && node.groupedIds?.length) return t('{n} more items', { n: node.count ?? node.groupedIds.length });
  const fallback: Record<MetroStationKind, string> = {
    worker: 'Worker', review: 'review', accept: 'acceptance', synth: 'synthesis',
    summary: 'metro: summary', pool: 'pool', group: 'Worker',
  };
  return t(fallback[node.kind]);
}

function renderDetailRow(flow: MetroFlow, node: WorkNode | undefined, width: number, now: number, ascii: boolean, noColour: boolean): MonitorRow {
  if (!node) return boardRow(fit('', width));
  const cv = new Canvas(width);
  const r = cv.row();
  const of = node.host ?? node;
  const state: MetroStationState = node.gate ? node.gate.state : node.state;
  const glyph = node.kind === 'pool' ? stationChar('worker', node.state, ascii) : stationChar(node.kind, state, ascii);
  const glyphStyle = state === 'working' && node.gate ? { fg: 'opinion' as const, bold: true } : stateStyle(state);
  const word = stationStateWord(node, flow);
  const num = of.num ? monitorText(of.num) : '';
  const hasExplicitTitle = Boolean(node.title || node.host?.title);
  const label = hasExplicitTitle || !num ? stationDefaultLabel(node, flow) : '';
  const fullLeft = [num, label].filter(Boolean).join(' ');
  const numPad = num ? `${num} ` : '';
  const rawWaits = node.waits ?? (node.blockers?.length ? node.blockers.join(',') : undefined);
  const waits = state === 'waiting' && rawWaits ? `${ascii ? '<-' : '←'}${monitorText(rawWaits)}` : '';
  const mins = elapsedMinutes(node.since ?? node.changedAt, now);
  const since = mins !== undefined ? metroAge(mins) : '';
  const icon = node.role && !ascii ? roleIcon(node.role) : '';
  const x = cv.put(r, 2, glyph, glyphStyle) + 1;
  const room = Math.max(0, width - x);
  const join = (parts: readonly string[]) => parts.filter(Boolean).join(' ');
  const whole = [join([icon, word, waits, since]), join([word, waits, since]), join([word, since])]
    .find((f) => visualLength(f) + visualLength(fullLeft) + 2 <= room);
  const withSince = join([word, since]);
  const right = whole ?? (visualLength(withSince) + visualLength(numPad) + 14 <= room ? withSince : word);
  const rightWidth = visualLength(right);
  const leftRoom = Math.max(0, room - rightWidth - 2);
  if (leftRoom > 0) cv.text(r, x, truncateAnsi(fullLeft, leftRoom), { fg: 'text' });
  const attention = state === 'asking' || state === 'held';
  const rightFg: FgRole = attention ? 'attention' : state === 'failed' ? 'danger' : 'muted';
  if (rightWidth <= width) cv.text(r, Math.max(0, width - rightWidth), truncateAnsi(right, width), { fg: rightFg });
  return boardRow(fit(paintRow(r, noColour), width));
}

function stationInspectOf(node: WorkNode, flow: MetroFlow): MetroStationInspect {
  const since = node.since ?? node.changedAt;
  const title = node.title ?? node.host?.title ?? stationDefaultLabel(node, flow);
  return {
    id: node.id,
    kind: node.kind,
    state: node.state,
    ...(node.num ? { num: node.num } : node.host?.num ? { num: node.host.num } : {}),
    ...(title ? { title } : {}),
    ...(node.label ? { label: node.label } : {}),
    ...(node.role ? { role: node.role } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(node.blockers?.length ? { blockers: node.blockers } : {}),
    ...(node.gate ? { gate: node.gate } : {}),
    ...(node.round ? { round: node.round } : {}),
    ...(node.host ? { hostId: node.host.id } : {}),
    ...(node.counts ? { counts: node.counts } : {}),
    ...(node.count !== undefined ? { count: node.count } : {}),
    ...(node.groupedIds?.length ? { groupedIds: node.groupedIds } : {}),
    ...(node.holdTag ? { holdTag: node.holdTag } : {}),
    ...(node.reason ? { reason: node.reason } : {}),
    ...(node.jobId ? { jobId: node.jobId } : {}),
  };
}

/** Render one open flow: header row + 1–3 Hairline map rows + 1 detail row. */
export function renderMetroFlow(flow: MetroFlow, selected: string | undefined, width: number, now: number): MonitorRow[] {
  const ascii = asciiBoard();
  const noColour = displayConfig().theme === 'none';
  const headerSelected = selected === runItem(flow.flow);
  const header = renderHeaderRow(flow, headerSelected, width, now, ascii, noColour);
  const m = layoutMetroFlow(flow, width, ascii);
  if (!m.lanes) return [header];

  const stations: WorkNode[] = [...m.nodes, ...m.spurs.flatMap((s) => s.nodes)];
  const cursorStation = stations.find((n) => metroStationItem(flow.flow, n.id) === selected);
  const allLogical = allLogicalStations(flow);
  const fallbackDetail = defaultDetailStation(flow, allLogical);
  const detailNode = cursorStation ?? fallbackDetail;
  const defaultLayoutId = fallbackDetail && stations.some((s) => s.id === fallbackDetail.id)
    ? fallbackDetail.id
    : stations.find((s) => s.state !== 'done' && s.state !== 'waiting')?.id ?? stations[0]?.id;

  // When folds cannot fit the whole map in `width`, pan a horizontal viewport following the cursor/default station.
  const overflow = m.width > width && width > 0;
  const anchor = cursorStation ?? stations.find((s) => s.id === defaultLayoutId) ?? stations[0];
  let scrollX = 0;
  if (overflow && anchor) {
    const maxScroll = Math.max(0, m.width - width);
    if (anchor.w + 4 > width) {
      scrollX = Math.max(0, Math.min(maxScroll, anchor.x - (width >= 6 ? 2 : 1)));
    } else {
      const anchorCenter = anchor.x + Math.floor(anchor.w / 2);
      scrollX = Math.max(0, Math.min(maxScroll, anchorCenter - Math.floor(width / 2)));
    }
  }
  const hasLeft = overflow && stations.some((n) => n.x - scrollX < 1);
  const hasRight = overflow && stations.some((n) => n.x + n.w - scrollX > width - 1);
  const leftLimit = hasLeft ? (width >= 6 ? 2 : 1) : 0;
  const rightLimit = Math.max(leftLimit, width - (hasRight ? (width >= 6 ? 2 : 1) : 0));

  const offscreenByNode = new Map<WorkNode, 'left' | 'right' | undefined>();
  for (const n of stations) {
    if (!overflow) {
      offscreenByNode.set(n, undefined);
      continue;
    }
    const sx = n.x - scrollX;
    if (n === anchor && sx < rightLimit && sx + n.w > leftLimit) {
      offscreenByNode.set(n, undefined);
    } else if (sx < leftLimit) {
      offscreenByNode.set(n, 'left');
    } else if (sx + n.w > rightLimit) {
      offscreenByNode.set(n, 'right');
    } else {
      offscreenByNode.set(n, undefined);
    }
  }

  const fullWidth = Math.max(width, m.width);
  const fullCv = new Canvas(fullWidth);
  const fullRows = Array.from({ length: m.lanes }, () => fullCv.row());
  drawHairlineLines(fullCv, fullRows, m, ascii);

  for (const n of stations) {
    if (!offscreenByNode.get(n)) drawStation(fullCv, fullRows, n, ascii, noColour, n === cursorStation);
  }

  // Without colour (and in ASCII), a repair line marks itself before its station(s).
  if (noColour || ascii) {
    for (const s of m.spurs) {
      const first = s.nodes[0];
      if (!first || offscreenByNode.get(first)) continue;
      const at = first.x - (cursorStation === first ? 2 : 1);
      if (at > s.a && at - scrollX >= leftLimit && at - scrollX < rightLimit) {
        fullCv.put(fullRows[first.lane]!, at, ascii ? '%' : '↻', { fg: 'stalled' });
      }
    }
    for (const n of m.nodes) {
      if (!n.inlineRepair || offscreenByNode.get(n)) continue;
      const at = n.x - (cursorStation === n ? 2 : 1);
      if (at >= 0 && at - scrollX >= leftLimit && at - scrollX < rightLimit) {
        fullCv.put(fullRows[n.lane]!, at, ascii ? '%' : '↻', { fg: 'stalled' });
      }
    }
  }

  if (cursorStation && !offscreenByNode.get(cursorStation)) {
    const r = fullRows[cursorStation.lane]!;
    if (noColour) {
      const leftBracket = cursorStation.x - 1;
      const rightBracket = cursorStation.x + cursorStation.w;
      if (leftBracket >= 0 && (!hasLeft || leftBracket - scrollX >= 1)) fullCv.put(r, leftBracket, ascii ? '>' : '▸');
      if (rightBracket < fullWidth && (!hasRight || rightBracket - scrollX < width - 1)) fullCv.put(r, rightBracket, ascii ? '<' : '◂');
    } else if (cursorStation.kind !== 'pool') {
      const from = Math.max(hasLeft ? scrollX + 1 : 0, cursorStation.x - 1);
      const to = Math.min(hasRight ? scrollX + width - 2 : fullWidth - 1, cursorStation.x + cursorStation.w);
      for (let cx = from; cx <= to; cx++) {
        if (!r[cx]!.bg) r[cx] = { ...r[cx]!, bg: 'selected' };
      }
    }
  }

  const cv = new Canvas(width);
  const rows = Array.from({ length: m.lanes }, (_, lane) => {
    const out = cv.row();
    const src = fullRows[lane]!;
    for (let sx = 0; sx < width; sx++) {
      const lx = sx + scrollX;
      if (lx >= 0 && lx < fullWidth) out[sx] = src[lx]!;
    }
    return out;
  });

  const byLane: MetroStationTarget[][] = Array.from({ length: m.lanes }, () => []);
  for (const n of stations) {
    const off = offscreenByNode.get(n);
    const sx = n.x - scrollX;
    const targetWidth = off ? n.w : Math.max(1, Math.min(n.w, rightLimit - sx));
    byLane[n.lane]!.push({
      item: metroStationItem(flow.flow, n.id),
      flow: flow.flow,
      stationId: n.id,
      x: sx,
      width: targetWidth,
      lane: n.lane,
      col: n.col,
      ...(off ? { offscreen: off } : {}),
      ...(n.id === defaultLayoutId ? { defaultEntry: true as const } : {}),
      ...(n.execJob ? { execJob: n.execJob } : {}),
      inspect: stationInspectOf(n, flow),
    });
  }
  for (const lane of byLane) lane.sort((a, b) => a.x - b.x);

  const allTargets = byLane.flat();
  const leftOffAll = allTargets.filter((target) => target.offscreen === 'left');
  const rightOffAll = allTargets.filter((target) => target.offscreen === 'right');
  const edgesByLane: MetroEdgeTarget[][] = Array.from({ length: m.lanes }, () => []);
  if (hasLeft && leftOffAll.length && width >= 2) {
    const markLanes = new Set<number>();
    for (let l = 0; l < m.lanes; l++) {
      if (byLane[l]!.some((target) => target.offscreen === 'left') || rows[l]![0]!.ch !== ' ') markLanes.add(l);
    }
    if (!markLanes.size) markLanes.add(Math.floor(m.lanes / 2));
    for (const l of markLanes) {
      const laneOff = byLane[l]!.filter((target) => target.offscreen === 'left');
      const pool = laneOff.length ? laneOff : leftOffAll;
      const target = [...pool].sort((a, b) => b.x - a.x || Math.abs(a.lane - l) - Math.abs(b.lane - l))[0];
      if (!target) continue;
      cv.put(rows[l]!, 0, ascii ? '<' : '«', { fg: 'muted', bold: true });
      edgesByLane[l]!.push({ side: 'left', x: 0, width: 1, target });
    }
  }
  if (hasRight && rightOffAll.length && width >= 2) {
    const markLanes = new Set<number>();
    for (let l = 0; l < m.lanes; l++) {
      if (byLane[l]!.some((target) => target.offscreen === 'right') || rows[l]![width - 1]!.ch !== ' ') markLanes.add(l);
    }
    if (!markLanes.size) markLanes.add(Math.floor(m.lanes / 2));
    for (const l of markLanes) {
      const laneOff = byLane[l]!.filter((target) => target.offscreen === 'right');
      const pool = laneOff.length ? laneOff : rightOffAll;
      const target = [...pool].sort((a, b) => a.x - b.x || Math.abs(a.lane - l) - Math.abs(b.lane - l))[0];
      if (!target) continue;
      cv.put(rows[l]!, width - 1, ascii ? '>' : '»', { fg: 'muted', bold: true });
      edgesByLane[l]!.push({ side: 'right', x: width - 1, width: 1, target });
    }
  }

  const mapRows: MonitorRow[] = rows.map((r, lane) => ({
    text: fit(paintRow(r, noColour), width),
    metroStations: byLane[lane]!,
    ...(edgesByLane[lane]!.length ? { metroEdges: edgesByLane[lane]! } : {}),
  }));
  const detail = renderDetailRow(flow, detailNode, width, now, ascii, noColour);
  return [header, ...mapRows, detail];
}

/** Contextual legend under the last flow (0–2 rows), or full legend (`all: true`) behind `?`. */
export function renderMetroLegend(
  flows: readonly MetroFlow[],
  width: number,
  options: { all?: boolean; maxRows?: number } = {},
): MonitorRow[] {
  const ascii = asciiBoard();
  const noColour = displayConfig().theme === 'none';
  const all = Boolean(options.all);
  const maxRows = options.maxRows ?? (all ? 6 : 2);
  const nodes = flows.flatMap((f) => f.stations.flatMap((s) => [
    { ...s, repairMark: false },
    ...stationRepairs(s).map((rep, i) => ({
      ...rep, id: repairStationId(s.id, rep, i), kind: 'worker' as const, gate: undefined, repairMark: true,
    })),
  ]));
  const has = (fn: (n: (typeof nodes)[number]) => boolean) => all || nodes.some(fn);
  const acceptWord = flows.some((f) => f.kind === 'council') && !flows.some((f) => f.kind === 'queue')
    ? t('synthesis') : t('metro: accept');
  const attention: Pick<Cell, 'fg' | 'bg' | 'bold'> = { bg: 'ask', bold: true };
  const raw: Array<[boolean, string, Pick<Cell, 'fg' | 'bg' | 'bold'>, string]> = [
    [has((n) => n.state === 'asking'), '?', attention, t('metro: asking')],
    [has((n) => n.state === 'held'), '!', attention, t('metro: held')],
    [has((n) => n.state === 'failed' || n.gate?.state === 'failed'), ascii ? 'x' : '✗', { fg: 'danger', bold: true }, t('failed')],
    [has((n) => n.repairMark), ascii ? '%' : noColour ? '↻' : '──', { fg: 'stalled' }, t('repair')],
    [has((n) => Boolean(n.gate)), ascii ? '{#@.}' : '‹▮◉▯›', { fg: 'opinion' }, t('gate')],
    [has((n) => n.state === 'lease' || n.gate?.state === 'lease'), ascii ? '~' : '◷', { fg: 'text' }, t('lease')],
    [has((n) => n.state === 'stalled'), ascii ? 'z' : '◍', { fg: 'stalled' }, t('stalled')],
    [has((n) => n.state === 'stopped'), ascii ? '/' : '⊘', { fg: 'muted' }, t('stopped')],
    [has((n) => n.state === 'unknown' || (n.kind === 'pool' && !poolParts(n.counts).length)), ascii ? 'u' : '◌', { fg: 'muted' }, t('unknown')],
    [has((n) => n.kind === 'review'), ascii ? 'r R' : '◇◈◆', { fg: 'muted' }, t('review')],
    [has((n) => n.kind === 'accept' || n.kind === 'synth'), ascii ? 'a A' : '☆✪★', { fg: 'muted' }, acceptWord],
    [all || ascii, ascii ? '@' : '◉', { fg: 'active', bold: true }, t('metro: working')],
    [all || ascii, ascii ? '+' : '●', { fg: 'text' }, t('done')],
    [all || ascii, ascii ? 'o' : '○', { fg: 'muted' }, t('to do')],
    [all, ascii ? '+6 o4' : '●×6 ○×4', { fg: 'muted' }, t('folded')],
  ];
  const items = raw.filter(([keep]) => keep);
  if (!items.length || width < 4) return [];

  const cv = new Canvas(width);
  let r: Cell[] | null = null;
  let x = 0;
  let used = 0;
  for (const [, glyph, style, word] of items) {
    const need = visualLength(glyph) + 1 + visualLength(word);
    if (!r || x + need > width) {
      if (used === maxRows) break;
      r = cv.row();
      x = 2;
      used += 1;
    }
    if (x + need > width) {
      const avail = Math.max(0, width - x - visualLength(glyph) - 1);
      x = cv.text(r, x, glyph, style);
      if (avail > 0) x = cv.text(r, x + 1, truncateAnsi(word, avail), { fg: 'muted' }) + 2;
      continue;
    }
    x = cv.text(r, x, glyph, style);
    x = cv.text(r, x + 1, word, { fg: 'muted' }) + 2;
  }
  return cv.rows.map((row) => boardRow(fit(paintRow(row, noColour), width)));
}

/* ───────────────────────── ExecutionRun -> MetroFlow (collector metro + legacy wave fallback) ───────────────────────── */

const ticketShort = (key: string) => key.split('/').at(-1)!;

function acceptTitle(seat: 'lead' | 'main' | string | undefined): string {
  return seat === 'main' ? t('Hand-back (main)') : t('Lead acceptance');
}

function collectorStationTitle(run: ExecutionRun, s: CollectorMetroStation): string | undefined {
  if (s.title) return s.title;
  if (run.kind === 'queue') {
    if (s.kind === 'review') return t('Run review');
    if (s.kind === 'accept') return acceptTitle(s.label ?? run.acceptanceSeat);
    return undefined;
  }
  if (run.kind === 'batch') {
    if (s.id === 'pilot') return s.label ? `${t('Pilot')} ${monitorText(s.label)}` : t('Pilot');
    if (s.kind === 'pool') {
      const count = s.count ?? run.batch?.count;
      return count !== undefined ? t('Pool of {n}', { n: count }) : t('Pool');
    }
    if (s.kind === 'summary') return t('metro: summary');
  }
  if (run.kind === 'land') {
    if (s.id === 'pick') return t('Cherry-pick');
    if (s.id === 'lease') return t('Lease wait');
    if (s.id === 'gate') return t('Gate');
    if (s.id === 'merge') return t('Merge');
  }
  if (run.kind === 'council') {
    if (s.kind === 'synth') return s.label ? t('Synthesis ({seat})', { seat: monitorText(s.label) }) : t('Synthesis');
    return s.label ? t('Member {name}', { name: monitorText(s.label) }) : t('Worker');
  }
  if (run.kind === 'prewalk') {
    if (s.id === 'target') return t('Worker');
    return s.label ? t('{kind} prewalk scout', { kind: monitorText(s.label) }) : t('Scouts');
  }
  return s.label ?? s.id;
}

function flowFromCollectorMetro(run: ExecutionRun, metro: CollectorMetroFlow): MetroFlow {
  const flowState: MetroFlowState = run.state === 'paused' ? 'paused' : 'running';
  const ticketById = run.kind === 'queue' ? new Map(run.tickets.map((tk) => [tk.ticket, tk])) : undefined;
  const labelRef = (ref: string) => (run.kind === 'queue' && !run.unattended && ticketById?.has(ref) ? ticketShort(ref) : ref);
  const stations: MetroStation[] = metro.stations.map((s) => {
    const tk = ticketById?.get(s.id);
    const num = tk ? labelRef(s.id) : undefined;
    const title = collectorStationTitle(run, s);
    const waits = s.blockers?.length ? s.blockers.map(labelRef).join(',') : undefined;
    const gate: MetroGate | undefined = s.gate && s.gate.state !== 'done'
      ? { k: s.gate.index, n: s.gate.total, state: s.gate.state, ...(s.gate.command ? { command: s.gate.command } : {}) }
      : undefined;
    const rawRepairs = s.repairs?.length ? s.repairs : s.repair ? [s.repair] : [];
    const repairs: MetroRepair[] = rawRepairs.map((r) => ({
      id: r.id,
      state: r.state,
      round: `${r.round}/${r.total}`,
      title: run.kind === 'queue' ? (s.title ?? num ?? r.label ?? t('Repair')) : (r.label ?? t('Repair')),
      ...(r.role ? { role: r.role } : {}),
      ...(r.changedAt !== undefined ? { changedAt: r.changedAt } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.jobId ? { jobId: r.jobId } : {}),
      ...(r.execJob ? { execJob: r.execJob } : {}),
    }));
    const stateWord = tk?.stage === 'settled' && s.state === 'done' ? 'settled' : undefined;
    return {
      id: s.id,
      ...(num ? { num } : {}),
      kind: s.kind,
      state: s.state,
      ...(stateWord ? { stateWord } : {}),
      ...(title ? { title } : {}),
      ...(s.label ? { label: s.label } : {}),
      ...(s.role ? { role: s.role } : {}),
      ...(s.blockers?.length ? { blockers: s.blockers } : {}),
      ...(waits ? { waits } : {}),
      ...(s.changedAt !== undefined ? { changedAt: s.changedAt } : {}),
      ...(gate ? { gate } : {}),
      ...(repairs.length ? { repair: repairs.at(-1), repairs } : {}),
      ...(s.pool ? { counts: s.pool } : {}),
      ...(s.count !== undefined ? { count: s.count } : {}),
      ...(s.holdTag ? { holdTag: s.holdTag } : {}),
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.jobId ? { jobId: s.jobId } : {}),
      ...(s.execJob ? { execJob: s.execJob } : {}),
    };
  });
  const batch = run.kind === 'batch' ? run.batch : undefined;
  const slots = batch?.slots !== undefined && batch.state === 'working' ? `${batch.totals.running}/${batch.slots}` : undefined;
  return {
    flow: run.flow,
    kind: run.kind,
    name: run.label,
    state: flowState,
    createdAt: run.createdAt,
    ...(batch ? { batch } : {}),
    ...(slots ? { slots } : {}),
    stations,
    edges: metro.edges,
    ...(metro.lastChangedId !== undefined ? { lastChangedId: metro.lastChangedId } : {}),
  };
}

function mapStepState(state: RunStepState): MetroStationState {
  switch (state) {
    case 'running': return 'working';
    case 'asking': return 'asking';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'skipped':
    case 'cancelled': return 'stopped';
    case 'waiting': return 'waiting';
  }
}

function legacyTicketStation(ticket: ExecutionRunTicket, label: (ref: string) => string, deps: readonly string[]): MetroStation {
  const num = label(ticket.ticket);
  const waits = ticket.blockers?.length ? ticket.blockers.map(label).join(',') : undefined;
  const base = {
    id: ticket.ticket,
    num,
    kind: 'worker' as const,
    ...(ticket.title ? { title: ticket.title } : {}),
    role: ticket.role ?? 'imp',
    deps,
    ...(ticket.blockers?.length ? { blockers: ticket.blockers } : {}),
    ...(waits ? { waits } : {}),
    ...(ticket.holdTag ? { holdTag: ticket.holdTag } : {}),
    ...(ticket.reason ? { reason: ticket.reason } : {}),
    ...(ticket.changedAt !== undefined ? { changedAt: ticket.changedAt } : {}),
    ...(ticket.jobId ? { jobId: ticket.jobId } : {}),
    ...(ticket.execJob ? { execJob: ticket.execJob } : {}),
  };
  switch (ticket.stage) {
    case 'landed': return { ...base, state: 'done' };
    case 'settled': return { ...base, state: 'done', stateWord: 'settled' };
    case 'held': return { ...base, state: 'held', ...(ticket.since !== undefined ? { since: ticket.since } : {}) };
    case 'failed': return { ...base, state: 'failed', ...(ticket.since !== undefined ? { since: ticket.since } : {}) };
    case 'queued':
    case 'blocked': return { ...base, state: 'waiting' };
    case 'worker':
      return {
        ...base,
        state: ticket.statusUnknown ? 'unknown' : ticket.asking ? 'asking' : ticket.stalled ? 'stalled' : 'working',
        ...(ticket.since !== undefined ? { since: ticket.since } : {}),
      };
    case 'land-gate': {
      if (ticket.landingUnknown) return { ...base, state: 'unknown' };
      const p = ticket.landProgress;
      const since = p?.since ?? ticket.since;
      if (p?.kind === 'lease') return { ...base, state: 'lease', ...(since !== undefined ? { since } : {}) };
      const lg = ticket.landGate;
      const gate: MetroGate | undefined = lg && lg.state !== 'done'
        ? { k: lg.index, n: lg.total, state: lg.state, ...(lg.command ? { command: lg.command } : {}) }
        : p?.kind === 'repair' ? { k: 1, n: 1, state: 'failed' }
          : { k: p?.index ?? 1, n: p?.total ?? Math.max(1, p?.index ?? 1), state: 'working' };
      const rawRepairs = ticket.landRepairs?.length ? ticket.landRepairs : ticket.landRepair ? [ticket.landRepair] : [];
      const repairs: MetroRepair[] = rawRepairs.length
        ? rawRepairs.map((r) => ({
            id: r.id, state: r.state, round: `${r.round}/${r.total}`,
            title: ticket.title ?? num, role: r.role ?? ticket.role ?? 'imp',
            ...(r.changedAt !== undefined ? { changedAt: r.changedAt } : {}),
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.jobId ? { jobId: r.jobId } : {}),
            ...(r.execJob ? { execJob: r.execJob } : {}),
          }))
        : p?.kind === 'repair' ? [{
            id: `${ticket.ticket}↻`, state: ticket.asking ? 'asking' : 'working',
            round: `${p.index ?? 1}/${p.total ?? 2}`, role: ticket.role ?? 'imp', title: ticket.title ?? num,
            ...(since !== undefined ? { since } : {}),
            ...(ticket.jobId ? { jobId: ticket.jobId } : {}),
            ...(ticket.execJob ? { execJob: ticket.execJob } : {}),
          }] : [];
      return {
        ...base,
        state: 'working',
        ...(gate ? { gate } : {}),
        ...(repairs.length ? { repair: repairs.at(-1), repairs } : {}),
        ...(since !== undefined ? { since } : {}),
      };
    }
  }
}

/** Wave inference fallback used only for legacy queue runs that lack collector `run.metro`. */
function legacyQueueMetroFlow(run: ExecutionRun): MetroFlow {
  const flowState: MetroFlowState = run.state === 'paused' ? 'paused' : 'running';
  const own = new Set(run.tickets.map((tk) => tk.ticket));
  const label = (ref: string) => (!run.unattended && own.has(ref) ? ticketShort(ref) : ref);
  const stations: MetroStation[] = [];
  const referenced = new Set<string>();
  const waves = run.queueWaves;
  if (waves) {
    let lastPrefixId: string | undefined;
    for (const tk of waves.prefix) {
      const deps = lastPrefixId ? [lastPrefixId] : [];
      if (lastPrefixId) referenced.add(lastPrefixId);
      stations.push(legacyTicketStation(tk, label, deps));
      lastPrefixId = tk.ticket;
    }
    const currentIds: string[] = [];
    for (const tk of waves.current) {
      const deps = tk.blockers?.length
        ? tk.blockers.filter((b) => own.has(b))
        : lastPrefixId ? [lastPrefixId] : [];
      for (const dep of deps) referenced.add(dep);
      stations.push(legacyTicketStation(tk, label, deps));
      currentIds.push(tk.ticket);
    }
    let prevWaveIds = currentIds.length ? currentIds : lastPrefixId ? [lastPrefixId] : [];
    for (const wave of waves.blocked) {
      const waveIds: string[] = [];
      for (const tk of wave) {
        const explicit = (tk.blockers ?? []).filter((b) => own.has(b));
        const deps = explicit.length ? explicit : prevWaveIds;
        for (const dep of deps) referenced.add(dep);
        stations.push(legacyTicketStation(tk, label, deps));
        waveIds.push(tk.ticket);
      }
      prevWaveIds = waveIds;
    }
  }
  const leaves = stations.filter((s) => !referenced.has(s.id)).map((s) => s.id);
  const reviewStep = run.steps.find((s) => s.key === 'review');
  const acceptStep = run.steps.find((s) => s.key === 'accept');
  stations.push({
    id: 'review',
    kind: 'review',
    state: mapStepState(run.reviewer?.state ?? reviewStep?.state ?? 'waiting'),
    title: t('Run review'),
    deps: leaves,
    ...(run.reviewer?.since !== undefined ? { since: run.reviewer.since } : {}),
    ...(run.reviewer?.jobId ? { jobId: run.reviewer.jobId } : {}),
    ...(run.reviewer?.execJob ? { execJob: run.reviewer.execJob } : {}),
  });
  stations.push({
    id: 'accept',
    kind: 'accept',
    state: mapStepState(run.lead?.state ?? acceptStep?.state ?? 'waiting'),
    title: acceptTitle(run.acceptanceSeat),
    ...(run.acceptanceSeat ? { label: run.acceptanceSeat } : {}),
    deps: ['review'],
    ...(run.lead?.since !== undefined ? { since: run.lead.since } : {}),
    ...(run.lead?.jobId ? { jobId: run.lead.jobId } : {}),
    ...(run.lead?.execJob ? { execJob: run.lead.execJob } : {}),
  });
  return { flow: run.flow, kind: run.kind, name: run.label, state: flowState, createdAt: run.createdAt, stations };
}

/** Project an open `ExecutionRun` using collector `run.metro`, falling back to wave inference only for legacy runs without `metro`. */
export function metroFlowFromRun(run: ExecutionRun): MetroFlow {
  if (run.metro) return flowFromCollectorMetro(run, run.metro);
  if (run.kind === 'queue') return legacyQueueMetroFlow(run);
  const flowState: MetroFlowState = run.state === 'paused' ? 'paused' : 'running';
  return { flow: run.flow, kind: run.kind, name: run.label, state: flowState, createdAt: run.createdAt, stations: [] };
}

/* ───────────────────────── station lookup & keyboard navigation ───────────────────────── */

export function metroStationAt(row: MonitorRow | undefined, col: number): MetroStationTarget | undefined {
  if (!row) return undefined;
  const edge = row.metroEdges?.find((e) => col >= e.x && col < e.x + e.width);
  if (edge) return edge.target;
  return row.metroStations?.find((s) => !s.offscreen && col >= s.x && col < s.x + s.width);
}

export function findMetroStation(rows: readonly MonitorRow[], item: string | undefined): MetroStationTarget | undefined {
  if (!item) return undefined;
  for (const row of rows) {
    if (!row.metroStations) continue;
    const hit = row.metroStations.find((s) => s.item === item);
    if (hit) return hit;
  }
  return undefined;
}

type NavStop = { kind: 'row'; item: string } | { kind: 'map'; flow: string; stations: MetroStationTarget[] };

function executionStops(rows: readonly MonitorRow[], hasStripMore: boolean): NavStop[] {
  const stops: NavStop[] = hasStripMore ? [{ kind: 'row', item: PROJECT_STRIP_MORE }] : [];
  const seenItems = new Set<string>();
  let openMap: Extract<NavStop, { kind: 'map' }> | undefined;
  for (const row of rows) {
    if (row.metroStations) {
      const flow = row.metroStations[0]?.flow ?? openMap?.flow;
      if (flow) {
        if (!openMap || openMap.flow !== flow) {
          openMap = { kind: 'map', flow, stations: [] };
          stops.push(openMap);
        }
        openMap.stations.push(...row.metroStations);
      }
      continue;
    }
    openMap = undefined;
    if (row.item && !seenItems.has(row.item)) {
      seenItems.add(row.item);
      stops.push({ kind: 'row', item: row.item });
    }
  }
  return stops.filter((s) => s.kind === 'row' || s.stations.length > 0);
}

function centerX(s: MetroStationTarget): number {
  return s.x + (s.width - 1) / 2;
}

function entryStation(map: Extract<NavStop, { kind: 'map' }>, fromTop: boolean): string | undefined {
  const lanes = [...new Set(map.stations.map((s) => s.lane))].sort((a, b) => a - b);
  if (!lanes.length) return undefined;
  const targetLane = fromTop ? lanes[0]! : lanes[lanes.length - 1]!;
  const onLane = map.stations.filter((s) => s.lane === targetLane);
  const anchor = map.stations.find((s) => s.defaultEntry) ?? onLane[0]!;
  return [...onLane].sort((a, b) =>
    Math.abs(a.col - anchor.col) - Math.abs(b.col - anchor.col)
    || Math.abs(centerX(a) - centerX(anchor)) - Math.abs(centerX(b) - centerX(anchor)),
  )[0]?.item;
}

/**
 * Pure keyboard movement on Execution:
 * - While on a map: `left`/`right` move between stations (never switch tabs);
 *   `up`/`down` move across lanes, then leave the map to the adjacent flow header / card.
 * - Entering a map from above (`down`) lands on its topmost lane; from below (`up`) on its bottommost lane.
 */
export function navigateExecutionMetro(
  rows: readonly MonitorRow[],
  cursor: string | undefined,
  key: 'left' | 'right' | 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end',
  hasStripMore: boolean,
): { cursor?: string; handled: boolean } {
  const stops = executionStops(rows, hasStripMore);
  if (!stops.length) return { cursor, handled: key !== 'left' && key !== 'right' };
  const stopIndex = stops.findIndex((s) =>
    s.kind === 'row' ? s.item === cursor : s.stations.some((st) => st.item === cursor));
  const currentStop = stopIndex >= 0 ? stops[stopIndex] : undefined;

  if (key === 'left' || key === 'right') {
    if (currentStop?.kind !== 'map') return { cursor, handled: false };
    const cur = currentStop.stations.find((st) => st.item === cursor)!;
    const sameCell = currentStop.stations.filter((st) =>
      st.lane === cur.lane && st.col === cur.col && (key === 'right' ? st.x > cur.x : st.x < cur.x));
    if (sameCell.length) {
      sameCell.sort((a, b) => (key === 'right' ? a.x - b.x : b.x - a.x));
      return { cursor: sameCell[0]!.item, handled: true };
    }
    const candidates = currentStop.stations.filter((st) => key === 'right' ? st.col > cur.col : st.col < cur.col);
    if (!candidates.length) return { cursor, handled: true };
    candidates.sort((a, b) =>
      (key === 'right' ? a.col - b.col : b.col - a.col)
      || Math.abs(a.lane - cur.lane) - Math.abs(b.lane - cur.lane)
      || a.lane - b.lane,
    );
    return { cursor: candidates[0]!.item, handled: true };
  }

  if (key === 'home' || key === 'end') {
    const target = key === 'home' ? stops[0]! : stops[stops.length - 1]!;
    return { cursor: target.kind === 'row' ? target.item : entryStation(target, key === 'home'), handled: true };
  }

  if ((key === 'up' || key === 'down') && currentStop?.kind === 'map') {
    const cur = currentStop.stations.find((st) => st.item === cursor)!;
    const candidates = currentStop.stations.filter((st) => key === 'down' ? st.lane > cur.lane : st.lane < cur.lane);
    if (candidates.length) {
      candidates.sort((a, b) =>
        (key === 'down' ? a.lane - b.lane : b.lane - a.lane)
        || Math.abs(a.col - cur.col) - Math.abs(b.col - cur.col)
        || Math.abs(centerX(a) - centerX(cur)) - Math.abs(centerX(b) - centerX(cur)),
      );
      return { cursor: candidates[0]!.item, handled: true };
    }
    const nextIdx = stopIndex + (key === 'down' ? 1 : -1);
    if (nextIdx < 0 || nextIdx >= stops.length) return { cursor, handled: true };
    const nextStop = stops[nextIdx]!;
    return { cursor: nextStop.kind === 'row' ? nextStop.item : entryStation(nextStop, key === 'down'), handled: true };
  }

  const step = key === 'up' ? -1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 1;
  const from = stopIndex >= 0 ? stopIndex : 0;
  const targetIdx = Math.max(0, Math.min(stops.length - 1, from + step));
  const target = stops[targetIdx]!;
  return { cursor: target.kind === 'row' ? target.item : entryStation(target, step > 0), handled: true };
}

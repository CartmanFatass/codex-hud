/**
 * Hairline metro-map model, layout, rendering and navigation for Execution workflows.
 * Pure; no I/O. Matches `docs/design/metro-map/` variant C · Hairline and `docs/design/tab-roles/README.md` §3a.
 */
import type { ExecutionRun, ExecutionRunJobTarget, ExecutionRunTicket, RunStepState, WorkflowNode } from '../collectors/execution-runs.js';
import type { WorkBatch } from '../collectors/workboard-types.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { roleIcon } from './model-glyphs.js';
import type { MetroStationTarget, MonitorRow } from './monitor.js';
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
}

export interface MetroRepair {
  readonly id?: string;
  readonly state: MetroStationState;
  readonly round: string;
  readonly title?: string;
  readonly role?: string;
  readonly since?: number;
  readonly changedAt?: number;
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
  readonly role?: string;
  /** Optional lane hint (0..2) from an upstream lane reducer. */
  readonly lane?: number;
  readonly deps?: readonly string[];
  readonly waits?: string;
  readonly since?: number;
  readonly changedAt?: number;
  readonly gate?: MetroGate;
  readonly repair?: MetroRepair;
  readonly counts?: MetroPoolCounts;
  readonly count?: number;
  readonly jobId?: string;
  readonly execJob?: ExecutionRunJobTarget;
}

export interface MetroEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * Typed input model for one open workflow's Hairline metro map.
 * Collectors (or the thin `metroFlowFromRun` adapter) build this off the paint path.
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
  /** Optional explicit lane count (1..3) when stations carry pre-assigned lanes. */
  readonly lanes?: number;
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
  return out.length ? out : [['waiting', 0]];
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

/* ───────────────────────── layout: waves, lanes, folding, routes ───────────────────────── */

interface WorkNode extends MetroStation {
  deps: string[];
  compact?: boolean;
  inlineRepair?: boolean;
  spur?: boolean;
  host?: WorkNode;
  round?: string;
  col: number;
  pref: number;
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

interface LayoutSpur {
  readonly host: WorkNode;
  readonly lane: number;
  readonly a: number;
  readonly b: number;
  readonly node: WorkNode;
}

export interface MetroLayout {
  readonly nodes: readonly WorkNode[];
  readonly edges: readonly LayoutEdge[];
  readonly spurs: readonly LayoutSpur[];
  readonly lanes: number;
  readonly width: number;
}

interface FoldStep {
  readonly done?: boolean;
  readonly keep?: number;
  readonly compact?: boolean;
}

function nodeWidth(node: Pick<MetroStation, 'kind' | 'counts' | 'count' | 'gate'> & { compact?: boolean }, ascii: boolean): number {
  if (node.kind === 'group') return visualLength(`●${ascii ? '' : '×'}${node.count ?? 0}`);
  if (node.kind === 'pool') {
    return 2 + poolParts(node.counts).reduce((sum, [, c], i) =>
      sum + (i ? 1 : 0) + 1 + (ascii ? 0 : 1) + String(c).length, 0);
  }
  if (node.gate) return gateSegments(node.gate).length + (node.compact ? 0 : 2);
  return 1;
}

/** Cycle-safe dependency depth. */
function depthsOf(nodes: readonly { id: string; deps: readonly string[] }[]): Map<string, number> {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = by.get(id);
    let maxParent = -1;
    if (node) {
      for (const dep of node.deps) {
        if (by.has(dep) && !visiting.has(dep)) maxParent = Math.max(maxParent, depth(dep));
      }
    }
    visiting.delete(id);
    const d = maxParent + 1;
    memo.set(id, d);
    return d;
  };
  for (const n of nodes) depth(n.id);
  return memo;
}

function resolvedStations(flow: MetroFlow): WorkNode[] {
  const extraDeps = new Map<string, string[]>();
  for (const edge of flow.edges ?? []) {
    let list = extraDeps.get(edge.to);
    if (!list) extraDeps.set(edge.to, list = []);
    if (!list.includes(edge.from)) list.push(edge.from);
  }
  return flow.stations.map((s) => {
    const deps = [...new Set([...(s.deps ?? []), ...(extraDeps.get(s.id) ?? [])])];
    return { ...s, deps, col: 0, pref: 0, lane: s.lane ?? 0, x: 0, w: 1 };
  });
}

function fold(nodes: readonly WorkNode[], step: FoldStep): WorkNode[] {
  let out: WorkNode[] = nodes.map((n) => ({ ...n, deps: [...n.deps], compact: step.compact }));
  const columns = () => {
    const d = depthsOf(out);
    const cols: WorkNode[][] = [];
    for (const n of out) (cols[d.get(n.id) ?? 0] ??= []).push(n);
    return cols;
  };
  const replace = (gone: WorkNode[], group: WorkNode) => {
    const ids = new Set(gone.map((n) => n.id));
    group.deps = [...new Set(gone.flatMap((n) => n.deps).filter((d) => !ids.has(d)))];
    const at = out.findIndex((n) => ids.has(n.id));
    out = out.filter((n) => !ids.has(n.id)).map((n) => n.deps.some((d) => ids.has(d))
      ? { ...n, deps: [...new Set(n.deps.map((d) => (ids.has(d) ? group.id : d)))] } : n);
    out.splice(Math.max(0, at), 0, group);
  };
  const plain = (n: WorkNode) => n.kind === 'worker' && !n.gate && !n.repair;
  if (step.done) {
    const gone: WorkNode[] = [];
    for (const col of columns()) {
      if (!col || !col.every((n) => plain(n) && n.state === 'done')) break;
      gone.push(...col);
    }
    if (gone.length > 1) {
      replace(gone, {
        id: 'done×', kind: 'group', state: 'done', count: gone.length, deps: [],
        col: 0, pref: 0, lane: 0, x: 0, w: 1,
      });
    }
  }
  if (step.keep !== undefined) {
    const ahead = columns().filter((col) => col && col.some((n) => plain(n) && n.state === 'waiting')
      && col.every((n) => n.state === 'waiting'));
    const gone = ahead.slice(step.keep).flat().filter(plain);
    if (gone.length > 1) {
      replace(gone, {
        id: 'wait×', kind: 'group', state: 'waiting', count: gone.length, deps: [],
        col: 0, pref: 0, lane: 0, x: 0, w: 1,
      });
    }
  }
  return out;
}

function limitWave(nodes: readonly WorkNode[]): WorkNode[] {
  const d = depthsOf(nodes);
  const cols: WorkNode[][] = [];
  for (const n of nodes) (cols[d.get(n.id) ?? 0] ??= []).push(n);
  let out = [...nodes];
  let restSeq = 0;
  for (const col of cols) {
    if (!col || col.length <= LANES) continue;
    const gone = [...col].sort((a, b) => URGENCY[a.state] - URGENCY[b.state]).slice(LANES - 1);
    const counts: Partial<Record<MetroStationState, number>> = {};
    for (const n of gone) counts[n.state] = (counts[n.state] ?? 0) + 1;
    const ids = new Set(gone.map((n) => n.id));
    const groupId = restSeq++ === 0 ? 'rest' : `rest-${restSeq}`;
    const group: WorkNode = {
      id: groupId,
      kind: 'pool',
      state: gone.some((n) => n.state === 'working') ? 'working' : gone[0]!.state,
      counts,
      deps: [...new Set(gone.flatMap((n) => n.deps))],
      title: t('{n} more items', { n: gone.length }),
      col: 0, pref: 0, lane: 0, x: 0, w: 1,
    };
    const colDepth = d.get(col[0]!.id) ?? 0;
    out = out.filter((n) => !ids.has(n.id)).map((n) => n.deps.some((x) => ids.has(x))
      ? { ...n, deps: [...new Set(n.deps.map((x) => (ids.has(x) ? groupId : x)))] } : n);
    let lastInCol = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if ((d.get(out[i]!.id) ?? 0) === colDepth) { lastInCol = i; break; }
    }
    out.splice(lastInCol + 1, 0, group);
  }
  return out;
}

function picks(k: number, h: number, from = 0): number[][] {
  if (k === 0) return [[]];
  const res: number[][] = [];
  for (let l = from; l <= h - k; l++) {
    for (const rest of picks(k - 1, h, l + 1)) res.push([l, ...rest]);
  }
  return res;
}

function buildLayout(flow: MetroFlow, step: FoldStep, gap: number, ascii: boolean): MetroLayout {
  const baseNodes = resolvedStations(flow);
  const hadExplicitLanes = !step.done && step.keep === undefined
    && flow.stations.length > 0 && flow.stations.every((s) => s.lane !== undefined);
  let nodes = limitWave(fold(baseNodes, step));
  if (!nodes.length) return { nodes: [], edges: [], spurs: [], lanes: 0, width: 0 };

  for (let guard = 0; guard < 16; guard++) {
    const d = depthsOf(nodes);
    const cols: WorkNode[][] = [];
    for (const n of nodes) {
      const colIdx = d.get(n.id) ?? 0;
      (cols[colIdx] ??= []).push({ ...n, deps: [...n.deps], col: colIdx });
    }
    const denseCols = cols.filter((c): c is WorkNode[] => Boolean(c?.length));
    const maxColLen = Math.max(1, ...denseCols.map((c) => c.length));
    const height = Math.min(LANES, Math.max(maxColLen, hadExplicitLanes ? Math.min(LANES, flow.lanes ?? 1) : 1));
    const trunk = Math.floor((height - 1) / 2);
    const by = new Map<string, WorkNode>();

    for (const [colIdx, col] of denseCols.entries()) {
      for (const n of col) {
        n.col = colIdx;
        if (hadExplicitLanes && n.lane !== undefined && !n.inlineRepair) {
          n.pref = Math.max(0, Math.min(height - 1, n.lane));
        } else {
          n.pref = n.deps.length === 1 && by.has(n.deps[0]!) ? by.get(n.deps[0]!)!.lane : trunk;
        }
      }
      col.sort((a, b) => Number(Boolean(a.repair)) - Number(Boolean(b.repair)) || a.pref - b.pref);
      const candidates = picks(col.length, height);
      const cost = (p: number[]) => p.reduce((sum, l, i) => sum + Math.abs(l - col[i]!.pref), 0);
      candidates.sort((a, b) => cost(a) - cost(b));
      const best = candidates[0] ?? col.map((_, i) => Math.min(height - 1, i));
      col.forEach((n, i) => { n.lane = best[i]!; by.set(n.id, n); });
    }

    let x = 2;
    for (const col of denseCols) {
      const w = Math.max(...col.map((n) => nodeWidth(n, ascii)));
      for (const n of col) {
        n.w = nodeWidth(n, ascii);
        n.x = x + Math.floor((w - n.w) / 2);
      }
      x += w + gap;
    }
    let width = x - gap + 1;
    const allNodes = [...by.values()];
    const edges: LayoutEdge[] = [];
    for (const n of allNodes) {
      for (const id of n.deps) {
        const u = by.get(id);
        if (!u) continue;
        const sx = u.x + u.w;
        const ex = n.x - 1;
        const merge = n.deps.length > 1;
        let bend: number | null = u.lane === n.lane ? null : merge ? Math.max(sx, ex - 1) : Math.min(ex, sx + 1);
        // For skip-a-column edges that would pass through a station on u.lane, bend early if n.lane is free.
        if (bend !== null && n.col - u.col > 1 && merge) {
          const hitsSourceLane = allNodes.some((m) => m !== u && m !== n && m.lane === u.lane && m.x >= sx && m.x < bend!);
          const targetLaneFree = !allNodes.some((m) => m !== u && m !== n && m.lane === n.lane && m.x >= sx && m.x <= ex);
          if (hitsSourceLane && targetLaneFree) bend = Math.min(ex, sx + 1);
        }
        edges.push({
          id: `${id}>${n.id}`, from: u.lane, to: n.lane, sx, ex, bend, merge,
          lit: u.state === 'done', spur: Boolean(n.inlineRepair),
        });
      }
    }

    let lanes = height;
    let inline: WorkNode | null = null;
    const spurs: LayoutSpur[] = [];
    for (const n of allNodes) {
      if (!n.repair) continue;
      const a = n.x - 2;
      const b = n.x + n.w + 1;
      const free = (lane: number) => lane >= 0 && lane < LANES
        && !allNodes.some((m) => m.lane === lane && m.x <= b && m.x + m.w > a)
        && !edges.some((e) => (e.from === lane && e.sx <= b && (e.bend ?? e.ex) >= a)
          || (e.to === lane && e.ex >= a && (e.bend ?? e.sx) <= b));
      const lane = [n.lane + 1, n.lane - 1].find(free);
      if (lane === undefined || a < 2) { inline = n; break; }
      const mid = Math.floor((a + b) / 2);
      const repairId = n.repair.id ?? `${n.id}↻`;
      spurs.push({
        host: n, lane, a, b,
        node: {
          id: repairId,
          num: n.num,
          kind: 'worker',
          state: n.repair.state,
          title: n.repair.title ?? n.title,
          role: n.repair.role,
          since: n.repair.since,
          changedAt: n.repair.changedAt,
          jobId: n.repair.jobId,
          execJob: n.repair.execJob,
          round: n.repair.round,
          host: n,
          deps: [],
          col: n.col,
          pref: lane,
          lane,
          x: mid,
          w: 1,
          spur: true,
        },
      });
      lanes = Math.max(lanes, lane + 1);
      width = Math.max(width, b + 1);
    }

    if (inline && inline.repair) {
      const repairId = inline.repair.id ?? `${inline.id}↻`;
      const r: WorkNode = {
        id: repairId,
        num: inline.num,
        kind: 'worker',
        state: inline.repair.state,
        title: inline.repair.title ?? inline.title,
        role: inline.repair.role,
        since: inline.repair.since,
        changedAt: inline.repair.changedAt,
        jobId: inline.repair.jobId,
        execJob: inline.repair.execJob,
        round: inline.repair.round,
        host: inline,
        deps: [inline.id],
        inlineRepair: true,
        col: 0, pref: 0, lane: 0, x: 0, w: 1,
      };
      const hostId = inline.id;
      nodes = nodes.map((n) => n.id === hostId ? { ...n, repair: undefined, state: 'done' as const }
        : { ...n, deps: n.deps.map((dep) => (dep === hostId ? repairId : dep)) });
      const at = nodes.findIndex((n) => n.id === hostId);
      nodes.splice(at + 1, 0, r);
      continue;
    }

    return { nodes: allNodes, edges, spurs, lanes, width };
  }
  return { nodes: [], edges: [], spurs: [], lanes: 0, width: 0 };
}

/** First fit wins: generous spacing, then folds in order, then compact gate and tighter spacing. */
export function layoutMetroFlow(flow: MetroFlow, width: number, ascii = asciiBoard()): MetroLayout {
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
      const m = buildLayout(flow, step, gap, ascii);
      if (m.width <= width) return m;
    }
  }
  return buildLayout(flow, { done: true, keep: 0, compact: true }, 1, ascii);
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
  for (const s of m.spurs) {
    const down = s.lane > s.host.lane;
    const away: Arm = down ? 'D' : 'U';
    const back: Arm = down ? 'U' : 'D';
    const out: LineEdge = { spur: true, lit: true };
    const ret: LineEdge = { spur: true, lit: s.node.state === 'done' };
    add(s.host.lane, s.a, [away], out);
    add(s.lane, s.a, [back, 'R'], out);
    for (let x = s.a + 1; x < s.node.x; x++) add(s.lane, x, LR, out);
    for (let x = s.node.x + 1; x < s.b; x++) add(s.lane, x, LR, ret);
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
    x = cv.put(r, x, plain ? '(' : '▐', plain ? {} : { fg: edgeFg });
    poolParts(node.counts).forEach(([state, n], i) => {
      if (i) x = cv.put(r, x, ' ', { bg });
      const own = stateStyle(state);
      x = cv.put(r, x, stationChar('worker', state, ascii), { bg, ...own });
      x = cv.text(r, x, `${ascii ? '' : '×'}${n}`, { bg, fg: state === 'waiting' ? 'muted' : 'text' });
    });
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
  const base = resolvedStations(flow);
  const all: WorkNode[] = [];
  for (const n of base) {
    all.push(n);
    if (n.repair) {
      all.push({
        id: n.repair.id ?? `${n.id}↻`,
        num: n.num,
        kind: 'worker',
        state: n.repair.state,
        title: n.repair.title ?? n.title,
        role: n.repair.role,
        since: n.repair.since,
        changedAt: n.repair.changedAt,
        jobId: n.repair.jobId,
        execJob: n.repair.execJob,
        round: n.repair.round,
        host: n,
        deps: [],
        col: 0, pref: 0, lane: 0, x: 0, w: 1,
      });
    }
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
  if (node.host && node.round) return `${t('repair')} ${monitorText(node.round)}`;
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
  const waits = state === 'waiting' && node.waits ? `${ascii ? '<-' : '←'}${monitorText(node.waits)}` : '';
  const mins = elapsedMinutes(node.since, now);
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

/** Render one open flow: header row + 1–3 Hairline map rows + 1 detail row. */
export function renderMetroFlow(flow: MetroFlow, selected: string | undefined, width: number, now: number): MonitorRow[] {
  const ascii = asciiBoard();
  const noColour = displayConfig().theme === 'none';
  const headerSelected = selected === runItem(flow.flow);
  const header = renderHeaderRow(flow, headerSelected, width, now, ascii, noColour);
  const m = layoutMetroFlow(flow, width, ascii);
  if (!m.lanes) return [header];

  const cv = new Canvas(width);
  const rows = Array.from({ length: m.lanes }, () => cv.row());
  drawHairlineLines(cv, rows, m, ascii);

  const stations: WorkNode[] = [...m.nodes, ...m.spurs.map((s) => s.node)];
  const cursorStation = stations.find((n) => metroStationItem(flow.flow, n.id) === selected);
  for (const n of stations) drawStation(cv, rows, n, ascii, noColour, n === cursorStation);

  // Without colour (and in ASCII), a repair round marks itself before its station.
  if (noColour || ascii) {
    for (const n of stations) {
      if (!n.spur && !n.inlineRepair) continue;
      const at = n.x - (cursorStation === n ? 2 : 1);
      if (at >= 0 && at < width) cv.put(rows[n.lane]!, at, ascii ? '%' : '↻', { fg: 'stalled' });
    }
  }

  if (cursorStation) {
    const r = rows[cursorStation.lane]!;
    if (noColour) {
      if (cursorStation.x - 1 >= 0) cv.put(r, cursorStation.x - 1, ascii ? '>' : '▸');
      if (cursorStation.x + cursorStation.w < width) cv.put(r, cursorStation.x + cursorStation.w, ascii ? '<' : '◂');
    } else if (cursorStation.kind !== 'pool') {
      const from = Math.max(0, cursorStation.x - 1);
      const to = Math.min(width - 1, cursorStation.x + cursorStation.w);
      for (let cx = from; cx <= to; cx++) {
        if (!r[cx]!.bg) r[cx] = { ...r[cx]!, bg: 'selected' };
      }
    }
  }

  const allLogical = allLogicalStations(flow);
  const fallbackDetail = defaultDetailStation(flow, allLogical);
  const detailNode = cursorStation ?? fallbackDetail;
  const defaultLayoutId = fallbackDetail && stations.some((s) => s.id === fallbackDetail.id)
    ? fallbackDetail.id
    : stations.find((s) => s.state !== 'done' && s.state !== 'waiting')?.id ?? stations[0]?.id;

  const byLane: MetroStationTarget[][] = Array.from({ length: m.lanes }, () => []);
  for (const n of stations) {
    if (n.x >= width) continue;
    byLane[n.lane]!.push({
      item: metroStationItem(flow.flow, n.id),
      flow: flow.flow,
      x: n.x,
      width: Math.min(n.w, width - n.x),
      lane: n.lane,
      col: n.col,
      ...(n.id === defaultLayoutId ? { defaultEntry: true as const } : {}),
      ...(n.execJob ? { execJob: n.execJob } : {}),
    });
  }
  for (const lane of byLane) lane.sort((a, b) => a.x - b.x);

  const mapRows: MonitorRow[] = rows.map((r, lane) => ({
    text: fit(paintRow(r, noColour), width),
    metroStations: byLane[lane]!,
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
    ...(s.repair ? [{ ...s.repair, id: s.repair.id ?? `${s.id}↻`, kind: 'worker' as const, gate: undefined, repairMark: true }] : []),
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
    [has((n) => n.state === 'unknown'), ascii ? 'u' : '◌', { fg: 'muted' }, t('unknown')],
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

/* ───────────────────────── thin adapter: ExecutionRun -> MetroFlow ───────────────────────── */

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

function claimJob(jobId: string | undefined, target: ExecutionRunJobTarget | undefined, seen: Set<string>): ExecutionRunJobTarget | undefined {
  if (!jobId || !target || seen.has(jobId)) return undefined;
  seen.add(jobId);
  return target;
}

const ticketShort = (key: string) => key.split('/').at(-1)!;

function ticketToStation(
  ticket: ExecutionRunTicket,
  label: (ref: string) => string,
  deps: readonly string[],
  seen: Set<string>,
): MetroStation {
  const num = label(ticket.ticket);
  const execJob = claimJob(ticket.jobId, ticket.execJob, seen);
  const waits = ticket.blockers?.length ? ticket.blockers.map(label).join(',') : undefined;
  const base = {
    id: `ticket:${ticket.ticket}`,
    num,
    kind: 'worker' as const,
    ...(ticket.title ? { title: ticket.title } : {}),
    role: ticket.role ?? 'imp',
    deps,
    ...(waits ? { waits } : {}),
    ...(ticket.jobId ? { jobId: ticket.jobId } : {}),
    ...(execJob ? { execJob } : {}),
  };
  switch (ticket.stage) {
    case 'landed':
      return { ...base, state: 'done' };
    case 'settled':
      return { ...base, state: 'done', stateWord: 'settled' };
    case 'held':
      return { ...base, state: 'held', ...(ticket.since !== undefined ? { since: ticket.since } : {}) };
    case 'failed':
      return { ...base, state: 'failed', ...(ticket.since !== undefined ? { since: ticket.since } : {}) };
    case 'queued':
    case 'blocked':
      return { ...base, state: 'waiting' };
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
      if (p?.kind === 'repair') {
        return {
          ...base,
          state: 'working',
          gate: { k: 1, n: 1, state: 'failed' },
          repair: {
            state: ticket.asking ? 'asking' : 'working',
            round: `${p.index ?? 1}/${p.total ?? 2}`,
            role: ticket.role ?? 'imp',
            title: ticket.title ?? num,
            ...(since !== undefined ? { since } : {}),
            ...(ticket.jobId ? { jobId: ticket.jobId } : {}),
            ...(execJob ? { execJob } : {}),
          },
          execJob: undefined,
        };
      }
      const k = p?.index ?? 1;
      const n = p?.total ?? Math.max(1, k);
      return {
        ...base,
        state: 'working',
        gate: { k, n, state: 'working' },
        ...(since !== undefined ? { since } : {}),
      };
    }
  }
}

/** Thin adapter projecting today's cached `ExecutionRun` into `MetroFlow` (wave-order fallback when edges are absent). */
export function metroFlowFromRun(run: ExecutionRun, seen: Set<string>): MetroFlow {
  const flowState: MetroFlowState = run.state === 'paused' ? 'paused' : 'running';
  const base = { flow: run.flow, kind: run.kind, name: run.label, state: flowState, createdAt: run.createdAt };

  if (run.kind === 'queue') {
    const own = new Set(run.tickets.map((tk) => tk.ticket));
    const label = (ref: string) => (!run.unattended && own.has(ref) ? ticketShort(ref) : ref);
    const idOf = (ref: string) => `ticket:${ref}`;
    const hasExplicitEdges = run.tickets.some((tk) => tk.stage !== 'queued' && tk.stage !== 'blocked' && tk.blockers !== undefined);
    const stations: MetroStation[] = [];
    const referenced = new Set<string>();

    if (hasExplicitEdges) {
      for (const tk of run.tickets) {
        const deps = (tk.blockers ?? []).filter((b) => own.has(b)).map(idOf);
        for (const dep of deps) referenced.add(dep);
        stations.push(ticketToStation(tk, label, deps, seen));
      }
    } else if (run.queueWaves) {
      const { prefix, current, blocked } = run.queueWaves;
      let lastPrefixId: string | undefined;
      for (const tk of prefix) {
        const deps = lastPrefixId ? [lastPrefixId] : [];
        if (lastPrefixId) referenced.add(lastPrefixId);
        stations.push(ticketToStation(tk, label, deps, seen));
        lastPrefixId = idOf(tk.ticket);
      }
      const currentIds: string[] = [];
      for (const tk of current) {
        const deps = tk.blockers?.length
          ? tk.blockers.filter((b) => own.has(b)).map(idOf)
          : lastPrefixId ? [lastPrefixId] : [];
        for (const dep of deps) referenced.add(dep);
        stations.push(ticketToStation(tk, label, deps, seen));
        currentIds.push(idOf(tk.ticket));
      }
      let prevWaveIds = currentIds.length ? currentIds : lastPrefixId ? [lastPrefixId] : [];
      for (const wave of blocked) {
        const waveIds: string[] = [];
        for (const tk of wave) {
          const explicit = (tk.blockers ?? []).filter((b) => own.has(b)).map(idOf);
          const deps = explicit.length ? explicit : prevWaveIds;
          for (const dep of deps) referenced.add(dep);
          stations.push(ticketToStation(tk, label, deps, seen));
          waveIds.push(idOf(tk.ticket));
        }
        prevWaveIds = waveIds;
      }
    }

    const leaves = stations.filter((s) => !referenced.has(s.id)).map((s) => s.id);
    const reviewStep = run.steps.find((s) => s.key === 'review');
    const acceptStep = run.steps.find((s) => s.key === 'accept');
    const reviewJob = claimJob(run.reviewer?.jobId, run.reviewer?.execJob, seen);
    const leadJob = claimJob(run.lead?.jobId, run.lead?.execJob, seen);
    stations.push({
      id: 'review',
      kind: 'review',
      state: mapStepState(run.reviewer?.state ?? reviewStep?.state ?? 'waiting'),
      title: t('Run review'),
      deps: leaves,
      ...(run.reviewer?.since !== undefined ? { since: run.reviewer.since } : {}),
      ...(run.reviewer?.jobId ? { jobId: run.reviewer.jobId } : {}),
      ...(reviewJob ? { execJob: reviewJob } : {}),
    });
    stations.push({
      id: 'accept',
      kind: 'accept',
      state: mapStepState(run.lead?.state ?? acceptStep?.state ?? 'waiting'),
      title: t('Lead acceptance'),
      deps: ['review'],
      ...(run.lead?.since !== undefined ? { since: run.lead.since } : {}),
      ...(run.lead?.jobId ? { jobId: run.lead.jobId } : {}),
      ...(leadJob ? { execJob: leadJob } : {}),
    });
    return { ...base, stations };
  }

  if (run.kind === 'batch' && run.batch) {
    const { batch } = run;
    const { done, failed, running, waiting, cancelled } = batch.totals;
    const stations: MetroStation[] = [];
    const hasPilot = Boolean(batch.pilots && batch.pilots.total > 0);
    if (hasPilot && batch.pilots) {
      stations.push({
        id: 'pilot',
        kind: 'worker',
        state: mapStepState(batch.pilots.state),
        title: t('Pilot {done}/{total}', { done: batch.pilots.done, total: batch.pilots.total }),
        deps: [],
      });
    }
    stations.push({
      id: 'pool',
      kind: 'pool',
      state: running ? 'working' : waiting ? 'waiting' : failed ? 'failed' : 'done',
      counts: { done, working: running, failed, waiting, stopped: cancelled },
      role: batch.role,
      title: t('Pool of {n}', { n: batch.count }),
      deps: hasPilot ? ['pilot'] : [],
      ...(run.createdAt !== null ? { since: run.createdAt } : {}),
    });
    stations.push({
      id: 'summary',
      kind: 'summary',
      state: run.endedAt === undefined ? 'waiting' : 'done',
      title: t('metro: summary'),
      deps: ['pool'],
    });
    const slots = batch.slots !== undefined && batch.state === 'working' ? `${running}/${batch.slots}` : undefined;
    return { ...base, batch, ...(slots ? { slots } : {}), stations };
  }

  if (run.kind === 'land') {
    const flat = (run.nodes ?? []).flat();
    const byKey = new Map(flat.map((n) => [n.key, n]));
    const pick = byKey.get('pick');
    const gate = byKey.get('gate');
    const repair = byKey.get('repair');
    const lease = byKey.get('lease');
    const merge = byKey.get('merge');
    const stations: MetroStation[] = [];
    let prev: string[] = [];
    if (pick) {
      const execJob = claimJob(pick.jobId, pick.execJob, seen);
      stations.push({
        id: 'pick', kind: 'worker', state: mapStepState(pick.state), title: t('Cherry-pick'), deps: [],
        ...(pick.since !== undefined ? { since: pick.since } : {}),
        ...(pick.jobId ? { jobId: pick.jobId } : {}), ...(execJob ? { execJob } : {}),
      });
      prev = ['pick'];
    }
    if (lease && (!gate || gate.state === 'waiting')) {
      const execJob = claimJob(lease.jobId, lease.execJob, seen);
      stations.push({
        id: 'lease', kind: 'worker', state: 'lease', title: t('Lease wait'), deps: prev,
        ...(lease.progress?.since !== undefined ? { since: lease.progress.since } : lease.since !== undefined ? { since: lease.since } : {}),
        ...(lease.jobId ? { jobId: lease.jobId } : {}), ...(execJob ? { execJob } : {}),
      });
      prev = ['lease'];
    } else if (gate) {
      const execJob = claimJob(gate.jobId, gate.execJob, seen);
      const repairJob = repair ? claimJob(repair.jobId, repair.execJob, seen) : undefined;
      const gState = gate.state === 'failed' ? 'failed' : gate.state === 'running' ? 'working' : undefined;
      const hasGateSteps = Boolean(gate.progress?.total && gState);
      const gateSpec: MetroGate | undefined = hasGateSteps
        ? { k: gate.progress!.index ?? 1, n: gate.progress!.total!, state: gState! }
        : undefined;
      const repairSpec: MetroRepair | undefined = repair ? {
        id: 'repair',
        state: mapStepState(repair.state),
        round: `${repair.progress?.index ?? 1}/${repair.progress?.total ?? 2}`,
        role: repair.role ?? 'imp',
        title: repair.label ?? t('Repair'),
        ...(repair.progress?.since !== undefined ? { since: repair.progress.since } : repair.since !== undefined ? { since: repair.since } : {}),
        ...(repair.jobId ? { jobId: repair.jobId } : {}),
        ...(repairJob ? { execJob: repairJob } : {}),
      } : undefined;
      stations.push({
        id: 'gate', kind: 'worker', state: mapStepState(gate.state), title: t('Gate'), deps: prev,
        ...(gateSpec ? { gate: gateSpec } : {}),
        ...(repairSpec ? { repair: repairSpec } : {}),
        ...(gate.progress?.since !== undefined ? { since: gate.progress.since } : gate.since !== undefined ? { since: gate.since } : {}),
        ...(gate.jobId ? { jobId: gate.jobId } : {}), ...(execJob ? { execJob } : {}),
      });
      prev = ['gate'];
    }
    if (merge) {
      const execJob = claimJob(merge.jobId, merge.execJob, seen);
      stations.push({
        id: 'merge', kind: 'worker', state: mapStepState(merge.state), title: t('Merge'), deps: prev,
        ...(merge.since !== undefined ? { since: merge.since } : {}),
        ...(merge.jobId ? { jobId: merge.jobId } : {}), ...(execJob ? { execJob } : {}),
      });
    }
    return { ...base, stations };
  }

  if (run.kind === 'council' || run.kind === 'prewalk') {
    const waves = run.nodes ?? [];
    const first = waves[0] ?? [];
    const second = waves[1] ?? [];
    const stations: MetroStation[] = [];
    for (const node of first) {
      const execJob = claimJob(node.jobId, node.execJob, seen);
      const title = run.kind === 'council'
        ? (node.label ? t('Member {name}', { name: monitorText(node.label) }) : t('Worker'))
        : (node.word === 'Scout' && node.label ? t('{kind} prewalk scout', { kind: monitorText(node.label) }) : t(node.word ?? 'Scouts'));
      stations.push({
        id: node.key,
        kind: 'worker',
        state: mapStepState(node.state),
        title,
        ...(run.kind === 'council' ? { role: node.role ?? 'oracle' } : node.role ? { role: node.role } : {}),
        deps: [],
        ...(node.since !== undefined ? { since: node.since } : {}),
        ...(node.jobId ? { jobId: node.jobId } : {}),
        ...(execJob ? { execJob } : {}),
      });
    }
    const deps = first.map((n) => n.key);
    for (const node of second) {
      const execJob = claimJob(node.jobId, node.execJob, seen);
      const isSynth = run.kind === 'council';
      const title = isSynth
        ? (node.label ? t('Synthesis ({seat})', { seat: monitorText(node.label) }) : t('Synthesis'))
        : t(node.word ?? 'Worker');
      stations.push({
        id: node.key,
        kind: isSynth ? 'synth' : 'worker',
        state: mapStepState(node.state),
        title,
        ...(!isSynth && node.role ? { role: node.role } : {}),
        deps,
        ...(node.since !== undefined ? { since: node.since } : {}),
        ...(node.jobId ? { jobId: node.jobId } : {}),
        ...(execJob ? { execJob } : {}),
      });
    }
    return { ...base, stations };
  }

  // Generic graph.json workflow: project nodes and their explicit blockers.
  const allNodes: WorkflowNode[] = (run.nodes ?? []).flat();
  const known = new Set(allNodes.map((n) => n.key));
  const stations: MetroStation[] = allNodes.map((node) => {
    const execJob = claimJob(node.jobId, node.execJob, seen);
    const deps = (node.blockers ?? []).filter((b) => known.has(b));
    return {
      id: node.key,
      kind: 'worker',
      state: mapStepState(node.state),
      title: node.label ?? node.key,
      ...(node.role ? { role: node.role } : {}),
      deps,
      ...(node.blockers?.length ? { waits: node.blockers.join(',') } : {}),
      ...(node.since !== undefined ? { since: node.since } : {}),
      ...(node.jobId ? { jobId: node.jobId } : {}),
      ...(execJob ? { execJob } : {}),
    };
  });
  return { ...base, stations };
}

/* ───────────────────────── station lookup & keyboard navigation ───────────────────────── */

export function metroStationAt(row: MonitorRow | undefined, col: number): MetroStationTarget | undefined {
  return row?.metroStations?.find((s) => col >= s.x && col < s.x + s.width);
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

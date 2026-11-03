/**
 * The tree's compact rows (design §3.2, §3.4, §3.6, §4.2): which rows there
 * are and in what order (`planRows`, strings-free), and each row as exactly
 * `width` columns of text (`renderRow`).
 *
 * A plan depends on the projection and the second, not on the selection or the
 * width, so a panel plans once a second and renders only the rows in view; a
 * rendered row is cached on its node projection under everything it reads,
 * listed once in `rowKey` (width, selection, prefix, clock text, emphasis,
 * language and translator, palette, glyph modes), so an unchanged row costs a
 * string compare (§6 #2b).
 */

import { colors, METER_DANGER, METER_WARN, theme, truncateAnsi, visualLength } from '../colors.js';
import { fitModelEffortToken, type ModelTokenPaints } from '../model-glyphs.js';
import { age } from '../monitor-labels.js';
import { palette } from '../palette.js';
import { displayConfig } from '../hud-config.js';
import { language } from '../i18n.js';
import { glyphSet, GLYPHS, useAscii, type Glyph, type GlyphSet } from './glyphs.js';
import type { DelegationProjection, GlyphCounts, NodeProjection, PNode } from './projection.js';
import { hasSelectionBand, paint, paintOnSelectedBand, panelSay, W, type Role, type Say } from './style.js';

/** A finished row stays on the list this long after the last finish in its subtree (§3.2). */
export const PUT_AWAY_MS = 180_000;
/** Deeper rows are drawn at this depth with a flat `↳` (§3.4). */
export const MAX_DEPTH = 4;
// The clock is always the last 7 columns (§3.4 rule 1: a row must not reflow when `59s` becomes `1m00s`), with a
// gap before it. A state word that does not fit beside the name at 32-39 columns yields instead, `close pane`
// included (rulings B10b s1, Q6; the 3-column clock of the §4.13 32-column sample broke the rule).
const CLOCK_COLS = 7;
const METER_COLS = 4;
const BADGE_COLS = 13;
const NAME_MIN = 8;
const SUMMARY_MIN = 12;
/** More active rows than this and the turn clocks go coarse (`◷9m`), so a second no longer repaints them. */
export const COARSE_CLOCK_ROWS = 30;
/** Names listed on the `✓ 9 done` row before it says `…`. */
const PUT_AWAY_NAMES = 8;

export interface RowOptions {
  nowMs: number;
  /** Keys whose children are folded into `+N (…)`. */
  collapsed?: ReadonlySet<string>;
  /** `a`: finished rows stay on the list instead of folding into `⊕N`. */
  showHistory?: boolean;
  /** `s`: creation order alone, no buckets. */
  sortByCreation?: boolean;
}

export interface FoldInfo {
  /** Rows hidden under the node. */
  hidden: number;
  below: GlyphCounts;
  /** The tree knows of children it did not list (`native_topology`). */
  unknown: boolean;
}

export interface PlannedRow {
  kind: 'node' | 'putAway';
  key: string;
  pn: PNode | null;
  /** Display depth, at most `MAX_DEPTH`. */
  depth: number;
  /** One flag per drawn ancestor column: does that ancestor have a later sibling (`│`) or not. */
  ancestors: boolean[];
  /** The mark of the row's own edge; none for the viewpoint root. */
  tee: 'none' | 'tee' | 'end';
  /** An unconfirmed edge (`┊`) takes the place of the tee. */
  unconfirmed: boolean;
  /** Deeper than `MAX_DEPTH`: `↳`. */
  flat: boolean;
  fold: FoldInfo | null;
  put: { count: number; names: string[] } | null;
}

export interface RowPlan {
  rows: PlannedRow[];
  /** Rows folded into `⊕N` across the tree. */
  putAway: number;
  /** More active rows than `COARSE_CLOCK_ROWS`. */
  coarse: boolean;
}

function creationOf(pn: PNode): number {
  return pn.proj.createdAt ?? Number.POSITIVE_INFINITY;
}

/** §3.2: by subtree bucket, trouble newest first, the rest in creation order. */
export function compareSiblings(byCreation: boolean) {
  return (a: PNode, b: PNode): number => {
    if (!byCreation) {
      if (a.sub.rank !== b.sub.rank) return a.sub.rank - b.sub.rank;
      if (a.sub.rank === 0) {
        const d = (b.sub.sortAt ?? Number.NEGATIVE_INFINITY) - (a.sub.sortAt ?? Number.NEGATIVE_INFINITY);
        if (d !== 0 && Number.isFinite(d)) return d;
      }
    }
    const ca = creationOf(a);
    const cb = creationOf(b);
    if (ca !== cb && Number.isFinite(ca) && Number.isFinite(cb)) return ca - cb;
    return a.index - b.index;
  };
}

interface Frame {
  items: Array<PNode | { put: { count: number; names: string[] } }>;
  i: number;
  ancestors: boolean[];
}

const planMemo = new WeakMap<DelegationProjection, { key: string; plan: RowPlan }>();

/** The rows in order, with each row's tree drawing and fold; no strings are built. */
export function planRows(proj: DelegationProjection, options: RowOptions): RowPlan {
  const memoKey = `${Math.floor(options.nowMs / 1000)}|${options.showHistory ? 1 : 0}|${options.sortByCreation ? 1 : 0}|${
    options.collapsed && options.collapsed.size > 0 ? [...options.collapsed].sort().join('\u0001') : ''
  }`;
  const hit = planMemo.get(proj);
  if (hit && hit.key === memoKey) return hit.plan;

  const compare = compareSiblings(options.sortByCreation === true);
  const rows: PlannedRow[] = [];
  let putAway = 0;
  const active = proj.counts.working + proj.counts.starting;

  const stack: Frame[] = [{ items: proj.roots.slice(), i: 0, ancestors: [] }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.items.length) {
      stack.pop();
      continue;
    }
    const item = frame.items[frame.i++];
    const later = frame.i < frame.items.length;
    const depthOf = frame.ancestors.length + 1;
    if ('put' in item) {
      rows.push({
        kind: 'putAway',
        key: `put:${stack.length}:${rows.length}`,
        pn: null,
        depth: Math.min(depthOf, MAX_DEPTH),
        ancestors: frame.ancestors.slice(0, MAX_DEPTH - 1),
        tee: 'end',
        unconfirmed: false,
        flat: false,
        fold: null,
        put: item.put,
      });
      continue;
    }
    const pn = item;
    // The viewpoint root is column zero; every other row hangs from a tee.
    const isViewRoot = frame.ancestors.length === 0 && stack.length === 1 && pn.proj.isRoot;
    const depth = isViewRoot ? 0 : Math.min(depthOf, MAX_DEPTH);
    const collapsed = options.collapsed?.has(pn.key) === true && pn.children.length > 0;
    rows.push({
      kind: 'node',
      key: pn.key,
      pn,
      depth,
      ancestors: frame.ancestors.slice(0, MAX_DEPTH - 1),
      tee: isViewRoot ? 'none' : later ? 'tee' : 'end',
      unconfirmed: !isViewRoot && (pn.proj.unconfirmed || pn.node === null),
      flat: !isViewRoot && depthOf > MAX_DEPTH,
      fold: collapsed ? { hidden: pn.sub.total, below: pn.sub.below, unknown: pn.childrenUnknown } : null,
      put: null,
    });
    if (collapsed || pn.children.length === 0) continue;

    // Children in bucket order; finished subtrees past their linger window fold into one row (§3.2).
    const kept: PNode[] = [];
    const away: PNode[] = [];
    for (const child of pn.children) {
      const finish = child.sub.youngestFinish;
      if (!options.showHistory && child.sub.allFinished && finish !== null && options.nowMs - finish >= PUT_AWAY_MS)
        away.push(child);
      else kept.push(child);
    }
    kept.sort(compare);
    const items: Frame['items'] = kept;
    if (away.length > 0) {
      away.sort(compare);
      const count = away.reduce((sum, child) => sum + 1 + child.sub.total, 0);
      putAway += count;
      items.push({
        put: { count, names: away.slice(0, PUT_AWAY_NAMES).map((child) => child.proj.name ?? child.key) },
      });
    }
    // This node's own column continues below it while it has later siblings; the root draws none.
    const own = isViewRoot ? [] : [later];
    stack.push({ items, i: 0, ancestors: frame.ancestors.concat(own) });
  }

  const plan: RowPlan = { rows, putAway, coarse: active > COARSE_CLOCK_ROWS };
  planMemo.set(proj, { key: memoKey, plan });
  return plan;
}

// ---------------------------------------------------------------------------
// Rendering

export interface RenderContext {
  proj: DelegationProjection;
  width: number;
  nowMs: number;
  ascii?: boolean;
  /** Word table: the panel's `t()` by default, `plainSay` for the bar. */
  say?: Say;
  selectedKey?: string | null;
  /** From the plan; turn clocks drop their seconds. */
  coarse?: boolean;
}

/** `12m04s`, `1h05m` (a turn's clock, §3.4). */
export function turnClockText(ms: number, coarse = false): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return coarse ? `${m}m` : `${m}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function clockOf(proj: NodeProjection, nowMs: number, g: GlyphSet, coarse: boolean): { text: string; role: Role } {
  const c = proj.marker.clock;
  // No clock rather than an invented age: nothing to measure from, or a time that has not happened yet (§3.4).
  if (c.at === null || c.kind === 'none' || c.at > nowMs) return { text: '', role: 'muted' };
  if (c.kind === 'turn') return { text: `${g.clock}${turnClockText(nowMs - c.at, coarse)}`, role: 'info' };
  const base = age(new Date(c.at), nowMs);
  const text = c.approx ? `~${base}` : base;
  return { text, role: c.kind === 'dwell' ? proj.marker.role : 'muted' };
}

const WORST_ORDER: readonly Glyph[] = ['flag', 'fail', 'warn', 'unknown', 'working', 'starting', 'stop', 'done'];

/** `1⚑ 2▸` for the long fold, the worst glyph alone for the short one. */
function foldTexts(fold: FoldInfo, g: GlyphSet): { long: string; short: string } {
  const u = fold.unknown ? '?' : '';
  const parts: string[] = [];
  let worst = '';
  for (const glyph of WORST_ORDER) {
    const n = fold.below[glyph];
    if (n <= 0) continue;
    if (!worst) worst = g.marker[glyph];
    parts.push(`${n}${g.marker[glyph]}`);
  }
  return { long: `+${fold.hidden}${u} (${parts.join(' ')})`, short: `+${fold.hidden}${u}${worst}` };
}

type Tier = 'wide' | 'medium' | 'narrow' | 'tight';
function tierOf(width: number): Tier {
  return width >= 48 ? 'wide' : width >= 40 ? 'medium' : width >= 32 ? 'narrow' : 'tight';
}

/** The meter in `cells` columns: heavy where used, light where free, with a half step (Unicode only). */
function meter(percent: number, cells: number, g: GlyphSet, ink: Ink): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const halves = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * cells * 2)) : 0;
  const unicodeHalf = g.meter.half !== g.meter.fill;
  const full = unicodeHalf ? Math.floor(halves / 2) : Math.round(halves / 2);
  const half = unicodeHalf && halves % 2 ? g.meter.half : '';
  const used = g.meter.fill.repeat(full) + half;
  // The fill's zone is the shared one (success, warning from 70, danger from 85), painted by the row's ink.
  const zone: Role = clamped >= METER_DANGER ? 'danger' : clamped >= METER_WARN ? 'warning' : 'success';
  return ink.paint(zone, used) + ink.muted(g.meter.track.repeat(Math.max(0, cells - visualLength(used))));
}

function clip(text: string, width: number, g: GlyphSet): string {
  if (width <= 0) return '';
  return visualLength(text) <= width ? text : truncateAnsi(text, width, g.ellipsis);
}

function padStart(text: string, width: number): string {
  const w = visualLength(text);
  return w >= width ? text : ' '.repeat(width - w) + text;
}

type RightClass = 'full' | 'native' | 'clock';

/**
 * Finished rows (`✓ ! ■`, and the reported-but-alive `close pane` ones) say
 * what they delivered in place of the badge and the meter (§3.4); the root is
 * never history.
 */
function isHistoryStyle(proj: NodeProjection): boolean {
  return !proj.isRoot && (proj.marker.rank === 3 || proj.marker.closePane);
}

function rightClassOf(proj: NodeProjection): RightClass {
  if (proj.marker.trouble || isHistoryStyle(proj)) return 'clock';
  return proj.isNative ? 'native' : 'full';
}

const rowCache = new WeakMap<NodeProjection, Map<string, string>>();
const ROW_CACHE_LIMIT = 8;

function prefixText(row: PlannedRow, g: GlyphSet): string {
  let out = '';
  for (const cont of row.ancestors) out += cont ? `${g.edge.line} ` : '  ';
  // The viewpoint root is drawn one column in, as in the design's samples (`|› ▸ ✳ main`), clear of the selection mark.
  if (row.tee === 'none') return `${out} `;
  if (row.flat) return `${out}${g.edge.flat} `;
  if (row.unconfirmed) return `${out}${g.edge.unconfirmed} `;
  return `${out}${row.tee === 'end' ? g.edge.end : g.edge.tee} `;
}

/** A new semantic episode keeps its state word and clock bold for this long (§3.2, §5.2). */
export const EMPHASIS_MS = 3000;

/**
 * Whether the row's state began in the last three seconds, by the published episode boundary (`stateSince`, §7 #23):
 * the second round of approval under the same `⚑` is a new episode too. Every node qualifies, the viewpoint root
 * included, and an `observed` boundary as much as an `event` one: it is persisted with the commit, not a timer
 * this process started. A boundary the published data does not stand behind (basis `unknown`, an anomalous clock)
 * is no episode, and neither is one that has not happened yet.
 */
function newEpisode(proj: NodeProjection, nowMs: number): boolean {
  const m = proj.marker;
  return m.sinceBasis !== 'unknown' && m.sinceMs !== null && nowMs >= m.sinceMs && nowMs - m.sinceMs < EMPHASIS_MS;
}

/**
 * How a row paints. A selected row on a palette with a band sits on it and paints every span through the palette's
 * `onSelectedBand` family (calibrated for that surface: nothing on the band is a plain `theme.*` colour). A selected
 * row on a palette without one (`none`, `terminal`), and every other row, uses the plain role colours (§5.2 "选中行").
 */
interface Ink {
  /** What recedes: the tree, separators, `⊟`, the summary, the fold, the meter's track. */
  muted(text: string): string;
  /** The selection mark. */
  accent(text: string): string;
  paint(role: Role, text: string): string;
  /** The model badge's paints; undefined is the palette's plain roles. */
  badge(): ModelTokenPaints | undefined;
}
const PLAIN_INK: Ink = {
  muted: (text) => colors.dim(text),
  accent: (text) => theme.accent(text),
  paint,
  badge: () => undefined,
};
const SELECTED_INK: Ink = {
  muted: (text) => palette().onSelectedBand.muted(text),
  accent: (text) => palette().onSelectedBand.accent(text),
  paint: paintOnSelectedBand,
  badge: () => {
    const ink = palette().onSelectedBand;
    return { model: ink.model, muted: ink.muted, warning: ink.warning };
  },
};

/** Marker paint with the §5.2 fade: success and warning settle to muted after `fadesAfterMs`. */
function fadedRole(proj: NodeProjection, nowMs: number): Role {
  const m = proj.marker;
  if (m.fadesAfterMs !== null && m.sinceMs !== null && nowMs - m.sinceMs >= m.fadesAfterMs) return 'muted';
  return m.role;
}

function nameMuted(proj: NodeProjection, nowMs: number): boolean {
  const m = proj.marker;
  if (m.muteName === 'always') return true;
  if (m.muteName === 'afterFade') return fadedRole(proj, nowMs) === 'muted' && m.fadesAfterMs !== null;
  return false;
}

/** The row's text for one node, exactly `ctx.width` columns. */
export function renderRow(row: PlannedRow, ctx: RenderContext): string {
  if (row.kind === 'putAway') return renderPutAway(row, ctx);
  const pn = row.pn!;
  const proj = pn.proj;
  const g = glyphSet(ctx.ascii);
  const say = ctx.say ?? panelSay;
  const selected = ctx.selectedKey === pn.key;
  const prefix = prefixText(row, g);
  const clock = clockOf(proj, ctx.nowMs, g, ctx.coarse === true);
  const faded = fadedRole(proj, ctx.nowMs);
  const parentModel = proj.isNative ? (pn.parent?.proj.model ?? null) : null;
  const emphasis = newEpisode(proj, ctx.nowMs);
  const key = rowKey(row, ctx, say, selected, prefix, clock.text, faded, parentModel, emphasis);
  let cache = rowCache.get(proj);
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;

  const text = layoutRow(row, ctx, { prefix, clock, faded, selected, parentModel, emphasis, g, say });
  if (!cache) {
    cache = new Map();
    rowCache.set(proj, cache);
  }
  if (cache.size >= ROW_CACHE_LIMIT) cache.clear();
  cache.set(key, text);
  return text;
}

const sayIds = new WeakMap<Say, number>();
let nextSayId = 1;
let lastSay: Say | null = null;
let lastSayId = 0;
/** A translator's identity for the row key: two different `Say`s must not share a cached row. */
function sayId(say: Say): number {
  if (say === lastSay) return lastSayId;
  let id = sayIds.get(say);
  if (id === undefined) {
    id = nextSayId++;
    sayIds.set(say, id);
  }
  lastSay = say;
  lastSayId = id;
  return id;
}

/** The fold's counts as a delimited tuple: `1,11,0,...` can never read as `11,1,0,...`. */
const foldKey = (fold: FoldInfo): string =>
  `${fold.hidden}/${fold.unknown ? 1 : 0}/${GLYPHS.map((glyph) => fold.below[glyph]).join(',')}`;

/**
 * Everything a row's text reads besides its node projection, in one place. A row is cached under this key, so
 * an input the layout reads that is missing here would show a stale row after it changed; each entry is covered
 * by a warm-versus-cold test in `b10b-cache.test.ts`.
 */
function rowKey(
  row: PlannedRow,
  ctx: RenderContext,
  say: Say,
  selected: boolean,
  prefix: string,
  clockText: string,
  faded: Role,
  parentModel: string | null,
  emphasis: boolean
): string {
  // The glyph set actually in use, not the option: an omitted `ascii` follows the display's icon set.
  return `${ctx.width}${useAscii(ctx.ascii) ? 'a' : 'u'}${selected ? 's' : 'n'}${emphasis ? 'e' : 'q'}${
    ctx.proj.crossHarness ? 'x' : 'y'
  }${nameMuted(row.pn!.proj, ctx.nowMs) ? 'm' : 'v'}\u0001${prefix}\u0001${clockText}\u0001${faded}\u0001${
    row.fold ? foldKey(row.fold) : ''
  }\u0001${parentModel ?? ''}\u0001${sayId(say)}\u0001${language()}\u0001${palette().name}\u0001${displayConfig().glyphs}`;
}

interface Layout {
  prefix: string;
  clock: { text: string; role: Role };
  faded: Role;
  selected: boolean;
  parentModel: string | null;
  /** The state word and the clock are bold: the state began in the last three seconds. */
  emphasis: boolean;
  g: GlyphSet;
  say: Say;
}

function layoutRow(row: PlannedRow, ctx: RenderContext, l: Layout): string {
  const pn = row.pn!;
  const proj = pn.proj;
  const m = proj.marker;
  const { g, say } = l;
  const width = ctx.width;
  const tier = tierOf(width);
  // A palette with a band puts the row on it and its text in the band's ink; one without (`none`, `terminal`)
  // marks the selection with `›` and the bold name alone, and everything else is drawn as on any other row.
  const banded = l.selected && hasSelectionBand();
  const ink = banded ? SELECTED_INK : PLAIN_INK;
  const emph = (text: string): string => (l.emphasis ? colors.bold(text) : text);
  // A selected row is the palette's band across its whole width, however its spans reset in between (§5.2).
  const finish = (text: string): string => (banded ? theme.selectedBand(exact(text, width)) : exact(text, width));
  const select = l.selected ? ink.accent(g.select) : ' ';
  // A cross-harness tree gives every row an icon slot. A native child has no harness mark of its own, so its slot
  // is blank until the data layer carries the native's kind (§3.4 icon slot, §7 #33; rulings B10b s1, Q3).
  const slot = ctx.proj.crossHarness ? (proj.harness && !proj.isNative ? g.harness[proj.harness] : ' ') : '';
  // The harness mark is muted, and "strong" on the selected row: the text colour in bold on a band (§5.2).
  const slotPainted = (text: string): string =>
    banded ? colors.bold(ink.paint('text', text)) : ink.muted(l.selected ? colors.bold(text) : text);
  const markerText = g.marker[m.glyph];
  const markerPainted = l.selected ? colors.bold(ink.paint(l.faded, markerText)) : ink.paint(l.faded, markerText);
  const lead =
    select + ink.muted(l.prefix) + markerPainted + ' ' + (slot ? (slot.trim() ? slotPainted(slot) : slot) + ' ' : '');
  const leadWidth = 1 + visualLength(l.prefix) + 2 + (slot ? 2 : 0);

  // The right cluster: what the row's class keeps at this width (§3.4, §4.2).
  const cls = rightClassOf(proj);
  let badgeCols = 0;
  let showMeter = false;
  if (cls !== 'clock' && tier !== 'tight') {
    showMeter = cls === 'full';
    badgeCols = tier === 'wide' ? BADGE_COLS : tier === 'medium' ? 6 : 0;
  }
  let badge =
    badgeCols > 0 && proj.model && !(cls === 'native' && proj.model === l.parentModel)
      ? fitModelEffortToken(proj.model, proj.effort ?? undefined, badgeCols, undefined, ink.badge())
      : '';
  // A native child shows a badge only when its model differs from its parent's; otherwise it has no column.
  if (cls === 'native' && !badge) badgeCols = 0;
  const rightWidth = () => (badgeCols > 0 ? badgeCols + 1 : 0) + (showMeter ? METER_COLS + 1 : 0) + CLOCK_COLS;
  // 32-39: a name field under 8 columns costs the meter, then the badge, before the name.
  if (showMeter && width - leadWidth - 1 - rightWidth() < NAME_MIN) showMeter = false;
  if (badgeCols > 0 && width - leadWidth - 1 - rightWidth() < NAME_MIN) {
    badgeCols = 0;
    badge = '';
  }
  const clockCell = padStart(l.clock.text, CLOCK_COLS);
  const right = [
    badgeCols > 0 ? ' '.repeat(Math.max(0, badgeCols - visualLength(badge))) + badge : '',
    showMeter
      ? proj.contextPercent !== null
        ? meter(proj.contextPercent, METER_COLS, g, ink)
        : ' '.repeat(METER_COLS)
      : '',
    l.clock.text ? emph(ink.paint(l.clock.role, clockCell)) : clockCell,
  ]
    .filter((part) => part !== '')
    .join(' ');
  const rw = rightWidth();
  const fieldRoom = width - leadWidth - 1 - rw;
  if (fieldRoom < 1) return finish(clip(lead + right, width, g));

  // The name field: name, `⊟`, state words, summary, fold; shed in the order of §4.2.
  const rawName = proj.name ?? say(W.main);
  const nameWidth = visualLength(rawName);
  // `⊟` says how a live run is hosted; a finished row (history) has no such fact to show (§4.10 samples).
  const headless = proj.headless && !isHistoryStyle(proj) ? ` ${g.headless}` : '';
  const headlessWidth = visualLength(headless);
  const fold = row.fold ? foldTexts(row.fold, g) : null;
  let words = m.words.map((w) => say(w)).join(` ${g.sep} `);
  let summary = '';
  if (isHistoryStyle(proj) && proj.summary) {
    // The summary stands in for `reported` and `failed`; `close pane` and `ended …` stay and it follows them.
    const keepWord = m.closePane || m.glyph === 'stop';
    const before =
      nameWidth +
      headlessWidth +
      (keepWord && words ? 3 + visualLength(words) : 0) +
      (fold ? 1 + visualLength(fold.long) : 0) +
      3;
    const left = fieldRoom - before;
    if (left >= SUMMARY_MIN) {
      summary = clip(proj.summary, left, g);
      if (!keepWord) words = '';
    } else if (!keepWord && m.glyph === 'done') {
      // `reported` says nothing a `✓` does not (§3.4): no room for the summary, no word.
      words = '';
    }
  }

  const muted = nameMuted(proj, ctx.nowMs);
  const nameStyle = (text: string): string => {
    if (l.selected) return colors.bold(muted ? ink.muted(text) : ink.paint('text', text));
    if (proj.isRoot) return colors.bold(theme.strong(text));
    return muted ? ink.muted(text) : theme.value(text);
  };
  const wordRole: Role = m.closePane ? 'text' : l.faded === 'muted' ? 'muted' : m.role;
  const widthOf = (hl: boolean, foldText: string, wordText: string): number =>
    (hl ? headlessWidth : 0) +
    (wordText ? 3 + visualLength(wordText) : 0) +
    (summary ? 3 + visualLength(summary) : 0) +
    (foldText ? 1 + visualLength(foldText) : 0);
  const floor = Math.min(NAME_MIN, nameWidth);
  const narrow = tier === 'narrow' || tier === 'tight';

  // Shed in order: the `⊟`, the fold's long form; then the name is cut down to 8 columns before anything else goes.
  const shed = (wordText: string): Array<[boolean, string, string]> => [
    [headless !== '', fold ? fold.long : '', wordText],
    [false, fold ? fold.long : '', wordText],
    [false, fold ? fold.short : '', wordText],
  ];
  const fits = (nameNeeds: number) => (step: [boolean, string, string]) =>
    fieldRoom - widthOf(step[0], step[1], step[2]) >= nameNeeds;
  let chosen: [boolean, string, string] | null;
  if (narrow && words) {
    // 32-39: the state word goes before the name is cut at all (§3.4 rule 3, read literally); once it is gone
    // the `⊟` comes back if it fits, since that is dropping in order until the row fits (rulings Q7).
    chosen = shed(words).find(fits(nameWidth)) ?? shed('').find(fits(floor)) ?? [false, fold ? fold.short : '', ''];
  } else {
    // From 40 columns the word stays and the name is cut to its 8-column floor (§4.2). A two-word state
    // (`ended · runtime limit`) gives up its second word before the first is clipped: drop a field, then cut
    // text (§0.1 #3; rulings Q7).
    const lead1 = m.words.length > 1 && words ? say(m.words[0]) : words;
    chosen = shed(words).find(fits(floor)) ?? (lead1 !== words ? shed(lead1).find(fits(floor)) : null) ?? null;
    if (!chosen) {
      // Still no room: from 40 columns the word is cut to what is left.
      const f = fold ? fold.short : '';
      const wordRoom =
        fieldRoom - floor - (f ? 1 + visualLength(f) : 0) - (summary ? 3 + visualLength(summary) : 0) - 3;
      chosen = [
        false,
        f,
        tier !== 'narrow' && tier !== 'tight' && lead1 && wordRoom >= 3 ? clip(lead1, wordRoom, g) : '',
      ];
    }
  }
  const [hl, foldText, wordText] = chosen;
  const nameRoom = Math.max(1, fieldRoom - widthOf(hl, foldText, wordText));
  let field = nameStyle(nameWidth > nameRoom ? clip(rawName, nameRoom, g) : rawName);
  if (hl) field += ink.muted(headless);
  if (wordText) field += ` ${ink.muted(g.sep)} ${emph(ink.paint(wordRole, wordText))}`;
  if (summary) field += ` ${ink.muted(g.sep)} ${ink.muted(summary)}`;
  if (foldText) field += ` ${ink.muted(foldText)}`;
  return finish(lead + exact(clip(field, fieldRoom, g), fieldRoom) + ' ' + right);
}

/** `text` as exactly `width` columns: short is padded, long is cut (a wide character that does not fit leaves a space). */
function exact(text: string, width: number): string {
  const w = visualLength(text);
  if (w === width) return text;
  if (w < width) return text + ' '.repeat(width - w);
  const cut = truncateAnsi(text, width, '');
  return cut + ' '.repeat(Math.max(0, width - visualLength(cut)));
}

function renderPutAway(row: PlannedRow, ctx: RenderContext): string {
  const g = glyphSet(ctx.ascii);
  const say = ctx.say ?? panelSay;
  const put = row.put!;
  const prefix = prefixText(row, g);
  const lead = ' ' + colors.dim(prefix) + theme.dim(g.marker.done) + ' ';
  const leadWidth = 1 + visualLength(prefix) + 2;
  const tail = `${g.putAway}${put.count}`;
  const tailWidth = visualLength(tail);
  const room = Math.max(0, ctx.width - leadWidth - 1 - tailWidth);
  const head = `${put.count} ${say('done')} ${g.sep} `;
  let text = head;
  let shown = 0;
  for (const name of put.names) {
    const next = shown === 0 ? name : ` ${name}`;
    const more = shown + 1 < put.names.length || put.count > put.names.length;
    if (visualLength(text + next) + (more ? 2 : 0) > room) break;
    text += next;
    shown++;
  }
  if (shown < put.names.length || put.count > put.names.length) text += ` ${g.ellipsis}`;
  const body = exact(clip(text, room, g), room);
  const line = lead + theme.dim(body) + ' ' + theme.dim(tail);
  return exact(line, ctx.width);
}

/** Every row of a plan as strings: for the statusline-sized lists and the tests; panels render only what is in view. */
export function renderRows(
  proj: DelegationProjection,
  options: RowOptions,
  ctx: Omit<RenderContext, 'proj' | 'nowMs' | 'coarse'>
): string[] {
  const plan = planRows(proj, options);
  const full: RenderContext = { ...ctx, proj, nowMs: options.nowMs, coarse: plan.coarse };
  return plan.rows.map((row) => renderRow(row, full));
}

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
import type { DelegationProjection, GlyphCounts, NodeProjection, PNode, ReviewCount } from './projection.js';
import { hasSelectionBand, paint, paintOnSelectedBand, panelSay, W, type Role, type Say } from './style.js';

/** A finished row stays on the list this long after the last finish in its subtree (§3.2). */
export const PUT_AWAY_MS = 180_000;
/** Deeper rows are drawn at this depth with a flat `↳` (§3.4). */
export const MAX_DEPTH = 4;
// The clock is always the last 7 columns (§3.4 rule 1: a row must not reflow when `59s` becomes `1m00s`), with a
// gap before it. A state word that does not fit beside the name at 32-39 columns yields instead, `close pane`
// included (rulings B10b s1, Q6; the 3-column clock of the §4.13 32-column sample broke the rule).
export const CLOCK_COLS = 7;
const METER_COLS = 4;
const BADGE_COLS = 13;
export const NAME_MIN = 8;
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
  /**
   * The key of the node whose children these rows are (a `⊕N` row's too); null for a root. A `⊕N` row is
   * identified by it, wherever the row sits (rulings B10B-s3 Q2).
   */
  parentKey: string | null;
}

export interface RowPlan {
  rows: PlannedRow[];
  /** Rows folded into `⊕N` across the tree. */
  putAway: number;
  /** More active rows than `COARSE_CLOCK_ROWS`. */
  coarse: boolean;
  /** A row's place in `rows`, by key. */
  index: Map<string, number>;
  /** A child put away → the key of the `⊕N` row that holds it. */
  away: Map<string, string>;
  /** A parent → the place of its `⊕N` row in `rows`. */
  putRows: Map<string, number>;
}

/** A `⊕N` row's key: its place in the plan, then the node whose children it holds (`put:7:codex:impl-a`). */
export function putKey(index: number, parentKey: string): string {
  return `put:${index}:${parentKey}`;
}
const PUT_KEY = /^put:(\d+):([\s\S]*)$/;
/** The place and the parent a `⊕N` row's key names; null for any other key. */
export function parsePutKey(key: string): { index: number; parentKey: string } | null {
  const m = PUT_KEY.exec(key);
  return m ? { index: Number(m[1]), parentKey: m[2] } : null;
}

function creationOf(pn: PNode): number {
  return Number.isFinite(pn.proj.createdAt) ? pn.proj.createdAt! : Number.POSITIVE_INFINITY;
}

/** §3.2: by subtree bucket, trouble newest first, the rest in creation order. */
export function compareSiblings(byCreation: boolean) {
  return (a: PNode, b: PNode): number => {
    if (!byCreation) {
      if (a.sub.rank !== b.sub.rank) return a.sub.rank - b.sub.rank;
      if (a.sub.rank === 0) {
        const ta = Number.isFinite(a.sub.sortAt) ? a.sub.sortAt! : Number.NEGATIVE_INFINITY;
        const tb = Number.isFinite(b.sub.sortAt) ? b.sub.sortAt! : Number.NEGATIVE_INFINITY;
        if (ta !== tb) return ta > tb ? -1 : 1;
      }
    }
    const ca = creationOf(a);
    const cb = creationOf(b);
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.index - b.index || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  };
}

interface PutItem {
  put: { count: number; names: string[] };
  /** The children folded into it, by key. */
  members: string[];
}
interface Frame {
  items: Array<PNode | PutItem>;
  i: number;
  ancestors: boolean[];
  /** The node these items are the children of. */
  parentKey: string | null;
}

/**
 * A plan is kept while its options are the same and the clock stays inside the window where no subtree crosses its
 * put-away time: the only thing the clock decides in a plan (§3.2). So a panel replans when the tree, the options or
 * a fold boundary change, not every second.
 */
const planMemo = new WeakMap<DelegationProjection, Map<string, { from: number; until: number; plan: RowPlan }>>();
/**
 * A projection keeps this many plans, one per option set: the one drawn and the one the `older` button counts (history
 * hidden while it is shown) do not evict each other (rulings B10B-s3, default 5).
 */
const PLAN_MEMO_ENTRIES = 4;

/** The rows in order, with each row's tree drawing and fold; no strings are built. */
export function planRows(proj: DelegationProjection, options: RowOptions): RowPlan {
  const memoKey = `${options.showHistory ? 1 : 0}|${options.sortByCreation ? 1 : 0}|${
    options.collapsed && options.collapsed.size > 0 ? [...options.collapsed].sort().join('\u0001') : ''
  }`;
  const memo = planMemo.get(proj);
  const hit = memo?.get(memoKey);
  if (hit && options.nowMs >= hit.from && options.nowMs < hit.until) return hit.plan;
  // The window: the latest put-away time already passed, and the next one to come.
  let from = Number.NEGATIVE_INFINITY;
  let until = Number.POSITIVE_INFINITY;

  const compare = compareSiblings(options.sortByCreation === true);
  const rows: PlannedRow[] = [];
  const away = new Map<string, string>();
  const putRows = new Map<string, number>();
  let putAway = 0;
  const active = proj.counts.working + proj.counts.starting;

  const stack: Frame[] = [{ items: proj.roots.slice(), i: 0, ancestors: [], parentKey: null }];
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
      const key = putKey(rows.length, frame.parentKey!);
      for (const member of item.members) away.set(member, key);
      putRows.set(frame.parentKey!, rows.length);
      rows.push({
        kind: 'putAway',
        key,
        pn: null,
        depth: Math.min(depthOf, MAX_DEPTH),
        ancestors: frame.ancestors.slice(0, MAX_DEPTH - 1),
        tee: 'end',
        unconfirmed: false,
        flat: false,
        fold: null,
        put: item.put,
        parentKey: frame.parentKey,
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
      parentKey: frame.parentKey,
    });
    if (collapsed || pn.children.length === 0) continue;

    // Children in bucket order; finished subtrees past their linger window fold into one row (§3.2).
    const kept: PNode[] = [];
    const gone: PNode[] = [];
    for (const child of pn.children) {
      const finish = child.sub.youngestFinish;
      const boundary = !options.showHistory && child.sub.allFinished && finish !== null ? finish + PUT_AWAY_MS : null;
      if (boundary !== null && options.nowMs >= boundary) {
        gone.push(child);
        from = Math.max(from, boundary);
      } else {
        kept.push(child);
        if (boundary !== null) until = Math.min(until, boundary);
      }
    }
    kept.sort(compare);
    const items: Frame['items'] = kept;
    if (gone.length > 0) {
      gone.sort(compare);
      const count = gone.reduce((sum, child) => sum + 1 + child.sub.total, 0);
      putAway += count;
      items.push({
        put: { count, names: gone.slice(0, PUT_AWAY_NAMES).map((child) => child.proj.name ?? child.key) },
        members: gone.map((child) => child.key),
      });
    }
    // This node's own column continues below it while it has later siblings; the root draws none.
    const own = isViewRoot ? [] : [later];
    stack.push({ items, i: 0, ancestors: frame.ancestors.concat(own), parentKey: pn.key });
  }

  const index = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) index.set(rows[i].key, i);
  const plan: RowPlan = { rows, putAway, coarse: active > COARSE_CLOCK_ROWS, index, away, putRows };
  let entries = memo;
  if (!entries) planMemo.set(proj, (entries = new Map()));
  if (entries.size >= PLAN_MEMO_ENTRIES && !entries.has(memoKey)) entries.delete(entries.keys().next().value!);
  entries.set(memoKey, { from, until, plan });
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
  /**
   * The model a native row's badge is compared with: a card's sub-rows compare with the card's own model
   * (rulings B10B-s2 Q10). Absent: the row's parent's.
   */
  cardModel?: string | null;
  /**
   * The width the row's tier (badge form, `◈N`) is judged by, when the row is drawn narrower than the panel: a folded
   * card and a card's sub-row are compact rows of the panel (§3.5, §4.2). Absent: `width`.
   */
  tierWidth?: number;
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

export function clockOf(
  proj: NodeProjection,
  nowMs: number,
  g: GlyphSet,
  coarse: boolean
): { text: string; role: Role } {
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
export function foldTexts(fold: FoldInfo, g: GlyphSet): { long: string; short: string } {
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

export type Tier = 'wide' | 'medium' | 'narrow' | 'tight';
export function tierOf(width: number): Tier {
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

export function clip(text: string, width: number, g: GlyphSet): string {
  if (width <= 0) return '';
  return visualLength(text) <= width ? text : truncateAnsi(text, width, g.ellipsis);
}

export function padStart(text: string, width: number): string {
  const w = visualLength(text);
  return w >= width ? text : ' '.repeat(width - w) + text;
}

type RightClass = 'full' | 'native' | 'clock';

/**
 * Finished rows (`✓ ! ■`, and the reported-but-alive `close pane` ones) say
 * what they delivered in place of the badge and the meter (§3.4); the root is
 * never history.
 */
export function isHistoryStyle(proj: NodeProjection): boolean {
  return !proj.isRoot && (proj.marker.rank === 3 || proj.marker.closePane);
}

function rightClassOf(proj: NodeProjection): RightClass {
  if (proj.marker.trouble || isHistoryStyle(proj)) return 'clock';
  return proj.isNative ? 'native' : 'full';
}

const rowCache = new WeakMap<NodeProjection, Map<string, string>>();
const ROW_CACHE_LIMIT = 8;

export function prefixText(row: PlannedRow, g: GlyphSet): string {
  let out = '';
  for (const cont of row.ancestors) out += cont ? `${g.edge.line} ` : '  ';
  // The viewpoint root is drawn one column in, as in the design's samples (`|› ▸ ✳ main`), clear of the selection mark.
  if (row.tee === 'none') return `${out} `;
  if (row.flat) return `${out}${g.edge.flat} `;
  if (row.unconfirmed) return `${out}${g.edge.unconfirmed} `;
  return `${out}${row.tee === 'end' ? g.edge.end : g.edge.tee} `;
}

/** The icon slot's text: '' when the tree has no slot, a blank when this row has nothing to put in it. */
export function slotText(proj: NodeProjection, tree: DelegationProjection, g: GlyphSet): string {
  // A kind icon makes the column only where the glyph set in use can draw one: ASCII has no kind column, so a
  // single-harness tree there has no slot at all (rulings B10B-s2 Q7).
  if (!tree.crossHarness && !(tree.kindIcons && g.kind.review !== '')) return '';
  if (proj.isNative) return (proj.kind && g.kind[proj.kind]) || ' ';
  return tree.crossHarness && proj.harness ? g.harness[proj.harness] : ' ';
}

/** The review chip shows from this width (§4.2's 56 row). */
export const CHIP_MIN_WIDTH = 56;

const reviewsKey = (r: ReviewCount | undefined): string => (r ? `\u0001r${r.total}/${r.failed}/${r.active}` : '');

/** Red when a review failed, the info colour while one is at work, else muted (today's `reviewChip`). */
function reviewChipPaint(r: ReviewCount, text: string, ink: Ink): string {
  return r.failed > 0 ? ink.paint('danger', text) : r.active > 0 ? ink.paint('info', text) : ink.muted(text);
}

/** A new semantic episode keeps its state word and clock bold for this long (§3.2, §5.2). */
export const EMPHASIS_MS = 3000;

/**
 * Whether the row's state began in the last three seconds, by the published episode boundary (`stateSince`, §7 #23):
 * the second round of approval under the same `⚑` is a new episode too. Every node qualifies, the viewpoint root
 * included, and an `observed` boundary as much as an `event` one: it is persisted with the commit, not a timer
 * this process started. A boundary the published data does not stand behind (basis `unknown`, an anomalous clock)
 * is no episode, and neither is one that has not happened yet. The marker's own clock (`sinceMs`) is not the
 * boundary: it falls back to ledger times when the continuity is unknown, and a fallback is no episode.
 */
export function newEpisode(proj: NodeProjection, nowMs: number): boolean {
  const m = proj.marker;
  return (
    m.episodeBasis !== 'unknown' && m.episodeMs !== null && nowMs >= m.episodeMs && nowMs - m.episodeMs < EMPHASIS_MS
  );
}

/**
 * How a row paints. A selected row on a palette with a band sits on it and paints every span through the palette's
 * `onSelectedBand` family (calibrated for that surface: nothing on the band is a plain `theme.*` colour). A selected
 * row on a palette without one (`none`, `terminal`), and every other row, uses the plain role colours (§5.2 "选中行").
 */
export interface Ink {
  /** What recedes: the tree, separators, `⊟`, the summary, the fold, the meter's track. */
  muted(text: string): string;
  /** The selection mark. */
  accent(text: string): string;
  paint(role: Role, text: string): string;
  /** The model badge's paints; undefined is the palette's plain roles. */
  badge(): ModelTokenPaints | undefined;
}
export const PLAIN_INK: Ink = {
  muted: (text) => colors.dim(text),
  accent: (text) => theme.accent(text),
  paint,
  badge: () => undefined,
};
export const SELECTED_INK: Ink = {
  muted: (text) => palette().onSelectedBand.muted(text),
  accent: (text) => palette().onSelectedBand.accent(text),
  paint: paintOnSelectedBand,
  badge: () => {
    const ink = palette().onSelectedBand;
    return { model: ink.model, muted: ink.muted, warning: ink.warning };
  },
};

/** Marker paint with the §5.2 fade: success and warning settle to muted after `fadesAfterMs`. */
export function fadedRole(proj: NodeProjection, nowMs: number): Role {
  const m = proj.marker;
  if (m.fadesAfterMs !== null && m.sinceMs !== null && nowMs - m.sinceMs >= m.fadesAfterMs) return 'muted';
  return m.role;
}

export function nameMuted(proj: NodeProjection, nowMs: number): boolean {
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
  const parentModel = proj.isNative
    ? ctx.cardModel !== undefined
      ? ctx.cardModel
      : (pn.parent?.proj.model ?? null)
    : null;
  const emphasis = newEpisode(proj, ctx.nowMs);
  const key = rowKey(row, ctx, say, selected, prefix, clock.text, faded, parentModel, emphasis);
  const reviewKey = reviewsKey(ctx.proj.reviews.get(pn.key));
  let cache = rowCache.get(proj);
  const cached = cache?.get(key + reviewKey);
  if (cached !== undefined) return cached;

  const reviews = ctx.proj.reviews.get(pn.key);
  const chip = reviews ? `${g.review}${reviews.total}` : '';
  const text = layoutRow(row, ctx, { prefix, clock, faded, selected, parentModel, emphasis, g, say, chip });
  if (!cache) {
    cache = new Map();
    rowCache.set(proj, cache);
  }
  if (cache.size >= ROW_CACHE_LIMIT) cache.clear();
  cache.set(key + reviewKey, text);
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
export const foldKey = (fold: FoldInfo): string =>
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
  return `${ctx.width}/${ctx.tierWidth ?? ''}${useAscii(ctx.ascii) ? 'a' : 'u'}${selected ? 's' : 'n'}${emphasis ? 'e' : 'q'}${
    ctx.proj.crossHarness ? 'x' : 'y'
  }${ctx.proj.kindIcons ? 'k' : 'j'}${nameMuted(row.pn!.proj, ctx.nowMs) ? 'm' : 'v'}\u0001${prefix}\u0001${clockText}\u0001${faded}\u0001${
    row.fold ? foldKey(row.fold) : ''
  }\u0001${parentModel ?? ''}\u0001${sayId(say)}\u0001${language()}\u0001${palette().name}\u0001${displayConfig().glyphs}`;
}

interface Layout {
  /** The plain text of the review chip (`◈2`), '' when the node has no review natives. */
  chip: string;
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
  const tier = tierOf(ctx.tierWidth ?? width);
  // A palette with a band puts the row on it and its text in the band's ink; one without (`none`, `terminal`)
  // marks the selection with `›` and the bold name alone, and everything else is drawn as on any other row.
  const banded = l.selected && hasSelectionBand();
  const ink = banded ? SELECTED_INK : PLAIN_INK;
  const emph = (text: string): string => (l.emphasis ? colors.bold(text) : text);
  // A selected row is the palette's band across its whole width, however its spans reset in between (§5.2).
  const finish = (text: string): string => (banded ? theme.selectedBand(exact(text, width)) : exact(text, width));
  const select = l.selected ? ink.accent(g.select) : ' ';
  // The icon slot exists in a cross-harness tree, or when some row has a kind icon (§3.4). A session or a job shows
  // its harness mark (cross-harness trees only); a native child shows its kind icon, and an absent or `other` kind
  // leaves the slot blank (§7 #33).
  const slot = slotText(proj, ctx.proj, g);
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
  // `◈N`, the review natives under the node: from 56 columns, before the badge, and the first thing to go when the
  // name field would fall under 8 cells (§4.2; rulings B10B-s2 Q8).
  let chip = cls !== 'clock' && (ctx.tierWidth ?? width) >= CHIP_MIN_WIDTH ? l.chip : '';
  const chipCols = () => (chip ? visualLength(chip) + 1 : 0);
  const rightWidth = () =>
    chipCols() + (badgeCols > 0 ? badgeCols + 1 : 0) + (showMeter ? METER_COLS + 1 : 0) + CLOCK_COLS;
  if (chip && width - leadWidth - 1 - rightWidth() < NAME_MIN) chip = '';
  // 32-39: a name field under 8 columns costs the meter, then the badge, before the name.
  if (showMeter && width - leadWidth - 1 - rightWidth() < NAME_MIN) showMeter = false;
  if (badgeCols > 0 && width - leadWidth - 1 - rightWidth() < NAME_MIN) {
    badgeCols = 0;
    badge = '';
  }
  const clockCell = padStart(l.clock.text, CLOCK_COLS);
  const right = [
    chip ? reviewChipPaint(ctx.proj.reviews.get(pn.key)!, chip, ink) : '',
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
  if (narrow && !words && headless !== '') {
    // 32-39, a row with a `⊟` and no state word: the `⊟` goes before the name is cut (§3.4 rule 3, §4.13's 32-column
    // sample: `review-tests` whole, no `⊟`). A row that needs no cut keeps it; once a cut is needed it is already
    // gone, and the name goes down to its floor (B10B-s2 review F7).
    chosen = shed('').find(fits(nameWidth)) ??
      shed('').slice(1).find(fits(floor)) ?? [false, fold ? fold.short : '', ''];
  } else if (narrow && words) {
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
export function exact(text: string, width: number): string {
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
  // The `⊕N` row is selectable like a node row: on a palette with a band it sits on the band and every span takes
  // the band's ink; without one (`none`, `terminal`) it is the `›` and the bold text (§5.2; rulings B10B-s2 Q5).
  const selected = ctx.selectedKey === row.key;
  const banded = selected && hasSelectionBand();
  const ink = banded ? SELECTED_INK : PLAIN_INK;
  const select = selected ? ink.accent(g.select) : ' ';
  const mark = selected ? colors.bold(ink.muted(g.marker.done)) : ink.muted(g.marker.done);
  const lead = select + ink.muted(prefix) + mark + ' ';
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
  const line = lead + (selected ? colors.bold(ink.muted(body)) : ink.muted(body)) + ' ' + ink.muted(tail);
  return banded ? theme.selectedBand(exact(line, ctx.width)) : exact(line, ctx.width);
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

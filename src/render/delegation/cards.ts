/**
 * Rich delegation cards and the accordion (design §3.5; rulings B10B-s2 Q2,
 * Q3, Q10).
 *
 * A card is drawn for the viewpoint root, every delegated worker, intent, job
 * and conflict claim, and every native child of the viewpoint root; any other
 * native is a sub-row of the nearest card above it (at most five, then one
 * `+N (…)` line). Cards indent two columns per depth. When the cards do not fit
 * the pane (or a card has more than five card siblings), cards fold into their
 * compact row with `─` in the frame column: finished `✓ ■` first, then the
 * unselected `▸ ·`, the root last; `⚑ ? ⚠ !` and the selected card never fold.
 *
 * A card's lines are cached under everything they read (500 cards, §6 #2c).
 */

import { colors, theme, visualLength } from '../colors.js';
import { fitModelEffortToken } from '../model-glyphs.js';
import { meterRow } from '../monitor-meter.js';
import type { MonitorRow } from '../monitor.js';
import { palette } from '../palette.js';
import { displayConfig } from '../hud-config.js';
import { language } from '../i18n.js';
import type { GlyphSet } from './glyphs.js';
import {
  ageOf,
  delegationElements,
  delegationLine,
  focusLine,
  focusText,
  hasDelegationLine,
  rootOf,
  type FocusLine,
} from './lines.js';
import type { DelegationProjection, PNode } from './projection.js';
import {
  clip,
  clockOf,
  exact,
  fadedRole,
  foldKey,
  foldTexts,
  NAME_MIN,
  nameMuted,
  newEpisode,
  PLAIN_INK,
  renderRow,
  SELECTED_INK,
  slotText,
  tierOf,
  type FoldInfo,
  type Ink,
  type PlannedRow,
  type RenderContext,
  type RowPlan,
} from './rows.js';
import { hasSelectionBand, type Role, type Say } from './style.js';
import { flowLines } from '../monitor-text.js';

/** Sub-rows a card shows before the rest fold into one line (rulings B10B-s2 Q10). */
export const MAX_SUB_ROWS = 5;
/** More card siblings than this and their finished cards fold (§3.5). */
export const SIBLING_FOLD = 5;
/** The stop-in-pane sentence wraps to at most this many lines (§3.5: three at 48, two at 80). */
const SENTENCE_LINES = 3;

/** Whether a node is drawn as a card of its own rather than a sub-row. */
export function isCardHolder(pn: PNode): boolean {
  if (!pn.proj.isNative) return true;
  return pn.parent !== null && pn.parent.proj.isRoot;
}

const overflowMemo = new WeakMap<RowPlan, ReadonlySet<string>>();
/**
 * The sub-rows a card does not draw (past the fifth, folded into its `+N (…)` line): they are not destinations of the
 * selection (rulings B10B-s3 Q2). Empty in compact, where every row is drawn.
 */
export function overflowKeys(plan: RowPlan): ReadonlySet<string> {
  let kept = overflowMemo.get(plan);
  if (!kept) {
    const keys = new Set<string>();
    for (const block of blocksOf(plan))
      if (block.kind === 'card') for (const row of block.subs.slice(MAX_SUB_ROWS)) keys.add(row.key);
    overflowMemo.set(plan, (kept = keys));
  }
  return kept;
}

interface CardBlock {
  kind: 'card';
  row: PlannedRow;
  pn: PNode;
  indent: number;
  subs: PlannedRow[];
}
interface RowBlock {
  kind: 'row';
  row: PlannedRow;
}
type Block = CardBlock | RowBlock;

/** A plan row drawn on its own (a put-away or `↳` row) loses its tree columns: cards carry no edges. */
function bare(row: PlannedRow): PlannedRow {
  return { ...row, ancestors: row.ancestors.map(() => false) };
}

function blocksOf(plan: RowPlan): Block[] {
  const blocks: Block[] = [];
  const cards = new Map<string, CardBlock>();
  for (const row of plan.rows) {
    const pn = row.pn;
    if (!pn || row.kind !== 'node') {
      blocks.push({ kind: 'row', row });
      continue;
    }
    if (isCardHolder(pn) && !row.flat) {
      const block: CardBlock = { kind: 'card', row, pn, indent: pn.parent === null ? 0 : 2 * row.depth, subs: [] };
      cards.set(pn.key, block);
      blocks.push(block);
      continue;
    }
    if (!isCardHolder(pn)) {
      let at = pn.parent;
      while (at && !cards.has(at.key)) at = at.parent;
      const card = at ? cards.get(at.key) : undefined;
      if (card) {
        card.subs.push(row);
        continue;
      }
    }
    blocks.push({ kind: 'row', row });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// One card

/** The card frame's paint: the marker's colour, the alert's in regular weight, muted once faded. */
function frameRole(role: Role): Role {
  return role === 'alert' ? 'danger' : role === 'text' || role === 'strong' ? 'muted' : role;
}

function sentenceLines(focus: FocusLine, inner: number, panelWidth: number, ink: Ink, g: GlyphSet): string[] {
  const sentence = focus.sentence!;
  const max = panelWidth >= 80 ? 2 : SENTENCE_LINES;
  const head = `${ink.paint('alert', focus.glyph!.text)} `;
  const lines = flowLines(sentence.long, Math.max(1, inner - 2));
  if (lines.length > max) return [focusText(focus, inner, panelWidth, g, ink)];
  return lines.map((line, i) => (i === 0 ? head : '  ') + ink.paint('text', line));
}

const cardIds = new WeakMap<object, number>();
let nextCardId = 1;
function idOf(object: object): number {
  let id = cardIds.get(object);
  if (id === undefined) {
    id = nextCardId++;
    cardIds.set(object, id);
  }
  return id;
}

export const CARD_CACHE_LIMIT = 500;
/** Card cache statistics (tests and the bench). */
export const cardCacheStats = { hits: 0, misses: 0 };

/** The sub-rows' lines: at most five, then `+N (…)`, or `children unknown` when only that is left to say. */
function subRowLines(block: CardBlock, ctx: RenderContext, width: number, g: GlyphSet, say: Say): string[] {
  const shown = block.subs.slice(0, MAX_SUB_ROWS);
  const rest = block.subs.slice(MAX_SUB_ROWS);
  const subCtx: RenderContext = { ...ctx, width, tierWidth: ctx.width, cardModel: block.pn.proj.model };
  const lines = shown.map((row) =>
    renderRow({ ...row, ancestors: [], tee: 'none', unconfirmed: false, flat: false }, subCtx)
  );
  if (rest.length > 0) {
    const fold: FoldInfo = {
      hidden: rest.length,
      below: { warn: 0, flag: 0, fail: 0, stop: 0, unknown: 0, working: 0, starting: 0, done: 0 },
      unknown: block.pn.childrenUnknown,
    };
    for (const row of rest) {
      fold.below[row.pn!.proj.marker.glyph]++;
      if (row.fold) {
        fold.hidden += row.fold.hidden;
        for (const k of Object.keys(row.fold.below) as Array<keyof FoldInfo['below']>)
          fold.below[k] += row.fold.below[k];
      }
    }
    lines.push(exact('  ' + colors.dim(foldTexts(fold, g).long), width));
  } else if (block.pn.childrenUnknown) lines.push(exact('  ' + colors.dim(say('children unknown')), width));
  return lines;
}

/** Bounded insertion-ordered cache: the oldest entry goes first. */
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= CARD_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** A cache read that keeps the entry: a hit moves to the young end, so what is drawn every tick is never evicted. */
function recall<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

const bodyCache = new Map<string, string[]>();
const footCache = new Map<string, string>();

/** The last drawing of each card, on its projection: a tick that changed nothing returns it without a lookup. */
interface CardMemo {
  /** Every input of the drawing, compared field by field before any key string is built. */
  inputs: unknown[];
  lines: string[];
}

/** Whether two input lists are the same, element by element (`===`; the sub-row texts are compared one by one). */
function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}
const cardMemo = new WeakMap<object, CardMemo>();

/** The display inputs every card shares (language, palette, glyphs, translator) as one small number. */
const looks = new Map<string, number>();
let nextLookId = 1;
export function lookId(g: GlyphSet, say: Say): number {
  const lang = language();
  const name = palette().name;
  const glyphs = displayConfig().glyphs;
  const l = lastLook;
  if (l && l.lang === lang && l.name === name && l.glyphs === glyphs && l.flag === g.marker.flag && l.say === say)
    return l.id;
  const look = [lang, name, glyphs, g.marker.flag, idOf(say)].join('\u0001');
  let id = looks.get(look);
  if (id === undefined) {
    // A monotonic id: after the table is cleared a new look never takes an id a cached card still carries.
    if (looks.size > 64) looks.clear();
    id = nextLookId++;
    looks.set(look, id);
  }
  lastLook = { lang, name, glyphs, flag: g.marker.flag, say, id };
  return id;
}
let lastLook: { lang: string; name: string; glyphs: string; flag: string; say: Say; id: number } | null = null;

/**
 * A card's lines. The head and the body are cached under everything they read but the clock; the foot under the
 * clock and what it paints with. So the second ticking redraws a live card's foot and nothing else (§6 #11, #16).
 */
function renderCard(block: CardBlock, ctx: RenderContext, g: GlyphSet, say: Say): string[] {
  const pn = block.pn;
  const proj = pn.proj;
  const m = proj.marker;
  const w = Math.max(1, ctx.width - block.indent);
  const inner = Math.max(1, w - 2);
  const nowMs = ctx.nowMs;
  const selected = ctx.selectedKey === pn.key;
  const banded = selected && hasSelectionBand();
  const ink = banded ? SELECTED_INK : PLAIN_INK;
  const faded = fadedRole(proj, nowMs);
  const muted = nameMuted(proj, nowMs);
  const clock = clockOf(proj, nowMs, g, ctx.coarse === true);
  const emphasis = newEpisode(proj, nowMs);
  const subTexts = subRowLines(block, ctx, w, g, say);
  // A collapsed card (`h`) says what it holds on its head (design §3.4; B10B-s2 review F6).
  const fold = block.row.fold;
  const foldAt = fold ? foldKey(fold) : '';
  const root = rootOf(ctx.proj);
  const look = lookId(g, say);
  const ages = [
    ageOf(proj.reportAt, nowMs),
    ageOf(proj.detail.boundAt, nowMs),
    ctx.width >= 80 ? ageOf(proj.detail.heartbeatAt, nowMs) : '',
    m.glyph === 'warn' ? ageOf(m.sinceMs, nowMs) : '',
  ];
  // Everything the drawing reads. A tick that changed none of it returns the last drawing without a lookup.
  const inputs: unknown[] = [
    root,
    ctx.width,
    block.indent,
    selected,
    faded,
    muted,
    look,
    ctx.proj.crossHarness,
    ctx.proj.kindIcons,
    ages[0],
    ages[1],
    ages[2],
    ages[3],
    subTexts,
    clock.text,
    clock.role,
    emphasis,
    foldAt,
  ];
  const last = cardMemo.get(proj);
  if (last && sameInputs(last.inputs, inputs)) {
    cardCacheStats.hits++;
    return last.lines;
  }
  const shape = `${ctx.width}\u0001${block.indent}\u0001${selected ? 1 : 0}\u0001${faded}\u0001${muted ? 1 : 0}`;
  const frame = (text: string) => (muted ? ink.muted(text) : ink.paint(frameRole(faded), text));
  const pad = ' '.repeat(block.indent);

  const bodyKey = [
    idOf(proj),
    root ? idOf(root) : 0,
    shape,
    look,
    ctx.proj.crossHarness ? 1 : 0,
    ctx.proj.kindIcons ? 1 : 0,
    ages.join('\u0001'),
    subTexts.join('\u0002'),
    foldAt,
  ].join('\u0001');
  const footKey = `${shape}\u0001${look}\u0001${clock.text}\u0001${clock.role}\u0001${emphasis ? 1 : 0}\u0001${proj.contextPercent}`;
  let top = recall(bodyCache, bodyKey);
  if (top) cardCacheStats.hits++;
  else {
    cardCacheStats.misses++;
    top = remember(bodyCache, bodyKey, cardTop());
  }
  const foot = recall(footCache, footKey) ?? remember(footCache, footKey, cardFoot());
  const lines = [...top, foot];
  cardMemo.set(proj, { inputs, lines });
  return lines;

  function cardTop(): string[] {
    const lines: string[] = [];
    // The head: corner (`›` when selected), marker, icon slot, name, a rule, the badge.
    const corner = selected ? ink.accent(g.select) : frame('┌');
    const marker = selected ? colors.bold(ink.paint(faded, g.marker[m.glyph])) : ink.paint(faded, g.marker[m.glyph]);
    const slot = slotText(proj, ctx.proj, g);
    const slotPainted = slot && slot.trim() ? (banded ? colors.bold(ink.paint('text', slot)) : ink.muted(slot)) : slot;
    const head = `${corner} ${marker} ${slot ? slotPainted + ' ' : ''}`;
    const headWidth = 4 + (slot ? 2 : 0);
    const tier = tierOf(ctx.width);
    const badgeCols = tier === 'wide' ? 13 : tier === 'medium' ? 6 : 0;
    const name = proj.name ?? say('main');
    let badge =
      badgeCols > 0 && proj.model
        ? fitModelEffortToken(proj.model, proj.effort ?? undefined, badgeCols, undefined, ink.badge())
        : '';
    if (badge && w - headWidth - visualLength(badge) - 3 < Math.min(8, visualLength(name))) badge = '';
    const tail = badge ? ` ${badge}` : '';
    const room = Math.max(1, w - headWidth - visualLength(tail) - 2);
    // The fold after the name, as the compact row writes it: the long form, then the short one, while the name keeps
    // its 8 columns (§4.2); neither fits, none is written.
    const foldText = fold
      ? ([foldTexts(fold, g).long, foldTexts(fold, g).short].find(
          (text) => room - 1 - visualLength(text) >= Math.min(NAME_MIN, visualLength(name))
        ) ?? '')
      : '';
    const foldWidth = foldText ? 1 + visualLength(foldText) : 0;
    const shown = clip(name, Math.max(1, room - foldWidth), g);
    const namePainted = selected
      ? colors.bold(muted ? ink.muted(shown) : ink.paint('text', shown))
      : proj.isRoot
        ? colors.bold(theme.strong(shown))
        : muted
          ? ink.muted(shown)
          : colors.bold(theme.value(shown));
    const dashes = Math.max(0, w - headWidth - visualLength(shown) - foldWidth - 1 - visualLength(tail));
    // Exactly `w` by construction while there is room for a dash; a name that fills the head is cut to fit.
    const built = `${head}${namePainted}${foldText ? ` ${ink.muted(foldText)}` : ''} ${frame('─'.repeat(dashes))}${tail}`;
    const headLine = dashes > 0 ? built : exact(built, w);
    lines.push(pad + (banded ? theme.selectedBand(headLine) : headLine));

    // The body: the delegation line, the focus line, the sub-rows. Nothing the view model does not carry.
    const body: string[] = [];
    if (hasDelegationLine(pn)) {
      const line = delegationLine(pn, ctx.proj, inner, nowMs, g, say, PLAIN_INK, ctx.width);
      if (line) body.push(line);
    }
    const focus = focusLine(pn, nowMs, g, say);
    if (focus) {
      if (focus.sentence) body.push(...sentenceLines(focus, inner, ctx.width, PLAIN_INK, g));
      else body.push(focusText(focus, inner, ctx.width, g, PLAIN_INK));
    }
    for (const text of body) {
      const cut = clip(text, inner, g);
      const room = Math.max(0, inner - visualLength(cut));
      lines.push(`${pad}${frame('│')} ${muted ? colors.dim(cut) : cut}${' '.repeat(room)}`);
    }
    // A sub-row is the node's compact row without its tree (exactly `w` wide): the frame takes the selection
    // column.
    for (const text of subTexts) lines.push(pad + (text.startsWith(' ') ? `${frame('│')}${text.slice(1)}` : text));
    return lines;
  }

  function cardFoot(): string {
    // The foot: the clock, then the context meter where it is known (no rate: rulings B10B-s2 Q2).
    const clockText = clock.text
      ? emphasis
        ? colors.bold(ink.paint(clock.role, clock.text))
        : ink.paint(clock.role, clock.text)
      : '';
    const left = `${frame('└')} ${clockText ? clockText + ' ' : ''}`;
    const meter = proj.contextPercent !== null ? { percent: proj.contextPercent } : undefined;
    const leftWidth = visualLength(left);
    const ruled = left + frame('─'.repeat(Math.max(0, w - leftWidth)));
    // `meterRow` and the rule fill exactly the rest of the line; only a clock wider than the card needs cutting.
    const text = meter ? (meterRow(w, left, '', meter) ?? ruled) : ruled;
    return pad + (leftWidth < w ? text : exact(text, w));
  }
}

/**
 * How many lines a card has, without drawing it: the head, the delegation line, the focus line (the stop-in-pane
 * sentence wraps), the sub-rows and their fold line, the foot. None of these counts depends on the clock, so the
 * accordion can fit the pane while only the cards in view are drawn (§6 #5, #11). Kept on the projection.
 */
export function cardHeight(block: CardBlock, ctx: RenderContext, g: GlyphSet, say: Say): number {
  const pn = block.pn;
  const subs = Math.min(MAX_SUB_ROWS, block.subs.length);
  const fold = block.subs.length > MAX_SUB_ROWS || pn.childrenUnknown ? 1 : 0;
  const look = lookId(g, say);
  const memo = heights.get(pn.proj);
  if (
    memo &&
    memo.width === ctx.width &&
    memo.indent === block.indent &&
    memo.subs === subs &&
    memo.fold === fold &&
    memo.look === look
  )
    return memo.height;
  const w = Math.max(1, ctx.width - block.indent);
  const inner = Math.max(1, w - 2);
  let body = 0;
  if (hasDelegationLine(pn) && delegationElements(pn, ctx.proj, ctx.width, ctx.nowMs, g, say).length > 0) body++;
  const focus = focusLine(pn, ctx.nowMs, g, say);
  if (focus) body += focus.sentence ? sentenceLines(focus, inner, ctx.width, PLAIN_INK, g).length : 1;
  const height = 2 + body + subs + fold;
  heights.set(pn.proj, { width: ctx.width, indent: block.indent, subs, fold, look, height });
  return height;
}
const heights = new WeakMap<
  object,
  { width: number; indent: number; subs: number; fold: number; look: number; height: number }
>();

/** A card folded into its compact row: the frame column says `─` (§3.5). */
function foldedCard(block: CardBlock, ctx: RenderContext): string {
  const w = Math.max(1, ctx.width - block.indent);
  const row: PlannedRow = { ...block.row, ancestors: [], tee: 'none', unconfirmed: false, flat: false };
  const text = renderRow(row, { ...ctx, width: w, tierWidth: ctx.width });
  // `renderRow` is exactly `w` wide and the first column is swapped one for one: the line is exactly the width.
  const body = text.startsWith(' ') ? colors.dim('─') + text.slice(1) : text;
  return ' '.repeat(block.indent) + body;
}

/** The frame a kept view draws for: the context of the latest tick (its clock), shared by the view's rows. */
interface Frame {
  ctx: RenderContext;
}

/** One card drawn on demand for the current frame, shared by its lines. */
class CardDrawing {
  private lines: string[] | null = null;
  constructor(
    readonly block: CardBlock,
    private readonly frame: Frame,
    private readonly g: GlyphSet,
    private readonly say: Say
  ) {}
  line(i: number): string {
    this.lines ??= renderCard(this.block, this.frame.ctx, this.g, this.say);
    return this.lines[i] ?? ' '.repeat(this.frame.ctx.width);
  }
  reset(): void {
    this.lines = null;
  }
}

/** A row of a kept view that is not a card line: a put-away or `↳` row, or a folded card. */
class FrameRow implements MonitorRow {
  private value: string | undefined;
  constructor(
    private readonly draw: (ctx: RenderContext) => string,
    private readonly frame: Frame,
    readonly item: string,
    readonly key: string
  ) {}
  get text(): string {
    return (this.value ??= this.draw(this.frame.ctx));
  }
  reset(): void {
    this.value = undefined;
  }
}

/**
 * A card's line `i` as a pane row: drawn when the pane reads it (§6 #5). A sub-row's line is the sub-row's own item (a
 * click on it selects it) and belongs to the card (`of`), whose whole range the view scrolls into place.
 */
class CardLine implements MonitorRow {
  readonly item: string;
  readonly of?: string;
  constructor(
    private readonly card: CardDrawing,
    private readonly index: number,
    readonly key: string,
    sub?: string
  ) {
    this.item = sub ?? card.block.pn.key;
    if (sub !== undefined) this.of = card.block.pn.key;
  }
  get text(): string {
    return this.card.line(this.index);
  }
}

// ---------------------------------------------------------------------------
// The accordion

/** 0 finished, 1 unselected alive, 2 the root; null never folds (§3.5). */
function foldClass(block: CardBlock, selectedKey: string | null | undefined): 0 | 1 | 2 | null {
  // The selected card, and the card that holds the selected sub-row, never fold (§3.5 "选中卡").
  if (block.pn.key === selectedKey) return null;
  if (selectedKey && block.subs.some((row) => row.key === selectedKey)) return null;
  const glyph = block.pn.proj.marker.glyph;
  if (block.pn.proj.isRoot)
    return glyph === 'working' || glyph === 'starting' || glyph === 'done' || glyph === 'stop' ? 2 : null;
  if (glyph === 'done' || glyph === 'stop') return 0;
  if (glyph === 'working' || glyph === 'starting') return 1;
  return null;
}

/**
 * The rich view's rows under the summary: each card whole or folded, each put-away and `↳` row as a row.
 * `viewport` is the room left under the pinned rows; absent, nothing folds for room.
 */
/**
 * A rich view kept on its plan: which blocks there are, their heights and folds, and the row objects. None of it
 * depends on the clock, so a tick that only moves the clock reuses all of it and only redraws, on read, the lines
 * whose text changed (§6 #11, #16).
 */
interface RichView {
  sig: string;
  frame: Frame;
  rows: MonitorRow[];
  drawings: CardDrawing[];
  lazies: FrameRow[];
}
const richViews = new WeakMap<RowPlan, RichView>();

/**
 * The rich view's rows under the summary: each card whole or folded, each put-away and `↳` row as a row.
 * `viewport` is the room left under the pinned rows; absent, nothing folds for room.
 */
export function richRows(
  proj: DelegationProjection,
  plan: RowPlan,
  ctx: RenderContext,
  g: GlyphSet,
  say: Say,
  viewport?: number
): MonitorRow[] {
  const sig = `${ctx.width}|${ctx.selectedKey ?? ''}|${viewport ?? ''}|${lookId(g, say)}|${proj === ctx.proj ? 1 : 0}`;
  const kept = richViews.get(plan);
  if (kept && kept.sig === sig) {
    kept.frame.ctx = ctx;
    for (const drawing of kept.drawings) drawing.reset();
    for (const row of kept.lazies) row.reset();
    return kept.rows;
  }
  const frame: Frame = { ctx };
  const blocks = blocksOf(plan);
  const cards = blocks.filter((b): b is CardBlock => b.kind === 'card');
  // Heights only: a card is drawn when a row of it is read, which the pane does for the rows in view (§6 #5).
  const full = new Map<CardBlock, number>();
  for (const card of cards) full.set(card, cardHeight(card, ctx, g, say));
  const folded = new Set<CardBlock>();

  // More than five card siblings: their finished cards fold at once.
  const siblings = new Map<string, CardBlock[]>();
  for (const card of cards) {
    const parent = card.pn.parent?.key ?? '';
    const group = siblings.get(parent);
    if (group) group.push(card);
    else siblings.set(parent, [card]);
  }
  for (const group of siblings.values())
    if (group.length > SIBLING_FOLD)
      for (const card of group) if (foldClass(card, ctx.selectedKey) === 0) folded.add(card);

  // Too tall for the pane: fold by class, bottom card first, until it fits.
  let height = 0;
  for (const b of blocks) height += b.kind === 'row' || folded.has(b) ? 1 : full.get(b)!;
  if (viewport !== undefined) {
    for (const cls of [0, 1, 2] as const) {
      for (let i = cards.length - 1; i >= 0 && height > viewport; i--) {
        const card = cards[i];
        const lines = full.get(card)!;
        if (!folded.has(card) && foldClass(card, ctx.selectedKey) === cls && lines > 1) {
          folded.add(card);
          height -= lines - 1;
        }
      }
      if (height <= viewport) break;
    }
  }

  const rows: MonitorRow[] = [];
  const drawings: CardDrawing[] = [];
  const lazies: FrameRow[] = [];
  for (const block of blocks) {
    if (block.kind === 'row') {
      const row = bare(block.row);
      const lazy = new FrameRow((c) => renderRow(row, c), frame, block.row.key, `row:${block.row.key}`);
      lazies.push(lazy);
      rows.push(lazy);
      continue;
    }
    const key = `card:${block.pn.key}`;
    if (folded.has(block)) {
      const lazy = new FrameRow((c) => foldedCard(block, c), frame, block.pn.key, key);
      lazies.push(lazy);
      rows.push(lazy);
      continue;
    }
    // A card's lines are exactly the width already (the indent and a `width - indent` card), drawn once, on the
    // first read of any of them.
    const card = new CardDrawing(block, frame, g, say);
    drawings.push(card);
    const count = full.get(block)!;
    // The sub-rows' lines sit after the head and the body: 2 lines of frame, the body, then the sub-rows, then the
    // `+N` line when there is one (`cardHeight`).
    const shown = Math.min(MAX_SUB_ROWS, block.subs.length);
    const fold = block.subs.length > MAX_SUB_ROWS || block.pn.childrenUnknown ? 1 : 0;
    const firstSub = count - 1 - fold - shown;
    for (let i = 0; i < count; i++) {
      const sub = i >= firstSub && i < firstSub + shown ? block.subs[i - firstSub].key : undefined;
      rows.push(new CardLine(card, i, key, sub));
    }
  }
  richViews.set(plan, { sig, frame, rows, drawings, lazies });
  return rows;
}

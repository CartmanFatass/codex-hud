/**
 * Width allocation for the status bar.
 *
 * The bar used to be one concatenated string clipped to the pane width, so a
 * narrow pane lost whatever happened to sit on the right. Here each field is a
 * module that knows its own importance and carries shorter ways to say itself.
 * When the pane is too narrow the engine shortens before it hides, hides the
 * least important thing first, and clips text only as a last resort.
 *
 * A pinned module is never hidden. That is what keeps an alert on screen at 40
 * columns, where the session id and the timer have long since gone.
 *
 * Fields that belong together carry the same `group`, and neighbours inside a
 * group are joined by a narrower separator than the one between groups, so the
 * bar reads as a few clusters rather than a uniform list. Modules marked
 * `align: 'right'` form the trailing cluster, pushed to the last column.
 * Modules marked `align: 'fill'` follow the leading cluster and own the
 * columns up to the trailing one. A `flex` module there asks for `FLEX_WANT`
 * columns in its first form, however long its words, so others shorten or
 * leave to make that room and do not move when the words change; in its later
 * forms it asks for none. In every form it is cut to whatever room is left.
 *
 * A module may reserve columns for each of its forms. Its text is padded to
 * them, so a field whose words change length (a clock, a tool name, a rate)
 * never moves its neighbours or makes the fit choose different forms for
 * them. A module with nothing to say takes no columns at all: it comes and
 * goes once in a while, its words change every second.
 */

import { truncateAnsi, visualLength } from '../colors.js';

export type VariantLevel = 'full' | 'short' | 'min';

export const VARIANT_ORDER: VariantLevel[] = ['full', 'short', 'min'];

export interface BarModule {
  id: string;
  /** Higher survives longer. Shortening and hiding both start at the bottom. */
  priority: number;
  /** Pinned modules are shortened but never hidden. */
  pinned?: boolean;
  /** Neighbours sharing a group are joined by the tighter group separator. */
  group?: string;
  /** Right-aligned modules form the trailing cluster; `fill` ones the zone between the two. */
  align?: 'left' | 'fill' | 'right';
  /**
   * In the fill zone: asks for `FLEX_WANT` columns in its first form only;
   * in every form it is cut to the room that is left, and left out under
   * `FLEX_MIN` columns.
   */
  flex?: boolean;
  /**
   * Order of shortening on the scale of the priorities: a module with one
   * takes its turns among the hides, each step going to whichever comes
   * lower. Without one, a module shortens before anything is hidden.
   */
  shrink?: number;
  /** May leave in the shortening pass, as if hiding were its shortest form. */
  optional?: boolean;
  /** Columns each form keeps, however short its text. */
  reserve?: Partial<Record<VariantLevel, number>>;
  /** Ways to say the same thing, longest first. Empty entries are skipped. */
  variants: Partial<Record<VariantLevel, string>>;
}

/** Where one surviving module ended up on the finished line. */
export interface BarSegment {
  id: string;
  level: VariantLevel;
  /** First column the module occupies, counting from 0. */
  x: number;
  /** Columns it occupies, after any clipping at the right edge. */
  width: number;
}

export interface FitResult {
  line: string;
  /** Module ids that survived, in display order. */
  kept: string[];
  /** The variant each surviving module settled on. */
  levels: Record<string, VariantLevel>;
  /**
   * Where each surviving module sits on the line, so a click at a column can
   * be answered with the field under it. Columns, not string indices: a wide
   * character is one column of text and two of string.
   */
  segments: BarSegment[];
  /** True when even the pinned minimum had to be clipped. */
  clipped: boolean;
}

interface Candidate {
  module: BarModule;
  levels: VariantLevel[];
  levelIndex: number;
  dropped: boolean;
}

const DEFAULT_GROUP_SEPARATOR = '  ';
/** Columns between clusters, at the least: as wide as the separator. */
const CLUSTER_GAP = 3;
/** A flexible field cut to fewer columns than this says nothing worth reading. */
const FLEX_MIN = 8;
/**
 * What a flexible field asks for, whatever its words: a fixed claim keeps the
 * fit, and so every other field, still while those words change.
 */
const FLEX_WANT = 32;

function availableLevels(module: BarModule): VariantLevel[] {
  return VARIANT_ORDER.filter((level) => {
    const text = module.variants[level];
    return typeof text === 'string' && text.length > 0;
  });
}

function rawText(candidate: Candidate): string {
  return candidate.module.variants[candidate.levels[candidate.levelIndex]] ?? '';
}

function currentText(candidate: Candidate): string {
  const text = rawText(candidate);
  const reserve = candidate.module.reserve?.[candidate.levels[candidate.levelIndex]] ?? 0;
  const width = visualLength(text);
  return width < reserve ? text + ' '.repeat(reserve - width) : text;
}

/** Neighbours in the same named group sit closer together than groups do. */
function sameGroup(left: Candidate, right: Candidate): boolean {
  const group = left.module.group;
  return Boolean(group) && group === right.module.group;
}

type Cluster = 'left' | 'fill' | 'right';

function clusterOf(candidate: Candidate): Cluster {
  return candidate.module.align ?? 'left';
}

function clusters(live: Candidate[]): Record<Cluster, Candidate[]> {
  return {
    left: live.filter((candidate) => clusterOf(candidate) === 'left'),
    fill: live.filter((candidate) => clusterOf(candidate) === 'fill'),
    right: live.filter((candidate) => clusterOf(candidate) === 'right'),
  };
}

function clusterWidth(items: Candidate[], separatorWidth: number, groupSeparatorWidth: number): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (i > 0) total += sameGroup(items[i - 1], items[i]) ? groupSeparatorWidth : separatorWidth;
    total += visualLength(currentText(items[i]));
  }
  return total;
}

/** Columns a fill-zone field asks for: a flexible one `FLEX_WANT` in its first form, else none. */
function asked(candidate: Candidate, claims: boolean): number {
  if (!candidate.module.flex) return visualLength(currentText(candidate));
  return claims && candidate.levelIndex === 0 ? FLEX_WANT : 0;
}

/**
 * Columns the line needs: the leading cluster, the fill zone's fields after a
 * separator, and the trailing cluster after a gap. Without `claims`, what
 * the fixed fields alone need, leaving the flexible ones the rest.
 */
function totalWidth(candidates: Candidate[], separatorWidth: number, groupSeparatorWidth: number, claims = true): number {
  const parts = clusters(candidates.filter((candidate) => !candidate.dropped));
  let total = clusterWidth(parts.left, separatorWidth, groupSeparatorWidth);
  let previous = parts.left.at(-1);
  for (const candidate of parts.fill) {
    const width = asked(candidate, claims);
    if (width === 0) continue;
    total += (previous ? (sameGroup(previous, candidate) ? groupSeparatorWidth : separatorWidth) : 0) + width;
    previous = candidate;
  }
  if (parts.right.length > 0) total += (total > 0 ? CLUSTER_GAP : 0) + clusterWidth(parts.right, separatorWidth, groupSeparatorWidth);
  return total;
}

/** The order of a step: a module's next shortening, or its hiding. */
function shortenOrder(candidate: Candidate): number {
  return candidate.module.shrink ?? candidate.module.priority - 1_000_000;
}

/**
 * Pick the cheapest step that still gives room: shortening the module whose
 * turn comes first (modules without a shrink order before any hide), or
 * hiding the least important unpinned one. Shortening wins a tie. Undefined
 * when nothing is left to give.
 */
function nextStep(candidates: Candidate[]): { candidate: Candidate; hide: boolean } | undefined {
  let shorten: Candidate | undefined;
  let hide: Candidate | undefined;
  for (const candidate of candidates) {
    if (candidate.dropped) continue;
    const optional = candidate.module.optional && !candidate.module.pinned;
    if ((candidate.levelIndex < candidate.levels.length - 1 || optional) &&
        (!shorten || shortenOrder(candidate) < shortenOrder(shorten))) {
      shorten = candidate;
    }
    if (!candidate.module.pinned && (!hide || candidate.module.priority < hide.module.priority)) {
      hide = candidate;
    }
  }
  if (shorten && (!hide || shortenOrder(shorten) <= hide.module.priority)) return { candidate: shorten, hide: false };
  return hide ? { candidate: hide, hide: true } : undefined;
}

export function fitModules(
  modules: BarModule[],
  options: { width: number; separator: string; groupSeparator?: string }
): FitResult {
  const groupSeparator = options.groupSeparator ?? DEFAULT_GROUP_SEPARATOR;
  const separatorWidth = visualLength(options.separator);
  const groupSeparatorWidth = visualLength(groupSeparator);
  const candidates: Candidate[] = modules
    .map((module) => ({ module, levels: availableLevels(module), levelIndex: 0, dropped: false }))
    .filter((candidate) => candidate.levels.length > 0);

  if (options.width <= 0 || candidates.length === 0) {
    return { line: '', kept: [], levels: {}, segments: [], clipped: false };
  }

  // Shorten before hiding, then hide from the bottom of the priority order
  // upwards; a module with its own shrink order takes its turn among the hides.
  while (totalWidth(candidates, separatorWidth, groupSeparatorWidth) > options.width) {
    const step = nextStep(candidates);
    if (!step) break;
    const { candidate } = step;
    if (!step.hide && candidate.levelIndex < candidate.levels.length - 1) candidate.levelIndex += 1;
    else candidate.dropped = true;
  }

  const live = candidates.filter((candidate) => !candidate.dropped);
  const parts = clusters(live);
  const between = (left: Candidate, right: Candidate) => (sameGroup(left, right) ? groupSeparatorWidth : separatorWidth);

  /**
   * The fill zone as it will be drawn: its fixed fields, then each flexible
   * one cut to the room the line leaves it, or left out when that room is
   * too small to read.
   */
  const room = options.width - totalWidth(candidates, separatorWidth, groupSeparatorWidth, false);
  const fill: Array<{ candidate: Candidate; text: string }> = [];
  let spare = room;
  for (const candidate of parts.fill) {
    const text = currentText(candidate);
    if (!candidate.module.flex) { fill.push({ candidate, text }); continue; }
    const previous = fill.at(-1)?.candidate ?? parts.left.at(-1);
    const lead = previous ? between(previous, candidate) : 0;
    if (spare - lead < FLEX_MIN) continue;
    const cut = visualLength(text) > spare - lead ? truncateAnsi(text, spare - lead) : text;
    fill.push({ candidate, text: cut });
    spare -= lead + visualLength(cut);
  }

  const shown = [...parts.left, ...fill.map((entry) => entry.candidate), ...parts.right];
  const level = (candidate: Candidate) => candidate.levels[candidate.levelIndex];

  /**
   * Lay a run of modules out from a starting column, measuring the same
   * separators the join uses. Doing it here rather than re-deriving it from
   * the rendered line keeps the columns exact through colour and wide glyphs.
   * The segment is the text itself; a reserve's padding is no field to click.
   */
  const lay = (items: Array<{ candidate: Candidate; text: string }>, from: number, after?: Candidate): { text: string; segments: BarSegment[]; end: number } => {
    let out = '';
    let x = from;
    const segments: BarSegment[] = [];
    let previous = after;
    for (const { candidate, text } of items) {
      if (previous) {
        const sep = sameGroup(previous, candidate) ? groupSeparator : options.separator;
        out += sep;
        x += visualLength(sep);
      }
      segments.push({ id: candidate.module.id, level: level(candidate), x,
        width: Math.min(visualLength(text), visualLength(rawText(candidate))) });
      out += text;
      x += visualLength(text);
      previous = candidate;
    }
    return { text: out, segments, end: x };
  };
  const plain = (items: Candidate[]) => items.map((candidate) => ({ candidate, text: currentText(candidate) }));

  const left = lay(plain(parts.left), 0);
  const middle = lay(fill, left.end, parts.left.at(-1));
  const right = lay(plain(parts.right), 0);
  const rw = right.end;
  const used = middle.end;
  const clipped = used + (rw > 0 ? (used > 0 ? CLUSTER_GAP : 0) + rw : 0) > options.width;

  let line: string;
  let segments: BarSegment[];
  if (clipped) {
    // Even the pinned minimum does not fit: everything in order, then cut.
    // What ran off the edge is not on screen, and what straddles it is only
    // on screen as far as the edge.
    const gap = rw > 0 && used > 0 ? ' '.repeat(CLUSTER_GAP) : '';
    line = truncateAnsi(left.text + middle.text + gap + right.text, options.width);
    const shift = used + gap.length;
    segments = [...left.segments, ...middle.segments, ...right.segments.map((segment) => ({ ...segment, x: segment.x + shift }))]
      .filter((segment) => segment.x < options.width)
      .map((segment) => ({ ...segment, width: Math.min(segment.width, options.width - segment.x) }));
  } else {
    // The slack goes before the trailing cluster, which is pushed to the
    // last column. Only slack is spent, so the line never grows past the pane.
    const rx = options.width - rw;
    line = left.text + middle.text + (rw > 0 ? ' '.repeat(rx - used) + right.text : '');
    segments = [...left.segments, ...middle.segments, ...right.segments.map((segment) => ({ ...segment, x: segment.x + rx }))];
  }

  return {
    line,
    kept: shown.map((candidate) => candidate.module.id),
    levels: Object.fromEntries(
      shown.map((candidate) => [candidate.module.id, candidate.levels[candidate.levelIndex]])
    ),
    segments,
    clipped,
  };
}

/**
 * The Claude Code statusline's delegation parts (design §4.12): the standing
 * count that ends the first line (`⧉ 2▸ 1⚑ 1✓`, `· 6/6` when the slots are
 * full) and the second line of items, `marker harness name [word] age`, in
 * bucket order. Height is 1 or 2, never more.
 *
 * Nothing here draws the first line: the session facts (model, context,
 * cost) come first and always win their columns, so the caller hands in its
 * line and `joinFirstLine` keeps the count at the end of it.
 *
 * This repository has no Claude Code statusline renderer to hook into (the first line is claude-hud's, §4.12),
 * so these are pure functions for that renderer to call. At 80 columns the line keeps its trailing `+1✓`:
 * §4.12 folds everything not shown into `+N`, finished items included (rulings B10b s1, Q12).
 *
 * The ladder, in order: pane / mode, ages, actives into `+N▸`, the troubled items' words (marker, harness and
 * name stay), the troubled items into counts `⚑ ? ⚠ ✗`. A conflicting child is one item, `⚠ ⌬ impl-c conflict ~6m`.
 */

import { colors, theme, truncateAnsi, visualLength } from '../colors.js';
import { age } from '../monitor-labels.js';
import type { DelegationViewModel } from '../../core/link/view-model.js';
import { slotsAlert } from './alerts.js';
import { countParts } from './bar.js';
import { glyphSet, GLYPHS, useAscii, type Glyph, type GlyphSet } from './glyphs.js';
import type { DelegationProjection, PNode } from './projection.js';
import { projectDelegation } from './projection.js';
import { compareSiblings, PUT_AWAY_MS } from './rows.js';
import { paint, panelSay, W, type Role, type Say } from './style.js';

export interface StatuslineOptions {
  /** Columns of the line. */
  width: number;
  nowMs: number;
  ascii?: boolean;
  /** `statusline.delegationLine`; false leaves the count alone (§4.12). */
  delegationLine?: boolean;
  say?: Say;
}

export interface StatuslineDelegation {
  /** The count that ends the first line; empty when nothing was delegated. */
  counts: string;
  /** The second line, exactly as drawn (at most `width` columns), or null. */
  line2: string | null;
  height: 1 | 2;
}

/** More actives than this fold into `+N▸`, by the width: 80, 120, 200 columns (§4.12). */
const ACTIVE_SHOWN = [
  [160, 5],
  [100, 3],
  [0, 2],
] as const;
const NAME_CAP = 24;

type Detail = 0 | 1 | 2;

interface Item {
  pn: PNode;
  /** Which marker; `glyph` is its drawing. */
  kind: Glyph;
  glyph: string;
  role: Role;
  harness: string;
  name: string;
  word: string;
  pane: string;
  mode: string;
  age: string;
  /** Close-pane and the like: alive in fact, never folded away. */
  keep: boolean;
  /** The word already says `pane`, so the pane label adds nothing. */
  paneWord: boolean;
}

function paneText(label: string, say: Say): string {
  return /^pane\b/i.test(label) ? label : `${say(W.pane)} ${label}`;
}

function itemOf(pn: PNode, nowMs: number, g: GlyphSet, say: Say, keep: boolean): Item {
  const p = pn.proj;
  const m = p.marker;
  const clock = m.clock;
  // No clock rather than an invented age: nothing to measure from, or a time that has not happened yet (§3.4).
  const base = clock.at === null || clock.kind === 'none' || clock.at > nowMs ? '' : age(new Date(clock.at), nowMs);
  const fresh = m.fadesAfterMs !== null && m.sinceMs !== null && nowMs - m.sinceMs >= m.fadesAfterMs;
  return {
    pn,
    kind: m.glyph,
    glyph: g.marker[m.glyph],
    role: fresh ? 'muted' : m.role,
    harness: p.harness ? g.harness[p.harness] : '',
    name: p.name ?? say(W.main),
    word: m.words.map((w) => say(w)).join(` ${g.sep} `),
    pane: p.paneLabel ? paneText(p.paneLabel, say) : '',
    mode: p.headless ? say('headless') : '',
    age: base ? (clock.approx ? `~${base}` : base) : '',
    keep,
    paneWord: m.closePane || m.stopInPane,
  };
}

function itemText(
  item: Item,
  detail: Detail,
  ages: boolean,
  g: GlyphSet,
  words = true
): { plain: string; painted: string } {
  const detailText = detail >= 1 && !item.paneWord ? item.pane || (detail >= 2 ? item.mode : '') : '';
  const name = truncateAnsi(item.name, NAME_CAP, g.ellipsis);
  const word = words ? item.word : '';
  const parts = [item.glyph, item.harness, name, word, detailText, ages ? item.age : ''].filter(Boolean);
  const painted = [
    paint(item.role, item.glyph),
    item.harness ? colors.dim(item.harness) : '',
    theme.value(name),
    word ? paint(item.role === 'muted' ? 'muted' : item.keep ? 'text' : item.role, word) : '',
    detailText ? colors.dim(detailText) : '',
    ages && item.age ? colors.dim(item.age) : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { plain: parts.join(' '), painted };
}

/** A count's mark: the first line's own (`✗` for a failure, `■` counted with `✓`, §3.2). */
function countMark(kind: Glyph, g: GlyphSet): string {
  return kind === 'fail' ? g.barFail : g.marker[kind === 'stop' ? 'done' : kind];
}

function countKinds(items: readonly Item[], order: readonly Glyph[], g: GlyphSet): Array<[number, string]> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(countMark(item.kind, g), (counts.get(countMark(item.kind, g)) ?? 0) + 1);
  const out: Array<[number, string]> = [];
  for (const kind of order) {
    const mark = countMark(kind, g);
    const n = counts.get(mark);
    if (n && !out.some(([, m]) => m === mark)) out.push([n, mark]);
  }
  return out;
}

/** `+2▸ +1✓`: what the line folds away, one token per kind, in the first line's order. */
function remainderText(items: readonly Item[], g: GlyphSet): string {
  return countKinds(items, GLYPHS, g)
    .map(([n, mark]) => `+${n}${mark}`)
    .join(' ');
}

/** The troubled items as counts, in the order every surface uses: `⚑ ? ⚠ ✗` (rulings B10b s1, Q11). */
const TROUBLE_ORDER: readonly Glyph[] = ['flag', 'unknown', 'warn', 'fail'];
function troubleCounts(items: readonly Item[], g: GlyphSet): string {
  return countKinds(items, TROUBLE_ORDER, g)
    .map(([n, mark]) => `${n}${mark}`)
    .join(' ');
}

/** The statusline's delegation parts for a view model. */
export function statuslineDelegation(vm: DelegationViewModel, options: StatuslineOptions): StatuslineDelegation {
  const proj = projectDelegation(vm);
  const g = glyphSet(options.ascii);
  const say = options.say ?? panelSay;
  const counts = countsText(proj, g);
  if (!counts || options.delegationLine === false) return { counts, line2: null, height: 1 };
  const line2 = secondLine(proj, options.width, options.nowMs, g, say);
  return { counts, line2, height: line2 === null ? 1 : 2 };
}

/** `⧉ 2▸ 1⚑ 1✓`, and `· 6/6` after it while the slots are full. */
export function countsText(proj: DelegationProjection, g: GlyphSet): string {
  const parts = countParts(proj.delegatedCounts, g);
  if (parts.length === 0) return '';
  const slots = slotsAlert(proj);
  return `${colors.dim(g.delegated)} ${parts.join(' ')}${slots ? ` ${colors.dim(g.sep)} ${theme.warning(`${slots.held}/${slots.limit}`)}` : ''}`;
}

function secondLine(proj: DelegationProjection, width: number, nowMs: number, g: GlyphSet, say: Say): string | null {
  const trouble: Item[] = [];
  const alive: Item[] = [];
  const tail: Item[] = [];
  const done: Item[] = [];
  // A conflicting child is one item however many parents claim it: the rows of the other claims are
  // synthetic (no node of their own), so they are told apart by the child they name (§4.12).
  const seen = new Set<string>();
  // The conflicts that did not fit the row budget are items all the same (`omittedConflicts`).
  const nodes = [...proj.nodes, ...proj.omittedConflicts]
    .filter((pn) => !pn.proj.isRoot && !pn.proj.isNative)
    .sort(compareSiblings(false));
  for (const pn of nodes) {
    const identity = pn.node === null ? (pn.relation?.childKey ?? pn.key) : pn.key;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const m = pn.proj.marker;
    if (m.rank === 0) trouble.push(itemOf(pn, nowMs, g, say, false));
    else if (m.rank === 1) alive.push(itemOf(pn, nowMs, g, say, false));
    else if (m.rank === 2) tail.push(itemOf(pn, nowMs, g, say, true));
    else if (m.glyph === 'fail' && m.finishedAt !== null && nowMs - m.finishedAt < PUT_AWAY_MS)
      trouble.push(itemOf(pn, nowMs, g, say, false));
    else done.push(itemOf(pn, nowMs, g, say, false));
  }
  // Only live or troubled delegations earn the line (§4.12).
  if (trouble.length + alive.length + tail.length === 0) return null;

  const maxActive = ACTIVE_SHOWN.find(([from]) => width >= from)![1];
  const start: Detail = width >= 160 ? 2 : width >= 100 ? 1 : 0;
  const lead = `${g.delegated} `;
  const sep = ` ${g.sep} `;

  // The ladder of §4.12: pane / mode, then ages, then actives into `+N▸`, then the troubled items lose their
  // words (marker, harness and name stay), and last the troubled become counts.
  interface Step {
    detail: Detail;
    ages: boolean;
    shown: number;
    troubleWords: boolean;
    troubleAsCounts: boolean;
  }
  const steps: Step[] = [];
  const shownStart = Math.min(maxActive, alive.length);
  const step = (detail: Detail, ages: boolean, shown: number, troubleWords = true, troubleAsCounts = false) =>
    steps.push({ detail, ages, shown, troubleWords, troubleAsCounts });
  for (const detail of start === 2 ? [2, 1, 0] : start === 1 ? [1, 0] : [0]) step(detail as Detail, true, shownStart);
  step(0, false, shownStart);
  for (let shown = shownStart - 1; shown >= 0; shown--) step(0, false, shown);
  step(0, false, 0, false);
  step(0, false, 0, false, true);

  for (const rung of steps) {
    const shownAlive = alive.slice(0, rung.shown);
    const folded = alive.slice(rung.shown);
    const pieces: Array<{ plain: string; painted: string }> = rung.troubleAsCounts
      ? [{ plain: troubleCounts(trouble, g), painted: paint('warning', troubleCounts(trouble, g)) }]
      : trouble.map((item) => itemText(item, rung.detail, rung.ages, g, rung.troubleWords));
    const shown = [...shownAlive, ...tail].map((item) => itemText(item, rung.detail, rung.ages, g));
    const rest = remainderText([...folded, ...done], g);
    const plainParts = [...pieces.map((p) => p.plain), ...shown.map((p) => p.plain), ...(rest ? [rest] : [])];
    const plain = lead + plainParts.join(sep);
    if (visualLength(plain) > width) continue;
    const painted = [
      ...pieces.map((p) => p.painted),
      ...shown.map((p) => p.painted),
      ...(rest ? [colors.dim(rest)] : []),
    ].join(colors.dim(sep));
    return `${colors.dim(g.delegated)} ${painted}`;
  }
  return null;
}

/**
 * The first line with the count kept at its end: the session facts give way
 * (cut with an ellipsis) before the count does, and the line never exceeds
 * `width`. The separator is the statusline's own `│`.
 */
export function joinFirstLine(first: string, counts: string, width: number, ascii?: boolean): string {
  if (!counts) return truncateAnsi(first, width, glyphSet(ascii).ellipsis);
  const bar = useAscii(ascii) ? ' | ' : ' │ ';
  const reserve = visualLength(counts) + visualLength(bar);
  if (reserve >= width) return truncateAnsi(counts, width, glyphSet(ascii).ellipsis);
  const room = width - reserve;
  const head = visualLength(first) > room ? truncateAnsi(first, room, glyphSet(ascii).ellipsis) : first;
  return `${head}${theme.separator(bar)}${counts}`;
}

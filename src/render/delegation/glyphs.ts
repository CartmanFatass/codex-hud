/**
 * The delegation view's glyphs (design §5.3): one table per look, Unicode and
 * its ASCII fallback. `icons=text` switches the whole set at once, never one
 * symbol alone, so a terminal that cannot draw `⌬` also gets `X` for every
 * other harness mark. Neither table ever contains a variation selector.
 */

import type { AgentTaskKind } from '../../types.js';
import { iconSet } from '../hud-config.js';

/** What a row's single marker stands for (§3.3). Colour and word live beside it, in `marker.ts`. */
export type Glyph = 'warn' | 'flag' | 'fail' | 'stop' | 'unknown' | 'working' | 'starting' | 'done';
export const GLYPHS: readonly Glyph[] = ['working', 'starting', 'flag', 'unknown', 'warn', 'fail', 'done', 'stop'];

export type HarnessMark = 'claude' | 'codex' | 'pi' | 'jev';

export interface GlyphSet {
  marker: Record<Glyph, string>;
  /** The bar writes a failure as `✗`; the rows write it as `!`. */
  barFail: string;
  harness: Record<HarnessMark, string>;
  /** A native child's kind of work in the icon slot (§3.4, §7 #33); `other` leaves the slot empty. */
  kind: Record<AgentTaskKind, string>;
  headless: string;
  /** The review chip's mark: `◈2` (§4.2; `r2` in ASCII, rulings B10B-s2 Q7). */
  review: string;
  delegated: string;
  /** `│ ├ └ ┊ ↳`. */
  edge: { line: string; tee: string; end: string; unconfirmed: string; flat: string };
  meter: { fill: string; half: string; track: string };
  parent: string;
  /** The folded-history count mark: `⊕9`. */
  putAway: string;
  /** The face before a turn clock; ASCII has none (the digits are enough). */
  clock: string;
  select: string;
  sep: string;
  ellipsis: string;
}

export const UNICODE_GLYPHS: GlyphSet = {
  marker: { warn: '⚠', flag: '⚑', fail: '!', stop: '■', unknown: '?', working: '▸', starting: '·', done: '✓' },
  barFail: '✗',
  harness: { claude: '✳', codex: '⌬', pi: 'π', jev: '◎' },
  // The panel's `KIND_GLYPHS` (`agent-title.ts`), kept apart so the bar's process does not load the panel.
  kind: { research: '⌕', experiment: '⚗', fix: '⚒', review: '◈', writing: '✎', summary: '∑', other: '' },
  headless: '⊟',
  review: '◈',
  delegated: '⧉',
  edge: { line: '│', tee: '├', end: '└', unconfirmed: '┊', flat: '↳' },
  meter: { fill: '━', half: '╸', track: '─' },
  parent: '↑',
  putAway: '⊕',
  clock: '◷',
  select: '›',
  sep: '·',
  ellipsis: '…',
};

export const ASCII_GLYPHS: GlyphSet = {
  marker: { warn: '^', flag: '@', fail: '!', stop: '#', unknown: '?', working: '>', starting: '.', done: '+' },
  barFail: '!',
  harness: { claude: 'C', codex: 'X', pi: 'P', jev: 'J' },
  kind: { research: '', experiment: '', fix: '', review: '', writing: '', summary: '', other: '' },
  headless: '-',
  review: 'r',
  delegated: '#',
  edge: { line: '|', tee: '|', end: '\\', unconfirmed: ':', flat: '>' },
  meter: { fill: '=', half: '=', track: '-' },
  parent: '^',
  putAway: '+',
  clock: '',
  select: '>',
  sep: '-',
  ellipsis: '~',
};

/** ASCII exactly when the display's icon set is `text` (§5.3); tests pass it explicitly. */
export function useAscii(ascii?: boolean): boolean {
  return ascii ?? iconSet() === 'text';
}

export function glyphSet(ascii?: boolean): GlyphSet {
  return useAscii(ascii) ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/**
 * The panel's one control bar: its first row, on its own background. Every
 * button the panel draws is here, and nowhere else: not on the status card,
 * not on a pane's band (a click there zooms the pane, but draws nothing).
 *
 * With icons, every button is the same size and the buttons are spread
 * evenly over the row: the same step from each icon to the next, the widest
 * that fits, and the columns left over half at each end. The chip grows
 * with the step:
 *
 *   step 2    "X "             the icon and the column it may spill into
 *   step 3    " X "            chips side by side
 *   step 4–5  " X " + gap      a column or two of bar between chips
 *   step 6+   "  X  " + gap
 *
 *   32 columns, ten buttons    ␠␠⌂␠␠▦␠␠⌥␠␠±␠␠◫␠␠≣␠␠ǁ␠␠⊕␠␠⚙␠␠?␠␠
 *   44 columns, nine           ␠⌂␠␠␠▦␠␠␠⌥␠␠␠± … ⚙␠␠␠?␠␠
 *
 * Where every button's word fits beside its icon (about 95 columns in
 * Chinese, 110 in English) the buttons carry their words, the same gap
 * between each two. The icons are the Unicode set, drawn by the font the
 * panel asks for (MesloLGS NF, which has every one of them), or Nerd Font
 * icons with `icons: nerd`. An icon is always in the full text colour and
 * bold, never dimmed; a tab's state is its chip: the focused pane on the
 * accent, an open one on a chip, a closed one on the bar itself. No key is
 * written anywhere on the bar; the keys (the tmux prefix, then a letter) are
 * in the help alone.
 *
 * The buttons, left to right: the main session, a tab per pane, the brief's
 * pause (only with a brief configured), the older agents (only when the
 * linger window put some away), settings and help. Short of two columns a
 * button, the closed panes' tabs go first, then the older agents' button,
 * then the brief's, then the tabs but the focused one's, then that one.
 *
 * With `icons: text` (or glyphs set to text) the buttons are words, which
 * cannot all be one size: they keep the steps below, giving up words, gaps
 * and buttons in turn. A click anywhere in a button's slot is its control; a
 * tab's click is `clickTab` in monitor.ts. Pure.
 */
import type { MonitorControl, MonitorPane, MonitorState } from './monitor.js';
import { MONITOR_PANES } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { palette } from './palette.js';
import { iconSet } from './hud-config.js';
import { t, language } from './i18n.js';

/** What the bar needs to know besides the panel's state. */
export interface BarInput {
  /** The brief, when one is configured. */
  brief?: { paused?: boolean };
  /** Agents the linger window put away; 0 hides the button. */
  expired: number;
}

type IconName = MonitorPane | 'main' | 'pause' | 'resume' | 'show' | 'hide' | 'settings' | 'help';

/**
 * The Unicode icons: one column each, every one a glyph MesloLGS NF (the
 * font the panel needs, see README) draws itself, so none falls back to
 * another font at another size, and none a glyph the legend gives another
 * meaning (✓ ✗ ◈ ◎ ◷ ⌕ ≡ ▸ …).
 */
export const UNICODE_ICONS: Record<IconName, string> = {
  main: '⌂',
  agents: '▦',
  worktrees: '⌥',
  changes: '±',
  details: '◫',
  timeline: '≣',
  pause: 'ǁ',
  resume: '▶',
  show: '⊕',
  hide: '⊖',
  settings: '⚙',
  help: '?',
};

/**
 * The Nerd Font icons, mostly Font Awesome's solid set for one look. Each
 * takes one cell but draws wider, so one is always followed by a space. The
 * robot is a Material Design icon past the BMP: a surrogate pair in a JS
 * string.
 */
export const ICONS: Record<IconName, string> = {
  main: '',
  agents: '\u{f06a9}',
  worktrees: '',
  changes: '',
  details: '',
  timeline: '',
  pause: '',
  resume: '',
  show: '',
  hide: '',
  settings: '',
  help: '',
};

/** The icon the panel draws for `name`, or '' with icons off. */
export function icon(name: IconName): string {
  const set = iconSet();
  return set === 'nerd' ? ICONS[name] : set === 'unicode' ? UNICODE_ICONS[name] : '';
}

/**
 * Each pane's names: `title` heads its frame, `tab` is its tab's word (the
 * title in Chinese, a shorter word in English), `short` the tab's word where
 * words do not fit and there are no icons.
 */
const PANE_NAMES: Record<MonitorPane, Record<'en' | 'zh', { title: string; tab: string; short: string }>> = {
  agents: { en: { title: 'Agents', tab: 'Agents', short: 'Ag' }, zh: { title: '卡片', tab: '卡片', short: '卡片' } },
  worktrees: {
    en: { title: 'Worktrees', tab: 'Trees', short: 'Wt' },
    zh: { title: '工作树', tab: '工作树', short: '工作…' },
  },
  changes: { en: { title: 'Changes', tab: 'Changes', short: 'Ch' }, zh: { title: '改动', tab: '改动', short: '改动' } },
  details: {
    en: { title: 'Inspector', tab: 'Inspect', short: 'In' },
    zh: { title: '详情', tab: '详情', short: '详情' },
  },
  timeline: {
    en: { title: 'Timeline', tab: 'Timeline', short: 'Tl' },
    zh: { title: '时间线', tab: '时间线', short: '时间…' },
  },
};

function names(id: MonitorPane) {
  return PANE_NAMES[id][language() === 'zh' ? 'zh' : 'en'];
}

/** A pane's title as its frame draws it: its icon (painted by the caller) and its name. */
export function paneTitle(id: MonitorPane): { icon: string; name: string } {
  return { icon: icon(id), name: names(id).title };
}

/** How big a chip is: icon and word with a side column each, the icon between side columns, or the icon and one column. */
type Size = 'wide' | 'pad' | 'tight';

/**
 * A chip's text: `glyph` (an icon, or a count) and `word` where it has one.
 * Without icons the word stands alone. The Nerd Font icon always has a space
 * after it to spill into.
 */
function chipText(glyph: string, word: string | null, size: Size): string {
  const face = glyph ? (word ? `${glyph} ${word}` : glyph) : (word ?? '');
  return size === 'tight' ? `${face} ` : ` ${face} `;
}

type ChipState = 'focused' | 'open' | 'closed' | 'button';

/**
 * A chip painted for its state. The face is always the full text colour and
 * bold; the state is the surface: the accent for the focused tab, a chip for
 * an open one or a button, the bar itself for a closed one. Without colour
 * the focused tab is in brackets ("[▦]").
 */
function paint(text: string, state: ChipState, accent = false): string {
  const lead = text.match(/^ */)![0];
  const trail = text.match(/ *$/)![0];
  const face = text.slice(lead.length, text.length - trail.length);
  if (palette().name === 'none') {
    if (state !== 'focused') return text;
    // The brackets take a side column each, so the chip keeps its width.
    if (lead && trail) return `${lead.slice(1)}[${face}]${trail.slice(1)}`;
    return trail ? `${face}]${trail.slice(1)}` : `[${face}]`;
  }
  if (state === 'focused') return theme.tab(theme.bold(text));
  const strong = theme.bold(accent ? theme.accent(face) : theme.value(face));
  return state === 'closed' ? `${lead}${strong}${trail}` : theme.chip(`${lead}${strong}${trail}`);
}

interface Button {
  text: string;
  kind: MonitorControl['kind'];
  pane?: MonitorPane;
}

interface Step {
  size: Size;
  /** The tabs keep their words. */
  tabWords: boolean;
  /**
   * How many of the other buttons keep their words: 3 all, 2 all but the
   * brief's and the older agents', 1 settings and help only, 0 none.
   * Without icons the buttons are words at every step, shortened under 3.
   */
  words: 0 | 1 | 2 | 3;
  /** Columns of bar between two chips. */
  gap: 0 | 1;
  /** Closed panes keep their tab. */
  closed: boolean;
  older: boolean;
  /** The older agents' button is its count alone: a Nerd Font eye gives way before a size does. */
  bare?: boolean;
  brief: boolean;
  /** 'all' the tabs there are, 'focus' only the focused pane's, '' none. */
  tabs: 'all' | 'focus' | '';
}

const ALL = { closed: true, older: true, brief: true, tabs: 'all' } as const;
/** From the widest chips to the fewest, in the order the bar gives them up. */
const STEPS: Step[] = [
  { size: 'wide', tabWords: true, words: 3, gap: 1, ...ALL },
  { size: 'wide', tabWords: false, words: 3, gap: 1, ...ALL },
  { size: 'wide', tabWords: false, words: 2, gap: 1, ...ALL },
  { size: 'wide', tabWords: false, words: 1, gap: 1, ...ALL },
  { size: 'pad', tabWords: false, words: 0, gap: 1, ...ALL },
  { size: 'pad', tabWords: false, words: 0, gap: 0, ...ALL },
  { size: 'pad', tabWords: false, words: 0, gap: 0, ...ALL, bare: true },
  { size: 'tight', tabWords: false, words: 0, gap: 0, ...ALL },
  { size: 'tight', tabWords: false, words: 0, gap: 0, ...ALL, bare: true },
  { size: 'tight', tabWords: false, words: 0, gap: 0, ...ALL, bare: true, closed: false },
  { size: 'tight', tabWords: false, words: 0, gap: 0, ...ALL, closed: false, older: false },
  { size: 'tight', tabWords: false, words: 0, gap: 0, ...ALL, closed: false, older: false, brief: false },
  { size: 'tight', tabWords: false, words: 0, gap: 0, closed: false, older: false, brief: false, tabs: 'focus' },
  { size: 'tight', tabWords: false, words: 0, gap: 0, closed: false, older: false, brief: false, tabs: '' },
];
/**
 * Where a width starts in STEPS: the chip sizes the panel's width calls for
 * (words from 56 columns, side columns from 36, gaps from 44), whether or not
 * something wider would fit.
 */
function firstStep(width: number): number {
  return width >= 56 ? 0 : width >= 44 ? 4 : width >= 36 ? 5 : 7;
}

type Bar = { line: string; controls: MonitorControl[] };

export function controlBar(state: MonitorState, input: BarInput, width: number): Bar {
  return iconSet() === 'text' ? wordBar(state, input, width) : iconBar(state, input, width);
}

/** One button of the icon bar: its icon, its word, and how its chip is painted. */
interface Spec {
  kind: MonitorControl['kind'];
  pane?: MonitorPane;
  glyph: string;
  word: string;
  state: ChipState;
  accent?: boolean;
}

/**
 * The buttons there are, left to right, keeping those `keep` lets stay:
 * the closed tabs (4), the older agents (3), the brief (2), the tabs but the
 * focused one's (1) and that one too (0), in the order the bar gives them up.
 */
function specs(state: MonitorState, input: BarInput, keep: number): Spec[] {
  const out: Spec[] = [{ kind: 'main', glyph: icon('main'), word: t('Main'), state: 'button' }];
  for (const id of MONITOR_PANES) {
    const mode = state.modes[id];
    const focused = id === state.focus && mode === 'open';
    // With no colour a tab cannot say closed; only the panes there are get one.
    if (mode === 'closed' && (keep < 4 || palette().name === 'none')) continue;
    if ((!focused && keep < 1) || keep < 0) continue;
    out.push({ kind: 'tab', pane: id, glyph: icon(id), word: names(id).tab, state: focused ? 'focused' : mode });
  }
  if (input.brief && keep >= 2) {
    const paused = Boolean(input.brief.paused);
    out.push({
      kind: 'brief',
      glyph: icon(paused ? 'resume' : 'pause'),
      word: t(paused ? 'Resume brief' : 'Pause brief'),
      state: 'button',
      accent: paused,
    });
  }
  if (input.expired && keep >= 3) {
    const shown = state.tree.showAll;
    const word = shown ? t('Hide') : `${input.expired} ${t('older')}`;
    out.push({ kind: 'older', glyph: icon(shown ? 'hide' : 'show'), word, state: 'button' });
  }
  out.push({ kind: 'settings', glyph: icon('settings'), word: t('Settings'), state: 'button' });
  out.push({ kind: 'help', glyph: icon('help'), word: t('Help'), state: 'button' });
  return out;
}

/**
 * A chip's width at a step of `pitch` columns from one icon to the next: the
 * icon and its spill column at 2, a column of chip each side from 3 (the
 * rest of the step a gap of bar), two each side from 6.
 */
function chipSize(pitch: number): 2 | 3 | 5 {
  return pitch >= 6 ? 5 : pitch >= 3 ? 3 : 2;
}

/**
 * The icon bar: the same step from each icon to the next, the spare columns
 * half at each end; or, where every word fits, each button's icon and word
 * with an equal gap between them.
 */
function iconBar(state: MonitorState, input: BarInput, width: number): Bar {
  for (let keep = 4; keep >= -1; keep--) {
    const buttons = specs(state, input, keep);
    const n = buttons.length;
    const faces = buttons.map((b) => `${b.glyph} ${b.word}`);
    const worded = faces.reduce((sum, face) => sum + visualLength(face) + 2, 0);
    if (worded + n - 1 <= width) {
      // Every word fits: the same gap between each two, up to three columns.
      const gap = Math.min(3, Math.floor((width - worded) / Math.max(1, n - 1)));
      const chips = faces.map((face) => ` ${face} `);
      return lay(buttons, chips, width, (i) => visualLength(chips[i]) + (i < n - 1 ? gap : 0));
    }
    // The widest step from one icon to the next that fits: n chips and n − 1 gaps.
    let pitch = 0;
    for (let p = Math.floor(width / Math.max(1, n - 1)); p >= 2 && !pitch; p--) {
      if ((n - 1) * p + chipSize(p) <= width) pitch = p;
    }
    if (!pitch) continue;
    const size = chipSize(pitch);
    const side = ' '.repeat((size - 1) / 2);
    const chips = buttons.map((b) => (size === 2 ? `${b.glyph} ` : `${side}${b.glyph}${side}`));
    return lay(buttons, chips, width, (i) => (i < n - 1 ? pitch : size));
  }
  // Narrower than two buttons: the main session's alone.
  const line = theme.bar(truncateAnsi(icon('main') || '⌂', width) + ' '.repeat(Math.max(0, width - 1)));
  return { line, controls: [{ kind: 'main', x: 0, y: 0, width: Math.min(width, 2) }] };
}

/**
 * Lay the chips out: button i takes `span(i)` columns, its chip first and
 * the gap after it; what the spans leave of `width` goes half to each end.
 * A click anywhere in a button's span (the ends' columns with the first and
 * the last) is that button's.
 */
function lay(buttons: Spec[], chips: string[], width: number, span: (i: number) => number): Bar {
  const spans = buttons.map((_, i) => span(i));
  const spare = width - spans.reduce((sum, w) => sum + w, 0);
  const lead = Math.floor(spare / 2);
  const controls: MonitorControl[] = [];
  let text = ' '.repeat(lead);
  let x = lead;
  buttons.forEach((b, i) => {
    const chip = visualLength(chips[i]);
    text += paint(chips[i], b.state, b.accent) + ' '.repeat(spans[i] - chip);
    const start = i === 0 ? 0 : x;
    const end = i === buttons.length - 1 ? width : x + spans[i];
    controls.push({ kind: b.kind, ...(b.pane ? { pane: b.pane } : {}), x: start, y: 0, width: end - start });
    x += spans[i];
  });
  text += ' '.repeat(Math.max(0, width - x));
  return { line: theme.bar(text), controls };
}

/** The bar with icons off: words, given up step by step where they do not fit. */
function wordBar(state: MonitorState, input: BarInput, width: number): Bar {
  const brief = input.brief;
  const zh = language() === 'zh';
  const set = iconSet();
  const words = set === 'text';
  const attempt = (o: Step) => {
    const gap = o.gap;
    const backWord = words ? `← ${o.words >= 2 ? t('Main') : zh ? '主' : 'Main'}` : o.words >= 2 ? t('Main') : null;
    const back: Button = { text: paint(chipText(icon('main'), backWord, o.size), 'button'), kind: 'main' };
    // With no colour the tabs cannot say closed; only the panes there are get one.
    const tabs: Button[] = MONITOR_PANES.filter(
      (id) => state.modes[id] !== 'closed' || (o.closed && palette().name !== 'none')
    )
      .filter((id) => o.tabs === 'all' || (o.tabs === 'focus' && id === state.focus))
      .map((id) => {
        const word = o.tabWords ? names(id).tab : words ? names(id).short : null;
        const mode = state.modes[id];
        const chipState: ChipState = id === state.focus && mode === 'open' ? 'focused' : mode;
        return {
          text: paint(chipText(icon(id), word, o.size), chipState),
          kind: 'tab',
          pane: id,
        };
      });
    const right: Button[] = [];
    if (brief && o.brief) {
      const paused = Boolean(brief.paused);
      const wide = o.words >= 3;
      const word = paused ? t(wide ? 'Resume brief' : 'Resume') : t(wide ? 'Pause brief' : 'Pause');
      const glyph = icon(paused ? 'resume' : 'pause');
      right.push({
        text: paint(chipText(glyph, wide || words ? word : null, o.size), 'button', paused),
        kind: 'brief',
      });
    }
    if (input.expired && o.older) {
      const n = input.expired;
      const shown = state.tree.showAll;
      const wide = o.words >= 3;
      // The Unicode set's sign is the count's own: "+37", "−37".
      const unicode = set === 'unicode';
      const glyph = unicode ? `${UNICODE_ICONS[shown ? 'hide' : 'show']}${n}` : icon(shown ? 'hide' : 'show');
      const count = unicode ? '' : `+${n}`;
      const word = shown
        ? wide || words
          ? t('Hide')
          : null
        : wide
          ? unicode
            ? t('older')
            : words
              ? t('+{n} older', { n })
              : `${count} ${t('older')}`
          : count || null;
      // Bare, a Nerd Font button says it as the Unicode set does: "+37", "−37".
      const face = o.bare && !unicode && !words ? `${UNICODE_ICONS[shown ? 'hide' : 'show']}${n}` : null;
      right.push({ text: paint(chipText(face ?? glyph, face ? null : word, o.size), 'button'), kind: 'older' });
    }
    const keep = o.words >= 1 || words;
    right.push({
      text: paint(chipText(icon('settings'), keep ? t('Settings') : null, o.size), 'button'),
      kind: 'settings',
    });
    right.push({ text: paint(chipText(icon('help'), keep ? t('Help') : null, o.size), 'button'), kind: 'help' });

    const sep = ' '.repeat(gap);
    // Back stands a column apart from the tabs, which are one group.
    const leftText = back.text + (tabs.length ? ' ' + tabs.map((b) => b.text).join(sep) : '');
    const rightText = right.map((b) => b.text).join(sep);
    const room = width - visualLength(leftText) - visualLength(rightText);
    // A column of bar at least keeps the tabs and the buttons apart.
    if (room < 1) return null;
    const controls: MonitorControl[] = [];
    controls.push({ kind: 'main', x: 0, y: 0, width: visualLength(back.text) });
    let x = visualLength(back.text) + 1;
    for (const b of tabs) {
      controls.push({ kind: 'tab', pane: b.pane, x, y: 0, width: visualLength(b.text) });
      x += visualLength(b.text) + gap;
    }
    x = width - visualLength(rightText);
    for (const b of right) {
      controls.push({ kind: b.kind, x, y: 0, width: visualLength(b.text) });
      x += visualLength(b.text) + gap;
    }
    return { line: theme.bar(leftText + ' '.repeat(room) + rightText), controls };
  };
  for (const step of STEPS.slice(firstStep(width))) {
    const found = attempt(step);
    if (found) return found;
  }
  // Narrower than back and the two buttons: back alone.
  const line = theme.bar(truncateAnsi(icon('main') || '←', width) + ' '.repeat(Math.max(0, width - 1)));
  return { line, controls: [{ kind: 'main', x: 0, y: 0, width: Math.min(width, 2) }] };
}

/**
 * The panel's one control bar: its first row, on its own background. Every
 * control the panel draws is here, and nowhere else: not on the status card,
 * not on a pane's title rule.
 *
 *   ≥56 columns   ␠←␠主会话␠ ␠▦␠ ␠⎇␠ ␠±␠ ␠⌖␠ ␠⋮␠      ␠‖␠ ␠+37␠ ␠☰␠设置␠ ␠?␠帮助␠
 *   44–55         ␠←␠ ␠▦␠ ␠⎇␠ ␠±␠ ␠⌖␠ ␠⋮␠           ␠‖␠ ␠+37␠ ␠☰␠ ␠?␠
 *   36–43         ␠←␠ ␠▦␠␠⎇␠␠±␠␠⌖␠␠⋮␠             ␠‖␠␠+37␠␠☰␠␠?␠
 *   <36           ←␠ ▦␠⎇␠±␠⌖␠⋮␠                    ‖␠+37␠☰␠?␠
 *
 * Each control is a chip whose size follows the panel's width: its icon (the
 * round-3 Unicode set, or Nerd Font icons with `icons: nerd`) and its word
 * with a column of chip on each side where there is room, the icon alone
 * between those columns narrower, and the icon and the one column its
 * drawing may spill into narrowest. The icon is always in the full text
 * colour and bold, never dimmed; a tab's state is its chip: the focused pane
 * on the accent, an open one on a chip, a folded one on a chip and
 * underlined, a closed one on the bar itself. With `icons: text` (or glyphs
 * set to text) the buttons are words. No key is written anywhere on the bar;
 * the keys (the tmux prefix, then a letter) are in the help alone.
 *
 * Left: the way back to the main session, then a tab per pane. Right: the
 * brief's pause (only with a brief configured), the older agents (only when
 * the linger window put some away), settings and help. Where a width's chips
 * do not fit, the next narrower ones are tried: words go first (the tabs',
 * then the brief's and the older agents', then the main session's, settings
 * and help last), then the gaps, then the side columns; then the closed
 * panes' tabs go, then the older agents' button, then the brief's; back,
 * settings and help stay. A click anywhere on a chip is its control; a tab's
 * click is `clickTab` in monitor.ts. Pure.
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
 * The round-3 icons: one column each, and none a glyph the legend gives
 * another meaning (✓ ✗ ◈ ◎ ◷ ⌕ ≡ …). The older agents' are the sign before
 * their count.
 */
export const UNICODE_ICONS: Record<IconName, string> = {
  main: '←',
  agents: '▦',
  worktrees: '⎇',
  changes: '±',
  details: '⌖',
  timeline: '⋮',
  pause: '‖',
  resume: '▸',
  show: '+',
  hide: '−',
  settings: '☰',
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

type ChipState = 'focused' | 'open' | 'folded' | 'closed' | 'button';

/**
 * A chip painted for its state. The face is always the full text colour and
 * bold; the state is the surface: the accent for the focused tab, a chip for
 * an open one or a button, a chip and an underline for a folded tab, the bar
 * itself for a closed one. Without colour the focused tab is in brackets
 * ("[▦]") and a folded one ends in "-" ("⎇-").
 */
function paint(text: string, state: ChipState, accent = false, folded = state === 'folded'): string {
  const lead = text.match(/^ */)![0];
  const trail = text.match(/ *$/)![0];
  const face = text.slice(lead.length, text.length - trail.length);
  if (palette().name === 'none') {
    const marked = folded ? `${face}-` : face;
    // The brackets take the side columns' place; a tight chip keeps its spill column.
    if (state === 'focused') return `[${marked}]${lead ? '' : trail}`;
    return `${lead}${marked}${folded && lead ? trail.slice(1) : trail}`;
  }
  if (state === 'focused')
    return theme.tab(folded ? `${lead}\x1b[4m${theme.bold(face)}\x1b[24m${trail}` : theme.bold(text));
  const strong = theme.bold(accent ? theme.accent(face) : theme.value(face));
  const shown = folded ? `\x1b[4m${strong}\x1b[24m` : strong;
  return state === 'closed' ? `${lead}${shown}${trail}` : theme.chip(`${lead}${shown}${trail}`);
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
  { size: 'tight', tabWords: false, words: 0, gap: 0, ...ALL },
  { size: 'tight', tabWords: false, words: 0, gap: 0, ...ALL, closed: false },
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
  return width >= 56 ? 0 : width >= 44 ? 4 : width >= 36 ? 5 : 6;
}

export function controlBar(
  state: MonitorState,
  input: BarInput,
  width: number
): { line: string; controls: MonitorControl[] } {
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
      (id) => id === 'agents' || state.modes[id] !== 'closed' || (o.closed && palette().name !== 'none')
    )
      .filter((id) => o.tabs === 'all' || (o.tabs === 'focus' && id === state.focus))
      .map((id) => {
        const word = o.tabWords ? names(id).tab : words ? names(id).short : null;
        const mode = id === 'agents' ? 'open' : state.modes[id];
        const chipState: ChipState = id === state.focus ? 'focused' : mode;
        return {
          text: paint(chipText(icon(id), word, o.size), chipState, false, mode === 'folded'),
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
      right.push({ text: paint(chipText(glyph, word, o.size), 'button'), kind: 'older' });
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

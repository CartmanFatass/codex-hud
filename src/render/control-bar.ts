/**
 * The panel's one control bar: its first row, on its own background. Every
 * control the panel draws is here, and nowhere else: not on the status card,
 * not on a pane's title rule.
 *
 *   ← 主会话  ▦ ⎇ ± ⌖ ⋮        ‖ 简报 +31 已收起 设置 帮助
 *
 * Each control is a button: a word, or an icon where words do not fit, on a
 * chip a step lighter than the bar. No key is written anywhere on it; the
 * keys (the tmux prefix, then a letter) are in the help alone.
 *
 * Left: the way back to the main session, then a tab per pane: an open
 * pane's in the text colour, a closed one's dim, the focused one on a
 * lighter chip and bold, a folded one dim and underlined. Right: the brief's
 * pause (only with a brief configured), the older agents (only when the
 * linger window put some away), settings and help. Short of room the tab
 * names become icons first, then the other words (the brief's and the older
 * agents' first, the main session's name next, settings and help last), then the closed panes'
 * tabs go, then the older agents' button, then the brief's; "←", settings
 * and help stay. A tab's click is `clickTab` in monitor.ts. Pure.
 */
import type { MonitorControl, MonitorPane, MonitorState } from './monitor.js';
import { MONITOR_PANES } from './monitor.js';
import { theme, colors, visualLength, truncateAnsi } from './colors.js';
import { palette } from './palette.js';
import { t, language } from './i18n.js';

/** What the bar needs to know besides the panel's state. */
export interface BarInput {
  /** The brief, when one is configured. */
  brief?: { paused?: boolean };
  /** Agents the linger window put away; 0 hides the button. */
  expired: number;
}

/**
 * Each pane's tab: its name, and its icon where names do not fit. The icons
 * are one column wide and none is a glyph the legend gives another meaning
 * (✓ ✗ ▸ ◈ ◎ ◷ ⌕ ≡ …).
 */
const TABS: Record<MonitorPane, { en: string; zh: string; icon: string }> = {
  agents: { en: 'Agents', zh: '卡片', icon: '▦' },
  worktrees: { en: 'Trees', zh: '工作树', icon: '⎇' },
  changes: { en: 'Changes', zh: '改动', icon: '±' },
  details: { en: 'Inspect', zh: '检查器', icon: '⌖' },
  timeline: { en: 'Timeline', zh: '时间线', icon: '⋮' },
};
/** The settings button's icon: a menu, not the ≡ that is a model's glyph. */
export const SETTINGS_ICON = '☰';

interface Button {
  text: string;
  kind: MonitorControl['kind'];
  pane?: MonitorPane;
}

/** A button: its face on a chip. Without colour there is no chip to pad, only the face. */
function chip(face: string, pad: boolean): string {
  return palette().name === 'none' ? face : theme.chip(pad ? ` ${face} ` : face);
}

/**
 * One pane's tab. Without colour the paint says nothing, so the focused pane
 * is "[▦]" and a folded one "⌖-" ("[⌖-]" both); closed ones are not drawn.
 */
function tab(state: MonitorState, id: MonitorPane, names: boolean, pad: boolean): string {
  const face = names ? TABS[id][language() === 'zh' ? 'zh' : 'en'] : TABS[id].icon;
  const mode = id === 'agents' ? 'open' : state.modes[id];
  const folded = mode === 'folded';
  if (palette().name === 'none') {
    const plain = `${face}${folded ? '-' : ''}`;
    return id === state.focus ? `[${plain}]` : plain;
  }
  const text = pad ? ` ${face} ` : face;
  if (id === state.focus) {
    const bold = theme.bold(theme.value(text));
    return theme.tab(folded ? `\x1b[4m${bold}\x1b[24m` : bold);
  }
  if (folded) return theme.chip(`\x1b[4m${colors.dim(text)}\x1b[24m`);
  // Dim, not the meter's track colour: that is a step off the chip and would vanish on it.
  return theme.chip(mode === 'closed' ? colors.dim(text) : theme.value(text));
}

interface Step {
  /** The tabs as names rather than icons. */
  names: boolean;
  /**
   * How many of the other buttons are words rather than icons: 3 all, 2 all
   * but the brief's and the older agents', 1 settings and help only, 0 none.
   */
  words: 0 | 1 | 2 | 3;
  /** A column of chip on each side of a button's face. */
  pad: boolean;
  /** Closed panes keep their tab. */
  closed: boolean;
  older: boolean;
  brief: boolean;
  /** 'all' the tabs there are, 'focus' only the focused pane's, '' none. */
  tabs: 'all' | 'focus' | '';
}

export function controlBar(
  state: MonitorState,
  input: BarInput,
  width: number
): { line: string; controls: MonitorControl[] } {
  const brief = input.brief;
  const attempt = (o: Step) => {
    const back: Button = {
      text: chip(theme.accent('←') + (o.words >= 2 ? ` ${theme.value(t('Main'))}` : ''), o.pad),
      kind: 'main',
    };
    // With no colour the tabs cannot say closed; only the panes there are get one.
    const tabs: Button[] = MONITOR_PANES.filter(
      (id) => id === 'agents' || state.modes[id] !== 'closed' || (o.closed && palette().name !== 'none')
    )
      .filter((id) => o.tabs === 'all' || (o.tabs === 'focus' && id === state.focus))
      .map((id) => ({ text: tab(state, id, o.names, o.pad), kind: 'tab', pane: id }));
    const right: Button[] = [];
    if (brief && o.brief) {
      const icon = brief.paused ? '▸' : '‖';
      const paint = brief.paused ? theme.accent : theme.value;
      right.push({ text: chip(paint(o.words >= 3 ? `${icon} ${t('Brief')}` : icon), o.pad), kind: 'brief' });
    }
    if (input.expired && o.older) {
      const n = input.expired;
      const face = state.tree.showAll
        ? o.words >= 3
          ? t('Hide older')
          : `−${n}`
        : o.words >= 3
          ? t('+{n} older', { n })
          : `+${n}`;
      right.push({ text: chip(theme.value(face), o.pad), kind: 'older' });
    }
    right.push({ text: chip(theme.value(o.words >= 1 ? t('Settings') : SETTINGS_ICON), o.pad), kind: 'settings' });
    right.push({ text: chip(theme.value(o.words >= 1 ? t('Help') : '?'), o.pad), kind: 'help' });

    const leftText = ' ' + back.text + (tabs.length ? '  ' + tabs.map((b) => b.text).join(' ') : '');
    const rightText = right.map((b) => b.text).join(' ') + ' ';
    const room = width - visualLength(leftText) - visualLength(rightText);
    // Two columns of bar at least keep the tabs and the buttons apart.
    if (room < 2) return null;
    const controls: MonitorControl[] = [];
    controls.push({ kind: 'main', x: 0, y: 0, width: 1 + visualLength(back.text) });
    let x = 1 + visualLength(back.text) + 2;
    for (const b of tabs) {
      controls.push({ kind: 'tab', pane: b.pane, x, y: 0, width: visualLength(b.text) });
      x += visualLength(b.text) + 1;
    }
    x = width - visualLength(rightText);
    for (const b of right) {
      controls.push({ kind: b.kind, x, y: 0, width: visualLength(b.text) });
      x += visualLength(b.text) + 1;
    }
    return { line: theme.bar(leftText + ' '.repeat(room) + rightText), controls };
  };
  const all = { closed: true, older: true, brief: true, tabs: 'all' } as const;
  const steps: Step[] = [
    { names: true, words: 3, pad: true, ...all },
    { names: true, words: 3, pad: false, ...all },
    { names: false, words: 3, pad: false, ...all },
    { names: false, words: 2, pad: false, ...all },
    { names: false, words: 1, pad: false, ...all },
    { names: false, words: 0, pad: false, ...all },
    { names: false, words: 0, pad: false, ...all, closed: false },
    { names: false, words: 0, pad: false, ...all, closed: false, older: false },
    { names: false, words: 0, pad: false, ...all, closed: false, older: false, brief: false },
    { names: false, words: 0, pad: false, closed: false, older: false, brief: false, tabs: 'focus' },
    { names: false, words: 0, pad: false, closed: false, older: false, brief: false, tabs: '' },
  ];
  for (const step of steps) {
    const found = attempt(step);
    if (found) return found;
  }
  // Narrower than the arrow and the two buttons: the arrow alone.
  const line = theme.bar(truncateAnsi(' ' + theme.accent('←'), width) + ' '.repeat(Math.max(0, width - 2)));
  return { line, controls: [{ kind: 'main', x: 0, y: 0, width: Math.min(width, 2) }] };
}

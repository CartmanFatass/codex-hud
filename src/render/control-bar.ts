/**
 * The panel's one control bar: its first row, on its own background. Every
 * control the panel draws is here, and nowhere else: not on the status card,
 * not on a pane's title rule.
 *
 *    主会话  󰚩 卡片  工作树  改动  详情  时间线    暂停简报  +37 已收起  设置  帮助
 *
 * Each control is a button on a chip a step lighter than the bar: a Nerd
 * Font icon and its word where they fit, the icon alone where they do not
 * (`icons: text`, or glyphs set to text: the words alone, shortened). No key
 * is written anywhere on it; the keys (the tmux prefix, then a letter) are in
 * the help alone.
 *
 * Left: the way back to the main session, then a tab per pane, named as the
 * pane's title names it: an open pane's in the text colour, a closed one's
 * dim, the focused one on a lighter chip and bold, a folded one dim and
 * underlined. Right: the brief's pause (only with a brief configured), the
 * older agents (only when the linger window put some away), settings and
 * help. Short of room the tabs lose their words first, then the closed panes'
 * tabs go, then the other buttons lose theirs (the brief's and the older
 * agents' first, the main session's next, settings and help last), then the
 * older agents' button goes, then the brief's; back, settings and help stay.
 * A tab's click is `clickTab` in monitor.ts. Pure.
 */
import type { MonitorControl, MonitorPane, MonitorState } from './monitor.js';
import { MONITOR_PANES } from './monitor.js';
import { theme, colors, visualLength, truncateAnsi } from './colors.js';
import { palette } from './palette.js';
import { nerdIcons } from './hud-config.js';
import { t, language } from './i18n.js';

/** What the bar needs to know besides the panel's state. */
export interface BarInput {
  /** The brief, when one is configured. */
  brief?: { paused?: boolean };
  /** Agents the linger window put away; 0 hides the button. */
  expired: number;
}

/**
 * The Nerd Font icons the bar and the pane titles use, mostly Font Awesome's
 * solid set for one look. Each takes one cell but draws wider, so one is
 * always followed by a space or its word. The robot is a Material Design
 * icon past the BMP: a surrogate pair in a JS string.
 */
export const ICONS = {
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
} as const;

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

/** A pane's title, as its frame and its tab name it: its icon first when icons are on. */
export function paneTitle(id: MonitorPane): string {
  return nerdIcons() ? `${ICONS[id]} ${names(id).title}` : names(id).title;
}

/**
 * A button's face: the icon and its word, the icon alone (and the space its
 * drawing spills into), or without icons the word alone.
 */
function face(icon: string, word: string | null, pad: boolean): string {
  const text = nerdIcons() ? (word ? `${icon} ${word}` : `${icon} `) : (word ?? '');
  // Padded, the icon alone already has its space after it. Without colour there is no chip to pad.
  return pad && palette().name !== 'none' ? ` ${text.endsWith(' ') ? text.slice(0, -1) : text} ` : text;
}

interface Button {
  text: string;
  kind: MonitorControl['kind'];
  pane?: MonitorPane;
}

/** A button: its face on a chip. Without colour there is no chip, only the face. */
function chip(text: string): string {
  return palette().name === 'none' ? text : theme.chip(text);
}

/**
 * One pane's tab. Without colour the paint says nothing, so the focused pane
 * is "[ 卡片]" and a folded one " 工作树-" ("[ 工作树-]" both); closed ones
 * are not drawn.
 */
function tab(state: MonitorState, id: MonitorPane, words: boolean, pad: boolean): string {
  const name = names(id);
  const text = face(ICONS[id], words ? name.tab : nerdIcons() ? null : name.short, pad);
  const mode = id === 'agents' ? 'open' : state.modes[id];
  const folded = mode === 'folded';
  if (palette().name === 'none') {
    const plain = `${text}${folded ? '-' : ''}`;
    return id === state.focus ? `[${plain}]` : plain;
  }
  if (id === state.focus) {
    const bold = theme.bold(theme.value(text));
    return theme.tab(folded ? `\x1b[4m${bold}\x1b[24m` : bold);
  }
  if (folded) return theme.chip(`\x1b[4m${colors.dim(text)}\x1b[24m`);
  // Dim, not the meter's track colour: that is a step off the chip and would vanish on it.
  return theme.chip(mode === 'closed' ? colors.dim(text) : theme.value(text));
}

interface Step {
  /** The tabs keep their words. */
  tabWords: boolean;
  /**
   * How many of the other buttons keep their words: 3 all, 2 all but the
   * brief's and the older agents', 1 settings and help only, 0 none. Without
   * icons settings and help are words at every step.
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
  const zh = language() === 'zh';
  const icons = nerdIcons();
  const attempt = (o: Step) => {
    const backWord = icons ? (o.words >= 2 ? t('Main') : null) : `← ${o.words >= 2 ? t('Main') : zh ? '主' : 'Main'}`;
    const back: Button = { text: chip(theme.value(face(ICONS.main, backWord, o.pad))), kind: 'main' };
    // With no colour the tabs cannot say closed; only the panes there are get one.
    const tabs: Button[] = MONITOR_PANES.filter(
      (id) => id === 'agents' || state.modes[id] !== 'closed' || (o.closed && palette().name !== 'none')
    )
      .filter((id) => o.tabs === 'all' || (o.tabs === 'focus' && id === state.focus))
      .map((id) => ({ text: tab(state, id, o.tabWords, o.pad), kind: 'tab', pane: id }));
    const right: Button[] = [];
    if (brief && o.brief) {
      const paused = Boolean(brief.paused);
      const wide = o.words >= 3;
      const word = paused ? t(wide ? 'Resume brief' : 'Resume') : t(wide ? 'Pause brief' : 'Pause');
      const paint = paused ? theme.accent : theme.value;
      right.push({
        text: chip(paint(face(paused ? ICONS.resume : ICONS.pause, wide || !icons ? word : null, o.pad))),
        kind: 'brief',
      });
    }
    if (input.expired && o.older) {
      const n = input.expired;
      const shown = state.tree.showAll;
      const wide = o.words >= 3;
      const word = shown ? (wide || !icons ? t('Hide') : null) : wide ? t('+{n} older', { n }) : `+${n}`;
      right.push({ text: chip(theme.value(face(shown ? ICONS.hide : ICONS.show, word, o.pad))), kind: 'older' });
    }
    const keep = o.words >= 1 || !icons;
    right.push({ text: chip(theme.value(face(ICONS.settings, keep ? t('Settings') : null, o.pad))), kind: 'settings' });
    right.push({ text: chip(theme.value(face(ICONS.help, keep ? t('Help') : null, o.pad))), kind: 'help' });

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
  const bare = { tabWords: false, words: 0, pad: false } as const;
  const steps: Step[] = [
    { tabWords: true, words: 3, pad: true, ...all },
    { tabWords: true, words: 3, pad: false, ...all },
    { tabWords: false, words: 3, pad: false, ...all },
    { tabWords: false, words: 3, pad: false, ...all, closed: false },
    { tabWords: false, words: 2, pad: false, ...all, closed: false },
    { tabWords: false, words: 1, pad: false, ...all, closed: false },
    { ...bare, ...all, closed: false },
    { ...bare, ...all, closed: false, older: false },
    { ...bare, ...all, closed: false, older: false, brief: false },
    { ...bare, closed: false, older: false, brief: false, tabs: 'focus' },
    { ...bare, closed: false, older: false, brief: false, tabs: '' },
  ];
  for (const step of steps) {
    // Fewer tabs may have room for their words again.
    const found = (!step.tabWords && step.tabs && attempt({ ...step, tabWords: true })) || attempt(step);
    if (found) return found;
  }
  // Narrower than back and the two buttons: back alone.
  const arrow = icons ? ICONS.main : '←';
  const line = theme.bar(truncateAnsi(' ' + theme.accent(arrow), width) + ' '.repeat(Math.max(0, width - 2)));
  return { line, controls: [{ kind: 'main', x: 0, y: 0, width: Math.min(width, 2) }] };
}

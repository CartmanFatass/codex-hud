/**
 * The panel's one control bar: its first row, on its own background. Every
 * control the panel draws is here, and nowhere else: not on the status card,
 * not on a pane's title rule.
 *
 *   ← 主会话  1 2 3 4 5        b‖  a+31  ,设置  ?
 *
 * Left: the way back to the main session, then a tab per pane: an open
 * pane's number in the text colour, a closed one's dim, the focused one on
 * a lighter surface, a folded one dim and underlined. Right: each switch as
 * its key, dim, and a short label: the brief's pause (only with a brief
 * configured), the older agents (only when the linger window put some
 * away), settings and help. Short of room the words go first (",设置"
 * becomes ","), then the closed panes' tabs, then the older agents' switch,
 * then the main session's name; "←", "," and "?" stay. A tab's click is
 * `clickTab` in monitor.ts. Pure.
 */
import type { MonitorControl, MonitorPane, MonitorState } from './monitor.js';
import { MONITOR_PANES, iconic } from './monitor.js';
import { theme, colors, visualLength, truncateAnsi } from './colors.js';
import { palette } from './palette.js';
import { t } from './i18n.js';

/** What the bar needs to know besides the panel's state. */
export interface BarInput {
  /** The brief, when one is configured. */
  brief?: { paused?: boolean };
  /** Agents the linger window put away; 0 hides the switch. */
  expired: number;
}

interface Segment {
  text: string;
  kind?: MonitorControl['kind'];
  pane?: MonitorPane;
}

/** A switch: its key dim, its label in the text colour (or `paint`). */
function key(k: string, label: string, paint: (s: string) => string = theme.value): string {
  return colors.dim(k) + (label ? paint(label) : '');
}

/**
 * One pane's tab, its state in its paint. Without colour the paint says
 * nothing, so the focused pane is "[4]" and a folded one "4-" ("[4-]"
 * both); closed ones are not drawn there at all.
 */
function tab(state: MonitorState, id: MonitorPane, index: number): string {
  const n = String(index + 1);
  const plain = palette().name === 'none';
  const mode = id === 'agents' ? 'open' : state.modes[id];
  const folded = mode === 'folded';
  if (id === state.focus) {
    if (plain) return `[${n}${folded ? '-' : ''}]`;
    const face = theme.bold(theme.value(n));
    return theme.tab(folded ? `\x1b[4m${face}\x1b[24m` : face);
  }
  if (folded) return plain ? `${n}-` : `\x1b[4m${colors.dim(n)}\x1b[24m`;
  return mode === 'closed' ? theme.track(n) : theme.value(n);
}

export function controlBar(
  state: MonitorState,
  input: BarInput,
  width: number
): { line: string; controls: MonitorControl[] } {
  const brief = input.brief;
  const words = !iconic();
  const attempt = (o: {
    labels: boolean;
    closed: boolean;
    older: boolean;
    sep: number;
    name: '' | 'Main session' | 'Main';
    pause: boolean;
    /** 'all' the tabs there are, 'focus' only the focused pane's, '' none. */
    tabs?: 'all' | 'focus' | '';
  }) => {
    const left: Segment[] = [{ text: theme.accent('←') + (o.name ? ` ${theme.value(t(o.name))}` : ''), kind: 'main' }];
    // With no colour the tabs cannot say closed; only the panes there are get one.
    const shown = MONITOR_PANES.map((id, i) => ({ id, i }))
      .filter(({ id }) => id === 'agents' || state.modes[id] !== 'closed' || (o.closed && palette().name !== 'none'))
      .filter(({ id }) => (o.tabs ?? 'all') === 'all' || (o.tabs === 'focus' && id === state.focus));
    const tabs: Segment[] = shown.map(({ id, i }) => ({ text: tab(state, id, i), kind: 'tab', pane: id }));
    const right: Segment[] = [];
    if (brief && o.pause) {
      const label = words ? (o.labels ? ` ${t(brief.paused ? 'resume' : 'pause')}` : '') : brief.paused ? '▸' : '‖';
      right.push({ text: key('b', label, brief.paused ? theme.accent : theme.value), kind: 'brief' });
    }
    if (input.expired && o.older) {
      const n = input.expired;
      const label = words
        ? o.labels
          ? ` ${t(state.tree.showAll ? 'hide {n}' : '+{n} older', { n })}`
          : ''
        : state.tree.showAll
          ? `−${n}`
          : `+${n}`;
      right.push({ text: key('a', label), kind: 'older' });
    }
    right.push({ text: key(',', o.labels ? t('Settings') : ''), kind: 'settings' });
    right.push({ text: key('?', ''), kind: 'help' });
    const gap = ' '.repeat(o.sep);
    const leftText = ' ' + left[0].text + (tabs.length ? '  ' + tabs.map((s) => s.text).join(' ') : '');
    const rightText = right.map((s) => s.text).join(gap) + ' ';
    const room = width - visualLength(leftText) - visualLength(rightText);
    // Two blank columns at least keep the tabs and the switches apart.
    if (room < 2) return null;
    const controls: MonitorControl[] = [];
    let x = 1;
    controls.push({ kind: 'main', x: 0, y: 0, width: x + visualLength(left[0].text) });
    x += visualLength(left[0].text) + 2;
    for (const s of tabs) {
      controls.push({ kind: 'tab', pane: s.pane, x, y: 0, width: visualLength(s.text) });
      x += visualLength(s.text) + 1;
    }
    x = width - visualLength(rightText);
    for (const s of right) {
      controls.push({ kind: s.kind!, x, y: 0, width: visualLength(s.text) });
      x += visualLength(s.text) + o.sep;
    }
    return { line: theme.bar(leftText + ' '.repeat(room) + rightText), controls };
  };
  const steps: Parameters<typeof attempt>[0][] = [
    { labels: true, closed: true, older: true, sep: 2, name: 'Main session', pause: true },
    { labels: false, closed: true, older: true, sep: 2, name: 'Main session', pause: true },
    { labels: false, closed: false, older: true, sep: 2, name: 'Main session', pause: true },
    { labels: false, closed: false, older: false, sep: 2, name: 'Main session', pause: true },
    { labels: false, closed: false, older: false, sep: 1, name: 'Main session', pause: true },
    { labels: false, closed: false, older: false, sep: 1, name: 'Main', pause: true },
    { labels: false, closed: false, older: false, sep: 1, name: '', pause: true },
    { labels: false, closed: false, older: false, sep: 1, name: '', pause: false },
    { labels: false, closed: false, older: false, sep: 1, name: '', pause: false, tabs: 'focus' },
    { labels: false, closed: false, older: false, sep: 1, name: '', pause: false, tabs: '' },
  ];
  for (const step of steps) {
    const found = attempt(step);
    if (found) return found;
  }
  // Narrower than the arrow and the two keys: the arrow alone.
  const line = theme.bar(truncateAnsi(' ' + theme.accent('←'), width) + ' '.repeat(Math.max(0, width - 2)));
  return { line, controls: [{ kind: 'main', x: 0, y: 0, width: Math.min(width, 2) }] };
}

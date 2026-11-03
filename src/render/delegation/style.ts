/**
 * Colour roles and the word table for the delegation view (design §5.2, §5.5).
 *
 * Roles name a meaning; `theme.*` decides the colour, so a palette swap
 * repaints the view like every other panel. Words are English keys: the panel
 * and the statusline pass them through `t()`, the bar says them as written
 * (the bar is English-only, `plainSay`).
 */

import { colors, theme } from '../colors.js';
import { t } from '../i18n.js';
import { palette } from '../palette.js';

export type Role = 'alert' | 'warning' | 'danger' | 'info' | 'success' | 'muted' | 'text' | 'strong';

/** Turns a word key into the reader's language. */
export type Say = (word: string, vars?: Record<string, string | number>) => string;

export const plainSay: Say = (word, vars) =>
  vars ? word.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : word;
export const panelSay: Say = t;

/**
 * `⚑` is the "alert" role. §5.2 asks for it to share its source with the bar's alert badge, and that badge is
 * the danger hue in every palette (there is no foreground alert colour), so the row marker is the danger hue
 * in bold. The red family therefore has two meanings: act (`⚑`, bold) and failed (`!`, regular weight), and
 * yellow stays with `⚠ ? ■` (rulings B10b s1, Q1).
 */
export function paint(role: Role, text: string): string {
  switch (role) {
    case 'alert':
      return colors.bold(theme.error(text));
    case 'warning':
      return theme.warning(text);
    case 'danger':
      return theme.error(text);
    case 'info':
      return theme.info(text);
    case 'success':
      return theme.success(text);
    case 'muted':
      return theme.dim(text);
    case 'strong':
      return colors.bold(theme.strong(text));
    default:
      return theme.value(text);
  }
}

/**
 * The same roles on the selected row's band (§5.2 "选中行"): every span goes through the palette's
 * `onSelectedBand` family, calibrated for that surface, and nothing on the band is drawn with a plain `theme.*`.
 * `alert` is the danger hue in bold and `strong` is the text colour in bold, as on the plain row.
 */
export function paintOnSelectedBand(role: Role, text: string): string {
  const ink = palette().onSelectedBand;
  switch (role) {
    case 'alert':
      return colors.bold(ink.danger(text));
    case 'warning':
      return ink.warning(text);
    case 'danger':
      return ink.danger(text);
    case 'info':
      return ink.info(text);
    case 'success':
      return ink.success(text);
    case 'muted':
      return ink.muted(text);
    case 'strong':
      return colors.bold(ink.text(text));
    default:
      return ink.text(text);
  }
}

/**
 * Whether the palette has a selection surface. `none` has no colour at all and `terminal` has no surface of its
 * own to calibrate a foreground against (its band is a fixed grey that is not the user's theme), so a selected
 * row there is the `›` and a bold name and nothing else (§5.2 "选中行").
 */
export function hasSelectionBand(): boolean {
  const name = palette().name;
  return name !== 'none' && name !== 'terminal';
}

/** The English words of §3.3 and §5.5 in one place, so a typo cannot fork the bar from the panel. */
export const W = {
  approval: 'approval',
  question: 'question',
  needsHuman: 'needs human',
  blocked: 'blocked',
  stopInPane: 'stop in pane',
  closePane: 'close pane',
  conflict: 'conflict',
  supervisorLost: 'supervisor lost',
  uncertain: 'uncertain',
  failed: 'failed',
  launchFailed: 'launch failed',
  interrupted: 'interrupted',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  stale: 'stale',
  unknown: 'unknown',
  starting: 'starting',
  notLoaded: 'not loaded',
  exited: 'exited',
  ended: 'ended',
  reported: 'reported',
  idle: 'idle',
  runtimeLimit: 'runtime limit',
  idleLimit: 'idle limit',
  blockedLimit: 'blocked limit',
  parentGone: 'parent gone',
  slots: 'slots',
  toClose: 'to close',
  toReconcile: 'to reconcile',
  main: 'main',
  pane: 'pane',
  stillRunning: 'still running',
  stopInItsPane: 'stop in its pane',
  closeItsPane: 'close its pane',
  noReport: 'no report',
  ago: '{age} ago',
  done: 'done',
} as const;

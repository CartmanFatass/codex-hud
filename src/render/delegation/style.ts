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

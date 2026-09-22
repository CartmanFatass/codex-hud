/**
 * Colour palettes.
 *
 * Components ask for meaning ("this is a warning"), never for a colour, so a
 * palette swap repaints the whole HUD consistently. `terminal` keeps the
 * original basic-ANSI look and inherits whatever the user's terminal theme
 * maps those codes to; the Catppuccin palettes pin exact colours; `none`
 * emits no escape sequences at all.
 */

import { displayConfig, type ThemeName } from './hud-config.js';

export type Paint = (text: string) => string;

export interface Palette {
  name: ThemeName;
  /** Ordinary text. */
  text: Paint;
  /** Labels, separators, anything that should recede. */
  muted: Paint;
  /** The one colour normal activity is allowed to use. */
  accent: Paint;
  success: Paint;
  warning: Paint;
  danger: Paint;
  info: Paint;
  model: Paint;
  branch: Paint;
  project: Paint;
  /** Emphasis without colour, for the identity of the session. */
  strong: Paint;
  selected: Paint;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

function basic(code: number): Paint {
  return (text: string) => `${ESC}${code}m${text}${RESET}`;
}

function rgb(hex: string): Paint {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (text: string) => `${ESC}38;2;${r};${g};${b}m${text}${RESET}`;
}

// Internal spans reset their own attributes. Restore the row highlight after
// each reset, so coloured status/model symbols don't punch holes in selection.
function highlight(code: string): Paint {
  const start = `${ESC}${code}m`;
  return text => start + text.replaceAll(RESET, RESET + start) + RESET;
}

const identity: Paint = (text: string) => text;

/**
 * The original look: basic ANSI codes, so the colours follow whatever the
 * user's terminal theme already defines.
 */
const TERMINAL: Palette = {
  name: 'terminal',
  text: basic(39), // Terminal foreground remains legible on light and dark themes.
  muted: basic(2),
  accent: basic(96),
  success: basic(32),
  warning: basic(33),
  danger: basic(31),
  info: basic(36),
  model: basic(96),
  branch: basic(35),
  // Identity, not a category: the project name is emphasis without a hue of
  // its own, which leaves the accent free to mean one thing.
  project: basic(1),
  strong: basic(1),
  selected: highlight('7'),
};

// Catppuccin Mocha and Latte, from the published palettes.
const MOCHA: Palette = {
  name: 'mocha',
  text: rgb('#CDD6F4'),
  muted: rgb('#9399B2'),
  accent: rgb('#89B4FA'),
  success: rgb('#A6E3A1'),
  warning: rgb('#F9E2AF'),
  danger: rgb('#F38BA8'),
  info: rgb('#89DCEB'),
  model: rgb('#CBA6F7'),
  branch: rgb('#F5C2E7'),
  project: rgb('#B4BEFE'),
  strong: rgb('#B4BEFE'),
  selected: highlight('48;2;49;50;68'),
};

const LATTE: Palette = {
  name: 'latte',
  text: rgb('#4C4F69'),
  muted: rgb('#6C6F85'),
  accent: rgb('#1E66F5'),
  success: rgb('#40A02B'),
  warning: rgb('#DF8E1D'),
  danger: rgb('#D20F39'),
  info: rgb('#04A5E5'),
  model: rgb('#8839EF'),
  branch: rgb('#EA76CB'),
  project: rgb('#7287FD'),
  strong: rgb('#7287FD'),
  selected: highlight('48;2;204;208;218'),
};

const NONE: Palette = {
  name: 'none',
  text: identity,
  muted: identity,
  accent: identity,
  success: identity,
  warning: identity,
  danger: identity,
  info: identity,
  model: identity,
  branch: identity,
  project: identity,
  strong: identity,
  selected: identity,
};

const PALETTES: Record<ThemeName, Palette> = {
  terminal: TERMINAL,
  mocha: MOCHA,
  latte: LATTE,
  none: NONE,
};

export function palette(): Palette {
  return PALETTES[displayConfig().theme] ?? TERMINAL;
}

export function paletteNames(): ThemeName[] {
  return Object.keys(PALETTES) as ThemeName[];
}

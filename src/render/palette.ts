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
  /**
   * Six colours to tell agents apart by, each agent keeping its own (a hash
   * of its id), for following one down the timeline. None is a success,
   * warning or error hue, so an agent's colour never reads as its state.
   */
  agents: readonly Paint[];
  /**
   * Backgrounds, each one a row's surface rather than its text: the status
   * card's band row, the control bar at the top, the selected agent's row,
   * a button on the bar (`chip`) and the focused tab, a step lighter still.
   * They restore themselves after every reset inside, so coloured spans keep
   * the surface.
   */
  band: Paint;
  bar: Paint;
  selectedBand: Paint;
  chip: Paint;
  tab: Paint;
  /**
   * A meter's unfilled part, clearly darker than the frame's rules so the
   * fill reads against it, and its scale (the window size, the reset) and
   * threshold tick.
   */
  track: Paint;
  tick: Paint;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

function basic(code: number): Paint {
  return (text: string) => `${ESC}${code}m${text}${RESET}`;
}

function ansi256(code: number): Paint {
  return (text: string) => `${ESC}38;5;${code}m${text}${RESET}`;
}

function hexParts(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function rgb(hex: string): Paint {
  const [r, g, b] = hexParts(hex);
  return (text: string) => `${ESC}38;2;${r};${g};${b}m${text}${RESET}`;
}

// Internal spans reset their own attributes. Restore the row highlight after
// each reset, so coloured status/model symbols don't punch holes in selection.
function highlight(code: string): Paint {
  const start = `${ESC}${code}m`;
  return text => start + text.replaceAll(RESET, RESET + start) + RESET;
}

/** A background in exact colour, kept across the resets inside it. */
function surface(hex: string): Paint {
  return highlight(`48;2;${hexParts(hex).join(';')}`);
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
  // Mid-tones of the 256-colour cube, legible on dark and light backgrounds.
  agents: [ansi256(33), ansi256(98), ansi256(133), ansi256(67), ansi256(37), ansi256(175)],
  // Greys of the 256-colour ramp, a step apart: the band, the bar above it,
  // the selected row, a button on the bar and the focused tab each one
  // lighter than the last.
  band: highlight('48;5;235'),
  bar: highlight('48;5;236'),
  selectedBand: highlight('48;5;237'),
  chip: highlight('48;5;238'),
  tab: highlight('48;5;240'),
  track: ansi256(239),
  // Steel blue: a scale, not a state, so neither the info blue nor a grey.
  tick: ansi256(67),
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
  agents: ['#89B4FA', '#B4BEFE', '#CBA6F7', '#F5C2E7', '#74C7EC', '#F2CDCD'].map(rgb),
  // Mantle under the band, the surfaces above the base for the rest.
  band: surface('#181825'),
  bar: surface('#313244'),
  selectedBand: surface('#45475A'),
  chip: surface('#45475A'),
  tab: surface('#585B70'),
  track: rgb('#585B70'),
  tick: rgb('#89B4FA'),
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
  agents: ['#1E66F5', '#7287FD', '#8839EF', '#EA76CB', '#209FB5', '#DD7878'].map(rgb),
  // A light theme: the band is a light surface a step off the base, and the
  // track is lighter than the muted text rather than darker, which on a
  // light ground is what recedes.
  band: surface('#E6E9EF'),
  bar: surface('#DCE0E8'),
  selectedBand: surface('#CCD0DA'),
  chip: surface('#CCD0DA'),
  tab: surface('#ACB0BE'),
  track: rgb('#BCC0CC'),
  tick: rgb('#209FB5'),
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
  agents: [identity],
  band: identity,
  bar: identity,
  selectedBand: identity,
  chip: identity,
  tab: identity,
  track: identity,
  tick: identity,
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

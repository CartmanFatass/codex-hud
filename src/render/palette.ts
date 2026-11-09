/**
 * Colour palettes.
 *
 * Components ask for meaning ("this is a warning"), never for a colour, so a
 * palette swap repaints the whole HUD consistently. `terminal` keeps the
 * original basic-ANSI look and inherits whatever the user's terminal theme
 * maps those codes to; the Catppuccin palettes and omp's titanium pin exact
 * colours; `none` emits no escape sequences at all.
 */

import { displayConfig, type ThemeName } from './hud-config.js';

export type Paint = (text: string) => string;

/**
 * The roles a worker runs as. Each one has its own ink, so a role word (and the card bracket beside it) says who is
 * working without a badge or a second column (concept §15, 2026-11-09 "model roles").
 */
export type WorkRole = 'imp' | 'reviewer' | 'sonic' | 'oracle' | 'jev';

export type RoleInk = Record<WorkRole, Paint>;

/**
 * The ink calibrated for `selectedBand` (the selected row's surface): text >= 4.5:1 against it, muted >= 3:1 and
 * >= 1.5:1 from text, every hue >= 3:1 with its hue and saturation kept (lightness is all that moves). A role
 * that already meets its floor is the plain role itself; only a failing one is a constant of its own.
 */
export interface OnSelectedBand {
  text: Paint;
  muted: Paint;
  accent: Paint;
  success: Paint;
  warning: Paint;
  danger: Paint;
  info: Paint;
  model: Paint;
  roleInk: RoleInk;
}

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
  /**
   * One ink per work role, on the role word only: imp, reviewer, sonic, oracle and Jev. None is a status colour, so a
   * role never reads as its state.
   */
  roleInk: RoleInk;
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
   * Eight colours for the research directions: an L1 agent and everything
   * under it, on the timeline and the cards. Neighbours far apart on the
   * wheel, so two directions at work together are told apart; none a
   * status colour.
   */
  directions: readonly Paint[];
  /**
   * Backgrounds, each one a row's surface rather than its text: the status
   * card's band row, the control bar at the top, the selected agent's row,
   * a button on the bar (`chip`), and the focused tab on the accent, its
   * text in a colour that reads on it.
   * They restore themselves after every reset inside, so coloured spans keep
   * the surface.
   */
  band: Paint;
  bar: Paint;
  selectedBand: Paint;
  chip: Paint;
  tab: Paint;
  /** The bar's alert badge: dark bold text on the danger colour, for what needs the person now. */
  alert: Paint;
  /**
   * A meter's unfilled part, clearly darker than the frame's rules so the
   * fill reads against it, and its scale (the window size, the reset) and
   * threshold tick.
   */
  track: Paint;
  tick: Paint;
  /** The rules of a look's frame and title lines: quieter than muted text, louder than the track. */
  frame: Paint;
  /**
   * Text in the colour of the focused tab's surface and of a chip's, for a
   * pill's rounded ends: the caps are glyphs, painted as text beside the
   * surface they round off.
   */
  tabEdge: Paint;
  chipEdge: Paint;
  /**
   * What the selected row's text, marks and badges are painted with, calibrated against `selectedBand`. A palette
   * with no band (`none`, `terminal`) has the plain roles here and never draws it (design §5.2 "选中行").
   */
  onSelectedBand: OnSelectedBand;
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

/** Bold, in an exact colour: emphasis that keeps its hue. */
function rgbBold(hex: string): Paint {
  const [r, g, b] = hexParts(hex);
  return (text: string) => `${ESC}1;38;2;${r};${g};${b}m${text}${RESET}`;
}

// Internal spans reset their own attributes. Restore the row highlight after
// each reset, so coloured status/model symbols don't punch holes in selection.
function highlight(code: string): Paint {
  const start = `${ESC}${code}m`;
  return (text) => start + text.replaceAll(RESET, RESET + start) + RESET;
}

/** A background in exact colour, kept across the resets inside it. */
function surface(hex: string): Paint {
  return highlight(`48;2;${hexParts(hex).join(';')}`);
}

const identity: Paint = (text: string) => text;

/**
 * A palette with its `onSelectedBand` family: each role is the palette's plain role unless `calibrated` names a
 * constant for it, so the family cannot drift from the roles it aliases.
 */
function withSelectedInk(roles: Omit<Palette, 'onSelectedBand'>, calibrated: Partial<OnSelectedBand> = {}): Palette {
  return {
    ...roles,
    onSelectedBand: {
      text: roles.text,
      muted: roles.muted,
      accent: roles.accent,
      success: roles.success,
      warning: roles.warning,
      danger: roles.danger,
      info: roles.info,
      model: roles.model,
      roleInk: roles.roleInk,
      ...calibrated,
    },
  };
}

/**
 * The original look: basic ANSI codes, so the colours follow whatever the
 * user's terminal theme already defines.
 */
const TERMINAL: Palette = withSelectedInk({
  name: 'terminal',
  text: basic(39), // Terminal foreground remains legible on light and dark themes.
  muted: basic(2),
  accent: basic(96),
  success: basic(32),
  warning: basic(33),
  danger: basic(31),
  info: basic(36),
  model: basic(96),
  // Mid-tones of the 256-colour cube, legible on dark and light backgrounds.
  roleInk: { imp: ansi256(81), reviewer: ansi256(170), sonic: ansi256(209), oracle: ansi256(141), jev: ansi256(79) },
  branch: basic(35),
  // Identity, not a category: the project name is emphasis without a hue of
  // its own, which leaves the accent free to mean one thing.
  project: basic(1),
  strong: basic(1),
  // A selected row in a list is on the selected card's band.
  selected: highlight('48;5;237'),
  // Mid-tones of the 256-colour cube, legible on dark and light backgrounds.
  agents: [ansi256(33), ansi256(98), ansi256(133), ansi256(67), ansi256(37), ansi256(175)],
  directions: [33, 208, 135, 179, 170, 67, 133, 75].map(ansi256),
  // Greys of the 256-colour ramp, a step apart: the band, the bar above it,
  // the selected row, a button on the bar and the focused tab each one
  // lighter than the last.
  band: highlight('48;5;235'),
  bar: highlight('48;5;236'),
  selectedBand: highlight('48;5;237'),
  chip: highlight('48;5;238'),
  tab: highlight('48;5;31;97'),
  alert: highlight('1;7;31'),
  track: ansi256(239),
  // Steel blue: a scale, not a state, so neither the info blue nor a grey.
  tick: ansi256(67),
  frame: ansi256(240),
  tabEdge: ansi256(31),
  chipEdge: ansi256(238),
});

// Catppuccin Mocha and Latte, from the published palettes.
const MOCHA: Palette = withSelectedInk({
  name: 'mocha',
  text: rgb('#CDD6F4'),
  muted: rgb('#9399B2'),
  accent: rgb('#89B4FA'),
  success: rgb('#A6E3A1'),
  warning: rgb('#F9E2AF'),
  danger: rgb('#F38BA8'),
  info: rgb('#89DCEB'),
  model: rgb('#CBA6F7'),
  roleInk: {
    imp: rgb('#4cc3ea'),
    reviewer: rgb('#e26fce'),
    sonic: rgb('#ff8f72'),
    oracle: rgb('#a99df2'),
    jev: rgb('#3fd9b0'),
  },
  branch: rgb('#F5C2E7'),
  project: rgb('#B4BEFE'),
  strong: rgb('#B4BEFE'),
  selected: highlight('48;2;49;50;68'),
  agents: ['#89B4FA', '#B4BEFE', '#CBA6F7', '#F5C2E7', '#74C7EC', '#F2CDCD'].map(rgb),
  directions: ['#89B4FA', '#CBA6F7', '#94E2D5', '#FAB387', '#B4BEFE', '#89DCEB', '#F5C2E7', '#EBA0AC'].map(rgb),
  // Mantle under the band, the surfaces above the base for the rest.
  band: surface('#181825'),
  bar: surface('#313244'),
  selectedBand: surface('#45475A'),
  chip: surface('#45475A'),
  tab: highlight('48;2;137;180;250;38;2;30;30;46'),
  alert: highlight('1;48;2;243;139;168;38;2;17;17;27'),
  track: rgb('#585B70'),
  tick: rgb('#89B4FA'),
  frame: rgb('#6C7086'),
  tabEdge: rgb('#89B4FA'),
  chipEdge: rgb('#45475A'),
});

const LATTE_ROLES: Omit<Palette, 'onSelectedBand'> = {
  name: 'latte',
  text: rgb('#4C4F69'),
  muted: rgb('#6C6F85'),
  accent: rgb('#1E66F5'),
  success: rgb('#40A02B'),
  warning: rgb('#DF8E1D'),
  danger: rgb('#D20F39'),
  info: rgb('#04A5E5'),
  model: rgb('#8839EF'),
  // The dark end of each role's family: the truecolor inks are too light to read on a light ground.
  roleInk: {
    imp: rgb('#087f9c'),
    reviewer: rgb('#a63c91'),
    sonic: rgb('#a84329'),
    oracle: rgb('#6556ae'),
    jev: rgb('#087a5d'),
  },
  branch: rgb('#EA76CB'),
  project: rgb('#7287FD'),
  strong: rgb('#7287FD'),
  selected: highlight('48;2;204;208;218'),
  agents: ['#1E66F5', '#7287FD', '#8839EF', '#EA76CB', '#209FB5', '#DD7878'].map(rgb),
  directions: ['#1E66F5', '#8839EF', '#179299', '#FE640B', '#7287FD', '#04A5E5', '#EA76CB', '#DD7878'].map(rgb),
  // A light theme: the band is a light surface a step off the base, and the
  // track is lighter than the muted text rather than darker, which on a
  // light ground is what recedes.
  band: surface('#E6E9EF'),
  bar: surface('#DCE0E8'),
  selectedBand: surface('#CCD0DA'),
  chip: surface('#CCD0DA'),
  tab: highlight('48;2;30;102;245;38;2;239;241;245'),
  alert: highlight('1;48;2;210;15;57;38;2;239;241;245'),
  track: rgb('#BCC0CC'),
  tick: rgb('#209FB5'),
  frame: rgb('#9CA0B0'),
  tabEdge: rgb('#1E66F5'),
  chipEdge: rgb('#CCD0DA'),
};

// On the latte band (#CCD0DA) these three fall under 3:1 (1.70, 2.17, 1.81). Lightness moves, hue and saturation stay.
const LATTE: Palette = withSelectedInk(LATTE_ROLES, {
  warning: rgb('#9C6414'),
  success: rgb('#337F22'),
  info: rgb('#0378A6'),
});

/**
 * omp's titanium, as omp paints its status line and settings: aluminium text
 * on dark titanium, electric blue where the attention goes, deep blue under
 * the active tab, readout green, amber and alert red for state.
 *
 * omp sets its terminal's background to brushed titanium (#151820) and sinks
 * its status line below it, in dark titanium (#0F1216). The HUD sits on the
 * terminal's own background, often near black, where that band vanishes, so
 * its surfaces rise above the usual dark backgrounds instead, as the terminal
 * palette's greys do: the band, the selected row, the selected agent's row
 * and a button on the bar, each a step lighter than the last. The track
 * stays between the band and the frame, so a meter on the band still shows.
 */
const TITANIUM: Palette = withSelectedInk({
  name: 'titanium',
  text: rgb('#E8ECF4'),
  muted: rgb('#9CA3B0'),
  accent: rgb('#00B4FF'),
  success: rgb('#00FF88'),
  warning: rgb('#FFB347'),
  danger: rgb('#FF4757'),
  info: rgb('#00B4FF'),
  model: rgb('#D4C090'),
  roleInk: {
    imp: rgb('#4cc3ea'),
    reviewer: rgb('#e26fce'),
    sonic: rgb('#ff8f72'),
    oracle: rgb('#a99df2'),
    jev: rgb('#3fd9b0'),
  },
  branch: rgb('#D06FED'),
  project: rgbBold('#E8ECF4'),
  strong: rgbBold('#E8ECF4'),
  selected: surface('#272D36'),
  agents: ['#5EC8FF', '#8FA8FF', '#B79CFF', '#D06FED', '#2AC3DE', '#D4C090'].map(rgb),
  directions: ['#5EC8FF', '#B79CFF', '#2AC3DE', '#E0A060', '#8FA8FF', '#7FE0D0', '#D06FED', '#D4C090'].map(rgb),
  band: surface('#232830'),
  bar: surface('#232830'),
  selectedBand: surface('#2E3540'),
  chip: surface('#3A424E'),
  tab: highlight('48;2;0;130;179;38;2;232;236;244'),
  alert: highlight('1;48;2;255;71;87;38;2;15;15;17'),
  track: rgb('#343B46'),
  tick: rgb('#6583A3'),
  frame: rgb('#454C59'),
  tabEdge: rgb('#0082B3'),
  chipEdge: rgb('#3A424E'),
});

const NONE: Palette = withSelectedInk({
  name: 'none',
  text: identity,
  muted: identity,
  accent: identity,
  success: identity,
  warning: identity,
  danger: identity,
  info: identity,
  model: identity,
  roleInk: { imp: identity, reviewer: identity, sonic: identity, oracle: identity, jev: identity },
  branch: identity,
  project: identity,
  strong: identity,
  selected: identity,
  agents: [identity],
  directions: [identity],
  band: identity,
  bar: identity,
  selectedBand: identity,
  chip: identity,
  tab: identity,
  alert: identity,
  track: identity,
  tick: identity,
  frame: identity,
  tabEdge: identity,
  chipEdge: identity,
});

const PALETTES: Record<ThemeName, Palette> = {
  terminal: TERMINAL,
  mocha: MOCHA,
  latte: LATTE,
  titanium: TITANIUM,
  none: NONE,
};

export function palette(): Palette {
  return PALETTES[displayConfig().theme] ?? TERMINAL;
}

/** The approved Home/Work mockup inks are local roles, not changes to global state colours. */
const boardFrom = (p: Palette) => ({
  attention: p.warning,
  danger: p.danger,
  success: p.success,
  active: p.accent,
  muted: p.muted,
  frame: p.frame,
  selected: p.selected,
  roleInk: p.roleInk,
});
const BOARD_NONE = boardFrom(NONE),
  BOARD_TERMINAL = { ...boardFrom(TERMINAL), attention: ansi256(179) },
  BOARD_LIGHT = boardFrom(LATTE);
const BOARD_DARK = {
  ...boardFrom(TITANIUM),
  attention: rgb('#efc15a'),
  danger: rgb('#f4727e'),
  success: rgb('#8fd073'),
  active: rgb('#6fa8ff'),
  muted: rgb('#6c7789'),
  frame: rgb('#363f4d'),
  selected: surface('#1c2433'),
};
export function workboardPalette(): typeof BOARD_DARK {
  const theme = displayConfig().theme;
  return theme === 'none'
    ? BOARD_NONE
    : theme === 'terminal'
      ? BOARD_TERMINAL
      : theme === 'latte'
        ? BOARD_LIGHT
        : BOARD_DARK;
}

export function paletteNames(): ThemeName[] {
  return Object.keys(PALETTES) as ThemeName[];
}

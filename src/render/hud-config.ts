/**
 * Display settings for the HUD.
 *
 * Read once at startup from the environment. Every knob has a default that
 * reproduces the previous behaviour, so an unconfigured HUD looks the way it
 * always did.
 */

import { resolveHudEnv } from '../utils/hud-env.js';

export type Density = 'focus' | 'balanced' | 'full';
export type ThemeName = 'terminal' | 'mocha' | 'latte' | 'titanium' | 'none';
export type GlyphMode = 'glyph' | 'text' | 'both';
export type MotionMode = 'full' | 'reduced';
export type ContextMode = 'used' | 'remaining';
/** The bottom bars (Claude, pi, Codex), all three at once: `│` separators (`line`) or powerline capsules (`p10k`). */
export const BAR_STYLES = ['line', 'p10k', 'gauge', 'tide', 'micro', 'stacked', 'headline', 'triptych'] as const;
export type BarStyle = (typeof BAR_STYLES)[number];
/** A coloured look cannot communicate its idiom without colour. Unknown settings keep today's look. */
export function barStyleOf(value: unknown): BarStyle {
  return BAR_STYLES.includes(value as BarStyle) ? (value as BarStyle) : 'line';
}
export function activeBarStyle(): BarStyle {
  return active.theme === 'none' ? 'line' : barStyleOf(active.barStyle);
}
/** The bar's fields in their fixed order; `loaded` is the right cluster (MCP, skills, pi's extension words). */
export const BAR_FIELDS = ['model', 'context', 'project', 'quota', 'notice', 'loaded'] as const;
export type BarField = (typeof BAR_FIELDS)[number];
/** Shown unless the settings say otherwise: all of them. */
export const DEFAULT_BAR_FIELDS: readonly BarField[] = BAR_FIELDS;
/** The panel's buttons and titles: Unicode icons, Nerd Font icons, emoji for the panes, or words alone. */
export type IconMode = 'unicode' | 'nerd' | 'emoji' | 'text';
/**
 * How the panel draws its control bar and its panes' titles, after omp: its
 * settings tab row (`tab`), its status band (`band`), emoji tiles (`tile`),
 * its rounded settings frame around the whole panel (`frame`), or pills
 * (`pill`). What the panel shows is the same in every look.
 */
export type LookName = 'tab' | 'band' | 'tile' | 'frame' | 'pill';
export const LOOKS: readonly LookName[] = ['tab', 'band', 'tile', 'frame', 'pill'];

export interface HudDisplayConfig {
  density: Density;
  theme: ThemeName;
  glyphs: GlyphMode;
  icons: IconMode;
  look: LookName;
  motion: MotionMode;
  context: ContextMode;
  barStyle: BarStyle;
  /** Which bar fields show (all by default); the order is fixed. */
  barFields: BarField[];
}

const DENSITIES: Density[] = ['focus', 'balanced', 'full'];
const THEMES: ThemeName[] = ['terminal', 'mocha', 'latte', 'titanium', 'none'];
const GLYPH_MODES: GlyphMode[] = ['glyph', 'text', 'both'];

function pick<T extends string>(raw: string | undefined, allowed: T[], fallback: T): T {
  const value = (raw ?? '').trim().toLowerCase();
  return (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/**
 * NO_COLOR is honoured as an override: a terminal that asked for no colour
 * gets none, whatever the theme says.
 */
function resolveTheme(env: NodeJS.ProcessEnv): ThemeName {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return 'none';
  }
  return pick(resolveHudEnv(env, 'HUD_THEME'), THEMES, 'terminal');
}

/** The fields named in a comma or space separated list, in their fixed order; no valid name means the default ones. */
function barFieldsOf(raw: string | undefined): BarField[] {
  const named = BAR_FIELDS.filter((field) => (raw ?? '').split(/[\s,]+/).includes(field));
  return named.length ? named : [...DEFAULT_BAR_FIELDS];
}

export function resolveDisplayConfig(env: NodeJS.ProcessEnv = process.env): HudDisplayConfig {
  return {
    density: pick(resolveHudEnv(env, 'HUD_DENSITY'), DENSITIES, 'balanced'),
    theme: resolveTheme(env),
    glyphs: pick(resolveHudEnv(env, 'HUD_GLYPHS'), GLYPH_MODES, 'both'),
    icons: pick(resolveHudEnv(env, 'HUD_ICONS'), ['unicode', 'nerd', 'emoji', 'text'], 'unicode'),
    look: pick(resolveHudEnv(env, 'HUD_LOOK'), [...LOOKS], 'tab'),
    motion: resolveHudEnv(env, 'HUD_REDUCED_MOTION') === '1' ? 'reduced' : 'full',
    context: pick(resolveHudEnv(env, 'HUD_CONTEXT'), ['used', 'remaining'], 'used'),
    barStyle: pick(resolveHudEnv(env, 'HUD_BAR_STYLE'), [...BAR_STYLES], 'line'),
    barFields: barFieldsOf(resolveHudEnv(env, 'HUD_BAR_FIELDS')),
  };
}

/**
 * The icons on the panel's buttons and titles, and whether a glyph stands in
 * for a word anywhere else (a brief field's label, "ago", the bar's activity
 * mark): the `icons` setting alone. `glyphs` is the model badge's and says
 * nothing about the rest.
 */
export function iconSet(): IconMode {
  return active.icons;
}

let active: HudDisplayConfig = resolveDisplayConfig();

export function displayConfig(): HudDisplayConfig {
  return active;
}

/** Test seam: swap the whole config, returning the previous one. */
export function setDisplayConfig(next: Partial<HudDisplayConfig>): HudDisplayConfig {
  const previous = active;
  active = { ...active, ...next };
  return previous;
}

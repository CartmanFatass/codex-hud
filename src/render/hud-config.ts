/**
 * Display settings for the HUD.
 *
 * Read once at startup from the environment. Every knob has a default that
 * reproduces the previous behaviour, so an unconfigured HUD looks the way it
 * always did.
 */

export type Density = 'focus' | 'balanced' | 'full';
export type ThemeName = 'terminal' | 'mocha' | 'latte' | 'titanium' | 'none';
export type GlyphMode = 'glyph' | 'text' | 'both';
export type MotionMode = 'full' | 'reduced';
export type ContextMode = 'used' | 'remaining';
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
  return pick(env.CODEX_HUD_THEME, THEMES, 'terminal');
}

export function resolveDisplayConfig(env: NodeJS.ProcessEnv = process.env): HudDisplayConfig {
  return {
    density: pick(env.CODEX_HUD_DENSITY, DENSITIES, 'balanced'),
    theme: resolveTheme(env),
    glyphs: pick(env.CODEX_HUD_GLYPHS, GLYPH_MODES, 'both'),
    icons: pick(env.CODEX_HUD_ICONS, ['unicode', 'nerd', 'emoji', 'text'], 'unicode'),
    look: pick(env.CODEX_HUD_LOOK, [...LOOKS], 'tab'),
    motion: env.CODEX_HUD_REDUCED_MOTION === '1' ? 'reduced' : 'full',
    context: pick(env.CODEX_HUD_CONTEXT, ['used', 'remaining'], 'used'),
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

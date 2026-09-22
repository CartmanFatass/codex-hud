/**
 * Display settings for the HUD.
 *
 * Read once at startup from the environment. Every knob has a default that
 * reproduces the previous behaviour, so an unconfigured HUD looks the way it
 * always did.
 */

export type Density = 'focus' | 'balanced' | 'full';
export type ThemeName = 'terminal' | 'mocha' | 'latte' | 'none';
export type GlyphMode = 'glyph' | 'text' | 'both';
export type MotionMode = 'full' | 'reduced';
export type ContextMode = 'used' | 'remaining';

export interface HudDisplayConfig {
  density: Density;
  theme: ThemeName;
  glyphs: GlyphMode;
  motion: MotionMode;
  context: ContextMode;
}

const DENSITIES: Density[] = ['focus', 'balanced', 'full'];
const THEMES: ThemeName[] = ['terminal', 'mocha', 'latte', 'none'];
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
    motion: env.CODEX_HUD_REDUCED_MOTION === '1' ? 'reduced' : 'full',
    context: pick(env.CODEX_HUD_CONTEXT, ['used', 'remaining'], 'used'),
  };
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

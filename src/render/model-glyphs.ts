import { colors, theme, visualLength } from './colors.js';
import { displayConfig, type GlyphMode } from './hud-config.js';

export const MODEL_GLYPHS = {
  astra: '☀',
  sol: '★',
  terra: '≡',
  luna: '☽',
  spark: '*',
} as const;

export const MODEL_LABELS = {
  astra: 'Astra',
  sol: 'Sol',
  terra: 'Terra',
  luna: 'Luna',
  spark: 'Spark',
} as const;

export const EFFORT_GLYPHS: Record<string, string> = {
  low: '○',
  medium: '◐',
  high: '◕',
  xhigh: '●',
  max: '◆',
  ultra: '✦',
};

export type ModelFamily = keyof typeof MODEL_GLYPHS;

export function classifyModelFamily(model?: string | null): ModelFamily | null {
  const slug = (model ?? '').trim().toLowerCase();
  if (!slug) {
    return null;
  }
  if (slug.includes('astra')) return 'astra';
  if (slug.includes('spark')) return 'spark';
  if (slug.includes('terra')) return 'terra';
  if (slug.includes('luna')) return 'luna';
  if (/(^|[-_.])sol($|[-_.])/.test(slug) || slug.endsWith('sol') || slug.includes('5.6-sol')) {
    return 'sol';
  }
  return null;
}

export function shortModelLabel(model?: string | null): string {
  const raw = (model ?? '').trim();
  if (!raw) {
    return '?';
  }
  return raw.replace(/^gpt-?/i, '') || raw;
}

/**
 * The badge's words: the version joined to the family, `gpt-6.1-sol` as
 * `6.1sol`. A model with no family keeps its own name, the `gpt-` prefix off.
 */
export function versionedModelLabel(model?: string | null): string {
  const raw = (model ?? '').trim();
  if (!raw) return '';
  const family = classifyModelFamily(raw);
  if (!family) return shortModelLabel(raw);
  const version =
    raw
      .toLowerCase()
      .replace(/^gpt-/, '')
      .match(/^\d+(?:\.\d+)?/)?.[0] ?? '';
  return version ? `${version}${family}` : family;
}

/**
 * The three paints a badge is made of: the family (symbol or words, and the high efforts' glyph), what recedes
 * (low efforts, `·effort` words, the words beside a symbol) and the strongest efforts. The default is the active
 * palette's own `model` / `muted` / `warning`; a row on a surface of its own passes the ink calibrated for it.
 */
export interface ModelTokenPaints {
  model: (text: string) => string;
  muted: (text: string) => string;
  warning: (text: string) => string;
}

const PLAIN_PAINTS: ModelTokenPaints = {
  model: (text) => theme.model(text),
  muted: (text) => colors.dim(text),
  warning: (text) => theme.warning(text),
};

function paintEffort(effort: string, glyph: string, paints: ModelTokenPaints): string {
  const key = effort.toLowerCase();
  if (key === 'max' || key === 'ultra') {
    return paints.warning(glyph);
  }
  if (key === 'high' || key === 'xhigh') {
    return paints.model(glyph);
  }
  return paints.muted(glyph);
}

export interface ModelTokenOptions {
  /** Override the configured glyph mode, for the narrowest layout variants. */
  mode?: GlyphMode;
  /** Override the paints (default: the active palette's plain roles). */
  paints?: ModelTokenPaints;
}

/**
 * The model/effort badge.
 *
 * `glyph` is the compact celestial symbol, `text` spells the version, family
 * and effort (`6.1sol·max`) for anyone who has not memorised the symbols, and
 * `both` shows the symbol next to those words. An unrecognised model always
 * falls back to its own name rather than being forced into a family.
 */
export function renderModelEffortToken(
  model?: string | null,
  effort?: string | null,
  options: ModelTokenOptions = {}
): string {
  const mode = options.mode ?? displayConfig().glyphs;
  const paints = options.paints ?? PLAIN_PAINTS;
  const family = classifyModelFamily(model);
  const effortKey = (effort ?? '').trim().toLowerCase();
  const effortGlyph = effortKey ? (EFFORT_GLYPHS[effortKey] ?? '') : '';

  // Unknown models have no symbol to show, so they read as text in every mode.
  const familyGlyph = family ? MODEL_GLYPHS[family] : '';
  const familyText = model ? versionedModelLabel(model) : '';

  if (mode === 'glyph' && familyGlyph) {
    const painted = paints.model(familyGlyph);
    return effortGlyph ? `${painted}${paintEffort(effortKey, effortGlyph, paints)}` : painted;
  }

  if (mode === 'text') {
    if (!familyText) {
      return '';
    }
    const painted = paints.model(familyText);
    return effortKey ? `${painted}${paints.muted('·' + effortKey)}` : painted;
  }

  // both, and the glyph-mode fallback for an unrecognised model
  const parts: string[] = [];
  if (familyGlyph) {
    parts.push(paints.model(familyGlyph) + (effortGlyph ? paintEffort(effortKey, effortGlyph, paints) : ''));
  }
  if (familyText) {
    parts.push(familyGlyph ? paints.muted(familyText) : paints.model(familyText));
  }
  if (!familyGlyph && effortKey) {
    parts.push(effortGlyph ? paintEffort(effortKey, effortGlyph, paints) : paints.muted('·' + effortKey));
  }
  return parts.join(' ');
}

/**
 * Symbol key, for help output and the tree panel footer. Users should not have
 * to learn the symbols from context.
 */
/**
 * The widest form of the badge that fits `max` columns, never a cut one: a
 * badge read as `6.1sol·…` says less than `6.1sol` and is wider than `☀◕`.
 * Text gives up the effort, then itself (no glyph where words were asked
 * for); both gives way to the glyphs; '' when nothing fits.
 */
export function fitModelEffortToken(
  model: string | undefined,
  effort: string | undefined,
  max: number,
  mode: ModelTokenOptions['mode'] = displayConfig().glyphs,
  paints?: ModelTokenPaints
): string {
  const forms = mode === 'text' ? ['text', 'text-bare'] : mode === 'glyph' ? ['glyph'] : ['both', 'glyph'];
  for (const form of forms) {
    const token =
      form === 'text-bare'
        ? renderModelEffortToken(model, undefined, { mode: 'text', paints })
        : renderModelEffortToken(model, effort, { mode: form as ModelTokenOptions['mode'], paints });
    if (token && visualLength(token) <= max) return token;
  }
  return '';
}

import { colors, theme } from './colors.js';
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
  const version = raw.toLowerCase().replace(/^gpt-/, '').match(/^\d+(?:\.\d+)?/)?.[0] ?? '';
  return version ? `${version}${family}` : family;
}

function paintEffort(effort: string, glyph: string): string {
  const key = effort.toLowerCase();
  if (key === 'max' || key === 'ultra') {
    return theme.warning(glyph);
  }
  if (key === 'high' || key === 'xhigh') {
    return theme.model(glyph);
  }
  return colors.dim(glyph);
}

export interface ModelTokenOptions {
  /** Override the configured glyph mode, for the narrowest layout variants. */
  mode?: GlyphMode;
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
  const family = classifyModelFamily(model);
  const effortKey = (effort ?? '').trim().toLowerCase();
  const effortGlyph = effortKey ? EFFORT_GLYPHS[effortKey] ?? '' : '';

  // Unknown models have no symbol to show, so they read as text in every mode.
  const familyGlyph = family ? MODEL_GLYPHS[family] : '';
  const familyText = model ? versionedModelLabel(model) : '';

  if (mode === 'glyph' && familyGlyph) {
    const painted = theme.model(familyGlyph);
    return effortGlyph ? `${painted}${paintEffort(effortKey, effortGlyph)}` : painted;
  }

  if (mode === 'text') {
    if (!familyText) {
      return '';
    }
    const painted = theme.model(familyText);
    return effortKey ? `${painted}${colors.dim('·' + effortKey)}` : painted;
  }

  // both, and the glyph-mode fallback for an unrecognised model
  const parts: string[] = [];
  if (familyGlyph) {
    parts.push(theme.model(familyGlyph) + (effortGlyph ? paintEffort(effortKey, effortGlyph) : ''));
  }
  if (familyText) {
    parts.push(familyGlyph ? colors.dim(familyText) : theme.model(familyText));
  }
  if (!familyGlyph && effortKey) {
    parts.push(effortGlyph ? paintEffort(effortKey, effortGlyph) : colors.dim('·' + effortKey));
  }
  return parts.join(' ');
}

/**
 * Symbol key, for help output and the tree panel footer. Users should not have
 * to learn the symbols from context.
 */
export function modelLegend(): string {
  const families = (Object.keys(MODEL_GLYPHS) as ModelFamily[])
    .map((family) => `${MODEL_GLYPHS[family]} ${MODEL_LABELS[family]}`)
    .join('  ');
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .map((effort) => `${EFFORT_GLYPHS[effort]} ${effort}`)
    .join('  ');
  return `${families}\n${efforts}`;
}

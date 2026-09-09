import { colors, theme } from './colors.js';

export const MODEL_GLYPHS = {
  astra: '☀',
  sol: '★',
  terra: '≡',
  luna: '☽',
  spark: '*',
} as const;

export const EFFORT_GLYPHS: Record<string, string> = {
  low: '○',
  medium: '◐',
  high: '◕',
  xhigh: '●',
  max: '⬤',
  ultra: '◉',
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

export function renderModelEffortToken(model?: string | null, effort?: string | null): string {
  const family = classifyModelFamily(model);
  const modelGlyph = family ? MODEL_GLYPHS[family] : model ? shortModelLabel(model) : '';
  const effortKey = (effort ?? '').trim().toLowerCase();
  const effortGlyph = effortKey ? EFFORT_GLYPHS[effortKey] ?? '' : '';
  if (!modelGlyph && !effortGlyph) {
    return '';
  }
  const paintedModel = modelGlyph ? theme.model(modelGlyph) : '';
  const paintedEffort = effortGlyph ? paintEffort(effortKey, effortGlyph) : '';
  return `${paintedModel}${paintedEffort}`;
}

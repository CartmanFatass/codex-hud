import { lookupModelEntry, SHIPPED_MODELS_CATALOG, type ModelFamilyId } from '../models/catalog.js';
import { colors, theme, visualLength } from './colors.js';
import { displayConfig, iconSet, type GlyphMode, type IconMode } from './hud-config.js';
import { PROVIDERS, providerMark, shortModel } from './providers.js';

export const MODEL_GLYPHS: Readonly<Record<ModelFamilyId, string>> = Object.fromEntries(
  Object.entries(SHIPPED_MODELS_CATALOG.families).map(([id, meta]) => [id, meta.glyph])
) as Record<ModelFamilyId, string>;

export const MODEL_LABELS: Readonly<Record<ModelFamilyId, string>> = Object.fromEntries(
  Object.entries(SHIPPED_MODELS_CATALOG.families).map(([id, meta]) => [id, meta.label])
) as Record<ModelFamilyId, string>;

export const EFFORT_GLYPHS: Record<string, string> = { ...SHIPPED_MODELS_CATALOG.effortGlyphs };

/**
 * The icon per HUD role, `[unicode, ascii, nerd]` (the `icons` setting picks one), in the order the worker zone and Home's top
 * line show them: sonic last, and `other` (the icon of any role not listed) before it. Shared by the bar, pi footer, Home
 * and herdr sidebar; the native statusline carries a copy (`native/src/render.rs`). Every role glyph is one terminal cell.
 */
export const ROLE_GLYPHS: Readonly<Record<string, readonly [unicode: string, ascii: string, nerd: string]>> = {
  imp: ['⚒', 'I', '\uF0AD'],
  'frontend-imp': ['✎', 'F', '\uF1FC'],
  general: ['✦', 'G', '\uF013'],
  oracle: ['◈', 'O', '\uF0EB'],
  reviewer: ['⚖', 'R', '\uF002'],
  lead: ['★', 'L', '\uF005'],
  other: ['•', '.', '•'],
  sonic: ['ϟ', '*', '\uF0E7'],
};

/** The role's icon in `set` (a role with no icon of its own gets `other`'s); `emoji` and `unicode` share the Unicode set. */
export function roleIcon(role: string, set: IconMode = iconSet()): string {
  const [unicode, ascii, nerd] = ROLE_GLYPHS[Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other']!;
  return set === 'text' ? ascii : set === 'nerd' ? nerd : unicode;
}

export type ModelFamily = ModelFamilyId;

export function classifyModelFamily(model?: string | null): ModelFamily | null {
  const slug = (model ?? '').trim().toLowerCase();
  if (!slug) {
    return null;
  }
  const entry = lookupModelEntry(slug);
  if (entry?.family) return entry.family;
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
 * `6.1sol`, a variant kept (`gpt-6.2-sol-fast` as `6.2sol-fast`). A model with no family keeps its own name, the `gpt-` prefix off.
 */
export function versionedModelLabel(model?: string | null): string {
  const raw = (model ?? '').trim().replace(/^.*\//, '');
  if (!raw) return '';
  const family = classifyModelFamily(raw);
  if (!family) return shortModelLabel(raw);
  const slug = raw.toLowerCase();
  const version = slug.replace(/^gpt-/, '').match(/^\d+(?:\.\d+)?/)?.[0] ?? '';
  // A variant after the family (`gpt-6.2-sol-fast`) is a different model: keep it.
  const variant = slug.match(new RegExp(`${family}(-[a-z][a-z0-9]*)$`))?.[1] ?? '';
  return `${version}${family}${variant}`;
}

/**
 * A model in one word for the bar's worker zone, read from the catalog rather than tabulated: a family is its id less the
 * version (`gpt-6.2-sol-fast` is `sol-fast`); else the entry's `shortLabel`, first alias or digit-free id (`opus`,
 * `haiku`); else a Gemini codename (`gemini-4-neon-high` is `neon`); else the vendor's catalog tag (`ds`, `glm`, `mis`).
 * An id with none of these keeps `shortModel`'s reading.
 */
export function workerModelName(model?: string | null): string {
  const bare = (model ?? '').trim().replace(/^.*\//, '');
  if (!bare) return '';
  if (classifyModelFamily(bare)) return versionedModelLabel(bare).replace(/^\d+(?:\.\d+)?/, '');
  const entry = lookupModelEntry(bare);
  const word = entry?.shortLabel ?? entry?.aliases?.[0] ?? (/\d/.test(bare) ? '' : bare.toLowerCase());
  if (word) return word;
  const codename = /^gemini-\d+(?:\.\d+)?-([a-z]+)/i.exec(bare)?.[1];
  if (codename) return codename.toLowerCase();
  const tag = (entry?.vendor ? PROVIDERS[entry.vendor] : providerMark({ id: bare }))?.ascii;
  return tag ? tag.toLowerCase() : shortModel(bare);
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

import { lookupModelEntry, SHIPPED_MODELS_CATALOG } from '../models/catalog.js';

/** Vendor marks shared by the panel and the pi footer. Recognisable model vendors win over gateways. */
export interface ProviderMark {
  glyph: string;
  ascii: string;
  color?: number;
}
export const PROVIDERS: Record<string, ProviderMark> = Object.fromEntries(
  Object.entries(SHIPPED_MODELS_CATALOG.vendors).map(([id, meta]) => [
    id,
    meta.color === undefined
      ? { glyph: meta.glyph, ascii: meta.ascii }
      : { glyph: meta.glyph, ascii: meta.ascii, color: meta.color },
  ])
);
const VENDOR_MATCHERS: ReadonlyArray<{ id: string; pattern: RegExp }> = Object.entries(
  SHIPPED_MODELS_CATALOG.vendors
).flatMap(([id, meta]) => {
  const parts: string[] = [];
  if (meta.matchPattern) parts.push(meta.matchPattern);
  if (meta.matchTokens?.length) {
    parts.push(...meta.matchTokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  return parts.length ? [{ id, pattern: new RegExp(parts.join('|')) }] : [];
});
export function providerMark(
  model: { provider?: string | null; id?: string; name?: string; baseUrl?: string } | undefined,
  ascii = false
): ProviderMark | null {
  if (!model) return null;
  const name = (model.id ?? model.name ?? '').toLowerCase();
  const vendor = VENDOR_MATCHERS.find(({ pattern }) => pattern.test(name))?.id ?? null;
  const id = (model.provider ?? '').toLowerCase();
  const mark =
    PROVIDERS[vendor ?? id] ??
    (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(model.baseUrl ?? '') ? PROVIDERS.litellm : null);
  return mark ? { ...mark, glyph: ascii ? mark.ascii : mark.glyph } : null;
}
/** Route and vendor words a model id leads with; the provider mark says the vendor, the route says nothing. */
const VENDOR_WORDS = /^(?:(?:claude|gpt|zai|glm|gemini|deepseek|openai|anthropic|mistral)[-/])+/i;
/**
 * A model id in a few columns: the route and vendor words, the date or build and the `[1m]` window tag go, and version
 * hyphens become dots (`claude-opus-5-5[1m]` is `opus-5.5`, `gpt-6.1-sol` is `6.1-sol`, `zai-glm-5-3-flash` is
 * `5.3-flash`, `deepseek-v4-1-flash-1017` is `v4.1-flash`). An id it does not know is kept, less those.
 */
export function shortModel(id: string | null | undefined): string {
  const whole = (id ?? '').trim();
  const explicit = lookupModelEntry(whole)?.shortLabel;
  if (explicit) return explicit;
  const slug = whole
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^.*\//, '')
    .replace(/^(?:[a-z]{2}\.)?anthropic\./i, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/-\d{4,8}$/, '')
    .replace(VENDOR_WORDS, '');
  return slug.replace(/(\d)-(\d+)(?=-|$)/g, '$1.$2') || whole;
}

/** Vendor marks shared by the panel and the pi footer. Recognisable model vendors win over gateways. */
export interface ProviderMark {
  glyph: string;
  ascii: string;
  color?: number;
}
export const PROVIDERS: Record<string, ProviderMark> = {
  openai: { glyph: '◎', ascii: 'OAI', color: 79 },
  anthropic: { glyph: '✻', ascii: 'Ant', color: 173 },
  copilot: { glyph: '\uec1e', ascii: 'GH', color: 110 },
  mistral: { glyph: 'M', ascii: 'Mis', color: 208 },
  deepseek: { glyph: '≋', ascii: 'DS', color: 69 },
  'huawei-maas': { glyph: '❀', ascii: 'HW', color: 160 },
  xai: { glyph: '⊘', ascii: 'xAI', color: 245 },
  'google-vertex': { glyph: '▲', ascii: 'Gem', color: 111 },
  gemini: { glyph: '▲', ascii: 'Gem', color: 111 },
  zai: { glyph: 'ℤ', ascii: 'GLM' },
  litellm: { glyph: '\ueb2d', ascii: 'LLM', color: 141 },
};
export function providerMark(
  model: { provider?: string | null; id?: string; name?: string; baseUrl?: string } | undefined,
  ascii = false
): ProviderMark | null {
  if (!model) return null;
  const name = (model.id ?? model.name ?? '').toLowerCase();
  const vendor = /gpt|o[134](?:-|$)/.test(name)
    ? 'openai'
    : /claude|sonnet|haiku|opus/.test(name)
      ? 'anthropic'
      : /deepseek/.test(name)
        ? 'deepseek'
        : /glm/.test(name)
          ? 'zai'
          : /gemini/.test(name)
            ? 'gemini'
            : /grok/.test(name)
              ? 'xai'
              : null;
  const id = (model.provider ?? '').toLowerCase();
  const mark =
    PROVIDERS[vendor ?? id] ??
    (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(model.baseUrl ?? '') ? PROVIDERS.litellm : null);
  return mark ? { ...mark, glyph: ascii ? mark.ascii : mark.glyph } : null;
}

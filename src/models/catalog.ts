/**
 * Single built-in model metadata catalog.
 *
 * Pure static module (zero disk I/O): safe for renderers, bars, footer pricing
 * fallbacks, Control picker offline fallbacks, and CLI launch-thinking checks.
 */
import rawCatalog from './models-catalog.json' with { type: 'json' };

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ModelFamilyId = 'astra' | 'sol' | 'terra' | 'luna' | 'spark';
export type CatalogCliAgent = 'agy' | 'claude' | 'codex' | 'grok';
export type CatalogBroTool = 'jev-ask' | 'jev-aistudio' | 'jev-flow';
export type CatalogBroProvider = 'chatgpt' | 'gemini';
export type CatalogBroKind = 'image' | 'video';

export interface ModelPricePerM {
  /** USD / 1M input tokens */
  input: number;
  /** USD / 1M cached input tokens (falls back to input when omitted) */
  cacheRead?: number;
  /** USD / 1M cache-write tokens (falls back to input when omitted) */
  cacheWrite?: number;
  /** USD / 1M output tokens */
  output: number;
  /** Audit note only; never displayed in UI. */
  source?: string;
}

export interface VendorMeta {
  glyph: string;
  ascii: string;
  color?: number;
  /** Substring tokens matched against the lowercased model name; model vendor wins over gateway provider. */
  matchTokens?: readonly string[];
  /** Explicit regex source for vendor recognition (e.g. `gpt|o[134](?:-|$)`). */
  matchPattern?: string;
}

export interface FamilyMeta {
  glyph: string;
  label: string;
}

export interface ModelEntry {
  vendor?: string;
  family?: ModelFamilyId;
  /** Shorthand aliases (e.g. `claude-fable-5-2` -> `["fable"]`). */
  aliases?: readonly string[];
  /** Exact CLI thinking levels accepted per agent (`--effort` / `model_reasoning_effort`). */
  cliThinking?: Partial<Record<CatalogCliAgent, readonly ThinkingLevel[]>>;
  /**
   * Local fallback list price for `p10k-footer.ts` when a provider reports no `usage.cost`.
   * Never exposed to the Control picker (spec §2.1: no price column without a local source).
   */
  pricingPerM?: ModelPricePerM;
  /** Optional explicit override for `shortModel()`. */
  shortLabel?: string;
}

export interface ModelsCatalogDocument {
  version: 1;
  /** Ordered thinking ladder shared by `nearestThinking` and validation. */
  thinkingOrder: readonly ThinkingLevel[];
  /** Built-in defaults for internal display text and Decision API helpers. */
  defaults: {
    summary: {
      apiBase: string;
      model: string;
      tiers: Readonly<Record<'lite' | 'low' | 'medium', string>>;
      settingsChoices: readonly string[];
    };
    decisions: {
      openai: string;
      gemini: string;
      typesafe: string;
    };
  };
  /** Offline fallback lists used when no dynamic discovery cache exists. */
  harnesses: {
    pi: {
      offlineModels: readonly string[];
      thinking: readonly ThinkingLevel[];
    };
    cli: {
      agents: readonly CatalogCliAgent[];
      thinking: readonly ThinkingLevel[];
      models: Readonly<Record<CatalogCliAgent, readonly string[]>>;
    };
    bro: {
      tools: readonly CatalogBroTool[];
      providers: readonly CatalogBroProvider[];
      kinds: readonly CatalogBroKind[];
      thinking: readonly string[];
      models: Readonly<Record<string, readonly string[]>>;
    };
  };
  vendors: Readonly<Record<string, VendorMeta>>;
  families: Readonly<Record<ModelFamilyId, FamilyMeta>>;
  effortGlyphs: Readonly<Record<string, string>>;
  /** Normalized model registry keyed by bare lowercased model ID (without provider prefix). */
  models: Readonly<Record<string, ModelEntry>>;
}

export const SHIPPED_MODELS_CATALOG: Readonly<ModelsCatalogDocument> = rawCatalog as ModelsCatalogDocument;

interface CatalogIndexes {
  byId: Map<string, ModelEntry>;
  pricesByKey: Map<string, ModelPricePerM>;
}

const indexCache = new WeakMap<ModelsCatalogDocument, CatalogIndexes>();

function buildIndexes(catalog: ModelsCatalogDocument): CatalogIndexes {
  const existing = indexCache.get(catalog);
  if (existing) return existing;
  const byId = new Map<string, ModelEntry>();
  const pricesByKey = new Map<string, ModelPricePerM>();
  for (const [id, entry] of Object.entries(catalog.models)) {
    const keys = [id, ...(entry.aliases ?? [])];
    for (const rawKey of keys) {
      const lower = rawKey.trim().toLowerCase();
      if (!lower) continue;
      if (!byId.has(lower)) byId.set(lower, entry);
      if (entry.pricingPerM) {
        const priceKey = lower.replace(/\./g, '-');
        if (!pricesByKey.has(priceKey)) pricesByKey.set(priceKey, entry.pricingPerM);
      }
    }
  }
  const built: CatalogIndexes = { byId, pricesByKey };
  indexCache.set(catalog, built);
  return built;
}

/** Look up a model entry by exact ID or alias (case-insensitive, ignoring any leading `provider/`). */
export function lookupModelEntry(
  modelId: string | null | undefined,
  catalog: ModelsCatalogDocument = SHIPPED_MODELS_CATALOG
): ModelEntry | undefined {
  const bare = (modelId ?? '').trim().replace(/^.*\//, '').toLowerCase();
  if (!bare) return undefined;
  return buildIndexes(catalog).byId.get(bare);
}

/** Resolve supported CLI thinking levels for an agent + model (supports exact ID, aliases, and optional `provider/`). */
export function resolveCliThinking(
  catalog: ModelsCatalogDocument,
  agent: CatalogCliAgent,
  model: string
): readonly ThinkingLevel[] | undefined {
  return lookupModelEntry(model, catalog)?.cliThinking?.[agent];
}

/**
 * Fallback list price for `p10k-footer.ts`: strips optional `provider/` prefix, normalizes `.` -> `-`,
 * and matches exact key/alias, undated base (`-YYYYMMDD` / `-MMDD`), or longest prefix.
 */
export function lookupModelPrice(
  modelId: string | undefined,
  catalog: ModelsCatalogDocument = SHIPPED_MODELS_CATALOG
): ModelPricePerM | null {
  if (!modelId) return null;
  const bare = modelId.trim().replace(/^.*\//, '');
  if (!bare) return null;
  const key = bare.toLowerCase().replace(/\./g, '-');
  const prices = buildIndexes(catalog).pricesByKey;
  const direct = prices.get(key);
  if (direct) return direct;
  const base = key.replace(/-\d{4,8}$/, '');
  const undated = prices.get(base);
  if (undated) return undated;
  let match: string | null = null;
  for (const candidate of prices.keys()) {
    if (key.startsWith(candidate) && (match === null || candidate.length > match.length)) match = candidate;
  }
  return match === null ? null : prices.get(match)!;
}

/** Strip a trailing snapshot date (`-YYYYMMDD`, `-YYYY-MM-DD`, or `-MMDD`), keeping any provider prefix. */
export function stripModelSnapshotDate(model: string): string {
  return model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/, '');
}

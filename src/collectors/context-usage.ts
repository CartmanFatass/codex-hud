/**
 * Context-window math, split out of the main loop so it can be replayed
 * against fixtures.
 *
 * Mirrors codex's own "context window left" calculation: the usable window is
 * the model window minus a fixed baseline reserved for the system prompt and
 * tool definitions, and the fill is measured from last_token_usage (what is
 * actually resident in the context) rather than cumulative session usage.
 */

import { BASELINE_TOKENS } from '../types.js';
import type { ContextUsage, TokenUsage, TokenUsageInfo } from '../types.js';

export function getNonCachedInputTokens(usage: TokenUsage | undefined): number {
  if (!usage) {
    return 0;
  }
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  return Math.max(0, input - cached);
}

/**
 * Whether the fixed baseline reservation applies to this window at all.
 *
 * The reservation only makes sense while it is a slice of the window. On a
 * model whose whole window is at or below the baseline, reserving it would
 * consume every token and pin the display at 100% no matter how empty the
 * conversation is, so those windows are measured raw instead.
 */
export function baselineApplies(contextWindow: number): boolean {
  return contextWindow > BASELINE_TOKENS;
}

export function baselineAdjustedUsedTokens(tokensInContext: number, contextWindow: number): number {
  if (contextWindow <= 0) {
    return 0;
  }
  const baseline = baselineApplies(contextWindow) ? BASELINE_TOKENS : 0;
  const used = Math.max(0, tokensInContext) + baseline;
  return Math.max(0, Math.min(contextWindow, used));
}

export function percentOfContextWindowRemaining(
  tokensInContext: number,
  contextWindow: number
): number {
  if (contextWindow <= 0) {
    return 0;
  }
  const used = baselineAdjustedUsedTokens(tokensInContext, contextWindow);
  const remaining = Math.max(0, contextWindow - used);
  const percent = (remaining / contextWindow) * 100;
  return Math.round(Math.max(0, Math.min(100, percent)));
}

export function buildContextUsage(
  tokenUsage: TokenUsageInfo | undefined,
  compactCount: number | undefined,
  lastCompactTime: Date | null | undefined
): ContextUsage | undefined {
  if (!tokenUsage) {
    return undefined;
  }

  const contextWindow = tokenUsage.model_context_window ?? 0;
  const lastUsage = tokenUsage.last_token_usage;

  if (contextWindow <= 0 || !lastUsage) {
    return undefined;
  }

  const tokensInContext = lastUsage.total_tokens ?? 0;
  const usedWithBaseline = baselineAdjustedUsedTokens(tokensInContext, contextWindow);
  const percentRemaining = percentOfContextWindowRemaining(tokensInContext, contextWindow);

  return {
    used: usedWithBaseline,
    total: contextWindow,
    percent: 100 - percentRemaining,
    inputTokens: getNonCachedInputTokens(lastUsage),
    outputTokens: lastUsage.output_tokens ?? 0,
    cachedTokens: lastUsage.cached_input_tokens ?? 0,
    compactCount: compactCount ?? 0,
    lastCompactTime: lastCompactTime ?? undefined,
  };
}

/**
 * Identity Line Renderer
 * Renders: [Model] █████░░░░░ 45%
 * Model name with context usage bar
 */

import type { HudData, LayoutConfig } from '../../types.js';
import { coloredBar, coloredPercent, truncateAnsi, visualLength } from '../colors.js';
import { getModelDisplayName } from '../../collectors/codex-config.js';
import { renderModelEffortToken } from '../model-glyphs.js';

/**
 * Render the identity line
 * Format: ☀◐ █████░░░░░ 45%
 */
export function renderIdentityLine(
  data: HudData,
  layout: LayoutConfig,
  options: { maxWidth?: number } = {}
): string {
  const parts: string[] = [];
  
  const modelName = data.session?.model ?? getModelDisplayName(data.config);
  const reasoningEffort = data.session?.reasoningEffort ?? data.config.model_reasoning_effort;
  const identityToken = renderModelEffortToken(modelName, reasoningEffort);
  let contextDisplay = '';
  const showContextBar = layout.showContextBar !== false;

  // Context usage bar (if available)
  if (showContextBar && data.contextUsage) {
    const ctx = data.contextUsage;
    contextDisplay = `${coloredBar(ctx.percent, layout.barWidth)} ${coloredPercent(ctx.percent)}`;
  } else if (showContextBar && data.tokenUsage?.total_token_usage) {
    const usage = data.tokenUsage.total_token_usage;
    const total = usage.total_tokens ?? 0;
    const contextWindow = data.tokenUsage.model_context_window;
    if (contextWindow && contextWindow > 0) {
      const percent = Math.round((total / contextWindow) * 100);
      contextDisplay = `${coloredBar(percent, layout.barWidth)} ${coloredPercent(percent)}`;
    }
  }

  const maxWidth = options.maxWidth;
  let modelDisplay = identityToken;
  if (maxWidth && maxWidth > 0) {
    const contextLen = contextDisplay ? visualLength(contextDisplay) + 1 : 0;
    const availableForModel = Math.max(0, maxWidth - contextLen);
    if (availableForModel <= 0 && contextDisplay) {
      return truncateAnsi(contextDisplay, maxWidth);
    }
    if (availableForModel > 0) {
      modelDisplay = truncateAnsi(identityToken, availableForModel);
    }
  }

  if (modelDisplay) {
    parts.push(modelDisplay);
  }
  if (contextDisplay) {
    parts.push(contextDisplay);
  }
  
  const line = parts.join(' ');
  return maxWidth ? truncateAnsi(line, maxWidth) : line;
}

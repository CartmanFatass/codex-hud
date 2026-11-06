/** D3 first-line preview: only supplied Claude facts, no collector or storage. */
import { truncateAnsi, visualLength } from './colors.js';
import { monitorText } from './monitor-text.js';
import { renderStatuslineDetails } from './statusline-details.js';
import type { StatuslineLanguage } from './statusline-labels.js';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function label(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return monitorText(value.slice(0, 512))
    .replace(/[\u2028\u2029]/g, ' ')
    .trim();
}

/** Unknown facts are omitted; zero is a fact. No model-to-context-window guesses. */
export interface StatuslineSessionOptions {
  details?: boolean;
  language?: StatuslineLanguage;
}

export function renderStatuslineSession(input: unknown, width = 80, options: StatuslineSessionOptions = {}): string {
  if (options.details === true) return renderStatuslineDetails(input, width, options.language ?? 'en');
  if (!Number.isSafeInteger(width) || width < 1 || width > 500) throw new Error('invalid_statusline_width');
  const value = object(input);
  const model = object(value.model);
  const context = object(value.context_window);
  const cost = object(value.cost);
  const name = label(model.display_name) ?? label(model.id) ?? 'Claude';
  const used = context.used_percentage;
  const contextText = nonnegative(used) && used <= 100 ? `ctx ${Math.round(used)}%` : null;
  const dollars = cost.total_cost_usd;
  const costText = nonnegative(dollars)
    ? `$${dollars > 0 && dollars < 0.01 ? dollars.toPrecision(2) : dollars.toFixed(2)}`
    : null;
  const parts = [name, contextText, costText].filter((part): part is string => part !== null);
  // Session identity wins; discard cost then context before shortening the name.
  while (parts.length > 1 && visualLength(parts.join(' · ')) > width) parts.pop();
  return truncateAnsi(parts.join(' · '), width);
}

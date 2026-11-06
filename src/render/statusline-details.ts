/** Pure presentation of the admitted main statusLine fields; no enrichment or identity inference. */
import { truncateAnsi, visualLength } from './colors.js';
import { monitorText } from './monitor-text.js';
import { STATUSLINE_LABELS, type StatuslineLanguage } from './statusline-labels.js';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}

function percent(value: unknown): number | null {
  return nonnegative(value) && value <= 100 ? Math.round(value) : null;
}

function displayText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let bounded = value.slice(0, 512);
  // Cutting the raw input must not split a supplementary code point.
  if (/[\ud800-\udbff]$/.test(bounded)) bounded = bounded.slice(0, -1);
  const text = monitorText(bounded)
    .replace(/[\u2028\u2029]/g, ' ')
    .replace(/[\u061c\u200e\u200f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .trim();
  return text || null;
}

/** Missing facts omit their segment. Known zero is retained, and siblings are independent. */
export function renderStatuslineDetails(input: unknown, width: number, language: StatuslineLanguage): string {
  if (!Number.isSafeInteger(width) || width < 1 || width > 500) throw new Error('invalid_statusline_width');
  const labels = STATUSLINE_LABELS[language];
  const value = object(input);
  const model = object(value.model);
  const context = object(value.context_window);
  const usage = object(context.current_usage);
  const cost = object(value.cost);
  const workspace = object(value.workspace);
  const name = displayText(model.display_name) ?? displayText(model.id) ?? 'Claude';
  const used = percent(context.used_percentage);
  const remaining = percent(context.remaining_percentage);
  const dollars = cost.total_cost_usd;
  const directory = displayText(workspace.current_dir) ?? displayText(value.cwd);
  const filled = used === null ? 0 : Math.floor(used / 10);
  const contextText =
    used === null ? null : `${labels.used} [${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ${used}%`;
  const costText = nonnegative(dollars)
    ? `${labels.cost} $${dollars > 0 && dollars < 0.01 ? dollars.toPrecision(2) : dollars.toFixed(2)}`
    : null;
  const tokens = (label: string, n: unknown) => (count(n) ? `${label} ${n} ${labels.tokens}` : null);
  const duration = (label: string, n: unknown) => (count(n) ? `${label} ${n} ms` : null);
  const added = cost.total_lines_added;
  const removed = cost.total_lines_removed;
  const changes = [count(added) ? `+${added}` : null, count(removed) ? `-${removed}` : null].filter(
    (part): part is string => part !== null
  );
  const optional = [
    directory === null ? null : `${labels.directory} ${directory}`,
    remaining === null ? null : `${labels.remaining} ${remaining}%`,
    tokens(labels.input, context.total_input_tokens),
    tokens(labels.output, context.total_output_tokens),
    count(context.context_window_size) && context.context_window_size > 0
      ? tokens(labels.window, context.context_window_size)
      : null,
    tokens(labels.cacheRead, usage.cache_read_input_tokens),
    tokens(labels.cacheWrite, usage.cache_creation_input_tokens),
    duration(labels.duration, cost.total_duration_ms),
    duration(labels.apiDuration, cost.total_api_duration_ms),
    changes.length ? `${labels.lines} ${changes.join(' ')}` : null,
  ].filter((part): part is string => part !== null);
  let core = [`${labels.model} ${name}`, contextText, costText].filter((part): part is string => part !== null);
  const line = () => [...core, ...optional].join(' · ');
  while (optional.length && visualLength(line()) > width) optional.pop();
  if (visualLength(line()) <= width) return line();

  // Retain identity before disposable facts; stop at the first fitting state with no backfill.
  core = [`${labels.model} ${name}`, used === null ? null : `${labels.used} ${used}%`, costText].filter(
    (part): part is string => part !== null
  );
  if (visualLength(line()) <= width) return line();
  if (costText !== null) core.pop();
  if (visualLength(line()) <= width) return line();
  if (used !== null) core.pop();
  if (visualLength(line()) <= width) return line();
  return truncateAnsi(name, width);
}

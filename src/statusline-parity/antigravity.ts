import { renderBar, type BarQuotaWindow } from '../render/layout/bar-fields.js';
import { monitorText } from '../render/monitor-text.js';
import { formatWindowLabel } from '../render/quota.js';
import { renderStatuslineDetails } from '../render/statusline-details.js';
import type { StatuslineSessionOptions } from '../render/statusline-session.js';
import { record } from './storage.js';

const percent = (value: unknown) =>
  typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value) : undefined;
const label = (value: unknown) =>
  typeof value === 'string' ? monitorText(value.slice(0, 256)).replace(/[\u2028\u2029]/g, ' ').trim() : '';

export function renderAntigravity(input: unknown, width: number, options: StatuslineSessionOptions): string {
  const value = record(input), model = record(value.model), context = record(value.context_window);
  const id = label(model.id), displayName = label(model.display_name);
  const name = displayName || id;
  const left = percent(context.remaining_percentage);
  const used = percent(context.used_percentage) ?? (left === undefined ? undefined : 100 - left);
  if (!name && used === undefined) throw new Error('unrecognized_antigravity_payload');
  const size = context.context_window_size;
  const window = typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : 0;
  const family = /^gemini/i.test(id) || /^gemini/i.test(displayName) ? 'gemini' : '3p';
  const quota = record(value.quota), now = Date.now();
  const windows: BarQuotaWindow[] = [];
  for (const [suffix, minutes] of [['5h', 300], ['weekly', 10080]] as const) {
    const { remaining_fraction, reset_time } = record(quota[`${family}-${suffix}`]);
    if (typeof remaining_fraction !== 'number' || !Number.isFinite(remaining_fraction)) continue;
    if (typeof reset_time !== 'string' || !(Date.parse(reset_time) > now)) continue;
    const remaining = Math.max(0, Math.min(100, Math.round(remaining_fraction * 100)));
    windows.push({ label: formatWindowLabel(minutes), percent: 100 - remaining, shown: `${remaining}% left`, meter: false });
  }
  const modelName = name || 'Antigravity';
  const workspace = record(value.workspace);
  if (options.details) {
    const language = options.language ?? 'en';
    return renderStatuslineDetails({
      model: { display_name: modelName },
      cwd: label(workspace.current_dir) || label(value.cwd),
      context_window: {
        used_percentage: used,
        remaining_percentage: left,
        context_window_size: window,
        total_input_tokens: context.total_input_tokens,
        total_output_tokens: context.total_output_tokens,
      },
    }, width, language, windows.map((w) => `${w.label} ${w.shown}`));
  }
  const cwd = label(workspace.project_dir) || label(value.cwd);
  const project = cwd.split(/[/\\]/).filter(Boolean).at(-1) || (cwd.startsWith('/') ? '/' : '');
  return '\x1b[0m' + renderBar({
    model: { name: modelName, id: id || undefined },
    context: used === undefined ? undefined : { percent: used, shown: `${used}%`, window },
    project: project ? { name: project, branch: null } : undefined,
    quota: windows.length ? { windows, trailing: true } : undefined,
  }, width).line;
}

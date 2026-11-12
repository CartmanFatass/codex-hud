/** Claude's statusline: the facts the owner has read in claude-hud 0.8.0 (MIT; see NOTICE), now one line from the shared
 * bar builder (`render/layout/bar-fields.ts`). Pure: all disk/process evidence and clocks are supplied. */
import { monitorText } from '../render/monitor-text.js';
import * as bar from '../render/layout/bar-fields.js';
import { shortModel } from '../render/providers.js';
import type { WorkSignals } from '../render/work-summary.js';
import { record } from './storage.js';
import type { ParitySettings } from './settings.js';
import type { TranscriptView } from './transcript.js';
import type { ConfigCounts } from './config-counts.js';
import type { GitView } from './git.js';
const RESET = '\x1b[0m';
const safe = (v: unknown, n = 512) => (typeof v === 'string' ? monitorText(v.slice(0, n)).trim() : '');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown) => (finite(v) && v >= 0 ? v : 0);
const pct = (v: unknown) => (finite(v) ? Math.round(Math.max(0, Math.min(100, v))) : null);
export function contextPercent(value: unknown): number {
  const c = record(record(value).context_window),
    u = record(c.current_usage);
  if (finite(c.used_percentage) && c.used_percentage > 0) return pct(c.used_percentage)!;
  const size = num(c.context_window_size);
  if (!size) return 0;
  const ratio = (num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)) / size;
  return Math.min(100, Math.round((ratio + 0.225 * Math.min(1, Math.max(0, (ratio - 0.05) / 0.45))) * 100));
}
/** The reading and the window it is against: where Claude compacts on its own (`compact`), when that is below the model's window. */
function contextReading(value: unknown, compact: number | null): { percent: number; window: number } {
  const size = num(record(record(value).context_window).context_window_size),
    percent = contextPercent(value);
  return compact && size && compact < size
    ? { percent: Math.min(100, Math.round((percent * size) / compact)), window: compact }
    : { percent, window: size };
}
/** The 5 h and the weekly window as Claude reports them; the bar shows the weekly one only from 80 % (`bar-fields.ts`). */
function usageWindows(value: Record<string, unknown>, now: number) {
  const limits = record(value.rate_limits);
  const window = (label: string, w: Record<string, unknown>) => {
    const percent = pct(w.used_percentage),
      ends = num(w.resets_at) * 1000;
    return percent === null
      ? []
      : [{ label, percent, reset: ends > now ? bar.span(Math.ceil((ends - now) / 60000)) : '' }];
  };
  const [five] = window('5h', record(limits.five_hour)),
    [seven] = window('7d', record(limits.seven_day));
  return [five, seven].filter((w) => w !== undefined);
}
/** What the transcript says just happened: a subagent started or finished, a skill was loaded. */
function events(t: TranscriptView, defs: AgentDefinitions, showAgents: boolean, showSkills: boolean): bar.BarEvent[] {
  const found: bar.BarEvent[] = [];
  for (const a of showAgents ? t.agents : []) {
    const def = defs[a.type];
    // The call's model, else the result's, else the definition's; the effort is the definition's.
    const who = {
      id: a.id,
      name: safe(a.type, 24) || 'agent',
      model: a.model || def?.model,
      effort: def?.effort,
    };
    found.push(bar.agentEvent('started', who, a.start));
    if (a.end !== undefined) found.push(bar.agentEvent('done', who, a.end));
  }
  for (const load of showSkills ? (t.skillLoads ?? []) : [])
    found.push({ kind: 'skill', at: load.at, text: `skill ${load.name}`, key: `skill ${load.name}` });
  return found;
}
/** What a subagent type's definition (`agents/<type>.md`) says about its model and effort, by type. */
export type AgentDefinitions = Record<string, { model?: string; effort?: string }>;
export interface ParityEvidence {
  transcript: TranscriptView;
  counts: ConfigCounts;
  git: GitView | null;
  /** Where Claude compacts on its own, in tokens, from its settings; null when it does not say. */
  compact?: number | null;
  /** The recent subagents' definitions, read by the collector; a type with none (a built-in one) is not in it. */
  definitions?: AgentDefinitions;
}
export function renderParity(
  input: unknown,
  width: number,
  settings: ParitySettings,
  evidence: ParityEvidence,
  now: number,
  env: NodeJS.ProcessEnv = {},
  work: WorkSignals = { needs: [], events: [] }
): string {
  const v = record(input),
    m = record(v.model),
    t = evidence.transcript,
    c = evidence.counts,
    d = settings.display;
  let model = safe(m.display_name) || safe(m.id) || 'Unknown';
  if (!safe(m.display_name) && /^(opus|sonnet|haiku)plan$/i.test(model))
    model = 'Claude ' + model[0].toUpperCase() + model.slice(1, -4);
  if (!safe(m.display_name) && /anthropic\.claude/.test(model)) {
    const match = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(model);
    if (match) model = `${match[1][0].toUpperCase() + match[1].slice(1)} ${match[2]}${match[3] ? '.' + match[3] : ''}`;
  }
  const effort = safe(typeof v.effort === 'string' ? v.effort : record(v.effort).level, 64).toLowerCase();
  const { percent, window } = contextReading(v, evidence.compact ?? null),
    git = settings.gitStatus.enabled ? evidence.git : null;
  const cwd = safe(v.cwd),
    project = cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0] || (cwd.startsWith('/') ? '/' : '');
  // Bedrock bills elsewhere: no usage window.
  const windows =
    env.CLAUDE_CODE_USE_BEDROCK === '1' || safe(m.id).toLowerCase().includes('anthropic.claude-')
      ? []
      : usageWindows(v, now);
  const facts: bar.BarFacts = {
    model: {
      name: shortModel(safe(m.id)) || model,
      id: safe(m.id) || model,
      effort: d.showEffortLevel && effort ? (t.ultracode ? `ultracode(${effort})` : effort) : undefined,
    },
    context: { percent, shown: `${percent}%`, window },
    project: {
      name: project,
      branch: git ? safe(git.branch) : null,
      dirty: Boolean(git?.dirty && settings.gitStatus.showDirty),
      marks:
        (git?.dirty && settings.gitStatus.showDirty ? '*' : '') +
        (git && settings.gitStatus.showAheadBehind ? bar.gitSync(git.ahead, git.behind) : ''),
    },
    quota: windows.length ? { windows } : undefined,
    needs: work.needs,
    events: [...events(t, evidence.definitions ?? {}, d.showAgents, d.showSkills), ...work.events],
    loaded: {
      counts: [
        ['MCP', c.mcpCount],
        ['skills', d.showSkills ? t.skills.length : 0],
      ],
    },
  };
  return RESET + bar.renderBar(facts, width, now).line;
}

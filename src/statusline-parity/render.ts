/** Claude's statusline: the facts the owner has read in claude-hud 0.8.0 (MIT; see NOTICE), now as one line in the
 * Codex bar's grammar (`render/layout/bar-fields.ts`). Pure: all disk/process evidence and clocks are supplied. */
import { monitorText } from '../render/monitor-text.js';
import { colors, theme, truncateAnsi, visualLength } from '../render/colors.js';
import * as bar from '../render/layout/bar-fields.js';
import type { BarModule } from '../render/layout/engine.js';
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
/** `19m`, `1h19m`, `2d1h`. */
function span(mins: number): string {
  const days = Math.floor(mins / 1440),
    hours = Math.floor(mins / 60) % 24,
    rest = mins % 60;
  return days ? `${days}d${hours ? hours + 'h' : ''}` : mins >= 60 ? `${hours}h${rest ? rest + 'm' : ''}` : `${mins}m`;
}
/** The 5 h window, and the weekly one once it passes 80 % (or when it is the only one), as claude-hud showed them. */
function usageModule(value: Record<string, unknown>, now: number): BarModule {
  const limits = record(value.rate_limits);
  const window = (label: string, w: Record<string, unknown>) => {
    const percent = pct(w.used_percentage),
      ends = num(w.resets_at) * 1000;
    return percent === null ? [] : [{ label, percent, reset: ends > now ? span(Math.ceil((ends - now) / 60000)) : '' }];
  };
  const [five] = window('5h', record(limits.five_hour)),
    [seven] = window('7d', record(limits.seven_day));
  const shown = [five, seven && (!five || seven.percent >= 80) ? seven : undefined].filter((w) => w !== undefined);
  const reading = (reset: boolean) =>
    shown
      .map(
        (w) =>
          bar.quotaReading(w.label, w.percent) +
          (reset && w.reset ? ` ${colors.dim('reset')} ${theme.value(w.reset)}` : '')
      )
      .join('  ');
  return bar.quotaModule(shown.length ? reading(true) : '', reading(false));
}
/** `sonnet-4.5` from `claude-sonnet-4-5-20250929`; an id this does not know is shown as it is. */
function agentModel(model: string | undefined): string {
  if (!model) return '';
  const candidate = model.replace(/\[[^\]]*\]$/, '');
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(candidate);
  if (match) return `${match[1].toLowerCase()}-${match[2]}${match[3] ? '.' + match[3] : ''}`;
  const legacy = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(candidate);
  return legacy ? `${legacy[3].toLowerCase()}-${legacy[1]}${legacy[2] ? '.' + legacy[2] : ''}` : safe(model);
}
/** Whole words up to `n` columns and `…`; a first word that is too long leaves nothing. Unspaced text (CJK) is cut by column. */
function cut(text: string, n: number): string {
  if (visualLength(text) <= n) return text;
  if (!/\s/.test(text) && /[^\x00-\x7f]/.test(text)) return truncateAnsi(text, n);
  let out = '';
  for (const word of text.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (visualLength(next) > n - 1) break;
    out = next;
  }
  return out ? out + '…' : '';
}
/** How long a finished agent stays on the bar by name (owner, 2026-11-11: 60 s was too short). */
const FINISHED_SHOWN_MS = 10 * 60_000;
/**
 * While an agent runs the segment tells it as the claude-hud row did: `◐ type [model]: description 12m`, the newest of
 * several with `+N`. With none running, the newest agent finished in the last ten minutes stays the same way with `✓`
 * and its run time. Narrower the description is cut first, then the model goes.
 */
function agentsModule(agents: TranscriptView['agents'], now: number): BarModule {
  const running = agents.filter((a) => a.end === undefined).sort((a, b) => b.startPos - a.startPos);
  const finished = agents
    .filter((x) => x.end !== undefined && x.end <= now && now - x.end <= FINISHED_SHOWN_MS)
    .sort((x, y) => y.end! - x.end! || y.startPos - x.startPos);
  const shown = running.length ? running : finished;
  const [a] = shown;
  if (!a) return bar.agentCountsModule({ active: 0, completed: 0, failed: 0, unknown: 0 });
  const name = safe(a.type, 24) || 'agent',
    model = agentModel(a.model),
    ms = Math.max(0, (a.end ?? now) - a.start),
    time = ms < 60000 ? `${Math.floor(ms / 1000)}s` : span(Math.floor(ms / 60000)),
    glyph = running.length ? theme.info('◐') : theme.success('✓');
  const row = (words: number, withModel: boolean) => {
    const description = cut(safe(a.description, 200), words);
    return `${glyph} ${theme.agentType(name)}${withModel && model ? colors.dim(` [${model}]`) : ''}${description ? colors.dim(': ') + theme.value(description) : ''} ${colors.dim(time + (shown.length > 1 ? ` +${shown.length - 1}` : ''))}`;
  };
  // The description is cut after the effort has gone, the model after the reset time.
  return {
    ...bar.AGENTS_BASE,
    shrinkByLevel: { full: bar.SHRINK.identity + 1, short: bar.SHRINK.quota + 2 },
    variants: { full: row(48, true), short: row(24, true), min: row(12, false) },
  };
}
export interface ParityEvidence {
  transcript: TranscriptView;
  counts: ConfigCounts;
  git: GitView | null;
}
export function renderParity(
  input: unknown,
  width: number,
  settings: ParitySettings,
  evidence: ParityEvidence,
  now: number,
  env: NodeJS.ProcessEnv = {},
  work = ''
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
  const percent = contextPercent(v),
    git = settings.gitStatus.enabled ? evidence.git : null;
  const cwd = safe(v.cwd),
    project = cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0] || (cwd.startsWith('/') ? '/' : '');
  const minutes = t.sessionStart === undefined ? 0 : Math.max(0, Math.floor((now - t.sessionStart) / 60000));
  const agents = d.showAgents ? t.agents : [],
    todos = d.showTodos ? t.todos : [];
  const modules = [
    bar.identityModule(
      model,
      d.showEffortLevel && effort ? (t.ultracode ? `ultracode(${effort})` : effort) : undefined
    ),
    bar.contextModule(percent, `${percent}%`, num(record(v.context_window).context_window_size), 10),
    bar.projectModule(
      project,
      git ? safe(git.branch) : null,
      git && git.dirty && settings.gitStatus.showDirty ? '*' : '',
      git && settings.gitStatus.showAheadBehind ? bar.gitSync(git.ahead, git.behind) : ''
    ),
    // Bedrock bills elsewhere: no usage window.
    env.CLAUDE_CODE_USE_BEDROCK === '1' || safe(m.id).toLowerCase().includes('anthropic.claude-')
      ? bar.quotaModule('')
      : usageModule(v, now),
    agentsModule(agents, now),
    bar.tasksModule(todos.filter((x) => x.status === 'completed').length, todos.length),
    bar.workModule(work),
    bar.configModule([
      ['CLAUDE.md', c.claudeMdCount],
      ['rules', c.rulesCount],
      ['MCP', c.mcpCount],
      ['skills', d.showSkills ? t.skills.length : 0],
      ['hooks', c.hooksCount],
    ]),
    bar.metaModule(
      'session',
      d.showDuration && t.sessionStart !== undefined
        ? `${colors.dim('session')} ${theme.value(minutes < 1 ? '<1m' : span(minutes))}`
        : ''
    ),
  ];
  return RESET + bar.fitBar(modules, width).line;
}

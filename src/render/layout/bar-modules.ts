import { formatTokenRate } from '../../collectors/token-rate.js';
/**
 * The status bar's fields, each one declared with its importance and with
 * shorter ways to say itself.
 *
 * Two rules run through this file. A field that has no trustworthy data
 * renders as an empty string and is skipped entirely, so nothing shows a zero
 * it does not have. And the meanings are kept apart: `Ctx` is how full the
 * context window is, `Tokens` is what the session has spent, `Quota` is the
 * account's usage window, `Tasks` is progress through the plan. They used to
 * share a label.
 */

import type { HudData } from '../../types.js';
import { colors, coloredBar, coloredPercent, completionBar, getContextColor, icons, theme, truncate } from '../colors.js';
import { renderModelEffortToken } from '../model-glyphs.js';
import { formatTokenCount } from '../lines/index.js';
import { collectAttention, highestSeverity } from '../attention.js';
import { summarizeSubagents } from '../../collectors/subagent-tree.js';
import { getApprovalPolicyDisplayValue } from '../../collectors/codex-config.js';
import { displayConfig, type Density, type GlyphMode } from '../hud-config.js';
import { formatCountdown, readQuotaWindows } from '../quota.js';
import { formatElapsedShort } from '../subagent-chip.js';
import type { BarModule } from './engine.js';

export const MODULE_PRIORITY = {
  attention: 100,
  identity: 92,
  activity: 94,
  project: 88,
  agents: 70,
  context: 93,
  cache: 64,
  tasks: 60,
  quota: 50,
  tokens: 40,
  speed: 54,
  timer: 34,
  environment: 30,
  session: 24,
} as const;

/**
 * Which fields each preset is allowed to show. Narrowing further is the
 * layout engine's job; this is about what the user asked to see at all.
 */
const DENSITY_MODULES: Record<Density, ReadonlyArray<keyof typeof MODULE_PRIORITY>> = {
  focus: ['attention', 'activity', 'identity', 'project', 'agents', 'context', 'cache'],
  balanced: ['attention', 'activity', 'identity', 'project', 'agents', 'context', 'cache', 'tasks', 'quota', 'speed', 'timer'],
  full: Object.keys(MODULE_PRIORITY) as Array<keyof typeof MODULE_PRIORITY>,
};

export function formatDuration(startTime: Date, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - startTime.getTime()) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  // Past a week and a half the hours stop telling the reader anything.
  if (diffDay >= 10) {
    return `${diffDay}d`;
  }
  if (diffDay > 0) {
    return `${diffDay}d${diffHour % 24}h`;
  }
  if (diffHour > 0) {
    return `${diffHour}h${diffMin % 60}m`;
  }
  if (diffMin > 0) {
    return `${diffMin}m`;
  }
  return `${diffSec}s`;
}

function attentionModule(data: HudData, nowMs: number): BarModule {
  const items = collectAttention(data, nowMs);
  if (items.length === 0) {
    return { id: 'attention', priority: MODULE_PRIORITY.attention, pinned: true, variants: {} };
  }
  const paint = highestSeverity(items) === 'error' ? theme.error : theme.warning;
  const count = items.length;
  return {
    id: 'attention',
    priority: MODULE_PRIORITY.attention,
    // Pinned: an alert is the one thing a narrow pane must not lose.
    pinned: true,
    variants: {
      full: paint(`! ${items.map((item) => item.label).join(' · ')}`),
      short: paint(`! ${items[0].label}`),
      min: paint(count > 1 ? `!${count}` : '!'),
    },
  };
}

function identityModule(data: HudData, glyphs: GlyphMode): BarModule {
  const model = data.session?.model ?? data.config.model;
  const effort = data.session?.reasoningEffort ?? data.config.model_reasoning_effort;

  // The configured badge style decides what the widest form looks like; the
  // narrower forms drop the effort, then the words, in that order. A reader
  // who chose words never has a symbol substituted back in.
  if (glyphs === 'text') {
    return {
      id: 'identity',
      priority: MODULE_PRIORITY.identity,
      group: 'who',
      variants: {
        full: renderModelEffortToken(model, effort, { mode: 'text' }),
        short: renderModelEffortToken(model, undefined, { mode: 'text' }),
      },
    };
  }

  if (glyphs === 'glyph') {
    return {
      id: 'identity',
      priority: MODULE_PRIORITY.identity,
      group: 'who',
      variants: {
        full: renderModelEffortToken(model, effort, { mode: 'glyph' }),
        min: renderModelEffortToken(model, undefined, { mode: 'glyph' }),
      },
    };
  }

  return {
    id: 'identity',
    priority: MODULE_PRIORITY.identity,
    group: 'who',
    variants: {
      full: renderModelEffortToken(model, effort, { mode: 'both' }),
      short: renderModelEffortToken(model, effort, { mode: 'glyph' }),
      min: renderModelEffortToken(model, undefined, { mode: 'glyph' }),
    },
  };
}

/**
 * What the session is doing.
 *
 * Idle, interrupted and failed are a single mark: there is nothing else to
 * say. A working turn is the one state a reader wants detail about, so the
 * widest form names the running tool and how long the turn has been going.
 * Both halves are omitted when the evidence for them is missing rather than
 * guessed at, and the narrow forms fall back to the mark alone.
 */
function activityModule(data: HudData, glyphs: GlyphMode, nowMs: number): BarModule {
  const status = data.stale ? 'stale' : data.activity?.state;
  if (!status) return { id: 'activity', priority: MODULE_PRIORITY.activity, group: 'who', variants: {} };
  const [glyph, label, paint] = {
    working: ['▸', 'Working', theme.info],
    idle: ['✓', 'Idle', theme.success],
    interrupted: ['■', 'Interrupted', theme.warning],
    error: ['✗', 'Failed', theme.error],
    stale: ['?', 'Sync delayed', theme.warning],
  }[status] as [string, string, (text: string) => string];
  const mark = paint(glyphs === 'text' ? label : glyph);

  if (status !== 'working') {
    return { id: 'activity', priority: MODULE_PRIORITY.activity, group: 'who',
      variants: { full: mark, min: mark } };
  }

  const running = [...(data.toolActivity?.recentCalls ?? [])].reverse().find((call) => call.status === 'running');
  const tool = running
    ? ` ${theme.value(running.name)}${running.target ? colors.dim(`: ${truncate(running.target, 20)}`) : ''}`
    : '';
  const turnStartedAt = data.activity?.turnStartedAt;
  const elapsed = turnStartedAt ? formatElapsedShort(turnStartedAt, nowMs) : '';
  return {
    id: 'activity',
    priority: MODULE_PRIORITY.activity,
    group: 'who',
    variants: {
      full: `${mark}${tool}${elapsed ? colors.dim(`${tool ? ' · ' : ' '}${elapsed}`) : ''}`,
      short: elapsed ? `${mark} ${colors.dim(elapsed)}` : mark,
      min: mark,
    },
  };
}

function projectModule(data: HudData): BarModule {
  const name = data.project.projectName;
  const branch = data.git.isGitRepo ? data.git.branch : null;
  const dirty = data.git.isDirty ? icons.dirty : '';
  const sync = [
    data.git.ahead > 0 ? `${icons.ahead}${data.git.ahead}` : '',
    data.git.behind > 0 ? `${icons.behind}${data.git.behind}` : '',
  ].join('');

  if (!branch) {
    return {
      id: 'project',
      priority: MODULE_PRIORITY.project,
      group: 'who',
      variants: {
        full: theme.projectName(name),
        short: theme.projectName(truncate(name, 16)),
        min: theme.projectName(truncate(name, 8)),
      },
    };
  }

  const branchFull = `${branch}${dirty ? ` ${dirty}` : ''}${sync ? ` ${sync}` : ''}`;
  // A repository inside the project folder is named after it: "shenlun › Learn-to-Write".
  const repo = data.git.repo;
  const where = repo ? `${theme.projectName(name)} ${colors.dim('›')} ${theme.projectName(repo)}` : theme.projectName(name);
  return {
    id: 'project',
    priority: MODULE_PRIORITY.project,
    group: 'who',
    variants: {
      full: `${where} ${theme.gitPrefix('git:(')}${theme.gitBranch(branchFull)}${theme.gitPrefix(')')}`,
      short: `${theme.projectName(truncate(repo ?? name, 16))} ${theme.gitBranch(`${branch}${dirty}`)}`,
      min: theme.gitBranch(truncate(`${branch}${dirty}`, 12)),
    },
  };
}

function contextModule(data: HudData, barWidth: number, meter: (percent: number, cells: number) => string = coloredBar): BarModule {
  const usage = data.contextUsage;
  if (!usage || usage.total <= 0) {
    return { id: 'context', priority: MODULE_PRIORITY.context, group: 'load', variants: {} };
  }
  const percent = usage.percent;
  const remaining = displayConfig().context === 'remaining';
  const number = getContextColor(percent)(remaining ? `${100 - percent}% left` : `${percent}%`);
  const newerActivity = Math.max(data.activity?.turnStartedAt?.getTime() ?? 0, usage.lastCompactTime?.getTime() ?? 0);
  const pending = data.stale || (newerActivity > 0 && (data.tokenUsageAt?.getTime() ?? 0) < newerActivity);
  const label = colors.dim(pending ? 'Ctx~' : 'Ctx');
  const compact = usage.compactCount > 0 ? colors.dim(` ${icons.refresh}${usage.compactCount}`) : '';
  const totals = colors.dim(` (${formatTokenCount(usage.used)}/${formatTokenCount(usage.total)})`);
  return {
    id: 'context',
    priority: MODULE_PRIORITY.context,
    group: 'load',
    variants: {
      full: `${label} ${meter(percent, barWidth)} ${number}${totals}${compact}`,
      short: `${label} ${meter(percent, Math.min(6, barWidth))} ${number}`,
      min: `${label} ${number}`,
    },
  };
}

// A user-facing 30-minute reminder, not a server-reported cache expiry.
// Only model usage advances the anchor; polling, tools and UI activity do not.
function cacheModule(data: HudData, nowMs: number, glyphs: GlyphMode): BarModule {
  const sampledAt = data.tokenUsageAt?.getTime();
  if (sampledAt === undefined || !Number.isFinite(sampledAt) || !Number.isFinite(nowMs)) {
    return { id: 'cache', priority: MODULE_PRIORITY.cache, group: 'load', variants: {} };
  }
  const minutes = Math.max(0, Math.floor((nowMs - sampledAt) / 60_000));
  const warning = minutes >= 25;
  const expired = minutes >= 30;
  const age = expired ? '30m+' : `${String(minutes).padStart(2, '0')}m`;
  const marker = data.stale ? '?' : '~';
  const text = `${glyphs === 'text' ? 'Cache ' : '◷'}${marker}${age}`;
  const paint = expired ? theme.error : warning || data.stale ? theme.warning : colors.dim;
  return {
    id: 'cache',
    priority: warning ? 96 : MODULE_PRIORITY.cache,
    group: 'load',
    pinned: warning,
    variants: { full: paint(text), min: paint(text) },
  };
}

function tasksModule(data: HudData): BarModule {
  const plan = data.planProgress;
  if (!plan || plan.totalSteps <= 0) {
    // No structured plan means no progress to show. Nothing is invented here.
    return { id: 'tasks', priority: MODULE_PRIORITY.tasks, group: 'usage', variants: {} };
  }
  const done = plan.completedSteps;
  const total = plan.totalSteps;
  const percent = Math.round((done / total) * 100);
  const current = plan.steps.find((step) => step.status === 'in_progress');
  const currentText = current ? colors.dim(` · ${truncate(current.step, 24)}`) : '';
  // Which step is running matters more than the meter, so the shorter form
  // keeps the step and drops the bar rather than the other way round.
  const currentShort = current ? colors.dim(` · ${truncate(current.step, 16)}`) : '';
  return {
    id: 'tasks',
    priority: MODULE_PRIORITY.tasks,
    group: 'usage',
    variants: {
      full: `${colors.dim('Tasks')} ${completionBar(percent, 6)} ${theme.value(`${done}/${total}`)}${currentText}`,
      short: `${theme.value(`${done}/${total}`)}${currentShort}`,
      min: theme.value(`${done}/${total}`),
    },
  };
}

function agentsModule(data: HudData): BarModule {
  const summary = summarizeSubagents(data.subagentTree?.nodes ?? []);
  if (summary.total === 0) {
    return { id: 'agents', priority: MODULE_PRIORITY.agents, group: 'load', variants: {} };
  }

  const full: string[] = [];
  if (summary.active > 0) full.push(theme.info(`${summary.active} run`));
  if (summary.completed > 0) full.push(theme.success(`${summary.completed} ok`));
  if (summary.failed > 0) full.push(theme.error(`${summary.failed} fail`));
  if (summary.unknown > 0) full.push(colors.dim(`${summary.unknown} ?`));

  const short: string[] = [];
  if (summary.active > 0) short.push(theme.info(String(summary.active)) + colors.dim(icons.running));
  if (summary.failed > 0) short.push(theme.error(String(summary.failed)) + theme.error(icons.cross));
  if (short.length === 0) short.push(theme.success(`${summary.completed}${icons.check}`));

  return {
    id: 'agents',
    priority: MODULE_PRIORITY.agents,
    group: 'load',
    variants: {
      full: `${colors.dim('Agents')} ${full.join(colors.dim(' · '))}`,
      short: `${colors.dim('Agents')} ${short.join(' ')}`,
      min: short.join(''),
    },
  };
}

function quotaModule(data: HudData, nowMs: number): BarModule {
  const windows = readQuotaWindows(data.rateLimits, nowMs);
  if (windows.length === 0) {
    // No quota snapshot means no quota field, rather than a bar reading zero.
    return { id: 'quota', priority: MODULE_PRIORITY.quota, group: 'usage', variants: {} };
  }

  const rendered = windows.map((window) => {
    const label = window.label ? colors.dim(window.label) + ' ' : '';
    return `${label}${coloredPercent(window.percent)}`;
  });

  // The countdown belongs to the window closest to running out.
  const soonest = windows
    .filter((window) => window.resetsAt && !window.resetDue)
    .sort((a, b) => (a.resetsAt!.getTime() - b.resetsAt!.getTime()))[0];
  const overdue = windows.find((window) => window.resetDue);
  const reset = soonest
    ? colors.dim(` · resets in ${formatCountdown(soonest.resetsAt!, nowMs)}`)
    : overdue
      // The clock ran out but no newer snapshot has arrived. Saying the quota
      // is back would be a guess, so the HUD only says the reset is due.
      ? colors.dim(' · reset due')
      : '';

  const first = windows[0];
  // The countdown is the half of the quota field a reader acts on, so it
  // survives into the shorter form as a bare symbol and a duration.
  const shortReset = soonest ? colors.dim(` ↺${formatCountdown(soonest.resetsAt!, nowMs)}`) : '';
  return {
    id: 'quota',
    priority: MODULE_PRIORITY.quota,
    group: 'usage',
    variants: {
      full: `${colors.dim('Quota')} ${rendered.join(colors.dim(' · '))}${reset}`,
      short: `${colors.dim(`Q${first.label}`)} ${coloredPercent(first.percent)}${shortReset}`,
      min: `${colors.dim('Q')}${coloredPercent(first.percent)}`,
    },
  };
}

function speedModule(data: HudData, nowMs: number): BarModule {
  if (data.stale || (data.activity?.state === 'working' &&
      (data.outputRate?.sampledAt.getTime() ?? 0) < (data.activity.turnStartedAt?.getTime() ?? 0))) {
    return { id: 'speed', priority: MODULE_PRIORITY.speed, group: 'usage', variants: {} };
  }
  const rate = formatTokenRate(data.outputRate, nowMs);
  return { id: 'speed', priority: MODULE_PRIORITY.speed, group: 'usage',
    variants: rate ? { full: `${colors.dim('Out')} ${theme.value(rate)}`, short: theme.value(rate) } : {} };
}

function tokensModule(data: HudData): BarModule {
  const usage = data.tokenUsage?.total_token_usage ?? data.tokenUsage?.last_token_usage;
  if (!usage) {
    return { id: 'tokens', priority: MODULE_PRIORITY.tokens, group: 'usage', variants: {} };
  }
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const cacheRate = input > 0 ? Math.round((cached / input) * 100) : null;
  const total = formatTokenCount(usage.total_tokens ?? 0);
  return {
    id: 'tokens',
    priority: MODULE_PRIORITY.tokens,
    group: 'usage',
    variants: {
      full: `${colors.dim('Tokens')} ${theme.tokenCount(total)}${cacheRate === null ? '' : colors.dim(` (cache ${cacheRate}%)`)}`,
      short: `${colors.dim('Tokens')} ${theme.tokenCount(total)}`,
      min: theme.tokenCount(total),
    },
  };
}

function timerModule(data: HudData, nowMs: number): BarModule {
  const startTime = data.session?.startTime ?? data.sessionStart;
  const duration = formatDuration(startTime, nowMs);
  return {
    id: 'timer',
    priority: MODULE_PRIORITY.timer,
    group: 'meta',
    align: 'right',
    variants: {
      full: colors.dim(`${icons.clock} ${duration}`),
      short: colors.dim(duration),
    },
  };
}

function environmentModule(data: HudData): BarModule {
  const approval = getApprovalPolicyDisplayValue(
    data.runtimeSession?.approvalPolicy ?? data.session?.approvalPolicy ?? data.config.approval_policy
  );
  const sandbox = data.runtimeSession?.sandboxMode ?? data.session?.sandboxMode ?? data.config.sandbox_mode;
  const mode = data.runtimeSession?.collaborationMode ?? data.session?.collaborationMode;

  // The sandbox names are long and the dangerous one must stay recognisable
  // even in the abbreviated form.
  const shortSandbox = (value: string): string =>
    value === 'danger-full-access' ? 'DANGER' : value === 'workspace-write' ? 'ws-write' : value === 'read-only' ? 'ro' : value;
  const paintSandbox = (value: string): string =>
    value === 'danger-full-access' ? theme.error('DANGER') : value === 'workspace-write' ? theme.warning('ws-write') : theme.info(value);

  const parts: string[] = [];
  if (mode && mode !== 'default') {
    parts.push(theme.warning(mode));
  }
  parts.push(colors.dim('Approval: ') + theme.value(approval));
  if (sandbox) {
    parts.push(colors.dim('Sandbox: ') + paintSandbox(sandbox));
  }
  if (data.project.extensionsCount > 0) {
    parts.push(colors.dim('MCP: ') + theme.info(String(data.project.extensionsCount)));
  }

  return {
    id: 'environment',
    priority: MODULE_PRIORITY.environment,
    group: 'meta',
    align: 'right',
    variants: {
      full: parts.join(colors.dim(' · ')),
      short: [
        colors.dim(approval),
        sandbox ? (sandbox === 'danger-full-access' ? theme.error('DANGER') : colors.dim(shortSandbox(sandbox))) : '',
      ]
        .filter(Boolean)
        .join(colors.dim('/')),
    },
  };
}

function sessionModule(data: HudData): BarModule {
  const id = data.session?.id;
  if (!id) {
    return { id: 'session', priority: MODULE_PRIORITY.session, group: 'meta', align: 'right', variants: {} };
  }
  const shortId = id.length > 8 ? id.slice(0, 8) : id;
  return {
    id: 'session',
    priority: MODULE_PRIORITY.session,
    group: 'meta',
    align: 'right',
    variants: {
      full: colors.dim('Session: ') + theme.info(shortId),
      short: theme.info(shortId),
    },
  };
}

export interface BarModuleOptions {
  nowMs?: number;
  barWidth?: number;
  density?: Density;
  glyphs?: GlyphMode;
  /** Draws the context meter; the bar's block meter by default. */
  meter?: (percent: number, cells: number) => string;
}

/**
 * Build the bar in display order. Order here is reading order; importance is
 * carried separately by each module's priority.
 */
export function buildBarModules(data: HudData, options: BarModuleOptions = {}): BarModule[] {
  const nowMs = options.nowMs ?? Date.now();
  const barWidth = options.barWidth ?? 10;
  const density = options.density ?? displayConfig().density;
  const glyphs = options.glyphs ?? displayConfig().glyphs;
  const allowed = new Set<string>(DENSITY_MODULES[density] ?? DENSITY_MODULES.balanced);

  const modules: BarModule[] = [
    attentionModule(data, nowMs),
    activityModule(data, glyphs, nowMs),
    identityModule(data, glyphs),
    projectModule(data),
    agentsModule(data),
    contextModule(data, barWidth, options.meter),
    cacheModule(data, nowMs, glyphs),
    tasksModule(data),
    quotaModule(data, nowMs),
    tokensModule(data),
    speedModule(data, nowMs),
    timerModule(data, nowMs),
    environmentModule(data),
    sessionModule(data),
  ];

  return modules.filter((module) => allowed.has(module.id));
}

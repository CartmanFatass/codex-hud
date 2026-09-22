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
  hint: 12,
} as const;

/**
 * Which fields each preset is allowed to show. Narrowing further is the
 * layout engine's job; this is about what the user asked to see at all.
 */
const DENSITY_MODULES: Record<Density, ReadonlyArray<keyof typeof MODULE_PRIORITY>> = {
  focus: ['attention', 'activity', 'identity', 'project', 'agents', 'context', 'cache', 'hint'],
  balanced: ['attention', 'activity', 'identity', 'project', 'agents', 'context', 'cache', 'tasks', 'quota', 'speed', 'timer', 'hint'],
  full: Object.keys(MODULE_PRIORITY) as Array<keyof typeof MODULE_PRIORITY>,
};

function formatDuration(startTime: Date, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - startTime.getTime()) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
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
      variants: {
        full: renderModelEffortToken(model, effort, { mode: 'glyph' }),
        min: renderModelEffortToken(model, undefined, { mode: 'glyph' }),
      },
    };
  }

  return {
    id: 'identity',
    priority: MODULE_PRIORITY.identity,
    variants: {
      full: renderModelEffortToken(model, effort, { mode: 'both' }),
      short: renderModelEffortToken(model, effort, { mode: 'glyph' }),
      min: renderModelEffortToken(model, undefined, { mode: 'glyph' }),
    },
  };
}

function activityModule(data: HudData, glyphs: GlyphMode): BarModule {
  const status = data.stale ? 'stale' : data.activity?.state;
  if (!status) return { id: 'activity', priority: MODULE_PRIORITY.activity, variants: {} };
  const [glyph, label, paint] = {
    working: ['▸', 'Working', theme.info],
    idle: ['✓', 'Idle', theme.success],
    interrupted: ['■', 'Interrupted', theme.warning],
    error: ['✗', 'Failed', theme.error],
    stale: ['?', 'Sync delayed', theme.warning],
  }[status] as [string, string, (text: string) => string];
  return { id: 'activity', priority: MODULE_PRIORITY.activity,
    variants: { full: paint(glyphs === 'text' ? label : glyph), min: paint(glyphs === 'text' ? label : glyph) } };
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
      variants: {
        full: theme.projectName(name),
        short: theme.projectName(truncate(name, 16)),
        min: theme.projectName(truncate(name, 8)),
      },
    };
  }

  const branchFull = `${branch}${dirty ? ` ${dirty}` : ''}${sync ? ` ${sync}` : ''}`;
  return {
    id: 'project',
    priority: MODULE_PRIORITY.project,
    variants: {
      full: `${theme.projectName(name)} ${theme.gitPrefix('git:(')}${theme.gitBranch(branchFull)}${theme.gitPrefix(')')}`,
      short: `${theme.projectName(truncate(name, 16))} ${theme.gitBranch(`${branch}${dirty}`)}`,
      min: theme.gitBranch(truncate(`${branch}${dirty}`, 12)),
    },
  };
}

function contextModule(data: HudData, barWidth: number): BarModule {
  const usage = data.contextUsage;
  if (!usage || usage.total <= 0) {
    return { id: 'context', priority: MODULE_PRIORITY.context, variants: {} };
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
    variants: {
      full: `${label} ${coloredBar(percent, barWidth)} ${number}${totals}${compact}`,
      short: `${label} ${coloredBar(percent, Math.min(6, barWidth))} ${number}`,
      min: `${label} ${number}`,
    },
  };
}

// A user-facing 30-minute reminder, not a server-reported cache expiry.
// Only model usage advances the anchor; polling, tools and UI activity do not.
function cacheModule(data: HudData, nowMs: number, glyphs: GlyphMode): BarModule {
  const sampledAt = data.tokenUsageAt?.getTime();
  if (sampledAt === undefined || !Number.isFinite(sampledAt) || !Number.isFinite(nowMs)) {
    return { id: 'cache', priority: MODULE_PRIORITY.cache, variants: {} };
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
    pinned: warning,
    variants: { full: paint(text), min: paint(text) },
  };
}

function tasksModule(data: HudData): BarModule {
  const plan = data.planProgress;
  if (!plan || plan.totalSteps <= 0) {
    // No structured plan means no progress to show. Nothing is invented here.
    return { id: 'tasks', priority: MODULE_PRIORITY.tasks, variants: {} };
  }
  const done = plan.completedSteps;
  const total = plan.totalSteps;
  const percent = Math.round((done / total) * 100);
  const current = plan.steps.find((step) => step.status === 'in_progress');
  const currentText = current ? colors.dim(` · ${truncate(current.step, 24)}`) : '';
  return {
    id: 'tasks',
    priority: MODULE_PRIORITY.tasks,
    variants: {
      full: `${colors.dim('Tasks')} ${completionBar(percent, 6)} ${theme.value(`${done}/${total}`)}${currentText}`,
      short: `${colors.dim('Tasks')} ${theme.value(`${done}/${total}`)}`,
      min: theme.value(`${done}/${total}`),
    },
  };
}

function agentsModule(data: HudData): BarModule {
  const summary = summarizeSubagents(data.subagentTree?.nodes ?? []);
  if (summary.total === 0) {
    return { id: 'agents', priority: MODULE_PRIORITY.agents, variants: {} };
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
    return { id: 'quota', priority: MODULE_PRIORITY.quota, variants: {} };
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
  return {
    id: 'quota',
    priority: MODULE_PRIORITY.quota,
    variants: {
      full: `${colors.dim('Quota')} ${rendered.join(colors.dim(' · '))}${reset}`,
      short: `${colors.dim(`Q${first.label}`)} ${coloredPercent(first.percent)}`,
      min: `${colors.dim('Q')}${coloredPercent(first.percent)}`,
    },
  };
}

function speedModule(data: HudData, nowMs: number): BarModule {
  if (data.stale || (data.activity?.state === 'working' &&
      (data.outputRate?.sampledAt.getTime() ?? 0) < (data.activity.turnStartedAt?.getTime() ?? 0))) {
    return { id: 'speed', priority: MODULE_PRIORITY.speed, variants: {} };
  }
  const rate = formatTokenRate(data.outputRate, nowMs);
  return { id: 'speed', priority: MODULE_PRIORITY.speed,
    variants: rate ? { full: `${colors.dim('Out')} ${theme.value(rate)}`, short: theme.value(rate) } : {} };
}

function tokensModule(data: HudData): BarModule {
  const usage = data.tokenUsage?.total_token_usage ?? data.tokenUsage?.last_token_usage;
  if (!usage) {
    return { id: 'tokens', priority: MODULE_PRIORITY.tokens, variants: {} };
  }
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const cacheRate = input > 0 ? Math.round((cached / input) * 100) : null;
  const total = formatTokenCount(usage.total_tokens ?? 0);
  return {
    id: 'tokens',
    priority: MODULE_PRIORITY.tokens,
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
    return { id: 'session', priority: MODULE_PRIORITY.session, variants: {} };
  }
  const shortId = id.length > 8 ? id.slice(0, 8) : id;
  return {
    id: 'session',
    priority: MODULE_PRIORITY.session,
    variants: {
      full: colors.dim('Session: ') + theme.info(shortId),
      short: theme.info(shortId),
    },
  };
}

function hintModule(data: HudData): BarModule {
  const hasAgents = (data.subagentTree?.nodes.length ?? 0) > 0;
  return {
    id: 'hint',
    priority: MODULE_PRIORITY.hint,
    variants: {
      full: colors.dim(hasAgents ? 'F12 tree' : 'F12'),
      short: colors.dim('F12'),
    },
  };
}

export interface BarModuleOptions {
  nowMs?: number;
  barWidth?: number;
  density?: Density;
  glyphs?: GlyphMode;
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
    activityModule(data, glyphs),
    identityModule(data, glyphs),
    projectModule(data),
    agentsModule(data),
    contextModule(data, barWidth),
    cacheModule(data, nowMs, glyphs),
    tasksModule(data),
    quotaModule(data, nowMs),
    tokensModule(data),
    speedModule(data, nowMs),
    timerModule(data, nowMs),
    environmentModule(data),
    sessionModule(data),
    hintModule(data),
  ];

  return modules.filter((module) => allowed.has(module.id));
}

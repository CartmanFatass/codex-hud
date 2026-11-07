import { nativeCallsOnly } from '../../core/link/view-model.js';
import { hudProblems } from '../hud-diagnostics.js';
/**
 * The status bar's fields, each one declared with its importance and with
 * shorter ways to say itself.
 *
 * The bar reads left to right without gaps: what the session runs on (the
 * model and its effort, the context held against the model's whole window,
 * the repository and its branch, the account's usage), then the main session
 * now (its state and clock, its output rate, its agents and its plan). The
 * notice zone takes the columns that are left: an alert that needs the
 * person, else what just happened, else the tool at work. On the right, what
 * Codex loaded: MCP servers, skills and hooks.
 *
 * Two rules run through this file. A field that has no trustworthy data
 * renders as an empty string and is skipped, so nothing shows a zero it does
 * not have. And a field whose words change length while the session runs
 * reserves its columns, so the bar holds still: nothing beside it moves, and
 * the fit never picks different forms because a tool name grew.
 */

import type { BarNotice, HudData } from '../../types.js';
import { colors, getContextColor, icons, METER_DANGER, METER_WARN, theme, truncate, visualLength } from '../colors.js';
import { formatTokenCount } from '../lines/index.js';
import { collectAttention, highestSeverity, alertParts, type AttentionItem } from '../attention.js';
import { agentCounts } from '../../collectors/subagent-tree.js';
import { actionText } from '../../collectors/agent-stages.js';
import { getApprovalPolicyDisplayValue } from '../../collectors/codex-config.js';
import { displayConfig, iconSet, type Density } from '../hud-config.js';
import { formatCredits, quotaState, readQuotaWindows } from '../quota.js';
import { age, idleFor } from '../monitor-labels.js';
import type { BarModule } from './engine.js';
import type { DelegationViewModel, HudDelegationData } from '../../core/link/view-model.js';
import { attentionForms, delegationAgentsModule, noticeSentence } from '../delegation/bar.js';
import { useAscii } from '../delegation/glyphs.js';

export const MODULE_PRIORITY = {
  attention: 100,
  // Its last form asks for no columns, so it never has to be hidden for room.
  notice: 90,
  activity: 94,
  context: 93,
  identity: 92,
  project: 88,
  quota: 86,
  agents: 70,
  speed: 64,
  tasks: 60,
  config: 40,
  environment: 30,
  tokens: 26,
  session: 24,
} as const;

/**
 * The order in which forms shorten, lowest first, where it is not the order
 * of hiding: as the pane narrows the right cluster leaves first, then the
 * effort, the context meter, the notice zone's claim to its room (it is then
 * cut to what is left), the agents' label, the branch and the turn's clock.
 * These steps take their turns among the hides (see `engine.ts`).
 */
const SHRINK = {
  // An alert keeps its words until the project has gone.
  attention: 89,
  session: 10,
  tokens: 12,
  environment: 15,
  config: 20,
  identity: 50,
  context: 52,
  notice: 54,
  agents: 56,
  project: 58,
  // The turn's clock outlasts the branch.
  activity: 59,
} as const;

/**
 * Which fields each preset is allowed to show. Narrowing further is the
 * layout engine's job; this is about what the user asked to see at all.
 */
const DENSITY_MODULES: Record<Density, ReadonlyArray<keyof typeof MODULE_PRIORITY>> = {
  focus: ['attention', 'notice', 'activity', 'identity', 'context', 'project'],
  balanced: [
    'attention',
    'notice',
    'activity',
    'identity',
    'context',
    'project',
    'quota',
    'speed',
    'agents',
    'tasks',
    'config',
  ],
  full: Object.keys(MODULE_PRIORITY) as Array<keyof typeof MODULE_PRIORITY>,
};

/** Columns the state keeps: its mark and a five-column clock, or `✓ idle`. */
const STATE_COLUMNS = 1 + 1 + 5;
const RATE_COLUMNS = 9;
/** How long something that just happened is told in full colour before the tool at work has the zone again. */
export const NOTICE_FRESH_MS = 60_000;

/** Below the warning line a reading is plain text; colour on the bar means something to look at. */
function signal(percent: number): (text: string) => string {
  return percent >= METER_DANGER ? theme.error : percent >= METER_WARN ? theme.warning : theme.value;
}

function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visualLength(text))) + text;
}

/** A turn's clock in five columns at most: 0:07, 12:34, then 1h05. */
export function turnClock(startTime: Date, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startTime.getTime()) / 1000));
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

/** What the person has to act on: an approval waiting, or something that failed. The bar's numbers already turn red for a full context or a spent quota. */
const BAR_ALERTS = new Set<AttentionItem['kind']>([
  'approval',
  'tool-error',
  'agent-error',
  'subtask-error',
  'review-error',
]);

/**
 * The failures of the bar's own tree: with a delegation tree they are nodes of it and light its alerts instead.
 * §4.1 counts per node, so one failed agent must not read `✗2`; only the delegation tree's alerts speak for
 * failures, and approvals and tool errors stay the bar's own (design rulings B10b s1, Q10).
 */
const TREE_FAILURES = new Set<AttentionItem['kind']>(['agent-error', 'subtask-error', 'review-error']);

/** Columns from which the full density adds the backend counts to the agents (design §0.2). */
const BACKEND_COUNTS_FROM = 160;

/** What the delegation parts of the bar need, when there is a delegation tree to show. */
interface DelegationBar {
  vm: DelegationViewModel;
  ascii: boolean;
  backends: boolean;
  /** The focus density keeps the counts without their label (design §4.1). */
  countsOnly: boolean;
}

/**
 * With a delegation tree the attention badge keeps its words (`⚑ 1 approval`, then `⚑1`) until the quota has
 * gone, and the agents' counts outlast the quota: the alert's two shortening steps come at 85 and 87 and the
 * counts hide at priority 87 (design §4.1 80-column samples, rulings B10b s1 "Samples"). Without a tree the
 * legacy order stands.
 */
const TREE_ATTENTION_SHRINK = { full: 85, short: 87 } as const;
const TREE_AGENTS_PRIORITY = 87;

/** The bar's own alerts that the attention badge counts beside the delegation tree's. */
function legacyAlertCounts(data: HudData, nowMs: number): { flag: number; fail: number } {
  const items = collectAttention(data, nowMs).filter(
    (item) => BAR_ALERTS.has(item.kind) && !TREE_FAILURES.has(item.kind)
  );
  return {
    flag: items.filter((item) => item.kind === 'approval').length,
    fail: items.filter((item) => item.severity === 'error').length,
  };
}

function attentionModule(data: HudData, nowMs: number, delegation: DelegationBar | null = null): BarModule {
  const items = collectAttention(data, nowMs).filter(
    (item) => BAR_ALERTS.has(item.kind) && !(delegation && TREE_FAILURES.has(item.kind))
  );
  const base = {
    id: 'attention',
    priority: MODULE_PRIORITY.attention,
    shrink: SHRINK.attention,
    ...(delegation ? { shrinkByLevel: TREE_ATTENTION_SHRINK } : {}),
    group: 'notice',
    // With a delegation tree the alert leads the line (design §4.1 samples), not the fill zone.
    align: delegation ? ('left' as const) : ('fill' as const),
    pinned: true,
  };
  const forms = delegation
    ? attentionForms(delegation.vm, nowMs, delegation.ascii, {
        flag: items.filter((item) => item.kind === 'approval').length,
        fail: items.filter((item) => item.severity === 'error').length,
      })
    : null;
  if (forms) {
    return {
      ...base,
      variants: {
        full: theme.alert(` ${forms.full} `),
        short: theme.alert(` ${forms.short} `),
        min: theme.alert(` ${forms.min} `),
      },
    };
  }
  if (items.length === 0) {
    return { ...base, variants: {} };
  }
  const mark = highestSeverity(items) === 'error' ? icons.cross : '!';
  // An approval says how long it has waited: a minute and an hour ask for
  // different haste. The failures are one phrase, as the status card says them.
  const parts = alertParts(items, nowMs);
  return {
    ...base,
    variants: {
      full: theme.alert(` ${mark} ${parts.join(' · ')} `),
      // Narrower, the first phrase alone: the wait is the first thing to go.
      short: theme.alert(` ${mark} ${alertParts(items, nowMs, undefined, false)[0]} `),
      min: theme.alert(parts.length > 1 ? ` ${mark}${parts.length} ` : ` ${mark} `),
    },
  };
}

/** The model by its name and the effort beside it, dim; narrower, the name alone. */
function identityModule(data: HudData): BarModule {
  const model = data.session?.model ?? data.config.model;
  const effort = data.session?.reasoningEffort ?? data.config.model_reasoning_effort;
  if (!model) return { id: 'identity', priority: MODULE_PRIORITY.identity, group: 'model', variants: {} };
  const name = theme.model(model);
  return {
    id: 'identity',
    priority: MODULE_PRIORITY.identity,
    shrink: SHRINK.identity,
    group: 'model',
    variants: { full: effort ? `${name} ${colors.dim(effort)}` : name, short: name },
  };
}

/**
 * What the session is doing, in a slot of fixed width: the mark and the
 * turn's clock while it works, `✓ idle` once it waits on the person (how long
 * is in the notice zone, with the turn that ended). Interrupted and failed
 * are the mark and its word. The tool at work is the notice zone's.
 */
function activityModule(data: HudData, words: boolean, nowMs: number): BarModule {
  const base = {
    id: 'activity',
    priority: MODULE_PRIORITY.activity,
    shrink: SHRINK.activity,
    group: 'state',
    reserve: { full: words ? STATE_COLUMNS + 6 : STATE_COLUMNS },
  };
  const problem = hudProblems(data, nowMs)[0];
  if (problem) return { ...base, variants: { full: theme.warning(`! ${problem}`), short: theme.warning('! HUD') } };
  const status = data.stale ? 'stale' : data.activity?.state;
  if (!status) return { ...base, variants: {} };
  const [glyph, label, paint] = {
    working: ['▸', 'Working', theme.info],
    idle: ['✓', 'Idle', theme.success],
    interrupted: ['■', 'Interrupted', theme.warning],
    error: ['✗', 'Failed', theme.error],
    stale: ['?', 'Sync delayed', theme.warning],
  }[status] as [string, string, (text: string) => string];
  const mark = paint(words ? label : glyph);
  if (status !== 'working') {
    return {
      ...base,
      variants: {
        full:
          words || status === 'idle'
            ? `${mark}${words ? '' : ` ${colors.dim('idle')}`}`
            : `${mark} ${colors.dim(label)}`,
        short: mark,
      },
    };
  }
  const turnStartedAt = data.activity?.turnStartedAt;
  const clock = turnStartedAt ? theme.value(padStart(turnClock(turnStartedAt, nowMs), 5)) : '';
  return { ...base, variants: { full: clock ? `${mark} ${clock}` : mark, short: mark } };
}

/** A notice in words: its mark, what happened, and how long ago, dim. Stale, all of it dim. */
function noticeText(notice: BarNotice, nowMs: number, fresh: boolean): string {
  const ago = colors.dim(` · ${age(notice.at, nowMs)} ago`);
  const [mark, paint, words] = {
    'agent-done': ['✓', theme.success, `${notice.subject ?? 'agent'} finished`],
    'agent-failed': [icons.cross, theme.error, `${notice.subject ?? 'agent'} failed`],
    'turn-done': [
      '✓',
      theme.success,
      `turn done${notice.durationMs !== undefined ? ` in ${turnClock(new Date(0), notice.durationMs)}` : ''}`,
    ],
    credits: ['◆', theme.warning, 'window spent, on credits now'],
  }[notice.kind] as [string, (text: string) => string, string];
  const clean = words.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return fresh
    ? `${paint(mark)} ${theme.value(clean)}${ago}`
    : colors.dim(`${mark} ${clean} · ${age(notice.at, nowMs)} ago`);
}

/**
 * The notice zone's text: what just happened, in colour for a minute; else,
 * while a turn runs, the tool at work and what it works on, dim; else the
 * last thing that happened, dim, with how long ago.
 */
function noticeLine(data: HudData, nowMs: number, delegation: DelegationBar | null = null): string {
  const latest = data.notices?.[0];
  // A delegation event of the last minute is told if it is newer than the bar's own.
  const told = delegation
    ? noticeSentence(delegation.vm, nowMs, delegation.ascii, legacyAlertCounts(data, nowMs))
    : null;
  if (told && !(latest && nowMs - latest.at.getTime() < NOTICE_FRESH_MS && latest.at.getTime() > told.at))
    return told.text;
  if (latest && nowMs - latest.at.getTime() < NOTICE_FRESH_MS) return noticeText(latest, nowMs, true);
  if (data.activity?.state === 'working' && !data.stale) {
    const calls = data.toolActivity?.recentCalls ?? [];
    const call = [...calls].reverse().find((entry) => entry.status === 'running') ?? calls.at(-1);
    if (call) {
      const code = call.arguments?.code;
      const action = call.target ?? actionText(call.name, typeof code === 'string' ? code : call.arguments);
      const target = (action === call.name ? '' : action).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
      return colors.dim(target ? `${call.name} ${target}` : call.name);
    }
  }
  return latest ? noticeText(latest, nowMs, false) : '';
}

/**
 * The notice zone. Its full form asks for a fixed share of the line, so the
 * right cluster, the effort and the meter make way for it and stay put while
 * its words change; its last form, the same words, asks for none and is cut
 * to whatever the line leaves.
 */
function noticeModule(data: HudData, nowMs: number, delegation: DelegationBar | null = null): BarModule {
  const text = noticeLine(data, nowMs, delegation);
  return {
    id: 'notice',
    priority: MODULE_PRIORITY.notice,
    shrink: SHRINK.notice,
    group: 'notice',
    align: 'fill',
    flex: true,
    variants: { full: text, min: text },
  };
}

/**
 * The context the last request held against the model's whole window, as
 * Codex reported them, with a meter before it. Below the warning line the
 * meter is the scale's colour and the numbers plain; past it both turn.
 */
function contextModule(data: HudData, cells: number): BarModule {
  const usage = data.contextUsage;
  const used = usage?.inContext ?? usage?.used;
  const window = usage?.window ?? usage?.total;
  if (used === undefined || !window || window <= 0) {
    return { id: 'context', priority: MODULE_PRIORITY.context, group: 'context', variants: {} };
  }
  const percent = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
  const paint = signal(percent);
  const numbers = `${paint(padStart(formatTokenCount(used), 6))}${colors.dim(`/${formatTokenCount(window)}`)}`;
  const halves = percent > 0 ? Math.max(1, Math.round((percent / 100) * cells * 2)) : 0;
  const fill = '━'.repeat(Math.floor(halves / 2)) + (halves % 2 ? '╸' : '');
  const meter =
    (percent >= METER_WARN ? getContextColor(percent) : theme.tick)(fill) +
    theme.track('─'.repeat(Math.max(0, cells - visualLength(fill))));
  return {
    id: 'context',
    priority: MODULE_PRIORITY.context,
    shrink: SHRINK.context,
    group: 'context',
    variants: { full: `${meter} ${numbers}`, short: numbers.trimStart() },
  };
}

function projectModule(data: HudData): BarModule {
  const name = data.git.repo ?? data.project.projectName;
  const base = { id: 'project', priority: MODULE_PRIORITY.project, shrink: SHRINK.project, group: 'project' };
  const branch = data.git.isGitRepo ? data.git.branch : null;
  if (!branch) {
    return { ...base, variants: { full: theme.projectName(name), short: theme.projectName(truncate(name, 16)) } };
  }
  const dirty = data.git.isDirty ? icons.dirty : '';
  const sync = [
    data.git.ahead > 0 ? `${icons.ahead}${data.git.ahead}` : '',
    data.git.behind > 0 ? `${icons.behind}${data.git.behind}` : '',
  ].join('');
  return {
    ...base,
    variants: {
      full: `${theme.projectName(name)} ${theme.gitBranch(`${branch}${dirty}${sync}`)}`,
      short: `${theme.projectName(truncate(name, 16))} ${theme.gitBranch(`${truncate(branch, 12)}${dirty}`)}`,
      min: theme.projectName(truncate(name, 12)),
    },
  };
}

/**
 * The account's usage as one reading: the tightest window. Once it is spent
 * and credits carry the account on, the balance alone stands in its place.
 */
function quotaModule(data: HudData, nowMs: number): BarModule {
  const windows = readQuotaWindows(data.rateLimits, nowMs);
  const base = { id: 'quota', priority: MODULE_PRIORITY.quota, group: 'quota' };
  if (windows.length === 0) {
    // No quota snapshot means no quota field, rather than a reading of zero.
    return { ...base, variants: {} };
  }
  const tightest = windows.reduce((a, b) => (b.percent > a.percent ? b : a));
  const { credits } = quotaState(data.rateLimits, windows);
  const text =
    tightest.percent >= 100 && credits
      ? `${colors.dim('credits')} ${theme.value(formatCredits(credits))}`
      : `${tightest.label ? `${colors.dim(tightest.label)} ` : ''}${signal(tightest.percent)(`${tightest.percent}%`)}`;
  return { ...base, variants: { full: text } };
}

/**
 * The main session's output rate, a whole number. While a turn runs and has
 * a sample of its own it is bright; otherwise it is the last turn's, dim, and
 * stays as it was.
 */
function speedModule(data: HudData): BarModule {
  const base = { id: 'speed', priority: MODULE_PRIORITY.speed, group: 'speed', reserve: { full: RATE_COLUMNS } };
  const rate = data.outputRate;
  if (
    !rate ||
    !Number.isFinite(rate.tokensPerSecond) ||
    rate.tokensPerSecond < 0 ||
    !Number.isFinite(rate.sampledAt.getTime())
  ) {
    return { ...base, variants: {} };
  }
  const fresh =
    !data.stale &&
    data.activity?.state === 'working' &&
    rate.sampledAt.getTime() >= (data.activity.turnStartedAt?.getTime() ?? 0);
  const value = padStart(String(Math.round(rate.tokensPerSecond)), 3);
  return {
    ...base,
    variants: { full: fresh ? `${theme.value(value)} ${colors.dim('tok/s')}` : colors.dim(`${value} tok/s`) },
  };
}

function agentsModule(data: HudData, delegation: DelegationBar | null = null): BarModule {
  const base = { id: 'agents', priority: MODULE_PRIORITY.agents, shrink: SHRINK.agents, group: 'agents' };
  // With a delegation tree the whole tree is counted, every harness, by marker (design §4.1).
  if (delegation) {
    return delegationAgentsModule(
      delegation.vm,
      { ...base, priority: TREE_AGENTS_PRIORITY },
      {
        ascii: delegation.ascii,
        showBackends: delegation.backends,
        countsOnly: delegation.countsOnly,
      }
    );
  }
  // The agents the main session started, as the panel's title counts them.
  const summary = agentCounts(data.subagentTree?.nodes ?? []).agents;
  if (summary.total === 0) {
    return { ...base, variants: {} };
  }
  const counts: string[] = [];
  if (summary.active > 0) counts.push(theme.info(`${summary.active}${icons.running}`));
  if (summary.completed > 0) counts.push(theme.success(`${summary.completed}${icons.check}`));
  if (summary.failed > 0) counts.push(theme.error(`${summary.failed}${icons.cross}`));
  if (summary.unknown > 0) counts.push(colors.dim(`${summary.unknown}?`));
  return { ...base, variants: { full: `${colors.dim('Agents')} ${counts.join(' ')}`, short: counts.join(' ') } };
}

function tasksModule(data: HudData): BarModule {
  const plan = data.planProgress;
  const base = { id: 'tasks', priority: MODULE_PRIORITY.tasks, group: 'tasks' };
  if (!plan || plan.totalSteps <= 0) {
    // No structured plan means no progress to show. Nothing is invented here.
    return { ...base, variants: {} };
  }
  return {
    ...base,
    variants: { full: `${colors.dim('Tasks')} ${theme.value(`${plan.completedSteps}/${plan.totalSteps}`)}` },
  };
}

/** What Codex loaded here: MCP servers, skills and hooks, each only when there is one. */
function configModule(data: HudData): BarModule {
  const parts = (
    [
      ['MCP', data.project.mcpCount],
      ['skills', data.project.skillsCount],
      ['hooks', data.project.hooksCount],
    ] as const
  )
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([label, count]) => `${colors.dim(label)} ${theme.value(String(count))}`);
  return {
    id: 'config',
    priority: MODULE_PRIORITY.config,
    shrink: SHRINK.config,
    optional: true,
    group: 'meta',
    align: 'right',
    variants: parts.length ? { full: parts.join('  ') } : {},
  };
}

function tokensModule(data: HudData): BarModule {
  const usage = data.tokenUsage?.total_token_usage ?? data.tokenUsage?.last_token_usage;
  const base = {
    id: 'tokens',
    priority: MODULE_PRIORITY.tokens,
    shrink: SHRINK.tokens,
    optional: true,
    group: 'meta',
    align: 'right' as const,
  };
  if (!usage) {
    return { ...base, variants: {} };
  }
  return {
    ...base,
    variants: { full: `${colors.dim('Tokens')} ${theme.tokenCount(formatTokenCount(usage.total_tokens ?? 0))}` },
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
    value === 'danger-full-access'
      ? 'DANGER'
      : value === 'workspace-write'
        ? 'ws-write'
        : value === 'read-only'
          ? 'ro'
          : value;
  const paintSandbox = (value: string): string =>
    value === 'danger-full-access'
      ? theme.error('DANGER')
      : value === 'workspace-write'
        ? theme.warning('ws-write')
        : theme.info(value);

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
    shrink: SHRINK.environment,
    optional: true,
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
    return {
      id: 'session',
      priority: MODULE_PRIORITY.session,
      shrink: SHRINK.session,
      optional: true,
      group: 'meta',
      align: 'right',
      variants: {},
    };
  }
  const shortId = id.length > 8 ? id.slice(0, 8) : id;
  // A model-written title, when the labels feature wrote one: the widest
  // reading only, and the id stays beside it.
  const title = data.sessionTitle ? truncate(data.sessionTitle.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''), 28) : '';
  return {
    id: 'session',
    priority: MODULE_PRIORITY.session,
    shrink: SHRINK.session,
    optional: true,
    group: 'meta',
    align: 'right',
    variants: {
      full: title ? theme.value(title) + colors.dim(` · ${shortId}`) : colors.dim('Session: ') + theme.info(shortId),
      short: theme.info(shortId),
    },
  };
}

export interface BarModuleOptions {
  nowMs?: number;
  /** Cells in the context meter. */
  barWidth?: number;
  density?: Density;
  /** Words where a mark would stand (the activity): the icons set to text. */
  words?: boolean;
  /** The pane's columns: the agents' backend counts need 160 of them, at the full density only. */
  width?: number;
  /** Delegation marks in ASCII; defaults to the icon set. */
  ascii?: boolean;
}

/**
 * Build the bar in display order. Order here is reading
 * order; importance is carried separately by each module's priority.
 */
export function buildBarModules(data: HudData & HudDelegationData, options: BarModuleOptions = {}): BarModule[] {
  const nowMs = options.nowMs ?? Date.now();
  const barWidth = options.barWidth ?? 10;
  const density = options.density ?? displayConfig().density;
  const words = options.words ?? iconSet() === 'text';
  const allowed = new Set<string>(DENSITY_MODULES[density] ?? DENSITY_MODULES.balanced);
  // No delegation tree, or none loaded: everything below is the bar as it always was.
  const delegation: DelegationBar | null =
    data.delegation && !nativeCallsOnly(data.delegation)
      ? {
          vm: data.delegation,
          ascii: useAscii(options.ascii),
          backends: density === 'full' && (options.width ?? 0) >= BACKEND_COUNTS_FROM,
          countsOnly: density === 'focus',
        }
      : null;
  // The focus density has no `agents` field, but with a delegation tree its counts are what the user asked the
  // bar to keep in view (design §4.1, 80-column sample; rulings B10b s1 round 2, Q1). Without a tree it is untouched.
  if (delegation) allowed.add('agents');

  const modules: BarModule[] = [
    // With a delegation tree the alert leads the line (design §4.1), so it is built first.
    ...(delegation ? [attentionModule(data, nowMs, delegation)] : []),
    identityModule(data),
    contextModule(data, barWidth),
    projectModule(data),
    quotaModule(data, nowMs),
    activityModule(data, words, nowMs),
    speedModule(data),
    (() => {
      const module = agentsModule(data, delegation);
      if (!nativeCallsOnly(data.delegation)) return module;
      const calls = `Native calls ${data.delegation!.nativeCalls!.count}`;
      return {
        ...module,
        variants: {
          ...module.variants,
          full: [module.variants.full, calls].filter(Boolean).join(' · '),
          short: [module.variants.short, calls].filter(Boolean).join(' · '),
        },
      };
    })(),
    tasksModule(data),
    ...(delegation ? [] : [attentionModule(data, nowMs)]),
    noticeModule(data, nowMs, delegation),
    configModule(data),
    environmentModule(data),
    tokensModule(data),
    sessionModule(data),
  ];

  return modules.filter((module) => allowed.has(module.id));
}

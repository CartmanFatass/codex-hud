/**
 * The bar's fields as plain values, shared by the three one-line bars: Codex's tmux bar (`bar-modules.ts`, from
 * `HudData`), Claude's statusline and pi's footer. A builder takes what it shows, not where it came from, so every
 * client draws a segment with the same words, glyphs and inks, in the same order, and `fitBar` fits them with the same
 * separators and the same priorities. No collector is imported here: the statusline starts as a fresh process.
 */

import { colors, getContextColor, icons, METER_DANGER, METER_WARN, theme, truncate, visualLength } from '../colors.js';
import { formatTokenCount } from '../lines/activity-line.js';
import { fitModules, type BarModule } from './engine.js';

export const MODULE_PRIORITY = {
  attention: 100,
  // Its last form asks for no columns, so it never has to be hidden for room.
  notice: 90,
  activity: 94,
  context: 93,
  identity: 92,
  // Claude and pi: the HUD jobs of this session, after the model and the context, before the repository.
  work: 89,
  project: 88,
  quota: 86,
  agents: 70,
  speed: 64,
  // pi only: the session's cost, working time, cache hit rate and first-token time, then the other extensions' words.
  cost: 62,
  tasks: 60,
  active: 46,
  cache: 47,
  ttft: 45,
  extensions: 42,
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
export const SHRINK = {
  // An alert keeps its words until the project has gone.
  attention: 89,
  session: 10,
  tokens: 12,
  environment: 15,
  // Claude and pi: Work gives up its running and ready counts before what the client loaded goes.
  work: 18,
  config: 20,
  identity: 50,
  context: 52,
  // Claude: the usage window's reset time outlasts the meter.
  quota: 53,
  notice: 54,
  agents: 56,
  project: 58,
  // The turn's clock outlasts the branch.
  activity: 59,
} as const;

/** Columns the output rate keeps, so its digits never move the fields beside it. */
const RATE_COLUMNS = 9;

/** Below the warning line a reading is plain text; colour on the bar means something to look at. */
export function signal(percent: number): (text: string) => string {
  return percent >= METER_DANGER ? theme.error : percent >= METER_WARN ? theme.warning : theme.value;
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visualLength(text))) + text;
}

/** One line for every client: a dimmed rule between clusters, two spaces inside one. */
export function fitBar(modules: BarModule[], width: number) {
  return fitModules(modules, { width, separator: theme.separator(' │ '), groupSeparator: '  ' });
}

/** `↑2↓1`: what the branch is ahead of and behind its upstream. */
export function gitSync(ahead: number, behind: number): string {
  return [ahead > 0 ? `${icons.ahead}${ahead}` : '', behind > 0 ? `${icons.behind}${behind}` : ''].join('');
}

/** The model by its name and the effort beside it, dim; narrower, the name alone. */
export function identityModule(model: string | undefined, effort?: string): BarModule {
  const base = { id: 'identity', priority: MODULE_PRIORITY.identity, group: 'model' };
  if (!model) return { ...base, variants: {} };
  const name = theme.model(model);
  return {
    ...base,
    shrink: SHRINK.identity,
    variants: { full: effort ? `${name} ${colors.dim(effort)}` : name, short: name },
  };
}

/**
 * The context against the model's whole window, with a meter before it. `shown` is the reading's own number: tokens
 * (Codex) or a percentage (Claude, pi); the window follows it. Below the warning line the meter is the scale's colour
 * and the numbers plain; past it both turn.
 */
export function contextModule(percent: number, shown: string, window: number, cells: number, pad = 0): BarModule {
  const numbers = `${signal(percent)(padStart(shown, pad))}${window > 0 ? colors.dim(`/${formatTokenCount(window)}`) : ''}`;
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

/** The repository and, in the branch's colour, its branch with the marks it carries; narrower, both cut short. */
export function projectModule(name: string, branch: string | null, dirty = '', sync = ''): BarModule {
  const base = { id: 'project', priority: MODULE_PRIORITY.project, shrink: SHRINK.project, group: 'project' };
  if (!name) return { ...base, variants: {} };
  if (!branch) {
    return { ...base, variants: { full: theme.projectName(name), short: theme.projectName(truncate(name, 16)) } };
  }
  return {
    ...base,
    variants: {
      full: `${theme.projectName(name)} ${theme.gitBranch(`${branch}${dirty}${sync}`)}`,
      short: `${theme.projectName(truncate(name, 16))} ${theme.gitBranch(`${truncate(branch, 12)}${dirty}`)}`,
      min: theme.projectName(truncate(name, 12)),
    },
  };
}

/** One usage window: its label dim, its percentage plain until the warning line. */
export function quotaReading(label: string, percent: number): string {
  return `${label ? `${colors.dim(label)} ` : ''}${signal(percent)(`${percent}%`)}`;
}

export function quotaModule(full: string, short?: string): BarModule {
  return {
    id: 'quota',
    priority: MODULE_PRIORITY.quota,
    shrink: SHRINK.quota,
    group: 'quota',
    variants: { full, ...(short ? { short } : {}) },
  };
}

/** The output rate, a whole number: bright while a turn runs and has a sample of its own, else dim. */
export function speedModule(tokensPerSecond: number, fresh: boolean): BarModule {
  const value = padStart(String(Math.round(tokensPerSecond)), 3);
  return {
    id: 'speed',
    priority: MODULE_PRIORITY.speed,
    group: 'speed',
    reserve: { full: RATE_COLUMNS },
    variants: { full: fresh ? `${theme.value(value)} ${colors.dim('tok/s')}` : colors.dim(`${value} tok/s`) },
  };
}

export const AGENTS_BASE = {
  id: 'agents',
  priority: MODULE_PRIORITY.agents,
  shrink: SHRINK.agents,
  group: 'agents',
} as const;

/** The agents the main session started: running, finished, failed, unknown. */
export function agentCountsModule(n: {
  active: number;
  completed: number;
  failed: number;
  unknown: number;
}): BarModule {
  const counts: string[] = [];
  if (n.active > 0) counts.push(theme.info(`${n.active}${icons.running}`));
  if (n.completed > 0) counts.push(theme.success(`${n.completed}${icons.check}`));
  if (n.failed > 0) counts.push(theme.error(`${n.failed}${icons.cross}`));
  if (n.unknown > 0) counts.push(colors.dim(`${n.unknown}?`));
  if (counts.length === 0) return { ...AGENTS_BASE, variants: {} };
  return { ...AGENTS_BASE, variants: { full: `${colors.dim('Agents')} ${counts.join(' ')}`, short: counts.join(' ') } };
}

export function tasksModule(completed: number, total: number): BarModule {
  const base = { id: 'tasks', priority: MODULE_PRIORITY.tasks, group: 'tasks' };
  // No structured plan means no progress to show. Nothing is invented here.
  if (total <= 0) return { ...base, variants: {} };
  return { ...base, variants: { full: `${colors.dim('Tasks')} ${theme.value(`${completed}/${total}`)}` } };
}

/**
 * The HUD jobs of this session, as `renderWorkSummary` words them (most urgent first, `Work: 1 needs you · 2 running`):
 * each clause in its own ink. Narrower, only what asks for the person stays (needs you, stalled, failed).
 */
export function workModule(text: string): BarModule {
  const base = { id: 'work', priority: MODULE_PRIORITY.work, group: 'work' };
  if (!text) return { ...base, variants: {} };
  const ink = (clause: string) =>
    /failed/.test(clause)
      ? theme.error(clause)
      : /needs you|stalled/.test(clause)
        ? theme.warning(clause)
        : /ready/.test(clause)
          ? theme.success(clause)
          : theme.info(clause);
  const clauses = text.replace(/^Work: /, '').split(' · ');
  const urgent = clauses.filter((clause) => /needs you|stalled|failed/.test(clause));
  const paint = (list: string[]) => `${colors.dim('Work:')} ${list.map(ink).join(colors.dim(' · '))}`;
  return {
    ...base,
    shrink: SHRINK.work,
    variants: { full: paint(clauses), short: paint(urgent.length ? urgent : clauses.slice(0, 1)) },
  };
}

/** What the client loaded here (MCP servers, skills, hooks, instruction files), each only when there is one. */
export function configModule(counts: ReadonlyArray<readonly [string, number | null | undefined]>): BarModule {
  const parts = counts
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

/** The right cluster's other fields: `full` is the whole reading, `short` the one that is left when it must shrink. */
export function metaModule(id: 'tokens' | 'session', full: string, short?: string): BarModule {
  return {
    id,
    priority: MODULE_PRIORITY[id],
    shrink: SHRINK[id],
    optional: true,
    group: 'meta',
    align: 'right',
    variants: full ? { full, ...(short ? { short } : {}) } : {},
  };
}

export function tokensModule(count: string): BarModule {
  return metaModule('tokens', `${colors.dim('Tokens')} ${theme.tokenCount(count)}`);
}

/** A labelled reading that only one client has (cost, cache hit rate, ...): dim label, plain value. */
export function readingModule(id: keyof typeof MODULE_PRIORITY, label: string, value: string): BarModule {
  return {
    id,
    priority: MODULE_PRIORITY[id],
    group: id,
    variants: value ? { full: `${label ? `${colors.dim(label)} ` : ''}${theme.value(value)}` } : {},
  };
}

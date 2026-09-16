/**
 * The subagent side panel.
 *
 * Four views share one narrow column: the tree, one agent's detail, the
 * session's plan and tool history, and a key/symbol reference. The tree
 * answers "who is running and who failed"; the detail answers "what do we
 * actually know about this one, and how old is that knowledge".
 */

import { colors, theme, icons, stripAnsi, truncateAnsi, visualLength } from './colors.js';
import { layoutLeftRight, renderSubagentPrefix, subagentVisual, formatElapsedShort } from './subagent-chip.js';
import { MODEL_GLYPHS, MODEL_LABELS, EFFORT_GLYPHS, type ModelFamily } from './model-glyphs.js';
import type { PanelFilter, PanelRow, PanelState } from './panel-state.js';
import { visibleRows } from './panel-state.js';
import type {
  ContextUsage,
  PlanProgress,
  RateLimitSnapshot,
  SubagentTree,
  SubagentTreeNode,
  ToolActivity,
} from '../types.js';
import { sparkline } from './sparkline.js';
import { formatCountdown, readQuotaWindows } from './quota.js';
import { summarizeSubagents, type SubagentSummary } from '../collectors/subagent-tree.js';

export interface PanelInput {
  tree: SubagentTree;
  state: PanelState;
  maxWidth: number;
  nowMs?: number;
  planProgress?: PlanProgress | null;
  toolActivity?: ToolActivity | null;
  contextUsage?: ContextUsage | null;
  rateLimits?: RateLimitSnapshot | null;
  /** Context fill percentages sampled while the panel has been open. */
  contextHistory?: number[];
  /** How much time those samples cover. */
  contextHistoryMs?: number | null;
}

/**
 * Panel header counts, in three lengths.
 *
 * Failures get their own number: folding them into a "done" total tells the
 * reader that work succeeded when it did not. When the column is too narrow
 * for words the counts become symbols, and the last thing given up is the
 * failure count.
 */
function countVariants(summary: SubagentSummary): string[] {
  const words: string[] = [colors.dim(`${summary.active} run`)];
  if (summary.completed > 0) words.push(theme.success(`${summary.completed} ok`));
  if (summary.failed > 0) words.push(theme.error(`${summary.failed} fail`));
  if (summary.unknown > 0) words.push(colors.dim(`${summary.unknown} ?`));

  const symbols: string[] = [colors.dim(`${summary.active}${icons.running}`)];
  if (summary.completed > 0) symbols.push(theme.success(`${summary.completed}${icons.check}`));
  if (summary.failed > 0) symbols.push(theme.error(`${summary.failed}${icons.cross}`));
  if (summary.unknown > 0) symbols.push(colors.dim(`${summary.unknown}${icons.unknown}`));

  const minimal: string[] = [colors.dim(`${summary.active}${icons.running}`)];
  if (summary.failed > 0) minimal.push(theme.error(`${summary.failed}${icons.cross}`));

  return [
    words.join(colors.dim(' · ')),
    symbols.join(' '),
    minimal.join(' '),
  ];
}

/**
 * Fit the session label and the counts into one line, giving up the label's
 * detail before giving up any of the counts.
 */
function renderPanelHeader(rootId: string, summary: SubagentSummary, maxWidth: number): string {
  const shortId = rootId.length > 8 ? rootId.slice(0, 8) : rootId;
  const lefts = [
    theme.info(`main · ${shortId}`),
    theme.info(`main·${shortId.slice(0, 4)}`),
    theme.info('main'),
  ];
  const rights = countVariants(summary);

  // Counts first: the session label may shrink to keep a failure count on
  // screen, never the other way round.
  for (const right of rights) {
    for (const left of lefts) {
      if (visualLength(left) + 1 + visualLength(right) <= maxWidth) {
        return layoutLeftRight(maxWidth, left, right);
      }
    }
  }
  return truncateAnsi(rights[rights.length - 1], maxWidth);
}

/**
 * How old the newest evidence is. Deliberately phrased as an age, never as a
 * verdict: the HUD does not know that a quiet agent is stuck.
 */
export function formatAge(date: Date | undefined, nowMs: number): string | null {
  if (!date) {
    return null;
  }
  const seconds = Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const STATUS_WORDS: Record<SubagentTreeNode['status'], string> = {
  running: 'running',
  starting: 'starting',
  completed: 'finished',
  error: 'failed',
  unknown: 'no events seen',
};

export function renderDirectoryTree(
  nodes: SubagentTreeNode[],
  prefix = '',
  maxWidth?: number
): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? '└─ ' : '├─ ';
    const hang = prefix + (isLast ? '   ' : '│  ');
    const connector = colors.dim(prefix + branch);
    const budget = maxWidth ? Math.max(1, maxWidth - visualLength(connector)) : undefined;
    lines.push(`${connector}${renderSubagentPrefix(node, budget)}`);
    if (node.children.length > 0) {
      lines.push(...renderDirectoryTree(node.children, hang, maxWidth));
    }
  });
  return lines;
}

const FILTER_LABELS: Record<PanelFilter, string> = {
  all: 'all',
  active: 'running',
  failed: 'failed',
  unknown: 'unknown',
};

function renderRow(row: PanelRow, selected: boolean, maxWidth: number): string {
  const marker = selected ? theme.accent('▌') : ' ';
  const connector = colors.dim(row.prefix);
  // Only a folded branch is marked: the symbol exists to say "there is more
  // under here", which is not true of an open one.
  const fold = row.hasChildren && row.collapsed ? colors.dim('+') : '';
  const used = visualLength(marker) + visualLength(connector) + (fold ? 1 : 0);
  const budget = Math.max(1, maxWidth - used);
  const body = renderSubagentPrefix(row.node, budget);
  // A row kept only to locate a match below it is dimmed, not hidden.
  return `${marker}${connector}${fold}${row.context ? colors.dim(stripAnsi(body)) : body}`;
}

function treeView(input: PanelInput, rows: PanelRow[]): string[] {
  const { tree, state, maxWidth } = input;
  const summary = summarizeSubagents(tree.nodes);
  const lines = [renderPanelHeader(tree.rootId, summary, maxWidth)];

  if (state.filter !== 'all') {
    lines.push(colors.dim(`filter: ${FILTER_LABELS[state.filter]}`));
  }

  if (tree.nodes.length === 0) {
    lines.push(colors.dim('No subagents'));
  } else if (rows.length === 0) {
    lines.push(colors.dim(`Nothing ${FILTER_LABELS[state.filter]}`));
  } else {
    for (const row of rows) {
      lines.push(renderRow(row, row.node.id === state.selectedId, maxWidth));
    }
  }

  lines.push(colors.dim('? keys'));
  return lines;
}

function detailView(input: PanelInput, rows: PanelRow[]): string[] {
  const nowMs = input.nowMs ?? Date.now();
  const selected = rows.find((row) => row.node.id === input.state.selectedId)?.node
    ?? findNode(input.tree.nodes, input.state.selectedId);
  if (!selected) {
    return [colors.dim('esc back'), colors.dim('agent is gone')];
  }

  const { icon, paint } = subagentVisual(selected);
  const lines: string[] = [
    colors.dim('esc back'),
    paint(`${icon} ${selected.name}`),
    paint(STATUS_WORDS[selected.status]),
  ];

  // Status and freshness are two answers, not one. An agent can be running
  // and quiet, or finished and recent.
  const age = formatAge(selected.lastEventAt ?? selected.lastActivityAt, nowMs);
  lines.push(colors.dim(age ? `last event ${age}` : 'no event timestamp'));

  const family = selected.model ? modelFamilyOf(selected.model) : null;
  if (selected.model || selected.effort) {
    const label = family ? `${MODEL_GLYPHS[family]} ${MODEL_LABELS[family]}` : selected.model ?? '';
    lines.push(theme.model(label) + (selected.effort ? colors.dim(`·${selected.effort}`) : ''));
  }
  if (selected.model && family) {
    lines.push(colors.dim(selected.model));
  }

  if (selected.startedAt) {
    const elapsed = formatElapsedShort(selected.startedAt, nowMs);
    const running = selected.status === 'running' || selected.status === 'starting';
    lines.push(colors.dim(running ? `running ${elapsed}` : `age ${elapsed}`));
  }
  lines.push(colors.dim(`id ${selected.id.slice(0, 12)}`));

  const children = selected.children.length;
  if (children > 0) {
    lines.push(colors.dim(`spawned ${children}`));
  }
  return lines;
}

function modelFamilyOf(model: string): ModelFamily | null {
  const slug = model.toLowerCase();
  const families = Object.keys(MODEL_GLYPHS) as ModelFamily[];
  return families.find((family) => slug.includes(family)) ?? null;
}

function findNode(nodes: SubagentTreeNode[], id: string | null): SubagentTreeNode | undefined {
  if (!id) {
    return undefined;
  }
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const found = findNode(node.children, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * The session's own work: plan steps as reported by plan_update, and the
 * tool calls with their recorded results. Nothing here is inferred from a
 * command's name.
 */
function sessionView(input: PanelInput): string[] {
  const lines: string[] = [colors.dim('esc back')];
  const plan = input.planProgress;

  if (plan && plan.totalSteps > 0) {
    lines.push(theme.value(`Tasks ${plan.completedSteps}/${plan.totalSteps}`));
    for (const step of plan.steps) {
      const mark = step.status === 'completed' ? icons.check : step.status === 'in_progress' ? icons.running : '·';
      const paint = step.status === 'completed' ? theme.success : step.status === 'in_progress' ? theme.accent : colors.dim;
      lines.push(paint(`${mark} ${step.step}`));
    }
  } else {
    lines.push(colors.dim('No plan reported'));
  }

  const resources = resourceLines(input);
  if (resources.length > 0) {
    lines.push(...resources);
  }

  const calls = input.toolActivity?.recentCalls ?? [];
  if (calls.length > 0) {
    lines.push(colors.dim('─ tools ─'));
    for (const call of calls.slice(-8).reverse()) {
      const mark = call.status === 'completed' ? icons.check : call.status === 'error' ? icons.cross : icons.running;
      const paint = call.status === 'completed' ? theme.success : call.status === 'error' ? theme.error : theme.accent;
      const duration = call.duration ? colors.dim(` ${Math.round(call.duration / 100) / 10}s`) : '';
      lines.push(`${paint(`${mark} ${call.name}`)}${duration}`);
      if (call.target) {
        lines.push(colors.dim(`  ${call.target}`));
      }
    }
  }
  return lines;
}

/**
 * Context, quota and compaction, each labelled with what it measures. The
 * trend covers only the time the panel has been open, and says so.
 */
function resourceLines(input: PanelInput): string[] {
  const nowMs = input.nowMs ?? Date.now();
  const lines: string[] = [];
  const usage = input.contextUsage;
  const windows = readQuotaWindows(input.rateLimits, nowMs);

  if (!usage && windows.length === 0) {
    return lines;
  }

  lines.push(colors.dim('─ context ─'));
  if (usage) {
    lines.push(`${theme.value(`${usage.percent}%`)} ${colors.dim(`${formatCount(usage.used)}/${formatCount(usage.total)}`)}`);
    const history = input.contextHistory ?? [];
    if (history.length >= 2) {
      const spanMs = input.contextHistoryMs ?? 0;
      const spanLabel = spanMs >= 60_000 ? `${Math.round(spanMs / 60_000)}m` : `${Math.round(spanMs / 1000)}s`;
      lines.push(`${theme.accent(sparkline(history, 12))} ${colors.dim(`last ${spanLabel}`)}`);
    }
    if (usage.compactCount > 0) {
      const age = formatAge(usage.lastCompactTime, nowMs);
      lines.push(colors.dim(`${icons.refresh}${usage.compactCount} compacted${age ? ` ${age}` : ''}`));
    }
  } else {
    lines.push(colors.dim('no context snapshot'));
  }

  if (windows.length > 0) {
    lines.push(colors.dim('─ quota ─'));
    for (const window of windows) {
      lines.push(`${colors.dim(window.label || 'window')} ${theme.value(`${window.percent}%`)}`);
      if (window.resetsAt && !window.resetDue) {
        lines.push(colors.dim(`  resets in ${formatCountdown(window.resetsAt, nowMs)}`));
      } else if (window.resetDue) {
        // The clock has passed but no newer snapshot has arrived, so the
        // percentage above is the last thing the account actually reported.
        lines.push(colors.dim('  reset due'));
      }
    }
  }

  return lines;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return String(value);
}

function helpView(): string[] {
  const families = (Object.keys(MODEL_GLYPHS) as ModelFamily[]).map(
    (family) => `${theme.model(MODEL_GLYPHS[family])} ${colors.dim(MODEL_LABELS[family])}`
  );
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map(
    (effort) => `${EFFORT_GLYPHS[effort]} ${colors.dim(effort)}`
  );
  return [
    colors.dim('esc back'),
    theme.value('keys'),
    colors.dim('j k  move'),
    colors.dim('h l  fold'),
    colors.dim('ret  detail'),
    colors.dim('f    filter'),
    colors.dim('t    session'),
    colors.dim('q    close'),
    theme.value('status'),
    `${theme.info(icons.running)} ${colors.dim('running')}`,
    `${theme.success(icons.check)} ${colors.dim('finished')}`,
    `${theme.error(icons.cross)} ${colors.dim('failed')}`,
    `${colors.dim(icons.unknown)} ${colors.dim('no events')}`,
    theme.value('models'),
    ...families,
    theme.value('effort'),
    ...efforts,
  ];
}

export function renderPanel(input: PanelInput): string[] {
  const rows = visibleRows(input.tree.nodes, input.state);
  const lines =
    input.state.view === 'detail'
      ? detailView(input, rows)
      : input.state.view === 'session'
        ? sessionView(input)
        : input.state.view === 'help'
          ? helpView()
          : treeView(input, rows);
  return lines.map((line) => truncateAnsi(line, input.maxWidth));
}

export function renderTreeUnboundPage(maxWidth?: number): string[] {
  const lines = [colors.dim('Waiting for main session')];
  if (maxWidth && maxWidth > 0) {
    return lines.map((line) => truncateAnsi(line, maxWidth));
  }
  return lines;
}

/** Plain-text panel, for tests and diagnostics. */
export function renderPanelPlain(input: PanelInput): string {
  return renderPanel(input).map(stripAnsi).join('\n');
}

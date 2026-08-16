/**
 * Header line renderer
 * Phase 3: Redesigned to match claude-hud layout
 * 
 * Layout:
 * Row 1: Tokens | Ctx bar | Plan bar | timer | project | mode/approval/sandbox | session
 * Later rows: first-level subagents by default; Ctrl+T expands parallel trees
 */

import type { HudData, RenderOptions, LayoutConfig, SubagentTreeNode } from '../types.js';
import { DEFAULT_LAYOUT } from '../types.js';
import { colors, theme, icons, coloredBar, coloredPercent, visualLength, truncateAnsi, padEnd, getSpinnerFrame } from './colors.js';
import {
  renderIdentityLine,
  renderProjectLine,
  renderEnvironmentCompact,
  renderUsageLine,
  renderTokenLine,
  formatTokenCount,
} from './lines/index.js';

/**
 * Render the compact layout (single line)
 * Format: [Model] █████ 45% | project git:(branch *) | 2 MCPs | ⏱️ 10m
 */
function renderCompactLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  const parts: string[] = [];
  
  // Identity (model + context bar)
  parts.push(renderIdentityLine(data, layout, { maxWidth: width }));
  
  // Project + git
  parts.push(renderProjectLine(data));
  
  // Quick stats (just MCP count)
  const mcpCount = data.project.mcpCount;
  if (mcpCount > 0) {
    parts.push(theme.info(`${mcpCount}`) + colors.dim(' MCPs'));
  }
  
  // Duration
  const usageLine = renderUsageLine(data, layout);
  if (usageLine) {
    parts.push(usageLine);
  }
  
  const separator = layout.showSeparators ? theme.separator(' │ ') : ' ';
  let row = parts.join(separator);
  if (visualLength(row) <= width) {
    return [row];
  }

  const trimmedParts = parts.slice(0, 2);
  row = trimmedParts.join(separator);
  if (visualLength(row) <= width) {
    return [row];
  }

  const identity = parts[0] ?? '';
  const availableForProject = Math.max(0, width - visualLength(identity) - visualLength(separator));
  const project = renderProjectLine(data, { includeFileStats: false, maxWidth: availableForProject });
  return [identity + separator + project];
}

function joinDense(parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && visualLength(part) > 0))
    .join(` ${colors.dim('|')} `);
}

function renderSessionCompact(data: HudData): string {
  const sessionId = data.session?.id;
  if (!sessionId) {
    return '';
  }
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
  return colors.dim('Session: ') + theme.info(shortId);
}

function formatElapsed(startTime: Date): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - startTime.getTime()) / 1000));
  if (diffSec < 60) {
    return `${diffSec}s`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m${String(diffSec % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(diffMin / 60)}h${String(diffMin % 60).padStart(2, '0')}m`;
}

function renderAlignedMeter(label: string, percent?: number, extra?: string): string {
  const bar = typeof percent === 'number' ? coloredBar(percent, 10) : colors.dim('░'.repeat(10));
  const percentText = typeof percent === 'number' ? coloredPercent(percent) : colors.dim('--%');
  const extraText = extra ? ` ${colors.dim(extra)}` : '';
  return `${colors.dim(label)} ${bar} ${percentText}${extraText}`;
}

function contextPercent(data: HudData): number | undefined {
  if (data.contextUsage) {
    return data.contextUsage.percent;
  }
  const usage = data.tokenUsage?.last_token_usage ?? data.tokenUsage?.total_token_usage;
  const window = data.tokenUsage?.model_context_window;
  if (!usage || !window) {
    return undefined;
  }
  return Math.round(((usage.total_tokens ?? 0) / window) * 100);
}

function contextTotals(data: HudData): string | undefined {
  if (data.contextUsage && data.contextUsage.total > 0) {
    const compact = data.contextUsage.compactCount > 0
      ? ` ↻${data.contextUsage.compactCount}`
      : '';
    return `(${formatTokenCount(data.contextUsage.used)}/${formatTokenCount(data.contextUsage.total)})${compact}`;
  }

  const usage = data.tokenUsage?.last_token_usage ?? data.tokenUsage?.total_token_usage;
  const window = data.tokenUsage?.model_context_window;
  if (!usage || !window) {
    return undefined;
  }
  return `(${formatTokenCount(usage.total_tokens ?? 0)}/${formatTokenCount(window)})`;
}

function planWindows(data: HudData): Array<{ percent: number; label: string }> {
  const limits = data.rateLimits;
  if (!limits) {
    return [];
  }
  return [limits.primary, limits.secondary]
    .filter((window): window is NonNullable<typeof window> => typeof window?.used_percent === 'number')
    .map((window) => {
      const minutes = window.window_minutes ?? 0;
      const label = minutes % 1440 === 0 && minutes > 0
        ? `${minutes / 1440}d`
        : minutes % 60 === 0 && minutes > 0
          ? `${minutes / 60}h`
          : minutes > 0
            ? `${minutes}m`
            : '';
      return { percent: Math.round(window.used_percent ?? 0), label };
    });
}

const MAX_PARALLEL_TREES = 6;
const MAX_TREE_ROWS = 6;
const TREE_COLUMN_GAP = 2;

function renderSubagentChip(node: SubagentTreeNode): string {
  const icon = node.status === 'completed'
    ? icons.check
    : node.status === 'error'
      ? icons.cross
      : node.status === 'starting'
        ? '○'
        : getSpinnerFrame();
  const color = node.status === 'completed'
    ? theme.success
    : node.status === 'error'
      ? theme.error
      : theme.info;
  const elapsed = node.startedAt ? ` ${colors.dim(formatElapsed(node.startedAt))}` : '';
  return `${color(`${icon} ${node.name}`)}${elapsed}`;
}

function renderColumnTree(root: SubagentTreeNode): string[] {
  const lines: string[] = [renderSubagentChip(root)];

  const walk = (nodes: SubagentTreeNode[], prefix: string) => {
    nodes.forEach((node, index) => {
      const isLast = index === nodes.length - 1;
      const branch = isLast ? '└─ ' : '├─ ';
      lines.push(`${colors.dim(prefix + branch)}${renderSubagentChip(node)}`);
      if (node.children.length > 0) {
        walk(node.children, prefix + (isLast ? '   ' : '│  '));
      }
    });
  };

  walk(root.children, '');
  return lines;
}

function renderParallelTrees(
  roots: SubagentTreeNode[],
  width: number,
  collapsed: boolean
): string[] {
  if (roots.length === 0 || width <= 0) {
    return [];
  }

  const extra = Math.max(0, roots.length - MAX_PARALLEL_TREES);
  const visible = roots.slice(0, MAX_PARALLEL_TREES);
  // Always reserve 6 slots so 2 trees stay adjacent instead of stretching
  // across the full HUD width.
  const colWidth = Math.max(
    12,
    Math.floor((width - TREE_COLUMN_GAP * (MAX_PARALLEL_TREES - 1)) / MAX_PARALLEL_TREES)
  );
  const columns = visible.map((root, index) => {
    const lines = collapsed
      ? [renderSubagentChip(root) + (root.children.length > 0 ? colors.dim(' ▾') : '')]
      : renderColumnTree(root);
    if (extra > 0 && index === visible.length - 1) {
      lines[0] = `${lines[0]}${colors.dim(` +${extra}`)}`;
    }
    return lines;
  });

  const fullHeight = Math.max(...columns.map((column) => column.length));
  const rowCount = Math.min(MAX_TREE_ROWS, fullHeight);
  const hidden = columns.reduce((sum, column) => sum + Math.max(0, column.length - rowCount), 0);
  const lines: string[] = [];

  for (let row = 0; row < rowCount; row++) {
    let line = '';
    columns.forEach((column, index) => {
      const cell = padEnd(column[row] ?? '', colWidth);
      line += index === columns.length - 1 ? cell : cell + ' '.repeat(TREE_COLUMN_GAP);
    });
    if (row === rowCount - 1 && hidden > 0) {
      line = `${truncateAnsi(line, Math.max(0, width - 6))} ${colors.dim(`…+${hidden}`)}`;
    }
    lines.push(truncateAnsi(line, width));
  }

  return lines;
}

/**
 * Header plus parallel directory trees for top-level subagents.
 */
function renderExpandedLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  const plans = planWindows(data);
  const ctxMeter = renderAlignedMeter('Ctx', contextPercent(data), contextTotals(data));
  const planMeter = plans.length > 0
    ? renderAlignedMeter('Plan', plans[0].percent, [plans[0].label, ...plans.slice(1).map((item) => `${item.percent}% ${item.label}`)].filter(Boolean).join(' · '))
    : renderAlignedMeter('Plan');

  const header = truncateAnsi(
    joinDense([
      renderTokenLine(data),
      ctxMeter,
      planMeter,
      renderUsageLine(data, layout),
      renderProjectLine(data, { includeFileStats: false }),
      renderEnvironmentCompact(data),
      renderSessionCompact(data),
    ]),
    width
  );

  return [header, ...renderParallelTrees(data.subagentTree?.nodes ?? [], width, true)];
}

function renderDirectoryTree(nodes: SubagentTreeNode[], prefix = ''): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? '└─ ' : '├─ ';
    lines.push(`${colors.dim(prefix + branch)}${renderSubagentChip(node)}`);
    if (node.children.length > 0) {
      lines.push(...renderDirectoryTree(node.children, prefix + (isLast ? '   ' : '│  ')));
    }
  });
  return lines;
}

/**
 * Original Ctrl+T page: session overview plus the current session's agent tree.
 */
function renderOverviewLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  const overview = data.overview;
  const sessionLines = !overview || overview.sessions.length === 0
    ? [colors.dim('No active sessions')]
    : overview.sessions.map((session) => {
      const shortId = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
      const ctx = session.contextUsage;
      const ctxDisplay = ctx
        ? `${coloredBar(ctx.percent, layout.barWidth)} ${coloredPercent(ctx.percent)}`
        : colors.dim('Ctx: --');
      const ctxLabel = ctx ? colors.dim('Ctx ') : '';
      return `${ctxLabel}${ctxDisplay} ${colors.dim('Session: ')}${theme.info(shortId)}`;
    });

  const tree = data.subagentTree;
  const treeLines = !tree || tree.nodes.length === 0
    ? [colors.dim('No subagents')]
    : renderDirectoryTree(tree.nodes);

  return [
    colors.dim('Overview') + theme.separator(' | ') + colors.dim('Ctrl+T back'),
    ...sessionLines,
    colors.dim('─'.repeat(Math.min(width, 40))),
    ...treeLines,
  ].map((line) => truncateAnsi(line, width));
}

/**
 * Render the full HUD output (all lines)
 */
export function renderHud(data: HudData, options: RenderOptions): string[] {
  const layout = options.layout ?? DEFAULT_LAYOUT;

  if (data.displayMode === 'overview') {
    return renderOverviewLayout(data, layout, options.width);
  }

  if (layout.mode === 'compact') {
    return renderCompactLayout(data, layout, options.width);
  }
  
  return renderExpandedLayout(data, layout, options.width);
}

// ============================================================================
// Legacy exports for backward compatibility
// ============================================================================

/**
 * Render the main header line (legacy)
 * @deprecated Use renderHud instead
 */
export function renderHeader(data: HudData, options: RenderOptions): string {
  const lines = renderHud(data, options);
  return lines[0] || '';
}

/**
 * Render the second line with detailed info (legacy)
 * @deprecated Use renderHud instead
 */
export function renderDetails(data: HudData, options: RenderOptions): string {
  const lines = renderHud(data, options);
  return lines[1] || '';
}

/**
 * Render the third line with tool activity (legacy)
 * @deprecated Use renderHud instead
 */
export function renderActivityLine(data: HudData, _options: RenderOptions): string | null {
  const lines = renderHud(data, _options);
  return lines[2] || null;
}

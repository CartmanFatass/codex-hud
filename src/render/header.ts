/**
 * Header line renderer
 * Phase 3: Redesigned to match claude-hud layout
 *
 * Layout:
 * Row 1: Tokens | Ctx bar | Plan bar | timer | project | mode/approval/sandbox | session
 * Rows 2+: active subagents by depth — one row per level, up to 3 levels,
 * directory-tree prefixes showing which lineage each agent belongs to.
 */

import type { HudData, RenderOptions, LayoutConfig, SubagentTree, SubagentTreeNode } from '../types.js';
import { DEFAULT_LAYOUT } from '../types.js';
import { colors, theme, coloredBar, coloredPercent, visualLength, truncateAnsi, padEnd } from './colors.js';
import { renderSubagentChip } from './subagent-chip.js';
import { collectActiveTreeLevels, type SubagentTreeEntry } from '../collectors/subagent-tree.js';
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

const MAX_HUD_TREE_LEVELS = 3;
const TREE_ROOT_GAP = 4;
const TREE_ENTRY_GAP = 2;

function renderTreeEntry(entry: SubagentTreeEntry): string {
  return `${colors.dim(entry.prefix)}${renderSubagentChip(entry.node)}`;
}

/**
 * One row per active subagent level (up to MAX_HUD_TREE_LEVELS), with agents
 * of the same depth sharing the row. Entries are grouped into regions by
 * their depth-1 ancestor so a lineage keeps its own column across rows; the
 * directory-tree prefixes carry ownership within and across regions. When the
 * regions do not fit, the row falls back to a flowing layout and truncates.
 */
function renderActiveTreeRows(tree: SubagentTree | undefined, width: number): string[] {
  const levels = collectActiveTreeLevels(tree, MAX_HUD_TREE_LEVELS);
  if (levels.length === 0 || width <= 0) {
    return [];
  }

  const rootOrder: string[] = [];
  const perRoot = new Map<string, SubagentTreeEntry[][]>();
  levels.forEach((entries, levelIdx) => {
    for (const entry of entries) {
      let bucket = perRoot.get(entry.rootId);
      if (!bucket) {
        bucket = Array.from({ length: levels.length }, () => [] as SubagentTreeEntry[]);
        perRoot.set(entry.rootId, bucket);
        rootOrder.push(entry.rootId);
      }
      bucket[levelIdx].push(entry);
    }
  });

  const regionRows = rootOrder.map((rootId) =>
    perRoot.get(rootId)!.map((entries) =>
      entries.map(renderTreeEntry).join(' '.repeat(TREE_ENTRY_GAP))
    )
  );
  const regionWidths = rootOrder.map((_, index) =>
    Math.max(1, ...regionRows[index].map((row) => visualLength(row)))
  );
  const gapTotal = TREE_ROOT_GAP * (rootOrder.length - 1);
  const natural = regionWidths.reduce((sum, w) => sum + w, 0) + gapTotal;

  if (natural <= width) {
    return regionRows[0].map((_, levelIdx) =>
      rootOrder
        .map((_, index) => padEnd(regionRows[index][levelIdx] ?? '', regionWidths[index]))
        .join(' '.repeat(TREE_ROOT_GAP))
        .replace(/\s+$/, '')
    );
  }

  return levels.map((entries) =>
    truncateAnsi(
      entries.map(renderTreeEntry).join(' '.repeat(TREE_ENTRY_GAP)),
      width
    )
  );
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

  return [header, ...renderActiveTreeRows(data.subagentTree, width)];
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

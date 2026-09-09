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
import {
  collectActiveTreeLineages,
  type SubagentTreeEntry,
} from '../collectors/subagent-tree.js';
import {
  renderProjectLine,
  renderEnvironmentCompact,
  renderUsageLine,
  renderTokenLine,
  formatTokenCount,
} from './lines/index.js';
import { getModelDisplayName } from '../collectors/codex-config.js';
import { renderModelEffortToken } from './model-glyphs.js';

/**
 * The single status line: model/effort glyphs plus the previous header fields.
 * Compact mode is this line only; expanded mode appends subagent rows under it.
 */
function renderStatusHeader(data: HudData, layout: LayoutConfig, width: number): string {
  const modelName = data.session?.model ?? getModelDisplayName(data.config);
  const reasoningEffort = data.session?.reasoningEffort ?? data.config.model_reasoning_effort;
  const modelToken = renderModelEffortToken(modelName, reasoningEffort);
  const plans = planWindows(data);
  const ctxMeter = renderAlignedMeter('Ctx', contextPercent(data), contextTotals(data));
  const planMeter = plans.length > 0
    ? renderAlignedMeter('Plan', plans[0].percent, [plans[0].label, ...plans.slice(1).map((item) => `${item.percent}% ${item.label}`)].filter(Boolean).join(' · '))
    : renderAlignedMeter('Plan');

  return truncateAnsi(
    joinDense([
      modelToken,
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
}

function renderCompactLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  return [renderStatusHeader(data, layout, width)];
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
 * of the same depth sharing the row. Each lineage gets a region; inside a
 * region every depth-2 agent owns a slice that also holds its depth-3 agents,
 * aligned across rows — so a grandchild always sits in its immediate parent's
 * slice and different parent structures cannot render identically. When the
 * regions do not fit, the layout falls back to flowing rows and truncates.
 */
function renderActiveTreeRows(tree: SubagentTree | undefined, width: number): string[] {
  const lineages = collectActiveTreeLineages(tree, MAX_HUD_TREE_LEVELS);
  if (lineages.length === 0 || width <= 0) {
    return [];
  }

  interface Region {
    rows: string[];
    width: number;
  }

  const regions: Region[] = lineages.map((lineage) => {
    const rootLine = renderTreeEntry(lineage.root);
    if (lineage.slices.length === 0) {
      return { rows: [rootLine], width: Math.max(1, visualLength(rootLine)) };
    }

    const sliceGap = ' '.repeat(TREE_ENTRY_GAP);
    const cells = lineage.slices.map((slice) => {
      const entryLine = renderTreeEntry(slice.entry);
      const childRow = slice.children.map(renderTreeEntry).join(sliceGap);
      const cellWidth = Math.max(1, visualLength(entryLine), visualLength(childRow));
      return { entryLine, childRow, hasChildren: slice.children.length > 0, cellWidth };
    });

    const rows: string[] = [rootLine];
    rows.push(
      cells.map((cell) => padEnd(cell.entryLine, cell.cellWidth)).join(sliceGap).replace(/\s+$/, '')
    );
    if (cells.some((cell) => cell.hasChildren)) {
      rows.push(
        cells.map((cell) => padEnd(cell.childRow, cell.cellWidth)).join(sliceGap).replace(/\s+$/, '')
      );
    }
    return { rows, width: Math.max(1, ...rows.map(visualLength)) };
  });

  const gapTotal = TREE_ROOT_GAP * (regions.length - 1);
  const natural = regions.reduce((sum, region) => sum + region.width, 0) + gapTotal;

  if (natural <= width) {
    const maxRows = Math.max(...regions.map((region) => region.rows.length));
    const rows: string[] = [];
    for (let row = 0; row < maxRows; row++) {
      rows.push(
        regions
          .map((region) => padEnd(region.rows[row] ?? '', region.width))
          .join(' '.repeat(TREE_ROOT_GAP))
          .replace(/\s+$/, '')
      );
    }
    return rows;
  }

  // Overflow: flow every level flat and hard-truncate to the pane width.
  const levelLines: string[][] = [
    lineages.map((lineage) => renderTreeEntry(lineage.root)),
  ];
  const level2 = lineages.flatMap((lineage) => lineage.slices.map((slice) => renderTreeEntry(slice.entry)));
  if (level2.length > 0) {
    levelLines.push(level2);
  }
  const level3 = lineages.flatMap((lineage) =>
    lineage.slices.flatMap((slice) => slice.children.map((child) => renderTreeEntry(child)))
  );
  if (level3.length > 0) {
    levelLines.push(level3);
  }
  return levelLines.map((entries) =>
    truncateAnsi(entries.join(' '.repeat(TREE_ENTRY_GAP)), width)
  );
}

/**
 * Header plus parallel directory trees for top-level subagents.
 */
function renderExpandedLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  return [renderStatusHeader(data, layout, width), ...renderActiveTreeRows(data.subagentTree, width)];
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

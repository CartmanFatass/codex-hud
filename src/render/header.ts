/**
 * Header line renderer
 *
 * Layout:
 * Row 1: the status bar, assembled from the modules in `layout/bar-modules.ts`
 * and fitted to the pane by `layout/engine.ts`.
 * Rows 2+: active subagents by depth — one row per level, up to 3 levels,
 * directory-tree prefixes showing which lineage each agent belongs to.
 */

import type { HudData, RenderOptions, LayoutConfig, SubagentTree } from '../types.js';
import { DEFAULT_LAYOUT } from '../types.js';
import { colors, theme, visualLength, truncateAnsi, padEnd } from './colors.js';
import { buildBarModules } from './layout/bar-modules.js';
import { fitModules } from './layout/engine.js';
import { renderSubagentChip } from './subagent-chip.js';
import {
  collectActiveTreeLineages,
  type SubagentTreeEntry,
} from '../collectors/subagent-tree.js';

/**
 * The single status line.
 *
 * Fields are assembled as modules and fitted to the pane by
 * `fitModules`, which shortens before it hides and keeps an alert on screen
 * after everything else has gone. Nothing here concatenates and clips.
 */
function renderStatusHeader(data: HudData, layout: LayoutConfig, width: number): string {
  const modules = buildBarModules(data, { barWidth: layout.barWidth ?? 10 });
  // A dimmed rule between clusters and a plain double space inside one: the
  // bar reads as a few groups rather than a list of equally spaced fields.
  return fitModules(modules, {
    width,
    separator: theme.separator(' │ '),
    groupSeparator: '  ',
  }).line;
}

function renderCompactLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  return [renderStatusHeader(data, layout, width)];
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

/**
 * Render the full HUD output (all lines)
 */
export function renderHud(data: HudData, options: RenderOptions): string[] {
  const layout = options.layout ?? DEFAULT_LAYOUT;

  if (layout.mode === 'compact') {
    return renderCompactLayout(data, layout, options.width);
  }
  
  return renderExpandedLayout(data, layout, options.width);
}

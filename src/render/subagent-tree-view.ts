import { colors, theme, stripAnsi, truncateAnsi, visualLength } from './colors.js';
import { layoutLeftRight, subagentStackedParts } from './subagent-chip.js';
import type { SubagentTree, SubagentTreeNode } from '../types.js';

function countStatuses(nodes: SubagentTreeNode[]): { running: number; done: number } {
  let running = 0;
  let done = 0;
  const walk = (items: SubagentTreeNode[]) => {
    for (const node of items) {
      if (node.status === 'completed' || node.status === 'error') {
        done += 1;
      } else {
        running += 1;
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return { running, done };
}

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
    const parts = subagentStackedParts(node);
    const connector = colors.dim(prefix + branch);
    const hangDim = colors.dim(hang);
    const headBudget = maxWidth ? Math.max(1, maxWidth - visualLength(connector)) : undefined;
    const detailBudget = maxWidth ? Math.max(1, maxWidth - visualLength(hangDim)) : undefined;
    const head = headBudget
      ? layoutLeftRight(headBudget, parts.iconName, parts.pulse)
      : `${parts.iconName}${parts.pulse ? ` ${parts.pulse}` : ''}`;
    const status = detailBudget
      ? layoutLeftRight(detailBudget, parts.status, parts.elapsed)
      : [parts.status, parts.elapsed].filter(Boolean).join('  ');
    lines.push(`${connector}${head}`);
    lines.push(`${hangDim}${status}`);
    if (parts.model || parts.effort) {
      const meta = detailBudget
        ? layoutLeftRight(detailBudget, parts.model, parts.effort)
        : [parts.model, parts.effort].filter(Boolean).join('·');
      lines.push(`${hangDim}${meta}`);
    }
    if (node.children.length > 0) {
      lines.push(...renderDirectoryTree(node.children, hang, maxWidth));
    }
  });
  return lines;
}

export function renderSubagentTreePage(tree: SubagentTree, maxWidth?: number): string[] {
  const counts = countStatuses(tree.nodes);
  const shortId = tree.rootId.length > 8 ? tree.rootId.slice(0, 8) : tree.rootId;
  const headerLeft = theme.info(`main · ${shortId}`);
  const headerRight = colors.dim(`${counts.running} run · ${counts.done} done`);
  const header = maxWidth
    ? layoutLeftRight(maxWidth, headerLeft, headerRight)
    : `${headerLeft}  ${headerRight}`;
  const lines = [header];
  if (tree.nodes.length === 0) {
    lines.push(colors.dim('No subagents'));
  } else {
    lines.push(...renderDirectoryTree(tree.nodes, '', maxWidth));
  }
  if (maxWidth && maxWidth > 0) {
    return lines.map((line) => truncateAnsi(line, maxWidth));
  }
  return lines;
}

export function renderTreeUnboundPage(maxWidth?: number): string[] {
  const lines = [colors.dim('Waiting for main session')];
  if (maxWidth && maxWidth > 0) {
    return lines.map((line) => truncateAnsi(line, maxWidth));
  }
  return lines;
}

export function renderSubagentTreePagePlain(tree: SubagentTree): string {
  return renderSubagentTreePage(tree).map(stripAnsi).join('\n');
}

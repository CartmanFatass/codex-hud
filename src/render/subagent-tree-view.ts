import { colors, theme, stripAnsi, truncateAnsi, visualLength } from './colors.js';
import { layoutLeftRight, renderSubagentPrefix } from './subagent-chip.js';
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
    const connector = colors.dim(prefix + branch);
    const budget = maxWidth ? Math.max(1, maxWidth - visualLength(connector)) : undefined;
    lines.push(`${connector}${renderSubagentPrefix(node, budget)}`);
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

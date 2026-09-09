import { colors, theme, stripAnsi, truncateAnsi } from './colors.js';
import { renderSubagentStackedLines } from './subagent-chip.js';
import type { SubagentTree, SubagentTreeNode } from '../types.js';

function renderRootLines(tree: SubagentTree): string[] {
  const shortId = tree.rootId.length > 8 ? tree.rootId.slice(0, 8) : tree.rootId;
  return [
    theme.info('● main'),
    colors.dim(`· ${shortId}`),
  ];
}

export function renderDirectoryTree(nodes: SubagentTreeNode[], prefix = ''): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? '└─ ' : '├─ ';
    const hang = prefix + (isLast ? '   ' : '│  ');
    const [head, ...details] = renderSubagentStackedLines(node);
    lines.push(`${colors.dim(prefix + branch)}${head}`);
    for (const detail of details) {
      lines.push(`${colors.dim(hang)}${detail}`);
    }
    if (node.children.length > 0) {
      lines.push(...renderDirectoryTree(node.children, hang));
    }
  });
  return lines;
}

export function renderSubagentTreePage(tree: SubagentTree, maxWidth?: number): string[] {
  const lines = [
    theme.info('Subagent tree'),
    colors.dim('q / Esc / Ctrl+C'),
    '',
  ];
  if (tree.nodes.length === 0) {
    lines.push(colors.dim('No subagents in this session.'));
  } else {
    lines.push(...renderRootLines(tree));
    lines.push(...renderDirectoryTree(tree.nodes));
    lines.push('');
    lines.push(colors.dim('⇄ traffic · 4s'));
    lines.push(colors.dim('◐ running'));
  }
  lines.push('');
  lines.push(colors.dim(`${tree.totalCount} node(s)`));
  if (maxWidth && maxWidth > 0) {
    return lines.map((line) => truncateAnsi(line, maxWidth));
  }
  return lines;
}

export function renderSubagentTreePagePlain(tree: SubagentTree): string {
  return renderSubagentTreePage(tree).map(stripAnsi).join('\n');
}

import { colors, theme, stripAnsi, truncateAnsi } from './colors.js';
import { renderSubagentChip } from './subagent-chip.js';
import type { SubagentTree, SubagentTreeNode } from '../types.js';

function renderRootChip(tree: SubagentTree): string {
  const shortId = tree.rootId.length > 8 ? tree.rootId.slice(0, 8) : tree.rootId;
  return `${theme.info('● main session')} ${colors.dim(`· ${shortId}`)}`;
}

export function renderDirectoryTree(nodes: SubagentTreeNode[], prefix = ''): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? '└─ ' : '├─ ';
    lines.push(`${colors.dim(prefix + branch)}${renderSubagentChip(node, { showStatusText: true })}`);
    if (node.children.length > 0) {
      lines.push(...renderDirectoryTree(node.children, prefix + (isLast ? '   ' : '│  ')));
    }
  });
  return lines;
}

export function renderSubagentTreePage(tree: SubagentTree, maxWidth?: number): string[] {
  const lines = [
    theme.info('Subagent tree'),
    colors.dim('live · q / Esc / Ctrl+C  close'),
    '',
  ];
  if (tree.nodes.length === 0) {
    lines.push(colors.dim('No subagents in this session.'));
  } else {
    lines.push(renderRootChip(tree));
    lines.push(...renderDirectoryTree(tree.nodes));
    lines.push('');
    lines.push(colors.dim('⇄/⇆ main<->agent traffic in the last 4s · ◐ colored = running'));
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

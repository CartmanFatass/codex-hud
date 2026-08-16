import { colors, theme, icons, stripAnsi } from './colors.js';
import type { SubagentTree, SubagentTreeNode } from '../types.js';

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

function renderChip(node: SubagentTreeNode): string {
  const icon = node.status === 'completed'
    ? icons.check
    : node.status === 'error'
      ? icons.cross
      : node.status === 'starting'
        ? '○'
        : icons.running;
  const color = node.status === 'completed'
    ? theme.success
    : node.status === 'error'
      ? theme.error
      : theme.info;
  const elapsed = node.startedAt ? ` ${colors.dim(formatElapsed(node.startedAt))}` : '';
  return `${color(`${icon} ${node.name}`)} ${colors.dim(node.status)}${elapsed}`;
}

export function renderDirectoryTree(nodes: SubagentTreeNode[], prefix = ''): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? '└─ ' : '├─ ';
    lines.push(`${colors.dim(prefix + branch)}${renderChip(node)}`);
    if (node.children.length > 0) {
      lines.push(...renderDirectoryTree(node.children, prefix + (isLast ? '   ' : '│  ')));
    }
  });
  return lines;
}

export function renderSubagentTreePage(tree: SubagentTree): string[] {
  const lines = [
    theme.info('Subagent tree'),
    colors.dim('live · q / Esc / Ctrl+C  close'),
    '',
  ];
  if (tree.nodes.length === 0) {
    lines.push(colors.dim('No subagents in this session.'));
  } else {
    lines.push(...renderDirectoryTree(tree.nodes));
  }
  lines.push('');
  lines.push(colors.dim(`${tree.totalCount} node(s)`));
  return lines;
}

export function renderSubagentTreePagePlain(tree: SubagentTree): string {
  return renderSubagentTreePage(tree).map(stripAnsi).join('\n');
}

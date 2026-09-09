/**
 * Shared subagent chip renderer used by both the collapsed HUD row and the
 * full-tree popup, so status icons, animation, and model/effort display stay
 * consistent between the two surfaces.
 */

import { colors, theme, icons, truncateAnsi, visualLength } from './colors.js';
import type { SubagentTreeNode } from '../types.js';

// CollabAgentItem events newer than this count as live main<->agent traffic.
export const COMM_FRESH_MS = 4000;

// The traffic marker is the only animated element: it flips while a
// main<->agent exchange is in its fresh window. 250ms per frame.
const COMM_FRAMES = ['⇄', '⇆'];
const COMM_FRAME_MS = 250;

export function commFrame(nowMs: number = Date.now()): string {
  return COMM_FRAMES[Math.floor(nowMs / COMM_FRAME_MS) % COMM_FRAMES.length];
}

export function hasFreshComm(node: SubagentTreeNode, nowMs: number = Date.now()): boolean {
  return Boolean(node.lastActivityAt && nowMs - node.lastActivityAt.getTime() <= COMM_FRESH_MS);
}

export function formatModelEffort(node: SubagentTreeNode): string | null {
  const model = node.model?.trim();
  const effort = node.effort?.trim();
  if (!model && !effort) {
    return null;
  }
  if (model && effort) {
    return `${model}·${effort}`;
  }
  return model ?? `·${effort}`;
}

export function formatElapsedShort(startTime: Date, nowMs: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - startTime.getTime()) / 1000));
  if (diffSec < 60) {
    return `${diffSec}s`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m${String(diffSec % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(diffMin / 60)}h${String(diffMin % 60).padStart(2, '0')}m`;
}

export function subagentVisual(node: SubagentTreeNode): {
  icon: string;
  paint: (text: string) => string;
} {
  // Static icon per status; color carries the running/terminal distinction.
  const icon = node.status === 'completed'
    ? icons.check
    : node.status === 'error'
      ? icons.cross
      : node.status === 'starting'
        ? '○'
        : icons.running;
  const paint = node.status === 'completed'
    ? theme.success
    : node.status === 'error'
      ? theme.error
      : theme.info;
  return { icon, paint };
}

function elapsedEndMs(node: SubagentTreeNode, nowMs: number): number {
  if (node.status === 'completed' || node.status === 'error') {
    return node.lastActivityAt?.getTime() ?? node.startedAt?.getTime() ?? nowMs;
  }
  return nowMs;
}

export function layoutLeftRight(maxWidth: number, left: string, right = '', gap = 1): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (!right) {
    return truncateAnsi(left, maxWidth);
  }
  const rightWidth = visualLength(right);
  if (rightWidth >= maxWidth) {
    return truncateAnsi(right, maxWidth);
  }
  const leftBudget = maxWidth - rightWidth - gap;
  if (leftBudget <= 0) {
    return truncateAnsi(right, maxWidth);
  }
  return `${truncateAnsi(left, leftBudget)}${' '.repeat(gap)}${right}`;
}

export function renderSubagentChip(
  node: SubagentTreeNode,
  opts?: { showStatusText?: boolean; nowMs?: number }
): string {
  const nowMs = opts?.nowMs ?? Date.now();
  const { icon, paint } = subagentVisual(node);
  const pulse = hasFreshComm(node, nowMs) ? theme.warning(`${commFrame(nowMs)} `) : '';
  const meta = formatModelEffort(node);
  const metaText = meta ? ` ${colors.dim(meta)}` : '';
  const statusText = opts?.showStatusText ? ` ${colors.dim(node.status)}` : '';
  const elapsed = node.startedAt
    ? ` ${colors.dim(formatElapsedShort(node.startedAt, elapsedEndMs(node, nowMs)))}`
    : '';
  return `${pulse}${paint(`${icon} ${node.name}`)}${metaText}${statusText}${elapsed}`;
}

export interface StackedAgentParts {
  iconName: string;
  pulse: string;
  status: string;
  elapsed: string;
  model: string;
  effort: string;
}

export function subagentStackedParts(
  node: SubagentTreeNode,
  opts?: { nowMs?: number }
): StackedAgentParts {
  const nowMs = opts?.nowMs ?? Date.now();
  const { icon, paint } = subagentVisual(node);
  return {
    iconName: paint(`${icon} ${node.name}`),
    pulse: hasFreshComm(node, nowMs) ? theme.warning(commFrame(nowMs)) : '',
    status: colors.dim(node.status),
    elapsed: node.startedAt
      ? colors.dim(formatElapsedShort(node.startedAt, elapsedEndMs(node, nowMs)))
      : '',
    model: node.model?.trim() ? colors.dim(node.model.trim()) : '',
    effort: node.effort?.trim() ? colors.dim(node.effort.trim()) : '',
  };
}

/** Side-panel rows: name on its own line, status/elapsed and model stacked below. */
export function renderSubagentStackedLines(
  node: SubagentTreeNode,
  opts?: { nowMs?: number; maxWidth?: number }
): string[] {
  const parts = subagentStackedParts(node, opts);
  const width = opts?.maxWidth;
  const head = width
    ? layoutLeftRight(width, parts.iconName, parts.pulse)
    : `${parts.iconName}${parts.pulse ? ` ${parts.pulse}` : ''}`;
  const status = width
    ? layoutLeftRight(width, parts.status, parts.elapsed)
    : [parts.status, parts.elapsed].filter(Boolean).join('  ');
  const lines = [head, status];
  if (parts.model || parts.effort) {
    const meta = width
      ? layoutLeftRight(width, parts.model, parts.effort)
      : [parts.model, parts.effort].filter(Boolean).join('·');
    lines.push(meta);
  }
  return lines;
}

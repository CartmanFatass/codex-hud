/**
 * Shared subagent chip renderer used by both the collapsed HUD row and the
 * full-tree popup, so status icons, animation, and model/effort display stay
 * consistent between the two surfaces.
 */

import { colors, theme, icons, truncateAnsi, visualLength } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import type { SubagentStatus, SubagentTreeNode } from '../types.js';

// CollabAgentItem events newer than this count as live main<->agent traffic.
export const COMM_FRESH_MS = 4000;

// The traffic marker is the only animated element: it flips while a
// main<->agent exchange is in its fresh window. 250ms per frame.
const COMM_FRAMES = ['⇄', '⇆'];
const COMM_FRAME_MS = 250;

/**
 * The traffic marker's current frame.
 *
 * With reduced motion the marker stops flipping and shows a single static
 * symbol. It still means the same thing: a main-to-agent exchange happened
 * recently, not that the model is mid-sentence or a tool is running.
 */
export function commFrame(nowMs: number = Date.now()): string {
  if (displayConfig().motion === 'reduced') {
    return COMM_FRAMES[0];
  }
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

const STATUS_VISUALS: Record<SubagentStatus, { icon: string; paint: (text: string) => string }> = {
  completed: { icon: icons.check, paint: theme.success },
  error: { icon: icons.cross, paint: theme.error },
  starting: { icon: icons.starting, paint: theme.info },
  running: { icon: icons.running, paint: theme.info },
  // An agent with no observed state reads as a question, not as activity.
  unknown: { icon: icons.unknown, paint: theme.dim },
};

export function subagentVisual(node: SubagentTreeNode): {
  icon: string;
  paint: (text: string) => string;
} {
  // Static icon per status; colour carries the running/terminal distinction.
  return STATUS_VISUALS[node.status] ?? STATUS_VISUALS.running;
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

export function renderSubagentPrefix(node: SubagentTreeNode, maxWidth?: number): string {
  const { icon, paint } = subagentVisual(node);
  const token = renderModelEffortToken(node.model, node.effort);
  const lead = token ? `${paint(icon)} ${token}` : paint(icon);
  const name = paint(node.name);
  const pulse = hasFreshComm(node) ? theme.warning(commFrame()) : '';
  if (!maxWidth) {
    return [lead, name, pulse].filter(Boolean).join(' ');
  }
  const pulseWidth = pulse ? visualLength(pulse) + 1 : 0;
  const leadWidth = visualLength(lead) + 1;
  const nameBudget = Math.max(1, maxWidth - leadWidth - pulseWidth);
  const clippedName = truncateAnsi(name, nameBudget);
  return [lead, clippedName, pulse].filter(Boolean).join(' ');
}

export function renderSubagentChip(
  node: SubagentTreeNode,
  opts?: { showStatusText?: boolean; nowMs?: number }
): string {
  const nowMs = opts?.nowMs ?? Date.now();
  const pulse = hasFreshComm(node, nowMs) ? theme.warning(`${commFrame(nowMs)} `) : '';
  const statusText = opts?.showStatusText ? ` ${colors.dim(node.status)}` : '';
  return `${pulse}${renderSubagentPrefix(node)}${statusText}`;
}

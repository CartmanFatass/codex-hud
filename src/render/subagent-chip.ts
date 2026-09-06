/**
 * Shared subagent chip renderer used by both the collapsed HUD row and the
 * full-tree popup, so status icons, animation, and model/effort display stay
 * consistent between the two surfaces.
 */

import { colors, theme, icons } from './colors.js';
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

export function renderSubagentChip(
  node: SubagentTreeNode,
  opts?: { showStatusText?: boolean; nowMs?: number }
): string {
  const nowMs = opts?.nowMs ?? Date.now();
  // Static icon per status; color carries the running/terminal distinction.
  // Animation is reserved for the traffic marker below.
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
  const pulse = hasFreshComm(node, nowMs) ? theme.warning(`${commFrame(nowMs)} `) : '';
  const meta = formatModelEffort(node);
  const metaText = meta ? ` ${colors.dim(meta)}` : '';
  const statusText = opts?.showStatusText ? ` ${colors.dim(node.status)}` : '';
  const elapsed = node.startedAt ? ` ${colors.dim(formatElapsedShort(node.startedAt, nowMs))}` : '';
  return `${pulse}${color(`${icon} ${node.name}`)}${metaText}${statusText}${elapsed}`;
}

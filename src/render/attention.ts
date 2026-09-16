/**
 * What needs a person.
 *
 * Only explicit events count. A quiet log is not a stuck agent and an
 * approval policy is not a pending approval, so nothing here is inferred from
 * silence or from configuration. Anything the HUD cannot observe stays absent
 * rather than being guessed at.
 */

import type { HudData, SubagentTreeNode } from '../types.js';

export type AttentionKind = 'tool-error' | 'agent-error' | 'quota-exhausted' | 'context-critical';

export interface AttentionItem {
  kind: AttentionKind;
  /** Short phrase for the bar. */
  label: string;
  /** One line of context for the detail view. */
  detail: string;
  severity: 'warning' | 'error';
}

const RECENT_TOOL_ERROR_MS = 120_000;

function walk(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

export function collectAttention(data: HudData, nowMs: number = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];

  // A tool that reported failure. Counted from the recorded result, never from
  // the command's name.
  const failedTools = (data.toolActivity?.recentCalls ?? []).filter(
    (call) => call.status === 'error' && nowMs - call.timestamp.getTime() <= RECENT_TOOL_ERROR_MS
  );
  if (failedTools.length > 0) {
    const latest = failedTools[failedTools.length - 1];
    items.push({
      kind: 'tool-error',
      label: failedTools.length === 1 ? '1 tool failed' : `${failedTools.length} tools failed`,
      detail: `${latest.name}${latest.target ? `: ${latest.target}` : ''}`,
      severity: 'error',
    });
  }

  // An agent that ended in error, as opposed to one that merely ended.
  const failedAgents: SubagentTreeNode[] = [];
  walk(data.subagentTree?.nodes ?? [], (node) => {
    if (node.status === 'error') {
      failedAgents.push(node);
    }
  });
  if (failedAgents.length > 0) {
    items.push({
      kind: 'agent-error',
      label: failedAgents.length === 1 ? '1 agent failed' : `${failedAgents.length} agents failed`,
      detail: failedAgents.map((node) => node.name).join(', '),
      severity: 'error',
    });
  }

  // Quota: only when the account actually reported being cut off, or a window
  // reported itself full.
  const limits = data.rateLimits;
  if (limits) {
    const reached = limits.rate_limit_reached_type;
    const fullWindow = [limits.primary, limits.secondary].find(
      (window) => typeof window?.used_percent === 'number' && window.used_percent >= 100
    );
    if (reached || fullWindow) {
      items.push({
        kind: 'quota-exhausted',
        label: 'quota spent',
        detail: reached ? `rate limit reached: ${reached}` : 'a usage window is full',
        severity: 'error',
      });
    }
  }

  const contextPercent = data.contextUsage?.percent;
  if (typeof contextPercent === 'number' && contextPercent >= 90) {
    items.push({
      kind: 'context-critical',
      label: `context ${contextPercent}%`,
      detail: 'the context window is nearly full',
      severity: 'warning',
    });
  }

  return items;
}

export function highestSeverity(items: AttentionItem[]): 'warning' | 'error' | null {
  if (items.some((item) => item.severity === 'error')) {
    return 'error';
  }
  if (items.length > 0) {
    return 'warning';
  }
  return null;
}

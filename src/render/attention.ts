/**
 * What needs a person.
 *
 * Only explicit events count. A quiet log is not a stuck agent and an
 * approval policy is not a pending approval, so nothing here is inferred from
 * silence or from configuration. Anything the HUD cannot observe stays absent
 * rather than being guessed at.
 */

import type { HudData, SubagentTreeNode } from '../types.js';
import { eachThread, type ThreadKind } from '../collectors/subagent-tree.js';
import { quotaState, readQuotaWindows } from './quota.js';

export type AttentionKind =
  | 'approval'
  | 'tool-error'
  | 'agent-error'
  | 'subtask-error'
  | 'review-error'
  | 'quota-exhausted'
  | 'context-critical';

export interface AttentionItem {
  kind: AttentionKind;
  /** Short phrase for the bar. */
  label: string;
  /** One line of context for the detail view. */
  detail: string;
  severity: 'warning' | 'error';
  /** For an approval: when it was asked for, so the wait can be shown. */
  since?: Date;
}

/** How long something has waited, at a glance: "45s", "12m", "1h05m". */
export function waitedText(since: Date, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${Math.floor(hours / 24)}d`;
}

const RECENT_TOOL_ERROR_MS = 120_000;

type Say = (text: string, vars?: Record<string, string | number>) => string;
const plain: Say = (text, vars) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ''));
const FAILED = /^(\d+) (tool|agent|subtask|review)s? failed$/;

/**
 * The alerts as the bar and the status card say them, a phrase each: an
 * approval with how long it has waited (`waits`), and the failures of every
 * kind as one, `1 agent · 1 subtask failed`, where it would otherwise be
 * `1 agent failed · 1 subtask failed`. `say` puts a phrase in the panel's
 * language; a failure goes through it as `1 agent` and `{list} failed`.
 */
export function alertParts(items: readonly AttentionItem[], nowMs: number, say: Say = plain, waits = true): string[] {
  const parts: string[] = [];
  const failed: string[] = [];
  let at = -1;
  for (const item of items) {
    const failure = item.label.match(FAILED);
    if (failure) {
      if (at < 0) at = parts.length;
      failed.push(say(failure[1] === '1' ? `1 ${failure[2]}` : `{n} ${failure[2]}s`, { n: failure[1] }));
      continue;
    }
    parts.push(`${say(item.label)}${waits && item.since ? ` ${waitedText(item.since, nowMs)}` : ''}`);
  }
  if (at >= 0) parts.splice(at, 0, say('{list} failed', { list: failed.join(' · ') }));
  return parts;
}

const APPROVAL_LABELS: Record<'exec' | 'patch' | 'input', string> = {
  exec: 'approval needed',
  patch: 'patch approval needed',
  input: 'input needed',
};

const APPROVAL_FALLBACK: Record<'exec' | 'patch' | 'input', string> = {
  exec: 'a command is waiting for approval',
  patch: 'a patch is waiting for approval',
  input: 'the session is waiting for an answer',
};

export function collectAttention(data: HudData, nowMs: number = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Codex asked and nothing has answered. First in the list because it is the
  // one item where the session cannot continue without the reader.
  const approval = data.pendingApproval;
  if (approval) {
    items.push({
      kind: 'approval',
      label: APPROVAL_LABELS[approval.kind],
      detail: approval.summary ?? APPROVAL_FALLBACK[approval.kind],
      severity: 'warning',
      // Only the main session's rollout records approvals, so the wait is
      // the session's; which agent asked is not something it says.
      ...(Number.isFinite(approval.since.getTime()) ? { since: approval.since } : {}),
    });
  }

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

  // A thread that ended in error, as opposed to one that merely ended, under
  // the name every view counts it by: an agent the main session started, a
  // subtask under one, a guardian review.
  const failed: Record<ThreadKind, SubagentTreeNode[]> = { agent: [], subtask: [], review: [] };
  eachThread(data.subagentTree?.nodes ?? [], (node, kind) => {
    if (node.status === 'error') {
      failed[kind].push(node);
    }
  });
  for (const kind of ['agent', 'subtask', 'review'] as const) {
    const nodes = failed[kind];
    if (nodes.length > 0) {
      items.push({
        kind: `${kind}-error`,
        label: nodes.length === 1 ? `1 ${kind} failed` : `${nodes.length} ${kind}s failed`,
        detail: nodes.map((node) => node.name).join(', '),
        severity: 'error',
      });
    }
  }

  // Quota: only when the account actually reported being cut off, or a window
  // reported itself full with no credits to carry on.
  const limits = data.rateLimits;
  if (limits && quotaState(limits, readQuotaWindows(limits, nowMs)).spent) {
    const reached = limits.rate_limit_reached_type;
    items.push({
      kind: 'quota-exhausted',
      label: 'quota spent',
      detail: reached ? `rate limit reached: ${reached}` : 'a usage window is full',
      severity: 'error',
    });
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

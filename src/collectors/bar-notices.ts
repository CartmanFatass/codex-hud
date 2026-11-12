/**
 * What just happened in the main session, for the bar's notice zone: an agent
 * it started finished or failed, the account went on to its credits. Each is
 * a change between two collections, so the tracker keeps what the last one
 * saw; the first collection of a session only sets that baseline, and
 * nothing that happened before the HUD looked is replayed.
 */

import type { BarNotice, HudData, SubagentTreeNode } from '../types.js';
import { readQuotaWindows, quotaState } from '../render/quota.js';

/** Notices kept, newest first. The bar shows one; the rest are for whoever reads the snapshot. */
const KEPT = 5;

function topAgents(data: HudData): SubagentTreeNode[] {
  return (data.subagentTree?.nodes ?? []).filter((node) => node.kind !== 'guardian');
}

function onCredits(data: HudData, nowMs: number): boolean {
  const windows = readQuotaWindows(data.rateLimits, nowMs);
  return windows.some((window) => window.percent >= 100) && quotaState(data.rateLimits, windows).credits !== null;
}

export class BarNoticeTracker {
  private root: string | null = null;
  private agents = new Map<string, SubagentTreeNode['status']>();
  private credits = false;
  private notices: BarNotice[] = [];

  /** Compares this collection with the last and returns the notices so far, newest first. */
  observe(data: HudData, nowMs: number): BarNotice[] {
    const root = data.session?.id ?? data.subagentTree?.rootId ?? '';
    const fresh = root !== this.root;
    if (fresh) {
      this.root = root;
      this.notices = [];
    }
    const at = new Date(nowMs);
    const found: BarNotice[] = [];

    const agents = topAgents(data);
    for (const node of agents) {
      // Its role, else its nickname, as the type of a Claude subagent is named.
      const who = {
        subject: node.role || node.nickname || node.name,
        id: node.id,
        model: node.model,
        effort: node.effort,
      };
      const before = this.agents.get(node.id);
      // Dated by its own start: an agent the tree only now lists is old news to the bar.
      if (!fresh && before === undefined && (node.status === 'running' || node.status === 'starting'))
        found.push({ kind: 'agent-started', ...who, at: node.startedAt ?? at });
      if (!fresh && (before === 'running' || before === 'starting')) {
        if (node.status === 'completed') found.push({ kind: 'agent-done', ...who, at });
        else if (node.status === 'error') found.push({ kind: 'agent-failed', ...who, at });
      }
    }
    this.agents = new Map(agents.map((node) => [node.id, node.status]));

    const credits = onCredits(data, nowMs);
    if (!fresh && credits && !this.credits) found.push({ kind: 'credits', at });
    this.credits = credits;

    if (found.length) this.notices = [...found.reverse(), ...this.notices].slice(0, KEPT);
    return this.notices;
  }
}

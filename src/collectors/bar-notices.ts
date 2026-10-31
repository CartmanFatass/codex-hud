/**
 * What just happened in the main session, for the bar's notice zone: an agent
 * it started finished or failed, a turn finished, the account went on to its
 * credits. Each is a change between two collections, so the tracker keeps
 * what the last one saw; the first collection of a session only sets that
 * baseline, and nothing that happened before the HUD looked is replayed. The
 * one exception is a session found idle: its turn's end is on record, so the
 * bar can say how long ago that was.
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
  private working = false;
  private turnStartedAt: Date | undefined;
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
      const before = this.agents.get(node.id);
      if (!fresh && (before === 'running' || before === 'starting')) {
        if (node.status === 'completed') found.push({ kind: 'agent-done', subject: node.name, at });
        else if (node.status === 'error') found.push({ kind: 'agent-failed', subject: node.name, at });
      }
    }
    this.agents = new Map(agents.map((node) => [node.id, node.status]));

    const state = data.stale ? undefined : data.activity?.state;
    if (state !== undefined) {
      const working = state === 'working';
      if (working) {
        this.turnStartedAt = data.activity?.turnStartedAt ?? this.turnStartedAt;
      } else if (state === 'idle' && (this.working || fresh)) {
        // Found idle on a first look, the turn's end is the activity's own time.
        const ended = fresh ? data.activity?.updatedAt : at;
        const started = data.activity?.turnStartedAt ?? this.turnStartedAt;
        if (ended) {
          found.push({ kind: 'turn-done', at: ended,
            ...(started && started.getTime() <= ended.getTime() ? { durationMs: ended.getTime() - started.getTime() } : {}) });
        }
      }
      this.working = working;
    }

    const credits = onCredits(data, nowMs);
    if (!fresh && credits && !this.credits) found.push({ kind: 'credits', at });
    this.credits = credits;

    if (found.length) this.notices = [...found.reverse(), ...this.notices].slice(0, KEPT);
    return this.notices;
  }
}

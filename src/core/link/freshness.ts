import { projectFreshness } from '../observation.js';
import type { DelegationViewModel, DelegationNodeDetails } from './view-model.js';

/** Pure paint-side aging of captured committed evidence; receipt is never a successful read. */
export function projectDelegationFreshness(
  view: DelegationViewModel,
  nowMs: number
): { view: DelegationViewModel; nextDeadline: number } {
  let nextDeadline = Infinity;
  let changed = false;
  const nodes = new Map(view.tree.nodes.map((node) => [node.key, node]));
  const details: Record<string, DelegationNodeDetails> = {};
  for (const [key, detail] of Object.entries(view.details)) {
    const original = nodes.get(key)?.observation?.statusProjection;
    if (detail.statusSource !== 'committed' || !original) {
      details[key] = detail;
      continue;
    }
    const freshness = projectFreshness(original.freshness.sources, original.freshness.requiredSourceIds, nowMs);
    for (const source of original.freshness.sources)
      if (source.deadlineAt !== null && source.deadlineAt >= nowMs)
        nextDeadline = Math.min(nextDeadline, source.deadlineAt + 1);
    if (
      detail.status?.freshness.state === freshness.state &&
      detail.status.freshness.reason === freshness.reason &&
      detail.status.freshness.staleSince === freshness.staleSince &&
      detail.status.freshness.clockAnomaly === freshness.clockAnomaly
    )
      details[key] = detail;
    else {
      details[key] = { ...detail, status: { ...original, freshness } };
      changed = true;
    }
  }
  return { view: changed ? { ...view, details } : view, nextDeadline };
}

/** Repaints between source reads share one immutable view until an actual deadline or clock rollback. */
export class DelegationFreshness {
  private input: DelegationViewModel | null = null;
  private projected: DelegationViewModel | null = null;
  private clock = -Infinity;
  private deadline = Infinity;
  current(view: DelegationViewModel | null, nowMs: number): DelegationViewModel | null {
    if (!view) {
      this.input = this.projected = null;
      this.deadline = Infinity;
      return null;
    }
    if (view === this.input && nowMs >= this.clock && nowMs < this.deadline) return this.projected;
    const result = projectDelegationFreshness(view, nowMs);
    this.input = view;
    this.projected = result.view;
    this.clock = nowMs;
    this.deadline = result.nextDeadline;
    return this.projected;
  }
  nextDeadline(): number {
    return this.deadline;
  }
}

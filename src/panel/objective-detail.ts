/** Resolve an open Objective sub-page's record and openable evidence together outside paint. */
import { collectObjectiveEvidence } from '../collectors/objectives.js';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { ObjectiveDetail } from '../render/monitor-state.js';
import { reconcileObjectiveDetail } from '../render/objective-detail.js';

/** Resolve both the Objective target and its openable evidence from one Project snapshot. */
export function resolveObjectiveDetail(
  detail: ObjectiveDetail,
  project: ProjectSnapshot | undefined,
  hudHome: string,
): ObjectiveDetail {
  const next = reconcileObjectiveDetail(detail, project);
  if (next.target.unavailable || next.target.pending) return next;
  return {
    ...next,
    evidence: collectObjectiveEvidence(next.target.objective, next.target.root, hudHome),
  };
}

export class PanelObjectiveSync {
  private last?: { root: string; id: string; project: ProjectSnapshot | undefined };

  constructor(private readonly hudHome: string) {}

  /** Re-resolve whenever the open Objective or its matching Project read changes. */
  sync(detail: ObjectiveDetail | undefined, project: ProjectSnapshot | undefined): ObjectiveDetail | undefined {
    if (!detail) {
      this.last = undefined;
      return undefined;
    }
    const root = detail.target.root;
    const id = detail.target.objective.id;
    const sameRead = this.last !== undefined
      && this.last.root === root
      && this.last.id === id
      && this.last.project === project;
    if (sameRead && (detail.target.pending || detail.target.unavailable || detail.evidence !== undefined)) {
      return detail;
    }
    const resolved = resolveObjectiveDetail(detail, project, this.hudHome);
    this.last = { root, id, project };
    return resolved;
  }
}

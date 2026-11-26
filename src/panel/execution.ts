/** Bounded project job activity and live worker records for Execution. */
import { executionSnapshot, type ExecutionSnapshot, type ExecutionView } from '../collectors/execution.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { SubagentTree } from '../types.js';
import { PanelJobPipeline } from './job-pipeline.js';

export class PanelExecution {
  private readonly noAgents: SubagentTree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
  private open?: { root: string; jobs: PanelJobPipeline };
  private snapshot?: ExecutionSnapshot;
  private ticketActivity?: ExecutionSnapshot['ticketActivity'];

  constructor(private readonly home: string, private readonly pane: string | null) {}

  /** `root` is the project whose jobs are needed, if any. */
  sync(root: string | undefined): void {
    if (root !== this.open?.root) {
      this.close();
      if (root !== undefined) this.open = { root, jobs: new PanelJobPipeline(this.home, { project: root, pane: this.pane, within: root }) };
    }
  }

  async refresh(inspecting?: string, now = Date.now(), activityOnly = false): Promise<void> {
    const open = this.open;
    if (!open || !(await open.jobs.refresh(inspecting)) || this.open !== open) return;
    const snapshot = executionSnapshot(this.home, open.jobs.workboard(this.noAgents),
      { root: open.root, pane: this.pane, complete: open.jobs.jobsObserved, activityOnly }, now);
    this.ticketActivity = snapshot.ticketActivity;
    if (!activityOnly) this.snapshot = snapshot;
  }

  activity(root: string) {
    return this.open?.root === root ? this.ticketActivity : undefined;
  }

  /** Collected facts for paint; undefined until the project's first read. */
  view(root: string): ExecutionView | undefined {
    return this.snapshot?.root === root ? this.snapshot : undefined;
  }

  /** The project's jobs, every pane's: what an Inspector opened from the page reads. */
  board(): WorkboardSnapshot | undefined {
    return this.snapshot && this.open?.jobs.workboard(this.noAgents);
  }

  dispose(): void { this.close(); }

  private close(): void {
    this.open?.jobs.dispose();
    this.open = undefined;
    this.snapshot = undefined;
    this.ticketActivity = undefined;
  }
}

/** What the panel collects for the Project Execution page, and only while it or an Inspector opened from it is up. */
import { executionSnapshot, type ExecutionSnapshot, type ExecutionView } from '../collectors/execution.js';
import { ScreenSampler } from '../collectors/execution-screens.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { SubagentTree } from '../types.js';
import { PanelJobPipeline } from './job-pipeline.js';

export class PanelExecution {
  private readonly noAgents: SubagentTree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
  private readonly screens: ScreenSampler;
  private open?: { root: string; jobs: PanelJobPipeline };
  private snapshot?: ExecutionSnapshot;

  constructor(private readonly home: string, private readonly pane: string | null, private readonly env: NodeJS.ProcessEnv, changed: () => void) {
    this.screens = new ScreenSampler(env, changed);
  }

  /** `root` is the project whose jobs are needed, if any; `watching` that its page is on screen, which alone reads worker panes. */
  sync(root: string | undefined, watching: boolean): void {
    if (root !== this.open?.root) {
      this.close();
      if (root !== undefined) this.open = { root, jobs: new PanelJobPipeline(this.home, { project: root, pane: this.pane, within: root }) };
    }
    if (watching && this.open) this.screens.start();
    else this.screens.stop();
  }

  async refresh(inspecting?: string, now = Date.now()): Promise<void> {
    const open = this.open;
    if (!open || !(await open.jobs.refresh(inspecting)) || this.open !== open) return;
    const { snapshot, targets } = executionSnapshot(this.home, open.jobs.workboard(this.noAgents),
      { root: open.root, pane: this.pane, env: this.env, complete: open.jobs.jobsObserved }, now);
    this.snapshot = snapshot;
    this.screens.watch(targets);
  }

  /** Collected facts for paint; undefined until the project's first read. */
  view(root: string): ExecutionView | undefined {
    return this.snapshot?.root === root ? { ...this.snapshot, screens: this.screens.current() } : undefined;
  }

  /** The project's jobs, every pane's: what an Inspector opened from the page reads. */
  board(): WorkboardSnapshot | undefined {
    return this.snapshot && this.open?.jobs.workboard(this.noAgents);
  }

  dispose(): void { this.close(); }

  private close(): void {
    this.screens.stop();
    this.screens.watch([]);
    this.open?.jobs.dispose();
    this.open = undefined;
    this.snapshot = undefined;
  }
}

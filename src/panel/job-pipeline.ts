import * as path from 'node:path';
import { DiffStatCollector } from '../collectors/diff-stat.js';
import { readHeadlessOutput } from '../collectors/headless-output.js';
import { readJobFile } from '../collectors/read-job-file.js';
import { jobFiles } from '../mcp/paths.js';
import type { ThinJobScope } from '../collectors/thin-jobs.js';
import { jobLaneSnapshot } from '../collectors/job-snapshot.js';
import type { WorkboardSnapshot, WorkLane } from '../collectors/workboard-types.js';
import { buildWorkboard } from '../collectors/workboard.js';
import type { SubagentTree } from '../types.js';
import { jobPanelObservation } from '../utils/collection-observation.js';

/** Collect the retained jobs of the calling pane, with extra evidence only for the inspected job. */
export class PanelJobPipeline {
  private boardCache?: { tree: SubagentTree; board: WorkboardSnapshot };
  private readonly snapshot;
  private thinJobs: WorkLane[] = [];
  private jobDiffs = new DiffStatCollector();
  private thinObservation = { complete: false };
  private generation = 0;
  private closed = false;

  constructor(
    readonly home: string,
    thinScope: ThinJobScope,
  ) { this.snapshot = jobLaneSnapshot(home, thinScope); }
  dispose(): void {
    this.closed = true;
    this.snapshot.close();
    this.boardCache = undefined;
  }
  workboard(tree: SubagentTree): WorkboardSnapshot {
    if (this.boardCache?.tree === tree) return this.boardCache.board;
    const board = buildWorkboard(tree, this.thinJobs);
    this.boardCache = { tree, board };
    return board;
  }
  get jobsObserved(): boolean { return this.thinObservation.complete; }
  observation(tree: SubagentTree, nativeQuiet: boolean) {
    return jobPanelObservation(this.workboard(tree), this.thinObservation.complete, nativeQuiet);
  }
  async refresh(inspecting?: string): Promise<boolean> {
    if (this.closed) return false;
    const generation = ++this.generation;
    const snapshot = await this.snapshot.read();
    if (!snapshot || this.closed || generation !== this.generation) return false;
    let lanes = snapshot.lanes;
    const id = /^thin-job:(j[0-9a-f]{16})$/.exec(inspecting ?? '')?.[1];
    const lane = id && lanes.find((l) => l.workers.some((w) => w.id === inspecting));
    if (id && lane) {
      const worker = lane.workers.find((w) => w.id === inspecting)!;
      const directory = path.resolve(this.home, 'jobs', id);
      const diffStat = await this.jobDiffs.job(directory, worker.settledAt, Date.now());
      if (this.closed || generation !== this.generation) return false;
      // A headless job has no tab to look at: the job open in the Inspector also carries its newest output lines.
      const output = worker.headless ? readHeadlessOutput(directory) : undefined;
      const limit = 4096;
      const excerpt = worker.files?.some((file) => file.kind === 'report')
        ? readJobFile(path.join(directory, jobFiles.report), limit) : undefined;
      const report = excerpt?.text.trim() ? { text: excerpt.text, truncated: (excerpt.size ?? 0) > limit } : undefined;
      if (diffStat || output || report) lanes = lanes.map((l) => l !== lane ? l : {
        ...l, workers: l.workers.map((w) => w === worker ? { ...w, ...(diffStat && { diffStat }), ...(output && { output }), ...(report && { report }) } : w),
      });
    }
    if (this.thinJobs !== lanes) this.boardCache = undefined;
    this.thinJobs = lanes;
    this.thinObservation = { complete: snapshot.complete };
    return true;
  }
}

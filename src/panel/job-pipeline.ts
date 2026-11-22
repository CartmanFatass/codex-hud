import * as path from 'node:path';
import { ActivityRings } from '../collectors/activity-ring.js';
import { DiffStatCollector } from '../collectors/diff-stat.js';
import type { ThinJobScope } from '../collectors/thin-jobs.js';
import { jobLaneSnapshot } from '../collectors/job-snapshot.js';
import type { OwnerWorker, WorkboardSnapshot, WorkLane } from '../collectors/workboard-types.js';
import { buildWorkboard } from '../collectors/workboard.js';
import type { SubagentTree } from '../types.js';
import { jobPanelObservation } from '../utils/collection-observation.js';

/** Collect thin jobs and project them alongside the native tree. */
export class PanelJobPipeline {
  private boardCache?: { tree: SubagentTree; board: WorkboardSnapshot };
  private readonly snapshot;
  private thinJobs: WorkLane[] = [];
  private rings = new ActivityRings();
  private jobDiffs = new DiffStatCollector();
  private thinObservation = { complete: false };
  private generation = 0;
  private closed = false;

  constructor(
    readonly home: string,
    thinScope: ThinJobScope,
    readonly openedAt = Date.now()
  ) { this.snapshot = jobLaneSnapshot(home, thinScope, { openedAt }); }
  dispose(): void {
    this.closed = true;
    this.snapshot.close();
    this.boardCache = undefined;
  }
  workboard(tree: SubagentTree): WorkboardSnapshot {
    if (this.boardCache?.tree === tree) return this.boardCache.board;
    let board = buildWorkboard(tree, this.thinJobs);
    // Each running worker's activity ring, fed once per recomposition; a worker is one object in the lanes and the list.
    const activity = this.rings.observe(board.workers, Date.now());
    if (activity.size) {
      const add = new Map(board.workers.filter((w) => activity.has(w.id)).map((w) => [w, { ...w, activity: activity.get(w.id) }]));
      const swap = (w: OwnerWorker) => add.get(w) ?? w;
      board = { ...board, workers: board.workers.map(swap), lanes: board.lanes.map((l) => ({ ...l, workers: l.workers.map(swap) })) };
    }
    this.boardCache = { tree, board };
    return board;
  }
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
      const diffStat = await this.jobDiffs.job(path.resolve(this.home, 'jobs', id), worker.settledAt, Date.now());
      if (this.closed || generation !== this.generation) return false;
      if (diffStat) lanes = lanes.map((l) => l !== lane ? l : {
        ...l, workers: l.workers.map((w) => w === worker ? { ...w, diffStat } : w),
      });
    }
    if (this.thinJobs !== lanes) this.boardCache = undefined;
    this.thinJobs = lanes;
    this.thinObservation = { complete: snapshot.complete };
    return true;
  }
}

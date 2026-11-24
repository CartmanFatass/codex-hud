import { join } from 'node:path';
import type { ListedProject } from '../roles/projects.js';
import type { ObjectiveRecord } from './objectives.js';
import { ResultReceipts, resultDate } from './result-receipts.js';
import { compareOwnerRequests, ProjectCollector, projectJobWindow, type ProjectItem, type ProjectSnapshot } from './project-board.js';
import type { WorkboardSnapshot } from './workboard-types.js';

export interface HomeProject extends ListedProject { snapshot?: ProjectSnapshot; resultDates?: ReadonlyMap<string, number> }
export interface HomeRequest { project: HomeProject; item: ProjectItem; index: number }
export interface HomePortfolio { projects: HomeProject[]; requests: HomeRequest[] }

const priorities: Record<ObjectiveRecord['priority'], number> = { high: 1, normal: 0, low: -1 };
const priority = (p: HomeProject) => priorities[p.snapshot?.objectives?.priority ?? 'normal'];
const activePriority = (p: HomeProject) => p.snapshot?.objectives?.stance === 'active' ? priority(p) : priorities.normal;

/** Absolute timestamp used both for ordering and for the Home header's displayed age. */
export function homeActivityAt(snapshot?: ProjectSnapshot): number | undefined {
  if (!snapshot?.objectives && !snapshot?.statePath) return snapshot?.lastJobAt;
  const at = Math.max(snapshot.updatedAt ?? -Infinity, snapshot.objectivesAt ?? -Infinity);
  return at === -Infinity ? undefined : at;
}

function projectRank({ unavailable, snapshot }: HomeProject): number {
  if (unavailable) return 5;
  if (snapshot?.waiting.length) return 0;
  if (!snapshot?.objectives && !snapshot?.statePath) return 4;
  if (snapshot.objectives?.stance === 'paused') return 3;
  if (snapshot.objectives?.stance === 'maintenance') return 2;
  return 1; // Active, including records with no declared stance.
}

function compareProjects(a: HomeProject, b: HomeProject): number {
  const rank = projectRank(a), rankDiff = rank - projectRank(b);
  if (rankDiff) return rankDiff;
  if (rank === 1) {
    const priorityDiff = activePriority(b) - activePriority(a);
    if (priorityDiff) return priorityDiff;
  }
  if (rank >= 1 && rank <= 3) {
    const aAt = homeActivityAt(a.snapshot), bAt = homeActivityAt(b.snapshot);
    if (aAt !== bAt) return (bAt ?? -Infinity) - (aAt ?? -Infinity);
  }
  return a.registrationIndex - b.registrationIndex;
}

/** One collector per available registration: Home keeps its own bounded file/rollup memos and does not mark visits. */
export class HomePortfolioCollector {
  private pool = new Map<string, ProjectCollector>();
  private receipts: ResultReceipts;
  constructor(private home: string) { this.receipts = new ResultReceipts(join(home, 'events')); }

  async read(list: readonly ListedProject[], board: WorkboardSnapshot, now: number): Promise<HomePortfolio> {
    const available = new Set(list.filter((p) => !p.unavailable).map((p) => p.root));
    for (const root of this.pool.keys()) if (!available.has(root)) this.pool.delete(root);
    const projects: HomeProject[] = [];
    let jobs: ReturnType<typeof projectJobWindow> | undefined;
    for (const project of list) {
      if (project.unavailable) { projects.push(project); continue; }
      const collector = this.pool.get(project.root) ?? new ProjectCollector(project.root, this.home);
      this.pool.set(project.root, collector);
      projects.push({ ...project, snapshot: await collector.collect('home', board, now, jobs ??= projectJobWindow(this.home)) });
    }
    if (projects.some((p) => p.snapshot?.objectives?.objectives.some((o) => o.result))) {
      const receipts = this.receipts.read();
      for (const project of projects) {
        let dates: Map<string, number> | undefined;
        for (const { id, result } of project.snapshot?.objectives?.objectives ?? []) {
          if (!result) continue;
          const at = resultDate(receipts, project.root, id, result);
          if (at !== undefined) (dates ??= new Map()).set(id, at);
        }
        if (dates) project.resultDates = dates;
      }
    }
    // Build requests in the original list order so project-block sorting cannot affect request ties.
    const requests = projects.flatMap((project) => project.snapshot?.waiting.map((item, index) => ({ project, item, index })) ?? []);
    requests.sort((a, b) => compareOwnerRequests(a.item, b.item, priority(a.project), priority(b.project)));
    return { projects: projects.sort(compareProjects), requests };
  }
}

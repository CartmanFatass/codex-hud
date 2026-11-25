import { join } from 'node:path';
import type { ListedProject } from '../roles/projects.js';
import type { ObjectiveRecord } from './objectives.js';
import { ResultReceipts, resultDate } from './result-receipts.js';
import { compareOwnerRequests, ProjectCollector, projectJobWindow, type ProjectItem, type ProjectSnapshot } from './project-board.js';
import type { WorkboardSnapshot } from './workboard-types.js';
import { archivedActivityProjects, localDayStart } from './job-stats.js';
import { advisorForProject, readAdvisorRecommendations, readAdvisorRuleHits, type AdvisorRuleHit } from './advisor-shadow.js';
import { AdvisorHistory, type AdviceEvent } from './advisor-history.js';

export interface HomeProject extends ListedProject {
  snapshot?: ProjectSnapshot;
  resultDates?: ReadonlyMap<string, number>;
  activeToday?: true;
  advisor?: { skill: string; path: string; session: string; at: number };
  advisorRules?: AdvisorRuleHit;
}
export interface HomeRequest { project: HomeProject; item: ProjectItem; index: number }
export interface HomePortfolio { projects: HomeProject[]; requests: HomeRequest[]; recentAdvice?: AdviceEvent[] }

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
  private advice: AdvisorHistory;
  private history?: { since: number; at: number; projects: ReadonlySet<string> };
  constructor(private home: string) {
    this.receipts = new ResultReceipts(join(home, 'events'));
    this.advice = new AdvisorHistory(home);
  }

  private jobHistory(since: number, now: number) {
    const hit = this.history;
    // History can be heavier than the live window. Refresh on the same cadence as Control's daily stats.
    if (hit?.since === since && now >= hit.at && now - hit.at < 30_000) return hit.projects;
    const projects = archivedActivityProjects(this.home, since, now);
    this.history = { since, at: now, projects };
    return projects;
  }

  async read(list: readonly ListedProject[], board: WorkboardSnapshot, now: number): Promise<HomePortfolio> {
    const available = new Set(list.filter((p) => !p.unavailable).map((p) => p.root));
    for (const root of this.pool.keys()) if (!available.has(root)) this.pool.delete(root);
    const projects: HomeProject[] = [];
    const since = localDayStart(now), history = list.length ? this.jobHistory(since, now) : undefined;
    const today = (at?: number) => at !== undefined && at >= since && at <= now;
    const advisorRecs = readAdvisorRecommendations(this.home, now);
    const ruleHits = readAdvisorRuleHits(this.home, now);
    let jobs: ReturnType<typeof projectJobWindow> | undefined;
    for (const project of list) {
      const entry: HomeProject = { ...project };
      if (!project.unavailable) {
        const collector = this.pool.get(project.root) ?? new ProjectCollector(project.root, this.home);
        this.pool.set(project.root, collector);
        entry.snapshot = await collector.collect('home', board, now, jobs ??= projectJobWindow(this.home));
      }
      const adv = advisorForProject(advisorRecs, project.root);
      if (adv) entry.advisor = { skill: adv.skill, path: adv.path, session: adv.session, at: adv.at };
      const rules = advisorForProject(ruleHits, project.root);
      if (rules) entry.advisorRules = rules;
      const s = entry.snapshot;
      if (adv || rules || s?.waiting.length || s?.active.length || today(s?.updatedAt) || today(s?.objectivesAt) ||
          today(s?.jobActivityAt) || history?.has(project.root)) entry.activeToday = true;
      projects.push(entry);
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
    const recentAdvice = this.advice.read(now);
    return { projects: projects.sort(compareProjects), requests, ...(recentAdvice.length && { recentAdvice }) };
  }
}

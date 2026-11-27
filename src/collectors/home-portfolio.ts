import { basename, join } from 'node:path';
import { isTicketQueueId, queueFile, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { fileSignature } from '../utils/file-signature.js';
import { headerScanner, type HeaderPass } from '../workflows/header-scan.js';
import { readUnattendedStatus } from '../unattended/state.js';
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
  workingRuns?: { features: ReadonlySet<string>; objectives: ReadonlySet<string> };
  activeToday?: true;
  advisor?: { skill: string; path: string; session: string; at: number };
  advisorRules?: AdvisorRuleHit;
}
export interface HomeRequest { project: HomeProject; item: ProjectItem; index: number; files?: string[] }
export interface HomePortfolio {
  projects: HomeProject[]; requests: HomeRequest[]; recentAdvice?: AdviceEvent[];
  unattended?: { objectives: string[]; running: number; handbacks: number };
}

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
  private scanFlows = headerScanner();
  private queues?: { stamp: string; pass: HeaderPass; files: string[] };
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

  private collectWorkingRuns(projects: HomeProject[]) {
    const byRoot = new Map(projects.filter((p) => p.snapshot?.objectives?.objectives.length).map((p) => [p.root, p]));
    if (!byRoot.size) return;
    // Reuse the directory listing until entries change; the header cache checks each queue's own stamp.
    const stamp = fileSignature(join(this.home, 'flows'));
    if (stamp === null) { this.queues = undefined; return; }
    if (stamp !== this.queues?.stamp) {
      try {
        const pass = this.scanFlows(this.home);
        this.queues = { stamp, pass, files: pass.files.filter((file) => file.endsWith('.json') && isTicketQueueId(file.slice(0, -5))) };
      } catch { this.queues = undefined; return; }
    }
    const { pass, files } = this.queues;
    const working = new Map<string, { features: Set<string>; objectives: Set<string> }>();
    for (const file of files) {
      try {
        const q = pass.header<TicketQueue>(file);
        if (q?.state !== 'working') continue;
        const root = q.project_root ?? q.root, project = byRoot.get(root);
        if (!project) continue;
        let runs = working.get(root);
        if (!runs) {
          runs = { features: new Set(), objectives: new Set() };
          working.set(root, runs);
          project.workingRuns = runs;
        }
        if (q.unattended) runs.objectives.add(q.unattended.objective);
        else runs.features.add(q.feature);
      } catch { /* An unreadable queue gives no evidence. */ }
    }
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
    this.collectWorkingRuns(projects);
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
    const requests: HomeRequest[] = projects.flatMap((project) => project.snapshot?.waiting.map((item, index) => ({ project, item, index })) ?? []);
    let unattended: HomePortfolio['unattended'];
    try {
      const status = readUnattendedStatus(this.home);
      if (status.on && status.control) unattended = { objectives: status.control.objectives, running: status.running.length, handbacks: status.handbacks.length };
      for (const h of status.handbacks) {
        const project = projects.find(p => p.root === h.root) ?? { root: h.root, name: basename(h.root), registrationIndex: list.length };
        const files = [...(h.path ? [h.path] : []), queueFile(this.home, h.flow), ...(h.job ? [join(this.home, 'jobs', h.job, 'report.md')] : [])];
        requests.push({ project, index: -1, files, item: {
          label: 'unattended', value: h.ticket ? `${h.ticket}: ${h.reason}` : h.reason,
          request: h.ticket ? `${h.flow}:${h.ticket}` : h.flow, objective: h.objective, at: Date.parse(h.at), waitedOn: true,
        } });
      }
    } catch { /* Unreadable service receipts give no display evidence. */ }
    requests.sort((a, b) => compareOwnerRequests(a.item, b.item, priority(a.project), priority(b.project)) ||
      a.project.registrationIndex - b.project.registrationIndex);
    const recentAdvice = this.advice.read(now);
    return { projects: projects.sort(compareProjects), requests, ...(unattended && { unattended }), ...(recentAdvice.length && { recentAdvice }) };
  }
}

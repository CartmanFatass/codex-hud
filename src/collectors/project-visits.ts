/** The panel's Project collectors: one per visited root, the panel's own never dropped, at most `max` in all. */
import { insideRoot, type ProjectCollector, type ProjectSnapshot } from './project-board.js';
import type { WorkboardSnapshot } from './workboard-types.js';

export class ProjectVisits {
  private readonly seen = new Map<string, { collector: ProjectCollector; snapshot?: ProjectSnapshot }>();
  constructor(readonly own: string, private readonly make: (root: string) => ProjectCollector, private readonly max = 4) {
    this.seen.set(own, { collector: make(own) });
  }
  /** The root's collector and its last snapshot; the newest visit, so the oldest other root is the one dropped. */
  visit(root: string) {
    const entry = this.seen.get(root) ?? { collector: this.make(root) };
    this.seen.delete(root);
    this.seen.set(root, entry);
    for (const key of [...this.seen.keys()]) {
      if (this.seen.size <= this.max) break;
      if (key !== this.own) this.seen.delete(key);
    }
    return entry;
  }
  /** The last snapshot of a root, without counting as a visit. */
  snapshot(root: string): ProjectSnapshot | undefined {
    return this.seen.get(root)?.snapshot;
  }
  private last?: { root: string; snapshot: ProjectSnapshot };
  /**
   * What the Project tab paints for a root: its own snapshot, or while a root just switched to has none yet, the one the
   * tab showed before, with the root it belongs to, so the first frame of a switch is the old page, never a blank one.
   */
  shown(root: string): { root: string; snapshot?: ProjectSnapshot } {
    const snapshot = this.snapshot(root);
    if (snapshot) this.last = { root, snapshot };
    return snapshot ? { root, snapshot } : (this.last ?? { root });
  }
  get roots(): string[] {
    return [...this.seen.keys()];
  }
}
/** What the Projects list shows of one project. `latest` is what it is doing: the slices working, else the newest landed to try, else the newest accepted (ledger order, no dates, no Git). */
export interface ProjectOverview {
  hasState: boolean; milestone?: string; waiting: number; running: number;
  counts: ProjectSnapshot['counts']; open: number; at?: number;
  latest?: { state: 'working' | 'blocked' | 'try' | 'accepted'; ids: string[] };
}
const latestOf = (ledger: ProjectSnapshot['ledger']): ProjectOverview['latest'] => {
  const ids = (state: string) => ledger.filter((r) => r.state === state).map((r) => r.id);
  for (const state of ['working', 'blocked'] as const) if (ids(state).length) return { state, ids: ids(state) };
  for (const state of ['try', 'accepted'] as const) if (ids(state).length) return { state, ids: ids(state).slice(-1) };
};
const overviewOf = (data: ProjectSnapshot, running: number): ProjectOverview => {
  const newest = Math.max(data.updatedAt ?? 0, data.tickets[0]?.at ?? 0), latest = latestOf(data.ledger);
  return { hasState: !!data.statePath, milestone: data.ladder.current, waiting: data.waiting.length, running, counts: data.counts,
    open: data.tickets.flatMap((f) => f.tickets).filter((r) => r.state !== 'done' && r.state !== 'dropped').length,
    ...(latest ? { latest } : {}), ...(newest ? { at: newest } : {}) };
};
/**
 * The light read behind the Projects list, one pass for every listed root while the list is visible: STATE and tickets as
 * Home reads them (a collector per root keeps the file signatures), and the unsettled HUD jobs from one scan of the job
 * lookup. Nothing else: no Git, no roles, no browser. A root that left the list loses its collector.
 */
export class ProjectOverviews {
  private readonly pool = new Map<string, ProjectCollector>();
  private readonly jobs: ProjectCollector;
  constructor(private readonly make: (root: string) => ProjectCollector, lookup: string) { this.jobs = make(lookup); }
  async read(roots: string[], board: WorkboardSnapshot, now: number): Promise<Map<string, ProjectOverview>> {
    for (const root of [...this.pool.keys()]) if (!roots.includes(root)) this.pool.delete(root);
    const cwds = this.jobs.liveCwds(), out = new Map<string, ProjectOverview>();
    for (const root of roots) {
      const collector = this.pool.get(root) ?? this.make(root);
      this.pool.set(root, collector);
      const data = await collector.collect('home', board, now);
      if (data) out.set(root, overviewOf(data, cwds.filter((cwd) => insideRoot(root, cwd)).length));
    }
    return out;
  }
}

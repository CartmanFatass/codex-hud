import type { HomeProject } from './home-portfolio.js';
import { collectJobStats, localDayStart, type JobStats } from './job-stats.js';
import { readSchedule, schedulePath, type ScheduleItem } from './schedule.js';
import { fileSignature } from '../utils/file-signature.js';

interface Landing { id: string; root: string; name: string; ticket?: string; title?: string; at: number }
export interface TodayFacts {
  since: number;
  landed: number;
  newest: Landing[];
  finished: ReadonlyMap<string, number>;
  failed: ReadonlyMap<string, number>;
  first: number;
  retried: number;
  limited: boolean;
}

function todayFacts(stats: JobStats, projects: readonly HomeProject[], since: number): TodayFacts | undefined {
  if (stats.coverage.skipped) return;
  const byRoot = new Map(projects.map(p => [p.root, p]));
  const landings = stats.landed.filter(({ job }) => job.project && byRoot.has(job.project));
  const newest = landings.map(({ job, at }) => ({ job, at: Date.parse(at ?? '') }))
    .sort((a, b) => b.at - a.at).slice(0, 3).map(({ job, at }) => {
      const project = byRoot.get(job.project!)!;
      const match = /^([a-z0-9-]+)\/(\d+)$/i.exec(job.ticket ?? '');
      const title = match && project.snapshot?.tickets.find(f => f.slug === match[1])?.tickets.find(t => t.number === match[2])?.title;
      return { id: job.job, root: project.root, name: project.name, ticket: job.ticket, title: title || job.summary || job.ticket, at };
    });
  const finished = new Map<string, number>(), failed = new Map<string, number>();
  for (const job of stats.settled) {
    if (!job.project || !byRoot.has(job.project) || job.state === 'stopped') continue;
    const counts = job.state === 'failed' || (job.dispatch_exit_code ?? 0) !== 0 ? failed
      : job.state === 'closed' || job.state === 'done' || job.state === 'idle_grace' ? finished : undefined;
    const role = job.role ?? 'other';
    if (counts) counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  let first = 0, retried = 0;
  for (const { job } of landings) if (job.ticket && job.land) {
    if (job.land.reruns || job.land.repairs) retried++;
    else first++;
  }
  return { since, landed: landings.length, newest, finished, failed, first, retried, limited: stats.coverage.limited };
}

/** Collection only. A changed schedule replaces the old reading, even when the new file is unreadable. */
export class HomeCardsCollector {
  private history?: { since: number; at: number; stats: JobStats };
  private schedule?: { stamp: string; items: readonly ScheduleItem[] | undefined };

  constructor(private home: string) {}

  readToday(projects: readonly HomeProject[], now: number): TodayFacts | undefined {
    const since = localDayStart(now), hit = this.history;
    const stats = hit?.since === since && now >= hit.at && now - hit.at < 30_000 ? hit.stats : collectJobStats(this.home, since, now);
    if (stats !== hit?.stats) this.history = { since, at: now, stats };
    return todayFacts(stats, projects, since);
  }

  readOpenSchedule(): readonly ScheduleItem[] | undefined {
    const stamp = fileSignature(schedulePath(this.home));
    if (stamp !== null && stamp === this.schedule?.stamp) return this.schedule.items;
    let items: readonly ScheduleItem[] | undefined;
    try { items = readSchedule(this.home).items.filter(item => !item.done_at); } catch { /* Unknown, not empty. */ }
    this.schedule = stamp === null ? undefined : { stamp, items };
    return items;
  }
}

import type { HomeProject } from './home-portfolio.js';
import { collectJobStats, localDayStart, type JobStats } from './job-stats.js';
import { readSchedule, schedulePath, type ScheduleItem } from './schedule.js';
import { fileSignature } from '../utils/file-signature.js';

export interface TodayFacts {
  since: number;
  landed: number;
  failed: number;
  limited: boolean;
}

function todayFacts(stats: JobStats, projects: readonly HomeProject[], since: number): TodayFacts | undefined {
  if (stats.coverage.skipped) return;
  const roots = new Set(projects.map(p => p.root));
  const landed = stats.landed.filter(({ job }) => job.project && roots.has(job.project)).length;
  const failed = stats.settled.filter(job => job.project && roots.has(job.project) && job.state !== 'stopped' &&
    (job.state === 'failed' || (job.dispatch_exit_code ?? 0) !== 0)).length;
  return { since, landed, failed, limited: stats.coverage.limited };
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

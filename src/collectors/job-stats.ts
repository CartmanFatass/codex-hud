import * as fs from 'node:fs';
import { join } from 'node:path';
import { projectJobFacts, type JobFacts } from '../roles/job-archive.js';
import { getJobIndexCache, JOB_ID_RE } from '../roles/job-index-cache.js';
import { jobLand, landedIn, readJobFlow, type JobFlow, type JobLand } from '../roles/job-land.js';
import { count, epoch, jobUsage, record, text, type JobUsage } from '../roles/job-usage.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { objectiveLink } from './objectives.js';

export const groupings = ['role', 'model', 'route', 'feature'] as const;
export type GroupBy = (typeof groupings)[number] | 'place';
export const DEFAULT_STATS_DAYS = 7;
export const MAX_STATS_DAYS = 90;
const ARCHIVE_LIMIT = 16 * 1024 * 1024;
const LIVE_LIMIT = 2000, FLOW_LIMIT = 4096;
export function localDayStart(now: number, days = 1) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days + 1);
  return date.getTime();
}

function archiveFacts(value: unknown): JobFacts | undefined {
  const r = record(value), id = text(r.job);
  if (r.v !== 1 || !id || !JOB_ID_RE.test(id)) return;
  const route = record(r.route), raw = record(r.land);
  const attempts = count(raw.attempts), reruns = count(raw.reruns), repairs = count(raw.repairs), state = text(raw.state);
  const land: JobLand | undefined = attempts !== undefined && reruns !== undefined && repairs !== undefined &&
    (state === 'queued' || state === 'running' || state === 'completed' || state === 'failed' || state === 'cancelled')
    ? { attempts, reruns, repairs, state, sha: text(raw.sha), landed_at: text(raw.landed_at), updated_at: text(raw.updated_at) } : undefined;
  return { job: id, project: text(r.project), role: text(r.role), harness: text(r.harness), model: text(r.model),
    used_place: text(r.used_place), ticket: text(r.ticket), objective: objectiveLink(r.objective), package: text(r.package), route: { tier: text(route.tier), mode: text(route.mode) },
    mode: text(r.mode), question_count: count(r.question_count), parent_job: text(r.parent_job), summary: text(r.summary),
    usage: jobUsage(r.usage), land, state: text(r.state), created_at: text(r.created_at), started_at: text(r.started_at),
    settled_at: text(r.settled_at), ended_at: text(r.ended_at), reaped_at: text(r.reaped_at), dispatch_exit_code: count(r.dispatch_exit_code) };
}
export const jobSettledAt = (j: { settled_at?: unknown; ended_at?: unknown }) => epoch(j.settled_at) ?? epoch(j.ended_at);
const enteredAt = (j: JobFacts) => epoch(j.created_at) ?? epoch(j.started_at) ?? jobSettledAt(j) ?? epoch(j.reaped_at);

function historyCoverage() {
  return { live: 0, archive: 0, flows: 0, skipped: 0, limited: false };
}
type HistoryCoverage = ReturnType<typeof historyCoverage>;
const unreadable = (c: HistoryCoverage, e: unknown) => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') c.skipped++; };
function listHistory(home: string, dir: string, coverage: HistoryCoverage) {
  try { return fs.readdirSync(join(home, dir), { withFileTypes: true }); } catch (e) { unreadable(coverage, e); return []; }
}

function readArchive(home: string, since: number, now: number, coverage: HistoryCoverage) {
  const jobs = new Map<string, JobFacts>();
  // Include the prior UTC month for joins to land receipts and sonic parents
  // that straddle the reporting window. The archive buckets on end/reap, not creation.
  const from = new Date(since);
  from.setUTCDate(1); from.setUTCMonth(from.getUTCMonth() - 1);
  const monthMin = from.toISOString().slice(0, 7), monthMax = new Date(now).toISOString().slice(0, 7);
  for (const entry of listHistory(home, 'archive', coverage).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^\d{4}-\d{2}\.jsonl$/.test(entry.name) || entry.name.slice(0, 7) < monthMin || entry.name.slice(0, 7) > monthMax) continue;
    try {
      const path = join(home, 'archive', entry.name), offset = Math.max(0, fs.lstatSync(path).size - ARCHIVE_LIMIT);
      const { bytes, truncated } = readFileBounded(path, ARCHIVE_LIMIT, { offset });
      if (offset || truncated) coverage.limited = true;
      const lines = bytes.toString('utf8').split('\n');
      if (offset) lines.shift();
      if (truncated) lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = archiveFacts(JSON.parse(line));
          if (!row) { coverage.skipped++; continue; }
          jobs.set(row.job, row);
        } catch { coverage.skipped++; }
      }
    } catch (e) { unreadable(coverage, e); }
  }
  return jobs;
}

function readFlows(home: string, coverage: HistoryCoverage, details = false) {
  const files = listHistory(home, 'flows', coverage).filter(e => /^f[0-9a-f]{16}(?:-[1-9]\d*)?\.json$/.test(e.name));
  if (files.length > FLOW_LIMIT) {
    coverage.limited = true;
    const mtime = (name: string) => {
      try { return fs.lstatSync(join(home, 'flows', name)).mtimeMs; } catch (e) { unreadable(coverage, e); return -Infinity; }
    };
    const dates = new Map(files.map(e => [e.name, mtime(e.name)]));
    files.sort((a, b) => dates.get(b.name)! - dates.get(a.name)! || a.name.localeCompare(b.name));
  }
  return files.slice(0, FLOW_LIMIT).flatMap(file => {
    try { return [readJobFlow(home, file.name, details)]; } catch (e) { unreadable(coverage, e); return []; }
  });
}

/** Dated evidence from the bounded history, independent of which live jobs are still retained. */
export function archivedActivityProjects(home: string, since: number, now: number): ReadonlySet<string> {
  const coverage = historyCoverage(), archive = readArchive(home, since, now, coverage), projects = new Set<string>();
  const today = (at?: number) => at !== undefined && at >= since && at <= now;
  for (const j of archive.values()) if (j.project && (today(epoch(j.started_at)) || today(jobSettledAt(j)) ||
    (j.land && landedIn(j.land, since, now)))) projects.add(j.project);
  // Detailed flow receipts keep the exact landing time, with no updated_at fallback.
  for (const f of readFlows(home, coverage, true)) {
    const project = f.project ?? archive.get(f.job)?.project;
    if (project && landedIn(f, since, now)) projects.add(project);
  }
  return projects;
}

/** Read-only merge; live receipts replace the same archived job, never add to it. */
export function collectJobStats(home: string, since: number, now: number, project?: string) {
  const coverage = historyCoverage(), jobs = readArchive(home, since, now, coverage), liveIds = new Set<string>();
  const cache = getJobIndexCache(home);
  const { dirs, totalValid } = cache.listJobDirsByMtime({ limit: LIVE_LIMIT, onDirError: (e) => unreadable(coverage, e), onStatError: (_id, e) => unreadable(coverage, e) });
  if (totalValid > LIVE_LIMIT) coverage.limited = true;
  for (const { id, dir } of dirs) {
    const job = cache.readJob(id), status = cache.readStatus(id);
    if ([job, status].some(r => r.status !== 'ok' && r.status !== 'missing')) coverage.skipped++;
    if (job.status !== 'ok' && status.status !== 'ok') continue;
    const row = projectJobFacts(home, dir, id, job.status === 'ok' ? job.value : {}, status.status === 'ok' ? status.value : {}, job.status === 'ok');
    jobs.set(id, { ...row, land: jobs.get(id)?.land });
    liveIds.add(id);
  }

  const flows = readFlows(home, coverage).filter(f => !project || (f.project ?? jobs.get(f.job)?.project) === project);
  const byJob = new Map<string, JobFlow[]>();
  for (const flow of flows) {
    const prior = byJob.get(flow.job) ?? [];
    prior.push(flow); byJob.set(flow.job, prior);
  }
  const available = [...jobs.values()].filter(j => !project || j.project === project);
  for (const j of available) {
    const current = jobLand(byJob.get(j.job) ?? []);
    if (current && (!j.land || current.attempts >= j.land.attempts)) j.land = current;
  }
  const inWindow = (at: number | undefined) => at !== undefined && at >= since && at <= now;
  const cohort = available.filter(j => inWindow(enteredAt(j)));
  coverage.live = cohort.filter(j => liveIds.has(j.job)).length;
  coverage.archive = cohort.length - coverage.live;
  coverage.flows = flows.filter(f => inWindow(epoch(f.updated_at)) || landedIn(f, since, now)).length;

  const landed = new Map<string, { job: JobFacts; sha?: string; at?: string }>();
  for (const j of available) if (j.land && landedIn(j.land, since, now)) landed.set(j.job, { job: j, sha: j.land.sha, at: j.land.landed_at });
  for (const f of flows) if (landedIn(f, since, now) && !landed.has(f.job))
    landed.set(f.job, { job: jobs.get(f.job) ?? { job: f.job, project: f.project }, sha: f.sha, at: f.landed_at });
  const failures = available.filter(j => (j.state === 'failed' || j.state === 'stopped' || (j.dispatch_exit_code ?? 0) > 0) &&
    inWindow(jobSettledAt(j) ?? enteredAt(j)));
  const failedLand = (state: JobLand['state']) => state === 'failed' || state === 'cancelled';
  const landFailures = flows.filter(f => failedLand(f.state) && inWindow(epoch(f.updated_at)))
    .map(f => ({ job: jobs.get(f.job) ?? { job: f.job }, attempt: f.attempt, state: f.state }));
  for (const j of available) if (j.land && failedLand(j.land.state) && inWindow(epoch(j.land.updated_at)) &&
      !byJob.get(j.job)?.some(f => f.attempt === j.land!.attempts))
    landFailures.push({ job: j, attempt: j.land.attempts, state: j.land.state });
  const flaky = new Map<string, number>();
  for (const f of flows) if (inWindow(epoch(f.updated_at)))
    for (const name of f.flaky) flaky.set(name, (flaky.get(name) ?? 0) + 1);
  const children = new Map<string, number>();
  for (const j of available) if (j.parent_job) children.set(j.parent_job, (children.get(j.parent_job) ?? 0) + 1);
  return { cohort, coverage, landed: [...landed.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
    failures, landFailures, flaky: [...flaky].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), children };
}
export type JobStats = ReturnType<typeof collectJobStats>;

type Metric = { total: number; known: number };
const metric = (counts: (number | undefined)[]): Metric => ({
  total: counts.reduce<number>((n, v) => n + (v ?? 0), 0), known: counts.filter(v => v !== undefined).length,
});
export const usageMetrics = ['input', 'cache_read', 'cache_write', 'output', 'cost_usd'] as const;
export function summarizeJobs(jobs: readonly JobFacts[], children: JobStats['children']) {
  const times = jobs.flatMap(j => {
    const start = epoch(j.created_at) ?? epoch(j.started_at), end = jobSettledAt(j);
    return start !== undefined && end !== undefined && end >= start ? [(end - start) / 60_000] : [];
  }).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = !times.length ? undefined : times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
  const lands = jobs.flatMap(j => j.land ? [j.land] : []);
  const usage = Object.fromEntries(usageMetrics.map(key => [key, metric(jobs.map(j => j.usage?.[key]))])) as Record<keyof JobUsage, Metric>;
  return { jobs: jobs.length, time: metric(times), median, questions: metric(jobs.map(j => j.question_count)),
    sonic: jobs.reduce((n, j) => n + (children.get(j.job) ?? 0), 0), usage,
    land: { observed: lands.length, landed: lands.filter(l => l.sha).length,
      repaired: lands.filter(l => l.sha && l.repairs > 0).length } };
}

const keys: Record<GroupBy, (j: JobFacts) => (string | undefined)[]> = {
  role: j => [j.role], model: j => [j.model], route: j => [j.route?.tier, j.route?.mode ?? j.mode],
  feature: j => [/^([a-z0-9-]+)[/-]\d+$/i.exec(j.ticket ?? '')?.[1] ?? j.package],
  place: j => [j.role, j.used_place ?? j.model ?? j.harness, j.mode ?? j.route?.mode],
};
export function groupJobStats(stats: JobStats, by: GroupBy) {
  const groups = new Map<string, { label: (string | undefined)[]; jobs: JobFacts[] }>();
  for (const j of stats.cohort) {
    const label = keys[by](j), key = JSON.stringify(label), g = groups.get(key) ?? { label, jobs: [] };
    g.jobs.push(j); groups.set(key, g);
  }
  return [...groups].map(([key, g]) => ({ key, label: g.label, ...summarizeJobs(g.jobs, stats.children) }))
    .sort((a, b) => b.jobs - a.jobs || a.key.localeCompare(b.key));
}

function controlJobStats(home: string, since: number, now: number) {
  const stats = collectJobStats(home, since, now);
  return { coverage: stats.coverage, total: summarizeJobs(stats.cohort, stats.children),
    roles: groupJobStats(stats, 'role'), places: groupJobStats(stats, 'place') };
}
export type ControlJobStats = ReturnType<typeof controlJobStats>;
let lastControl: { home: string; since: number; now: number; value: ControlJobStats } | undefined;
export function collectControlJobStats(home: string, now: number): ControlJobStats {
  const since = localDayStart(now);
  if (lastControl?.home === home && lastControl.since === since && now >= lastControl.now && now - lastControl.now < 30_000)
    return lastControl.value;
  const value = controlJobStats(home, since, now);
  lastControl = { home, since, now, value };
  return value;
}
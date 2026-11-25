import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { herdrId, listedPanes, runHerdr } from './herdr-run.js';
import { jobCallerPane } from './job-pane.js';
import { sharedRoot } from './projects.js';
import { JOB_ID_RE, type JobIndexCache } from './job-index-cache.js';
import { jobFiles } from '../mcp/paths.js';
import type { Job } from '../mcp/job-contracts.js';

type JobProject = Partial<Pick<Job, 'cwd' | 'project_root' | 'worktree'>>;
type JobOwner = JobProject & Partial<Pick<Job, 'job' | 'herdr_pane' | 'caller_pane'>>;

/** Older receipts resolve their cwd once per scan per directory. */
export function projectJobFilter(cwd: string) {
  const root = sharedRoot(cwd);
  const legacy = new Map([[cwd, root]]);
  return (job: JobProject): boolean => {
    if (typeof job.project_root === 'string') return job.project_root === root;
    if (typeof job.worktree?.main_root === 'string') return job.worktree.main_root === root;
    if (typeof job.cwd !== 'string' || !job.cwd) return false;
    if (!legacy.has(job.cwd)) legacy.set(job.cwd, sharedRoot(job.cwd));
    return legacy.get(job.cwd) === root;
  };
}

/** Match a package selector within its project. Callers also check that they own the job. */
export function packageJobFilter(cwd: string, label: string, preset?: string) {
  const matches = projectJobFilter(cwd);
  return (job: Job) => job.package === label && (preset === undefined || (job.route?.preset ?? job.preset) === preset) && matches(job);
}

/** Missing/malformed herdr evidence cannot transfer ownership. Never use a workspace-filtered list. */
export async function adoptProjectJobs(home: string, pane: string, cwd: string, jobs: JobOwner[], env: NodeJS.ProcessEnv,
  owesCaller: (dir: string, job: Record<string, unknown>) => boolean, cache?: JobIndexCache, onAdopt?: (id: string) => void) {
  const other = jobs.filter((job) => herdrId(jobCallerPane(job)) && jobCallerPane(job) !== pane);
  if (!other.length) return false;
  const matches = projectJobFilter(cwd);
  const candidates = other.filter(matches);
  if (!candidates.length) return false;
  const result = await runHerdr(['pane', 'list'], env, { budgetMs: 1000 });
  const listed = result.ok ? listedPanes(result.stdout) : null;
  if (!listed) return false;
  const live = new Set(listed.map((row) => row.paneId));
  if (!live.has(pane)) return false;
  const orphans = candidates.filter((job) => !live.has(jobCallerPane(job)));
  if (!orphans.length) return false;

  const root = join(home, 'jobs');
  let key: string;
  try { key = fs.realpathSync(root); }
  catch { return false; } // The jobs directory may disappear while herdr is answering.
  // Concurrent MCP and watch scans may both see an orphan. Only the first can transfer it.
  const release = await tryAbstractLock('job-adopt', key).catch(() => undefined);
  if (!release) return false;
  let adopted = false;
  try {
    for (const job of orphans) {
      if (typeof job.job !== 'string' || !JOB_ID_RE.test(job.job)) continue;
      const dir = join(root, job.job), file = join(dir, jobFiles.job);
      try {
        let latest: Partial<Job> | null;
        if (cache) {
          const res = cache.readJob<Partial<Job>>(job.job);
          if (res.status === 'ok') latest = res.value;
          else if (res.status === 'truncated') latest = readJsonFile(file) as Partial<Job>;
          else continue;
        } else {
          latest = readJsonFile(file) as Partial<Job>;
        }
        if (latest?.job !== job.job || jobCallerPane(latest) !== jobCallerPane(job) || !matches(latest) || !owesCaller(dir, latest)) continue;
        const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
        const updated = { ...latest, [latest.caller_pane !== undefined ? 'caller_pane' : 'herdr_pane']: pane };
        if (cache) cache.writeJsonAtomic(file, updated, { indent: 2, mkdir: false });
        else writePrivateFile(file, JSON.stringify(updated, null, 2) + '\n', { mkdir: false });
        if (dirStat) try { fs.utimesSync(dir, dirStat.atime, dirStat.mtime); } catch { /* Best-effort ordering preservation. */ }
        adopted = true;
        onAdopt?.(job.job);
      } catch {
        // Keep scanning if a job disappears or its receipt cannot be updated.
      }
    }
  } finally { await release(); }
  return adopted;
}

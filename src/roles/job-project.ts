import { readJsonFile } from '../utils/atomic-fs.js';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { herdrId } from './herdr-run.js';
import { loadLivePanes, noticeReader } from './select-send.js';
import { jobNoticeOrigin } from '../workflows/scope.js';
import { jobCallerPane } from './job-pane.js';
import { sharedRoot } from './projects.js';
import { JOB_ID_RE, getJobIndexCache } from './job-index-cache.js';
import { jobFiles } from '../mcp/paths.js';
import type { Job } from '../mcp/job-contracts.js';

type JobProject = Partial<Pick<Job, 'cwd' | 'project_root' | 'worktree'>>;

/** Older receipts resolve their cwd once per scan per directory. */
export function projectJobFilter(cwd: string, resolveRoot = sharedRoot) {
  const root = resolveRoot(cwd);
  const legacy = new Map([[cwd, root]]);
  return (job: JobProject): boolean => {
    if (typeof job.project_root === 'string') return job.project_root === root;
    if (typeof job.worktree?.main_root === 'string') return job.worktree.main_root === root;
    if (typeof job.cwd !== 'string' || !job.cwd) return false;
    if (!legacy.has(job.cwd)) legacy.set(job.cwd, resolveRoot(job.cwd));
    return legacy.get(job.cwd) === root;
  };
}

/** Match a package selector within its project. Callers also check that they own the job. */
export function packageJobFilter(cwd: string, label: string, preset?: string) {
  const matches = projectJobFilter(cwd);
  return (job: Job) => job.package === label && (preset === undefined || (job.route?.preset ?? job.preset) === preset) && matches(job);
}

/** Missing/malformed herdr evidence cannot transfer ownership. Never use a workspace-filtered list. */
export async function adoptProjectJobs(home: string, pane: string, cwd: string, jobs: Job[], env: NodeJS.ProcessEnv,
  owesCaller: (dir: string, job: Job) => boolean, cache = getJobIndexCache(home), onAdopt?: (id: string) => void,
  load?: (hasAttention: () => boolean) => Promise<Awaited<ReturnType<typeof loadLivePanes>> | undefined>) {
  const matches = projectJobFilter(cwd), root = join(home, 'jobs');
  const candidates = jobs.filter(job => JOB_ID_RE.test(job.job) && herdrId(jobCallerPane(job)) && jobCallerPane(job) !== pane && matches(job));
  if (!candidates.length) return false;
  const live = load ? await load(() => candidates.some(job => {
    try { return owesCaller(join(root, job.job), job); } catch { return false; }
  })) : await loadLivePanes(home, env);
  if (!live?.panes) return false;
  const eligible = noticeReader(home, pane, cwd, env, async () => live);
  const listed = new Set(live.panes.map(p => p.pane_id));
  const orphans = candidates.filter(job => !listed.has(jobCallerPane(job)));
  if (!orphans.length) return false;

  let key: string;
  try { key = fs.realpathSync(root); }
  catch { return false; } // The jobs directory may disappear while herdr is answering.
  // Concurrent MCP and watch scans may both see an orphan. Only the first can transfer it.
  const release = await tryAbstractLock('job-adopt', key).catch(() => undefined);
  if (!release) return false;
  let adopted = false;
  try {
    for (const job of orphans) {
      const dir = join(root, job.job), file = join(dir, jobFiles.job);
      try {
        const res = cache.readJob<Job>(job.job);
        const latest = res.status === 'ok' ? res.value : res.status === 'truncated' ? readJsonFile(file) as Job : null;
        if (latest?.job !== job.job || jobCallerPane(latest) !== jobCallerPane(job) || !matches(latest) || !owesCaller(dir, latest)) continue;
        if (!await eligible(jobNoticeOrigin(home, latest), 'adopt')) continue;
        const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
        const updated = { ...latest, [latest.caller_pane !== undefined ? 'caller_pane' : 'herdr_pane']: pane };
        cache.writeJsonAtomic(file, updated, { indent: 2, mkdir: false });
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

import { spawnSync } from 'node:child_process';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { herdrId, listedPanes, runHerdr } from './herdr-run.js';
import { sharedRoot } from './projects.js';
import { jobFiles } from '../mcp/paths.js';
import type { Job } from '../mcp/job-contracts.js';

type JobProject = Partial<Pick<Job, 'cwd' | 'project_root' | 'worktree'>>;
type JobOwner = JobProject & Partial<Pick<Job, 'job' | 'herdr_pane'>>;

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

/** Missing/malformed herdr evidence cannot transfer ownership. Never use a workspace-filtered list. */
export async function adoptProjectJobs(home: string, pane: string, cwd: string, jobs: JobOwner[], env: NodeJS.ProcessEnv,
  owesCaller: (dir: string, job: Record<string, unknown>) => boolean) {
  const other = jobs.filter((job) => herdrId(job.herdr_pane) && job.herdr_pane !== pane);
  if (!other.length) return false;
  const matches = projectJobFilter(cwd);
  const candidates = other.filter(matches);
  if (!candidates.length) return false;
  const result = await runHerdr(['pane', 'list'], env, { budgetMs: 1000 });
  const listed = result.ok ? listedPanes(result.stdout) : null;
  if (!listed) return false;
  const live = new Set(listed.map((row) => row.paneId));
  if (!live.has(pane)) return false;
  const orphans = candidates.filter((job) => !live.has(job.herdr_pane as string));
  if (!orphans.length) return false;

  const root = join(home, 'jobs');
  let fd: number;
  try { fd = fs.openSync(root, 'r'); }
  catch { return false; } // The jobs directory may disappear while herdr is answering.
  let adopted = false;
  try {
    // Concurrent MCP and watch scans may both see an orphan. Only the first can transfer it.
    const lock = spawnSync('flock', ['-nx', '3'], { env, stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 1000 });
    if (lock.status !== 0) return false;
    for (const job of orphans) {
      if (typeof job.job !== 'string' || !/^j[0-9a-f]{16}$/.test(job.job)) continue;
      const dir = join(root, job.job), file = join(dir, jobFiles.job);
      try {
        const latest = readJsonFile(file) as Partial<Job>;
        if (latest?.job !== job.job || latest.herdr_pane !== job.herdr_pane || !matches(latest) || !owesCaller(dir, latest)) continue;
        writePrivateFile(file, JSON.stringify({ ...latest, herdr_pane: pane }, null, 2) + '\n', { mkdir: false });
        adopted = true;
      } catch {
        // Keep scanning if a job disappears or its receipt cannot be updated.
      }
    }
  } finally { fs.closeSync(fd); }
  return adopted;
}

/** Main-session entry points. Only read executable configuration from the registered main checkout. */
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { parseWorktreeList, worktreeGit as git } from '../collectors/worktrees.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { notifyRunner } from '../utils/runner-lifetime.js';
import { procStat } from '../utils/proc.js';
import { activeLand, landAttempt, landFile, landNotice, landOutcome, readLand, retryableLand, writeLand, type LandConfig, type LandFlow } from './land-state.js';
import { managedReceiptMatches } from './managed-worktree.js';
import { binScript } from './paths.js';
import type { Job } from './job-contracts.js';

function config(home: string, root: string): LandConfig {
  if (!registeredProject(home, root).registered) throw Error('hud_land requires a registered project');
  const c = JSON.parse(fs.readFileSync(join(root, '.hud/project.json'), 'utf8')).land;
  const commands = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim());
  if (!c || typeof c.base !== 'string' || !c.base || c.base.startsWith('-') || !commands(c.gate) || !commands(c.after) ||
      typeof c.push !== 'boolean' || (c.wrapper !== undefined && (typeof c.wrapper !== 'string' || !c.wrapper)) ||
      (c.timeout_s !== undefined && (!Number.isFinite(c.timeout_s) || c.timeout_s < 0.001 || c.timeout_s * 1000 > 2 ** 31 - 1)))
    throw Error('Invalid or missing project land config: expected base, gate, after, push and optional wrapper and timeout_s');
  return c;
}
export async function startLand(home: string, id: string, job: Pick<Job, 'job' | 'cwd' | 'worktree'> | null, state: string | null, pane: string | null, task: boolean) {
  const wt = job?.worktree;
  if (!job || job.job !== id || !wt || wt.root !== job.cwd || wt.main_root !== sharedRoot(process.cwd()))
    throw Error('hud_land requires a managed worktree job in the caller project');
  const { flow, prior, cleanup } = landAttempt(home, id);
  if (prior && !retryableLand(prior)) return prior;
  if (!['idle_grace', 'closed', 'done'].includes(state ?? '')) throw Error(`Cannot land ${id}: job state is ${state ?? 'unknown'} (expected idle_grace, done or closed)`);
  const c = config(home, wt.main_root);
  await git(wt.main_root, ['check-ref-format', `refs/heads/${c.base}`]);
  const trees = parseWorktreeList(await git(wt.main_root, ['worktree', 'list', '--porcelain', '-z']));
  const tree = trees.slice(1).find(t => t.path === wt.root && t.branch === wt.branch);
  if (trees[0]?.path !== wt.main_root || !tree?.head || tree.locked !== undefined || tree.prunable !== undefined ||
      !managedReceiptMatches(id, { ...job, worktree: wt }))
    throw Error('Source is no longer the registered job worktree');
  fs.mkdirSync(join(home, 'flows'), { mode: 0o700, recursive: true });
  const child = fork(binScript('land-runner'), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const ready = new Promise<boolean>((done) => {
    child.once('message', (msg) => done(msg === 'ready'));
    child.once('disconnect', () => done(false));
    child.on('error', () => done(false));
  });
  try {
    const pid = child.pid, start = pid && procStat(pid)?.start;
    if (!pid || !start) throw Error('Could not start land helper');
    const loaded = await ready, now = new Date().toISOString();
    const f: LandFlow = { flow, job: id, pane, task, wt, config: c, source_sha: tree.head, pid, start,
      state: loaded ? 'queued' : 'failed', step: loaded ? 'main-checkout lease' : 'load land helper', created_at: now, updated_at: now };
    if (!loaded) f.error = 'HUD was rebuilt; retry the land';
    // Publish before granting permission to run; a concurrent caller can win the receipt but cannot start a second land.
    try { writeLand(home, f, true); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return readLand(home, flow)!; throw e; }
    // flows/ is outside the jobs watch. Wake it on startup failure too so a terminal notice can be delivered.
    notifyRunner(join(home, 'jobs', id), pid);
    if (loaded) child.send({ home, flow, cleanup });
    return f;
  } finally { if (child.connected) child.disconnect(); child.unref(); }
}
export function landTask(home: string, f: LandFlow, cancel = false) {
  if (cancel && activeLand(f)) fs.closeSync(fs.openSync(`${landFile(home, f.flow)}.cancel`, 'a', 0o600));
  return { taskId: f.flow, status: activeLand(f) ? 'working' : f.state,
    statusMessage: `${f.flow} — ${f.state === 'failed' ? landOutcome(f) : `${f.state}: ${f.step}`}`,
    createdAt: f.created_at, lastUpdatedAt: f.updated_at, ttlMs: 3 * 60 * 60_000, pollIntervalMs: 5000,
    ...(!activeLand(f) ? { result: { content: [{ type: 'text', text: landNotice(f) }] } } : {}) };
}

/** Main-session entry points. Only read executable configuration from the registered main checkout. */
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { parseWorktreeList, worktreeGit as git } from '../collectors/worktrees.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { procStat } from '../roles/worker-tree.js';
import { activeLand, flowId, landFile, landNotice, readLand, writeLand, type LandConfig, type LandFlow } from './land-state.js';
import { managedReceiptMatches, type ManagedWorktree } from './managed-worktree.js';

type Job = { job: string; cwd: string; worktree?: ManagedWorktree };
function config(home: string, root: string): LandConfig {
  if (!registeredProject(home, root).registered) throw Error('hud_land requires a registered project');
  const c = JSON.parse(fs.readFileSync(join(root, '.hud/project.json'), 'utf8')).land;
  const commands = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim());
  if (!c || typeof c.base !== 'string' || !c.base || c.base.startsWith('-') || !commands(c.gate) || !commands(c.after) ||
      typeof c.push !== 'boolean' || (c.wrapper !== undefined && (typeof c.wrapper !== 'string' || !c.wrapper)))
    throw Error('Invalid or missing project land config: expected base, gate, after, push and optional wrapper');
  return c;
}
export async function startLand(home: string, id: string, job: Job | null, state: string | null, pane: string | null, task: boolean) {
  const wt = job?.worktree;
  if (!job || job.job !== id || !wt || wt.root !== job.cwd || wt.main_root !== sharedRoot(process.cwd()))
    throw Error('hud_land requires a managed worktree job in the caller project');
  const flow = flowId(id), prior = readLand(home, flow);
  if (prior) return prior;
  if (!['idle_grace', 'closed', 'done'].includes(state ?? '')) throw Error(`Cannot land ${id}: job state is ${state ?? 'unknown'} (expected idle_grace, done or closed)`);
  const c = config(home, wt.main_root);
  await git(wt.main_root, ['check-ref-format', `refs/heads/${c.base}`]);
  const trees = parseWorktreeList(await git(wt.main_root, ['worktree', 'list', '--porcelain', '-z']));
  const tree = trees.slice(1).find(t => t.path === wt.root && t.branch === wt.branch);
  if (trees[0]?.path !== wt.main_root || !tree?.head || tree.locked !== undefined || tree.prunable !== undefined ||
      !managedReceiptMatches(id, { ...job, worktree: wt }))
    throw Error('Source is no longer the registered job worktree');
  fs.mkdirSync(join(home, 'flows'), { mode: 0o700, recursive: true });
  // Publish the helper identity before it gets permission to run. Losing a creation race never starts a second land.
  const child = fork(new URL('./land-runner.js', import.meta.url), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  child.on('error', () => { /* A dead helper is reported against its last persisted step. */ });
  try {
    const pid = child.pid, start = pid && procStat(pid)?.start;
    if (!pid || !start) throw Error('Could not start land helper');
    const now = new Date().toISOString();
    const f: LandFlow = { flow, job: id, pane, task, wt, config: c, source_sha: tree.head, pid, start,
      state: 'queued', step: 'main-checkout lease', created_at: now, updated_at: now };
    try { writeLand(home, f, true); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return readLand(home, flow)!; throw e; }
    child.send({ home, flow });
    return f;
  } finally { if (child.connected) child.disconnect(); child.unref(); }
}
export function landTask(home: string, f: LandFlow, cancel = false) {
  if (cancel && activeLand(f)) fs.closeSync(fs.openSync(`${landFile(home, f.flow)}.cancel`, 'a', 0o600));
  return { taskId: f.flow, status: activeLand(f) ? 'working' : f.state, statusMessage: `${f.flow} — ${f.state}: ${f.step}`,
    createdAt: f.created_at, lastUpdatedAt: f.updated_at, ttlMs: 3 * 60 * 60_000, pollIntervalMs: 5000,
    ...(!activeLand(f) ? { result: { content: [{ type: 'text', text: landNotice(f) }] } } : {}) };
}

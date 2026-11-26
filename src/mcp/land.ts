/** Main-session entry points. Only read executable configuration from the registered main checkout. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { parseWorktreeList, worktreeGit as git } from '../collectors/worktrees.js';
import { registeredProject } from '../roles/projects.js';
import { loadGraph } from '../workflows/graph.js';
import { freezeGraph, requestStop, runDir, runLock } from '../workflows/store.js';
import { wakeSealedWorkflow } from '../workflows/wake.js';
import { activeLand, landAttempt, landNotice, landOutcome, readLand, recoverLand, retryableLand, writeLand, type LandConfig, type LandFlow } from './land-state.js';
import { managedReceiptMatches } from './managed-worktree.js';
import { BUNDLED_ROOT } from './paths.js';
import type { Job } from './job-contracts.js';

export function validLandConfig(home: string, root: string): LandConfig {
  if (!registeredProject(home, root).registered) throw Error('hud_land requires a registered project');
  const c = JSON.parse(fs.readFileSync(join(root, '.hud/project.json'), 'utf8')).land;
  const commands = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim());
  if (!c || typeof c.base !== 'string' || !c.base || c.base.startsWith('-') || !commands(c.gate) || !commands(c.after) ||
      typeof c.push !== 'boolean' || (c.wrapper !== undefined && (typeof c.wrapper !== 'string' || !c.wrapper)) ||
      (c.timeout_s !== undefined && (!Number.isFinite(c.timeout_s) || c.timeout_s < 0.001 || c.timeout_s * 1000 > 2 ** 31 - 1)))
    throw Error('Invalid or missing project land config: expected base, gate, after, push and optional wrapper and timeout_s');
  return c;
}
export async function startLand(home: string, id: string, job: Pick<Job, 'job' | 'cwd' | 'worktree'> | null, state: string | null, pane: string | null, task: boolean, ticketQueue?: string, retry?: string, approvedHead?: string) {
  const wt = job?.worktree;
  if (!job || job.job !== id || !wt || wt.root !== job.cwd)
    throw Error('hud_land requires a managed worktree job');
  let attempt = landAttempt(home, id);
  if (attempt.prior && activeLand(attempt.prior)) {
    await recoverLand(home, attempt.prior.flow);
    attempt = landAttempt(home, id);
  }
  const { flow, prior, cleanup } = attempt;
  // A recovering runner observes its earlier attempt. An explicitly resumed queue can retry that specific receipt.
  if (prior && (!retryableLand(prior) || (ticketQueue && prior.flow !== retry))) {
    if (!registeredProject(home, wt.main_root).registered) throw Error('hud_land requires a registered project');
    return prior;
  }
  if (!['idle_grace', 'closed', 'done'].includes(state ?? '')) throw Error(`Cannot land ${id}: job state is ${state ?? 'unknown'} (expected idle_grace, done or closed)`);
  const c = validLandConfig(home, wt.main_root);
  await git(wt.main_root, ['check-ref-format', `refs/heads/${c.base}`]);
  const trees = parseWorktreeList(await git(wt.main_root, ['worktree', 'list', '--porcelain', '-z']));
  const tree = trees.slice(1).find(t => t.path === wt.root && t.branch === wt.branch);
  if (trees[0]?.path !== wt.main_root || !tree?.head || tree.locked !== undefined || tree.prunable !== undefined ||
      !managedReceiptMatches(id, { ...job, worktree: wt }))
    throw Error('Source is no longer the registered job worktree');
  const source_sha = tree.head;
  if (approvedHead && source_sha !== approvedHead) throw Error('Source changed after unattended lead approval');
  const graph = loadGraph(fs.readFileSync(join(BUNDLED_ROOT, 'workflows/land.toml'), 'utf8'), 'toml', {
    roles: new Map(), bindings: { job: id }, landSource: id,
  });
  return wakeSealedWorkflow<LandFlow>(join(home, 'jobs', id), (pid, start, loaded) => runLock(home, flow, () => {
    const won = readLand(home, flow);
    if (won) return { result: won };
    const now = new Date().toISOString();
    const f: LandFlow = { flow, job: id, pane, task, ...(ticketQueue && { ticket_queue: ticketQueue }),
      ...(approvedHead && { protected_spec: true, single: true }), wt, config: c, source_sha, pid, start,
      state: loaded ? 'queued' : 'failed', step: loaded ? 'main-checkout lease' : 'load land helper', created_at: now, updated_at: now,
      workflow: { flow, pane: pane ?? '', state: 'working', epoch: 0, streak: 0, settled: 0, failures: 0,
        steps: { land: { state: 'waiting' } }, notices: {} } };
    if (!loaded) f.error = 'HUD was rebuilt; retry the land';
    if (!fs.existsSync(join(runDir(home, flow), 'graph.json'))) freezeGraph(home, flow, graph);
    // The engine commits admission to the sealed step again before invoking it.
    writeLand(home, f, true);
    return { result: f, claimed: true, input: loaded ? { home, flow, cleanup } : undefined };
  }));
}
export function landTask(home: string, f: LandFlow, cancel = false) {
  if (cancel && activeLand(f)) requestStop(home, f.flow);
  return { taskId: f.flow, status: activeLand(f) ? 'working' : f.state,
    statusMessage: `${f.flow} — ${f.state === 'failed' ? landOutcome(f) : `${f.state}: ${f.step}`}`,
    createdAt: f.created_at, lastUpdatedAt: f.updated_at, ttlMs: 3 * 60 * 60_000, pollIntervalMs: 5000,
    ...(!activeLand(f) ? { result: { content: [{ type: 'text', text: landNotice(f) }] } } : {}) };
}

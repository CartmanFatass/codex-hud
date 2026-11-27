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
import { readTicketQueue } from './ticket-queue-state.js';
import type { Job } from './job-contracts.js';

export function validLandConfig(home: string, root: string): LandConfig {
  if (!registeredProject(home, root).registered) throw Error('hud_land requires a registered project');
  const c = JSON.parse(fs.readFileSync(join(root, '.hud/project.json'), 'utf8')).land;
  const commands = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim());
  const invalid = (field: string, expected: string): never => {
    throw Error(`Invalid or missing project land config: land.${field} must be ${expected}`);
  };
  if (typeof c?.base !== 'string' || !c.base.trim() || c.base.startsWith('-')) invalid('base', 'a branch name');
  if (!commands(c.gate)) invalid('gate', 'an array of non-empty commands');
  if (!commands(c.after)) invalid('after', 'an array of non-empty commands');
  if (typeof c.push !== 'boolean') invalid('push', 'true or false');
  if (c.wrapper !== undefined && (typeof c.wrapper !== 'string' || !c.wrapper.trim())) invalid('wrapper', 'a non-empty string');
  if (c.timeout_s !== undefined && (!Number.isFinite(c.timeout_s) || c.timeout_s < 0.001 || c.timeout_s * 1000 > 2 ** 31 - 1))
    invalid('timeout_s', 'a number in seconds from 0.001 through 2147483.647');
  return c;
}
export async function startLand(
  home: string,
  id: string,
  job: Pick<Job, 'job' | 'cwd' | 'worktree' | 'ticket_queue'> | null,
  state: string | null,
  pane: string | null,
  task: boolean,
  ticketQueue?: string,
  retry?: string,
  approvedHead?: string,
  ownerManual = false,
  autoLand = false,
) {
  const wt = job?.worktree;
  if (!job || job.job !== id || !wt || wt.root !== job.cwd)
    throw Error('hud_land requires a managed worktree job');
  const ownerQueue = job.ticket_queue ? readTicketQueue(home, job.ticket_queue) : null;
  if (ownerQueue?.unattended) {
    const item = ownerQueue.tickets.find(t => t.job === id);
    if (ticketQueue) {
      if (ticketQueue !== ownerQueue.flow || !approvedHead || item?.approved_head !== approvedHead)
        throw Error('Unattended job can only be landed by its run with an approved commit');
    } else if (ownerManual) {
      if (!item?.held)
        throw Error('Unattended job is managed by its run; only a held item can be landed manually');
    } else {
      throw Error('Unattended job requires its run and an approved commit');
    }
  }
  let attempt = landAttempt(home, id);
  if (attempt.prior && activeLand(attempt.prior)) {
    await recoverLand(home, attempt.prior.flow);
    attempt = landAttempt(home, id);
  }
  const { flow, prior, cleanup } = attempt;
  // A recovering runner observes its earlier attempt. An explicitly resumed queue can retry that specific receipt.
  if (prior && (!retryableLand(prior) || (ticketQueue && prior.flow !== retry) || autoLand)) {
    if (!registeredProject(home, wt.main_root).registered) throw Error('hud_land requires a registered project');
    return prior;
  }
  if (!['idle_grace', 'closed', 'done'].includes(state ?? '')) {
    const repair = state === 'failed' && prior?.state === 'failed' && /^repair \d+$/.test(prior.step)
      ? prior.repairs?.at(-1)
      : undefined;
    if (repair?.job === id) {
      const outcome = repair.outcome.replace(/\s+/g, ' ').trim();
      const where = fs.existsSync(wt.root)
        ? `Branch ${wt.branch} is preserved at ${wt.root}; inspect ${prior!.flow} (hud_read job=${prior!.flow}) and retry on this worktree with hud_create retry_of=${id}, then call hud_land on the new job.`
        : `Inspect ${prior!.flow} (hud_read job=${prior!.flow}) before retrying with hud_create retry_of=${id}.`;
      throw Error(`Cannot land ${id}: job state is failed from ${prior!.flow} ${prior!.step} (${outcome}). ${where}`);
    }
    throw Error(`Cannot land ${id}: job state is ${state ?? 'unknown'} (expected idle_grace, done or closed)`);
  }
  const c = validLandConfig(home, wt.main_root);
  try { await git(wt.main_root, ['check-ref-format', `refs/heads/${c.base}`]); }
  catch { throw Error('Invalid project land config: land.base must be a branch name'); }
  const trees = parseWorktreeList(await git(wt.main_root, ['worktree', 'list', '--porcelain', '-z']));
  const tree = trees.slice(1).find(t => t.path === wt.root && t.branch === wt.branch);
  if (trees[0]?.path !== wt.main_root || !tree?.head || tree.locked !== undefined || tree.prunable !== undefined ||
      !managedReceiptMatches(id, { ...job, worktree: wt }))
    throw Error('Source is no longer the registered job worktree');
  const source_sha = tree.head;
  if (approvedHead && source_sha !== approvedHead) throw Error('Source changed after unattended approval');
  const graph = loadGraph(fs.readFileSync(join(BUNDLED_ROOT, 'workflows/land.toml'), 'utf8'), 'toml', {
    roles: new Map(), bindings: { job: id }, landSource: id,
  });
  return wakeSealedWorkflow<LandFlow>(join(home, 'jobs', id), (pid, start, loaded) => runLock(home, flow, () => {
    const won = readLand(home, flow);
    if (won) return { result: won };
    const now = new Date().toISOString();
    const f: LandFlow = { flow, job: id, pane, task, ...(ticketQueue && { ticket_queue: ticketQueue }),
      ...(autoLand && { auto_land: true as const }),
      ...(approvedHead && { protected_spec: true, single: true }), wt, config: c, source_sha, pid, start,
      state: loaded ? 'queued' : 'failed', step: loaded ? 'main-checkout lease' : 'load land helper', created_at: now, updated_at: now,
      workflow: { flow, pane: pane ?? '', ...(autoLand && { project_root: wt.main_root }), state: 'working', epoch: 0, streak: 0, settled: 0, failures: 0,
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

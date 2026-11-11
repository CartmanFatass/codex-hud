/** Pure display projection of the existing finished/native linger policy.
 * P2 q18: Home overview/footer and Work share this projection, so Home never
 * hands off to an expired Work target. Counts are visible-worker counts.
 * Decisions (including daily one-way records), coverage, human-needed workers
 * and successful unclosed facade output are retained. Zero linger is identity;
 * the existing show-all reveal bypasses expiry on both tabs. No source mutation.
 */
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { SubagentTreeNode } from '../types.js';
import type { MonitorData, MonitorState } from './monitor.js';
import { isExpired } from './panel-state.js';
import { effectiveStatus, jobSettledAt } from './job-details.js';

/** Retain only the currently inspected worker; this is never a model request target. */
export function jobInspectorTargets(board: WorkboardSnapshot, state: MonitorState): ReadonlySet<string> {
  if (state.focus !== 'details' || state.boardInspect === 'summary') return new Set();
  const target = state.boardInspect;
  const worker =
    target && target.kind === 'worker'
      ? board.workers.find((w) => w.id === target.workerId && w.laneId === target.laneId)
      : !target && state.preview === 'agent'
        ? board.workers.find((w) => w.nodeId === state.tree.selectedId)
        : undefined;
  return new Set(worker ? [worker.id] : []);
}

const cache = new WeakMap<
  WorkboardSnapshot,
  {
    tree: MonitorData['tree'];
    key: string;
    at: number;
    until: number;
    board: WorkboardSnapshot;
  }
>();
export function visibleWorkboard(
  input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  now: number
): WorkboardSnapshot {
  const policy = state.tree;
  const linger = policy.lingerMs;
  if (!linger || linger <= 0 || policy.showAll || policy.filter !== 'all') return board;
  const key = JSON.stringify([linger, policy.showAll, policy.filter]);
  const prior = cache.get(board);
  if (prior && prior.tree === input.tree && prior.key === key && prior.at <= now && now < prior.until)
    return prior.board;
  const nodes = new Map<string, SubagentTreeNode>();
  const walk = (items: readonly SubagentTreeNode[]) => {
    for (const node of items) {
      nodes.set(node.id, node);
      walk(node.children);
    }
  };
  walk(input.tree.nodes);
  let until = Infinity;
  const visible = (worker: OwnerWorker, invocation: boolean) => {
    if (worker.id.startsWith('thin-job:')) return true; // Thin history is already capped at the newest 20.
    // Current attention and successful unclosed facade output are not finished history.
    if (
      worker.homeNeedsHuman ||
      worker.work?.request ||
      worker.work?.failed ||
      (worker.work?.result && worker.work.facadeClosed === false)
    )
      return true;
    const node = worker.nodeId ? nodes.get(worker.nodeId) : undefined;
    if (node) {
      const status = effectiveStatus(node);
      const native = status === 'completed' ? (node.statusAt ?? node.lastEventAt) : (node.lastEventAt ?? node.statusAt);
      const at = ((node.job ? jobSettledAt(node) : undefined) ?? native)?.getTime();
      if ((status === 'completed' || status === 'unknown') && at !== undefined && Number.isFinite(at)) {
        const edge = at + linger + 1;
        if (edge > now) until = Math.min(until, edge);
      }
      return !isExpired(node, policy, now);
    }
    const completed =
      worker.work?.result === true ||
      ['closed', 'idle_grace', 'completed', 'done', 'awaiting-acceptance'].includes(worker.state);
    const unknown = worker.state === 'unknown';
    if (!completed && !unknown) return true;
    // An open invocation of unknown outcome is not known to have finished.
    if (unknown && invocation && worker.work?.facadeClosed !== true) return true;
    const at = completed ? worker.settledAt : (worker.work?.activityAt ?? worker.settledAt ?? worker.startedAt);
    if (at === null || at === undefined || !Number.isFinite(at)) return false;
    const edge = at + linger + 1;
    if (edge > now) until = Math.min(until, edge);
    return now - at <= linger;
  };
  let changed = false;
  const lanes = board.lanes.flatMap((lane) => {
    const workers = lane.workers.filter((worker) => visible(worker, lane.identity.kind === 'invocation'));
    if (workers.length === lane.workers.length) return [lane];
    changed = true;
    // Keep genuine decision-only/source-only scopes, not an empty expired-worker shell.
    return workers.length || lane.decisions.length ? [{ ...lane, workers }] : [];
  });
  let result = changed ? { ...board, lanes, workers: lanes.flatMap((lane) => lane.workers) } : board;
  if (
    prior &&
    changed &&
    result.workers.length === prior.board.workers.length &&
    result.workers.every((worker, index) => worker === prior.board.workers[index]) &&
    result.lanes.length === prior.board.lanes.length &&
    result.lanes.every((lane, index) => lane.id === prior.board.lanes[index].id)
  )
    result = prior.board;
  cache.set(board, { tree: input.tree, key, at: now, until, board: result });
  return result;
}

/** Pure projection. Names/cwd never join a task directory to an invocation. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { DelegationViewModel } from '../core/link/view-model.js';
import type { JobSnapshot } from './job-display-types.js';
import type { DecisionRecord, OwnerWorker, TaskSnapshot, WorkboardSnapshot, WorkLane } from './workboard-types.js';
export const invocationLaneId = (home: string, root: string, job: string): string =>
  `invocation:${JSON.stringify([home, root, job])}`;
export const callTime = (record: DecisionRecord): number | null => record.evidence.at(-1)?.at ?? null;
export function isLocalDay(at: number | null, nowMs: number): boolean {
  if (at === null || !Number.isFinite(at)) return false;
  const d = new Date(at),
    now = new Date(nowMs);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
export interface HomeCalls {
  worth: readonly DecisionRecord[];
  routine: readonly DecisionRecord[];
  older: readonly DecisionRecord[];
  today: number;
}
export function homeCalls(board: WorkboardSnapshot, nowMs: number): HomeCalls {
  const today = board.decisions
    .filter((d) => isLocalDay(callTime(d), nowMs))
    .sort((a, b) => (callTime(b) ?? 0) - (callTime(a) ?? 0) || a.id.localeCompare(b.id));
  return {
    worth: today.filter((d) => (d.oneWay || d.departure) && (d.oneWay || nowMs - callTime(d)! <= 7200000)),
    routine: today.filter((d) => !d.oneWay && !d.departure && nowMs - callTime(d)! <= 7200000),
    older: today.filter((d) => !d.oneWay && nowMs - callTime(d)! > 7200000),
    today: today.length,
  };
}
export function buildWorkboard(
  home: string,
  tasks: TaskSnapshot,
  jobs: JobSnapshot,
  tree: SubagentTree,
  legacy: DelegationViewModel | null = null
): WorkboardSnapshot {
  const lanes: WorkLane[] = tasks.lanes.filter((l) => l.identity.kind === 'task-directory').map((l) => l);
  const nodeByJob = new Map<string, SubagentTreeNode>(),
    nodes = new Map<string, SubagentTreeNode>();
  const walk = (items: readonly SubagentTreeNode[]) => {
    for (const n of items) {
      nodes.set(n.id, n);
      if (n.job) nodeByJob.set(n.job.id, n);
      walk(n.children);
    }
  };
  walk(tree.nodes);
  for (const job of jobs.jobs) {
    const id = invocationLaneId(home, job.root, job.jobId),
      observed = tasks.lanes.find((l) => l.id === id),
      node = nodeByJob.get(job.id);
    const w = job.work;
    const awaitingAcceptance = w?.facadeClosed === false && job.status === 'completed';
    const worker: OwnerWorker = {
      id: job.id,
      laneId: id,
      ...(node ? { nodeId: node.id } : {}),
      harness: job.backend?.harness ?? null,
      role: job.role,
      task: job.name || job.jobId,
      model: job.observedModel ?? job.backend?.model ?? null,
      effort: job.observedEffort ?? job.backend?.effort ?? null,
      state: awaitingAcceptance ? 'awaiting-acceptance' : job.lifecycle,
      startedAt: job.createdAt,
      settledAt: w?.settledAt ?? null,
      phase: awaitingAcceptance ? 'awaiting-acceptance' : (job.runtimePhase ?? job.phase ?? observed?.phase ?? null),
      homeNeedsHuman: w?.runtimeTerminal === true && w.homeNeedsHuman === true,
      humanEndedAt: w?.endedAt ?? null,
      stale: job.freshness.state !== 'current',
      evidence: observed?.evidence ?? [],
    };
    lanes.push({
      id,
      identity: { kind: 'invocation', home, root: job.root, jobId: job.jobId },
      label: job.name || job.jobId,
      title: job.name || job.jobId,
      startedAt: job.createdAt,
      phase: worker.phase,
      workers: [worker],
      decisions: observed?.decisions ?? [],
      evidence: observed?.evidence ?? [],
    });
  }
  // Exact native-ref enrichment is already resolved by the tree composer. Helpers are not owner rows.
  const addNative = (node: SubagentTreeNode) => {
    if (node.job) return;
    if (node.id.startsWith('job-root:')) {
      for (const child of node.children) addNative(child);
      return;
    }
    const id = `native:${node.id}`;
    const worker: OwnerWorker = {
      id: node.id,
      nodeId: node.id,
      laneId: id,
      harness: node.ref?.harness ?? 'codex',
      role: node.role ?? null,
      task: node.label || node.name,
      model: node.model ?? null,
      effort: node.effort ?? null,
      state: node.status,
      startedAt: node.turnStartedAt?.getTime() ?? node.startedAt?.getTime() ?? null,
      settledAt: ['completed', 'error'].includes(node.status) ? (node.statusAt?.getTime() ?? null) : null,
      phase: null,
      homeNeedsHuman: false,
      humanEndedAt: null,
      stale: node.status === 'unknown',
      evidence: [],
    };
    lanes.push({
      id,
      identity: { kind: 'native', refKey: node.id },
      label: node.name,
      title: node.label || node.name,
      startedAt: worker.startedAt,
      phase: null,
      workers: [worker],
      decisions: [],
      evidence: [],
    });
  };
  for (const node of tree.nodes) addNative(node);
  // Residual legacy observations remain explicitly historical/read-only, not invented native subjects.
  for (const n of legacy?.tree.nodes ?? []) {
    if (nodes.has(n.key)) continue;
    const relation = legacy!.tree.relations.find((r) => r.childKey === n.key),
      detail = legacy!.details[n.key];
    if (!relation && n.parentKey === null) continue; // Viewpoint roots are not workers.
    const id = `native:legacy:${n.key}`,
      role = relation?.link.role ?? null;
    const title = relation?.link.label || detail?.latestReportForRun?.summary || role || n.key;
    const worker: OwnerWorker = {
      id: n.key,
      laneId: id,
      harness: n.identity.kind === 'session' ? n.identity.ref.harness : null,
      role,
      task: title,
      model: null,
      effort: null,
      state: n.currentRun?.state ?? 'unknown',
      startedAt: n.currentRun?.createdAt ?? null,
      settledAt: n.currentRun?.endedAt ?? null,
      phase: null,
      homeNeedsHuman: false,
      humanEndedAt: null,
      stale: !n.observation,
      evidence: [],
    };
    lanes.push({
      id,
      identity: { kind: 'native', refKey: n.key },
      label: role || title,
      title,
      startedAt: worker.startedAt,
      phase: null,
      workers: [worker],
      decisions: [],
      evidence: [],
    });
  }
  lanes.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id));
  let partial = tasks.coverage.incomplete || jobs.coverage.incomplete;
  if (lanes.length > 200) {
    lanes.length = 200;
    partial = true;
  }
  const workers = lanes.flatMap((l) => l.workers).slice(0, 200);
  const all = lanes.flatMap((l) => l.decisions);
  // Preserve explicit one-way facts before routine history at the resident bound.
  const decisions =
    all.length <= 1000
      ? all
      : [...all]
          .sort((a, b) => Number(b.oneWay) - Number(a.oneWay) || (callTime(b) ?? 0) - (callTime(a) ?? 0))
          .slice(0, 1000);
  partial ||= all.length > decisions.length;
  return {
    revision: `${jobs.generation}:${tasks.revision}`,
    lanes,
    workers,
    decisions,
    coverage: {
      incomplete: partial,
      workspace: tasks.coverage.workspace,
      diagnostics: [...tasks.coverage.diagnostics, ...jobs.coverage.diagnostics],
    },
  };
}

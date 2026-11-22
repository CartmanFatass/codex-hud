/** Pure projection of native subagents and workspace tasks. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import { nativeWorker } from './work-card.js';
import type { DecisionRecord, OwnerWorker, TaskSnapshot, WorkboardSnapshot, WorkLane } from './workboard-types.js';

const callTime = (record: DecisionRecord): number => record.evidence.at(-1)?.at ?? 0;

export function buildWorkboard(tree: SubagentTree, tasks?: TaskSnapshot): WorkboardSnapshot {
  const lanes: WorkLane[] = [...(tasks?.lanes ?? [])];
  const nativeLanes = new Map<string, WorkLane>();
  const addNative = (node: SubagentTreeNode, parent?: SubagentTreeNode) => {
    const harness = node.ref?.harness ?? 'codex';
    const root = node.ref
      ? `${node.ref.sourceId}/${node.ref.harness === 'claude' ? node.ref.sessionId : tree.rootId}`
      : tree.rootId;
    const id = `native:${harness}:${root}`;
    const worker = { ...nativeWorker(node, id), harness, parentName: parent?.name };
    let lane = nativeLanes.get(id);
    if (!lane) {
      lane = {
        id,
        identity: { kind: 'native', refKey: root },
        label: `${harness === 'claude' ? 'Claude' : 'Codex'} · this session`,
        title: '',
        startedAt: worker.startedAt,
        phase: null,
        workers: [],
        decisions: [],
        evidence: [],
      };
      nativeLanes.set(id, lane);
      lanes.push(lane);
    }
    (lane.workers as OwnerWorker[]).push(worker);
    for (const child of node.children) addNative(child, node);
  };
  for (const node of tree.nodes) addNative(node);
  lanes.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id));
  let partial = !!tree.incomplete || !!tasks?.coverage.incomplete;
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
      : [...all].sort((a, b) => Number(b.oneWay) - Number(a.oneWay) || callTime(b) - callTime(a)).slice(0, 1000);
  partial ||= all.length > decisions.length;
  return {
    revision: String(tasks?.revision ?? 0),
    lanes,
    workers,
    decisions,
    coverage: {
      incomplete: partial,
      workspace: tasks?.coverage.workspace ?? null,
      diagnostics: tasks?.coverage.diagnostics ?? [],
    },
  };
}

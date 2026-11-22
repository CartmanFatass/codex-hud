/** Pure projection of thin jobs and native subagents. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import { nativeWorker } from './work-card.js';
import type { OwnerWorker, WorkboardSnapshot, WorkLane } from './workboard-types.js';

export function buildWorkboard(tree: SubagentTree, thinJobs: readonly WorkLane[] = []): WorkboardSnapshot {
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
    }
    (lane.workers as OwnerWorker[]).push(worker);
    for (const child of node.children) addNative(child, node);
  };
  for (const node of tree.nodes) addNative(node);
  const native = [...nativeLanes.values()]
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id))
    .slice(0, 200);
  return {
    revision: '0',
    lanes: [...thinJobs, ...native],
    workers: [...thinJobs.flatMap((l) => l.workers), ...native.flatMap((l) => l.workers).slice(0, 200)],
    decisions: thinJobs.flatMap((l) => l.decisions),
    coverage: { incomplete: !!tree.incomplete || nativeLanes.size > 200, workspace: null, diagnostics: [] },
  };
}

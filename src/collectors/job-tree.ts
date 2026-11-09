/** Pure composition. Admission is exact-root/exact-ref only; no I/O or execution. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { SessionRef } from '../core/types/identity.js';
import { completeNativeRef } from '../roles/association.js';
import { sessionRefKey } from '../core/identity.js';
import type { DelegationViewModel } from '../core/link/view-model.js';
import type { LinkTreeNode } from '../core/link/types.js';
import type { JobDisplay, JobSnapshot } from './job-display-types.js';
import { JOB_BOUNDS } from './job-observations.js';

export interface JobTreeInput {
  tree: SubagentTree;
  snapshot: JobSnapshot;
  /** Explicit association root for the native viewpoint; never inferred from bare tree.rootId. */
  root: string;
  nowMs: number;
  legacy?: DelegationViewModel | null;
  nativeRefs?: ReadonlyMap<string, SessionRef>;
  /** Shared all-roots projection allowance remaining after other roots/containers. */
  maxAdditionalNodes?: number;
}
export interface JobTreeResult {
  tree: SubagentTree;
  legacy: DelegationViewModel | null;
  aliases: Readonly<Record<string, string>>;
  coverage: JobSnapshot['coverage'];
  diagnostics: readonly string[];
}
function refKey(ref: unknown): string | null {
  return completeNativeRef(ref) ? sessionRefKey(ref) : null;
}
function display(job: JobDisplay): SubagentTreeNode {
  const settledJudgment = ['completed', 'closed'].includes(job.lifecycle) && !!job.judgments?.length;
  const status = job.freshness.state !== 'current' && !job.outcome && !settledJudgment ? 'unknown' : job.status;
  return {
    id: job.id,
    name: job.name,
    ...(job.role ? { role: job.role } : {}),
    status,
    depth: 1,
    children: [],
    job,
    ...(job.backend?.model ? { model: job.backend.model } : {}),
    ...(job.backend?.effort ? { effort: job.backend.effort } : {}),
    ...(job.createdAt !== null ? { startedAt: new Date(job.createdAt) } : {}),
  };
}
export function composeJobTree(input: JobTreeInput): JobTreeResult {
  const diagnostics: string[] = [];
  const aliases: Record<string, string> = {};
  const byRef = new Map<string, SubagentTreeNode[]>();
  const parent = new Map<SubagentTreeNode, SubagentTreeNode | null>();
  const seen = new Set<string>();
  const clone = (nodes: readonly SubagentTreeNode[], p: SubagentTreeNode | null): SubagentTreeNode[] => {
    const result: SubagentTreeNode[] = [];
    for (const n of nodes) {
      if (seen.has(n.id)) {
        diagnostics.push(`cycle_or_duplicate:${n.id}`);
        continue;
      }
      seen.add(n.id);
      const copy = { ...n, children: [] as SubagentTreeNode[] };
      parent.set(copy, p);
      const key = refKey(n.ref ?? input.nativeRefs?.get(n.id));
      if (key) byRef.set(key, [...(byRef.get(key) ?? []), copy]);
      copy.children = clone(n.children, copy);
      result.push(copy);
    }
    return result;
  };
  const nodes = clone(input.tree.nodes, null);
  const jobs = input.snapshot.jobs.filter((j) => j.root === input.root);
  const claimants = new Map<string, number>();
  const countClaims = (job: JobDisplay) => {
    const key = refKey(job.native);
    if (key) claimants.set(key, (claimants.get(key) ?? 0) + 1);
    for (const helper of job.helpers) {
      const h = refKey(helper.native);
      if (h) claimants.set(h, (claimants.get(h) ?? 0) + 1);
    }
  };
  for (const job of jobs) countClaims(job);
  for (const [key, count] of claimants) if (count > 1) diagnostics.push(`ambiguous_native_ownership:${key}`);
  const suppressed = new Set<string>();
  let added = 0;
  const room = Math.min(
    input.maxAdditionalNodes ?? JOB_BOUNDS.nodes,
    Math.max(0, JOB_BOUNDS.nodes - seen.size - (input.legacy?.tree.nodes.length ?? 0))
  );
  let omitted = 0;
  const legacyNodes = input.legacy?.tree.nodes ?? [];
  const movable = (n: LinkTreeNode) =>
    n.identity.kind === 'session' && refKey(n.identity.ref) !== null && !n.key.startsWith('native-call:');
  const moveLegacy = (source: LinkTreeNode, target: SubagentTreeNode | null): SubagentTreeNode | null => {
    const plan: LinkTreeNode[] = [];
    const visiting = new Set<string>();
    const check = (n: LinkTreeNode): boolean => {
      if (!movable(n) || seen.has(n.key) || visiting.has(n.key) || plan.length >= JOB_BOUNDS.nodes) return false;
      visiting.add(n.key);
      plan.push(n);
      return legacyNodes.filter((child) => child.parentKey === n.key).every(check);
    };
    if (!check(source)) {
      diagnostics.push(`legacy_subtree_not_admitted:${source.key}`);
      return null;
    }
    const build = (n: LinkTreeNode, p: SubagentTreeNode | null): SubagentTreeNode => {
      // The plan validates the complete session identity; no display-only namespace is converted.
      const ref = n.identity.kind === 'session' ? n.identity.ref : undefined;
      const projection = n.observation?.statusProjection;
      const copy: SubagentTreeNode = {
        id: n.key,
        name: n.native?.title ?? ref?.sessionId ?? n.key,
        ...(ref ? { ref: { ...ref } } : {}),
        status:
          projection?.freshness.state !== 'fresh'
            ? 'unknown'
            : projection.lastTurnOutcome === 'failed'
              ? 'error'
              : projection.activity === 'working'
                ? 'running'
                : projection.lastTurnOutcome === 'completed'
                  ? 'completed'
                  : 'unknown',
        depth: 1,
        children: [],
      };
      seen.add(copy.id);
      parent.set(copy, p);
      suppressed.add(n.key);
      aliases[n.key] = copy.id;
      const key = refKey(ref);
      if (key) byRef.set(key, [...(byRef.get(key) ?? []), copy]);
      copy.children = plan.filter((child) => child.parentKey === n.key).map((child) => build(child, copy));
      return copy;
    };
    const moved = build(source, target);
    (target?.children ?? nodes).push(moved);
    return moved;
  };
  const attach = (job: JobDisplay, target: SubagentTreeNode | null): SubagentTreeNode | null => {
    const key = refKey(job.native);
    const rootRef = input.nativeRefs?.get(input.tree.rootId);
    if (key && key === refKey(rootRef)) {
      diagnostics.push(`cycle_refused:${job.id}`);
      return null;
    }
    let hits = key ? (byRef.get(key) ?? []) : [];
    if (key && claimants.get(key) === 1 && hits.length === 0) {
      const matches = legacyNodes.filter(
        (n) => movable(n) && n.identity.kind === 'session' && refKey(n.identity.ref) === key && !suppressed.has(n.key)
      );
      if (matches.length === 1) {
        const candidate = matches[0]!;
        const legacyParent = legacyNodes.find((n) => n.key === candidate.parentKey);
        const parentMatches = target
          ? legacyParent?.key === target.id
          : legacyParent?.identity.kind === 'session' &&
            `${legacyParent.identity.ref.sourceId}/${legacyParent.identity.ref.sessionId}` === input.root;
        if (parentMatches) {
          const moved = moveLegacy(candidate, target);
          if (moved) hits = [moved];
        } else diagnostics.push(`conflicting_legacy_parent:${job.id}`);
      }
    }
    let node: SubagentTreeNode;
    if (key && claimants.get(key) === 1 && hits.length === 1) {
      node = hits[0]!;
      // Enrich in place in the copied native tree: never move native descendants or overwrite native evidence.
      let ancestor = target;
      while (ancestor) {
        if (ancestor === node) {
          diagnostics.push(`cycle_refused:${job.id}`);
          return null;
        }
        ancestor = parent.get(ancestor) ?? null;
      }
      const actualParent = parent.get(node);
      if (actualParent !== target) {
        diagnostics.push(`conflicting_parent:${job.id}`);
        if (added >= room) {
          omitted++;
          return null;
        }
        node = display(job);
        (target?.children ?? nodes).push(node);
        parent.set(node, target);
        added++;
      } else {
        node.job = job;
        aliases[job.id] = node.id;
      }
    } else {
      if (added >= room) {
        omitted++;
        return null;
      }
      node = display(job);
      if (seen.has(node.id)) {
        diagnostics.push(`duplicate_job:${job.id}`);
        return null;
      }
      seen.add(node.id);
      (target?.children ?? nodes).push(node);
      parent.set(node, target);
      added++;
    }
    // A legacy row can be suppressed only with the same complete ref and an admitted replacement.
    // native-call:* namespaces are synthetic display namespaces, never binding evidence.
    if (key && claimants.get(key) === 1) {
      for (const legacy of input.legacy?.tree.nodes ?? []) {
        if (
          legacy.key.startsWith('native-call:') ||
          legacy.identity.kind !== 'session' ||
          refKey(legacy.identity.ref) !== key
        )
          continue;
        if (suppressed.has(legacy.key)) continue;
        const children = legacyNodes.filter((child) => child.parentKey === legacy.key);
        // Admission of every descendant is atomic. On incomplete topology keep the residual legacy row.
        if (children.length) {
          const moved = moveLegacy(legacy, target);
          if (moved) {
            // The already-admitted native node owns the shared session. Transfer only its descendants.
            (target?.children ?? nodes).splice((target?.children ?? nodes).indexOf(moved), 1);
            node.children.push(...moved.children);
            for (const child of moved.children) parent.set(child, node);
          } else continue;
        }
        suppressed.add(legacy.key);
        aliases[legacy.key] = node.id;
      }
    }
    for (const helper of job.helpers) attach(helper, node);
    return node;
  };
  for (const job of jobs) attach(job, null);
  let count = 0;
  const depths = (items: SubagentTreeNode[], depth: number) => {
    for (const n of items) {
      n.depth = depth;
      count++;
      depths(n.children, depth + 1);
    }
  };
  depths(nodes, 1);
  const legacy = input.legacy
    ? {
        ...input.legacy,
        tree: {
          ...input.legacy.tree,
          nodes: input.legacy.tree.nodes.filter((n) => !suppressed.has(n.key)),
          selectionMap: { ...input.legacy.tree.selectionMap, ...aliases },
        },
      }
    : null;
  return {
    tree: { ...input.tree, nodes, totalCount: count, updatedAt: new Date(input.nowMs) },
    legacy,
    aliases,
    diagnostics,
    coverage: {
      ...input.snapshot.coverage,
      incomplete: input.snapshot.coverage.incomplete || omitted > 0,
      omitted: input.snapshot.coverage.omitted === null ? null : input.snapshot.coverage.omitted + omitted,
    },
  };
}

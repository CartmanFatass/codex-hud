/**
 * The node projection and the per-tick tree pass (design §6 #2, #3, #10, #12).
 *
 * Everything the bar, the statusline and the panel rows need from the view
 * model is derived here once and shared:
 *
 *  - a node projection (marker, words, name, harness, badge facts) cached per
 *    node under its facts (`facts.ts`: the design's `(identity, asOfSeq,
 *    commitSeq, evidenceStamp)` plus every other fact the projection reads),
 *    so an unchanged node costs one string compare and nothing else;
 *  - one post-order pass (children before parents, no recursion) for each
 *    node's subtree bucket, `(1⚑ 2▸)` counts and finish time;
 *  - the tree counts, backend counts and the tree-level spend sum.
 *
 * The view model is read, never mutated, and no function here reads a clock:
 * `nowMs` is a parameter of the few consumers that need it.
 */

import { sumCostUsd } from '../../core/observation.js';
import type { LinkRelationProjection, LinkTreeNode } from '../../core/link/types.js';
import type { DelegationNodeDetails, DelegationViewModel } from '../../core/link/view-model.js';
import type { CostTotal, Metric } from '../../core/types/observation.js';
import { monitorText, plainText } from '../monitor-text.js';
import { factsEqual, nodeFacts, shortRefOf, type NodeFacts } from './facts.js';
import type { Glyph, HarnessMark } from './glyphs.js';
import { GLYPHS } from './glyphs.js';
import { deriveMarker, harnessFromBackend, harnessOf, type NodeMarker, type Rank } from './marker.js';

export type GlyphCounts = Record<Glyph, number>;
export const emptyCounts = (): GlyphCounts => ({
  warn: 0,
  flag: 0,
  fail: 0,
  stop: 0,
  unknown: 0,
  working: 0,
  starting: 0,
  done: 0,
});

export interface NodeProjection {
  key: string;
  marker: NodeMarker;
  harness: HarnessMark | null;
  /** The label, role or short reference, escaped; null for a root with no label (the renderer says `main`). */
  name: string | null;
  headless: boolean;
  /** `edge = intent`: drawn with the unconfirmed `┊`. */
  unconfirmed: boolean;
  isRoot: boolean;
  isNative: boolean;
  /** The report's summary, escaped and flattened, for history rows. */
  summary: string | null;
  reportAt: number | null;
  cancelRequestedAt: number | null;
  model: string | null;
  effort: string | null;
  contextPercent: number | null;
  createdAt: number | null;
  paneLabel: string | null;
}

export interface Subtree {
  /** Best (lowest) rank in the subtree, itself included (§3.2). */
  rank: Rank;
  /** Newest `since` among the rank-0 members when the subtree's bucket is rank 0. */
  sortAt: number | null;
  /** Descendants only, by marker: the `(1⚑ 2▸)` of a folded subtree. */
  below: GlyphCounts;
  total: number;
  /** Every node in the subtree is a history row with a known finish time. */
  allFinished: boolean;
  /** The newest finish in the subtree (a parent is put away with its youngest child). */
  youngestFinish: number | null;
}

export interface PNode {
  /** Null for a conflict relation drawn as a row of its own (§3.6). */
  node: LinkTreeNode | null;
  relation: LinkRelationProjection | undefined;
  key: string;
  proj: NodeProjection;
  parent: PNode | null;
  children: PNode[];
  depth: number;
  /** The tree's `native_topology` continuation: children exist that nothing listed. */
  childrenUnknown: boolean;
  sub: Subtree;
  index: number;
}

export interface Backends {
  codex: number;
  pi: number;
  jev: number;
  claude: number;
}

export interface DelegationProjection {
  vm: DelegationViewModel;
  nodes: PNode[];
  byKey: Map<string, PNode>;
  /** Viewpoint roots first, then the extra intent roots (§3.1). */
  roots: PNode[];
  /** A tree with more than one harness shows the harness marks (§3.4). */
  crossHarness: boolean;
  /** Counts over every node but the viewpoint roots, by marker (§3.3 "计数"). */
  counts: GlyphCounts;
  /** The same, over delegated workers and jobs only (the statusline `⧉`). */
  delegatedCounts: GlyphCounts;
  backends: Backends;
  /** Reported-but-alive visible agents in the tree. */
  toClose: number;
  spend: CostTotal;
  /** Distinct child keys of the conflicts drawn or counted. */
  conflictKeys: Set<string>;
  /**
   * Conflict relations that would have had a row of their own but did not fit the node budget
   * (`MAX_PROJECTED_NODES`); their children are still counted once each.
   */
  omittedConflictRows: number;
}

/** §6 #1, #6: the work of one tick is bounded by 200 projected nodes, conflict rows included. */
export const MAX_PROJECTED_NODES = 200;

interface CacheEntry {
  node: LinkTreeNode;
  detail: DelegationNodeDetails | undefined;
  relation: LinkRelationProjection | undefined;
  conflictName: string | null;
  facts: NodeFacts;
  proj: NodeProjection;
  seen: number;
}

/** §6 #2(a). One per process is enough; tests make their own. */
export class ProjectionCache {
  private entries = new Map<string, CacheEntry>();
  private generation = 0;
  hits = 0;
  misses = 0;
  get size(): number {
    return this.entries.size;
  }
  begin(): number {
    return ++this.generation;
  }
  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }
  set(key: string, entry: CacheEntry): void {
    this.entries.set(key, entry);
  }
  /** Drops what this pass did not see, so a removed node cannot leak. */
  sweep(): void {
    for (const [key, entry] of this.entries) if (entry.seen !== this.generation) this.entries.delete(key);
  }
}

export const sharedProjectionCache = new ProjectionCache();

/**
 * One name for a conflicting child, however many parents claim it (§3.4): the label the current records agree on,
 * else the child's session short form (`codex:51aa`); never a guess at a role from any single record. The
 * child's identity comes from the tree when the child is a node, else from what the records say of it.
 */
function conflictNameOf(records: readonly LinkRelationProjection[], identityShort: string | null): string {
  const labels = records.map((r) => r.link.label?.trim() ?? '');
  if (labels.length > 0 && labels[0] !== '' && labels.every((l) => l === labels[0])) return labels[0];
  if (identityShort) return identityShort;
  for (const r of records) {
    const ref = r.link.childRef;
    if (ref) return shortRefOf({ kind: 'session', ref });
  }
  // Nothing names the child: the earliest link id, so every claim writes the same thing.
  return (
    records
      .map((r) => r.link.linkId)
      .sort()[0]
      ?.slice(0, 8) ?? ''
  );
}

/** The harness of a conflicting child: a link that names its session says it; the backend profile is a hint. */
function conflictHarnessOf(records: readonly LinkRelationProjection[]): HarnessMark | null {
  for (const r of records) if (r.link.childRef) return r.link.childRef.harness;
  for (const r of records) {
    const hint = harnessFromBackend(r.link.backend);
    if (hint) return hint;
  }
  return null;
}

function buildProjection(f: NodeFacts): NodeProjection {
  const marker = deriveMarker(f);
  const name =
    f.conflictCount > 0
      ? monitorText(f.conflictName ?? f.shortRef)
      : f.linkLabel?.trim()
        ? monitorText(f.linkLabel.trim())
        : f.linkRole?.trim()
          ? monitorText(f.linkRole.trim())
          : f.isRoot
            ? null
            : monitorText(f.shortRef);
  return {
    key: f.key,
    marker,
    harness: harnessOf(f),
    name,
    headless: f.runMode === 'headless',
    unconfirmed: f.edge === 'intent',
    isRoot: f.isRoot,
    isNative: f.edge === 'native',
    summary: f.reportSummary ? monitorText(plainText(f.reportSummary).replace(/\s+/g, ' ').trim()) || null : null,
    reportAt: f.reportCreatedAt,
    cancelRequestedAt: f.runCancelRequestedAt,
    // Model and effort are the observed session's own words: escaped once here, so the badge cannot carry a
    // terminal command into a row (§6 #7).
    model: f.model ? monitorText(f.model) : null,
    effort: f.effort ? monitorText(f.effort) : null,
    contextPercent: f.contextPercent,
    createdAt: f.linkCreatedAt ?? f.runCreatedAt,
    paneLabel: f.paneLabel !== null ? monitorText(f.paneLabel) : null,
  };
}

const RELATION_PRIORITY: Record<LinkRelationProjection['attribution'], number> = {
  confirmed: 0,
  intent: 1,
  history: 2,
  conflict: 3,
};

function leafSubtree(proj: NodeProjection): Subtree {
  const m = proj.marker;
  return {
    rank: m.rank,
    sortAt: m.rank === 0 ? (m.sinceMs ?? Number.NEGATIVE_INFINITY) : null,
    below: emptyCounts(),
    total: 0,
    allFinished: m.historyEligible,
    youngestFinish: m.historyEligible ? m.finishedAt : null,
  };
}

interface Memo {
  details: DelegationViewModel['details'];
  capacity: DelegationViewModel['capacity'];
  result: DelegationProjection;
}
const memo = new WeakMap<DelegationViewModel['tree'], Memo>();

/**
 * Projects a view model. Cheap when nothing changed: the same tree, details
 * and capacity objects return the previous result, and a rebuilt-but-equal
 * node costs one facts compare through the cache.
 */
export function projectDelegation(
  vm: DelegationViewModel,
  cache: ProjectionCache = sharedProjectionCache
): DelegationProjection {
  const hit = memo.get(vm.tree);
  if (hit && hit.details === vm.details && hit.capacity === vm.capacity && cache === sharedProjectionCache)
    return hit.result.vm === vm ? hit.result : { ...hit.result, vm };
  const result = buildProjection_(vm, cache);
  if (cache === sharedProjectionCache) memo.set(vm.tree, { details: vm.details, capacity: vm.capacity, result });
  return result;
}

function buildProjection_(vm: DelegationViewModel, cache: ProjectionCache): DelegationProjection {
  const tree = vm.tree;
  const generation = cache.begin();
  const relationsByChild = new Map<string, LinkRelationProjection[]>();
  for (const relation of tree.relations) {
    const group = relationsByChild.get(relation.childKey);
    if (group) group.push(relation);
    else relationsByChild.set(relation.childKey, [relation]);
  }
  const unknownChildren = new Set(tree.continuation.filter((c) => c.reason === 'native_topology').map((c) => c.key));
  const nodeByKey = new Map<string, LinkTreeNode>();
  for (const node of tree.nodes) nodeByKey.set(node.key, node);

  // One name and one harness per conflicting child, from the whole group of its records (§3.4).
  const conflictGroups = new Map<string, { name: string; harness: HarnessMark | null }>();
  const conflictGroupOf = (childKey: string): { name: string; harness: HarnessMark | null } => {
    let info = conflictGroups.get(childKey);
    if (!info) {
      const records = (relationsByChild.get(childKey) ?? []).filter((r) => r.attribution === 'conflict');
      const node = nodeByKey.get(childKey);
      info = {
        name: conflictNameOf(records, node ? shortRefOf(node.identity) : null),
        harness: !node
          ? conflictHarnessOf(records)
          : node.identity.kind === 'session'
            ? node.identity.ref.harness
            : node.identity.kind === 'job'
              ? 'jev'
              : conflictHarnessOf(records),
      };
      conflictGroups.set(childKey, info);
    }
    return info;
  };

  const nodes: PNode[] = [];
  const byKey = new Map<string, PNode>();
  const harnesses = new Set<HarnessMark>();
  for (const node of tree.nodes) {
    const detail = vm.details[node.key];
    const group = relationsByChild.get(node.key);
    const relation = group
      ? [...group].sort((a, b) => RELATION_PRIORITY[a.attribution] - RELATION_PRIORITY[b.attribution])[0]
      : undefined;
    const isRoot = node.depth === 0 && node.identity.kind === 'session';
    const conflictName = node.conflict && node.conflict.count > 0 ? conflictGroupOf(node.key).name : null;
    const entry = cache.get(node.key);
    let proj: NodeProjection;
    if (
      entry &&
      entry.node === node &&
      entry.detail === detail &&
      entry.relation === relation &&
      entry.conflictName === conflictName
    ) {
      proj = entry.proj;
      entry.seen = generation;
      cache.hits++;
    } else {
      const facts = nodeFacts(node, detail, relation, isRoot, conflictName);
      if (entry && factsEqual(entry.facts, facts)) {
        proj = entry.proj;
        entry.node = node;
        entry.detail = detail;
        entry.relation = relation;
        entry.conflictName = conflictName;
        entry.seen = generation;
        cache.hits++;
      } else {
        cache.misses++;
        proj = buildProjection(facts);
        cache.set(node.key, { node, detail, relation, conflictName, facts, proj, seen: generation });
      }
    }
    const pn: PNode = {
      node,
      relation,
      key: node.key,
      proj,
      parent: null,
      children: [],
      depth: node.depth,
      childrenUnknown: unknownChildren.has(node.key),
      sub: leafSubtree(proj),
      index: nodes.length,
    };
    nodes.push(pn);
    byKey.set(node.key, pn);
    if (proj.harness && node.identity.kind !== 'delegationIntent') harnesses.add(proj.harness);
  }
  cache.sweep();

  // Conflict relations whose parent is drawn get a row of their own (§3.6), inside the same node budget as
  // everything else; the ones that do not fit are counted (once per child) and reported, not drawn.
  const conflictKeys = new Set<string>();
  for (const pn of nodes) if (pn.proj.marker.glyph === 'warn') conflictKeys.add(pn.key);
  const drawn = nodes.length;
  const omitted: LinkRelationProjection[] = [];
  for (const relation of tree.relations) {
    if (relation.attribution !== 'conflict' || relation.parentKey === null) continue;
    const parent = byKey.get(relation.parentKey);
    if (!parent) continue;
    if (nodes.length >= MAX_PROJECTED_NODES) {
      omitted.push(relation);
      continue;
    }
    const info = conflictGroupOf(relation.childKey);
    const synthetic = syntheticConflictRow(relation, parent, nodes.length, info);
    nodes.push(synthetic);
    conflictKeys.add(relation.childKey);
    // A drawn row is a harness mark on the screen: a tree that shows a second harness is cross-harness (§3.4).
    if (info.harness) harnesses.add(info.harness);
  }

  for (let i = 0; i < nodes.length; i++) {
    const pn = nodes[i];
    const parentKey = pn.node ? pn.node.parentKey : (pn.relation?.parentKey ?? null);
    const parent = parentKey !== null ? byKey.get(parentKey) : undefined;
    if (parent) {
      pn.parent = parent;
      parent.children.push(pn);
    }
  }

  // Children come after parents in the node list, so one reverse sweep is a post-order pass (§6 #10).
  for (let i = nodes.length - 1; i >= 0; i--) {
    const pn = nodes[i];
    const sub = pn.sub;
    let youngest = sub.allFinished ? sub.youngestFinish : null;
    for (const child of pn.children) {
      const cs = child.sub;
      sub.total += 1 + cs.total;
      for (const glyph of GLYPHS) sub.below[glyph] += cs.below[glyph];
      sub.below[child.proj.marker.glyph] += 1;
      if (cs.rank < sub.rank) {
        sub.rank = cs.rank;
        sub.sortAt = cs.sortAt;
      } else if (cs.rank === sub.rank && sub.rank === 0 && cs.sortAt !== null)
        sub.sortAt = sub.sortAt === null ? cs.sortAt : Math.max(sub.sortAt, cs.sortAt);
      if (!cs.allFinished) sub.allFinished = false;
      else if (cs.youngestFinish !== null)
        youngest = youngest === null ? cs.youngestFinish : Math.max(youngest, cs.youngestFinish);
    }
    sub.youngestFinish = sub.allFinished ? youngest : null;
  }

  // `Agents` (and the summary row) count every node but the viewpoint root, natives, jobs and put-away history
  // included, by marker, with `■` counted as `✓` (§0.2, §1, §3.2). The statusline's `⧉` counts delegated workers
  // and jobs only (`delegatedCounts`, §5.3). One kind order on every surface (rulings B10b s1, Q11).
  const counts = emptyCounts();
  const delegatedCounts = emptyCounts();
  const backends: Backends = { codex: 0, pi: 0, jev: 0, claude: 0 };
  let toClose = 0;
  const counted = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const pn = nodes[i];
    if (pn.proj.isRoot) continue;
    const synthetic = i >= drawn;
    // A conflicting child counts once however many parents claim it (§3.3).
    if (synthetic) {
      if (counted.has(pn.relation!.childKey)) continue;
    }
    counted.add(synthetic ? pn.relation!.childKey : pn.key);
    const glyph = pn.proj.marker.glyph;
    counts[glyph]++;
    if (pn.proj.marker.closePane) toClose++;
    if (!pn.proj.isNative) {
      delegatedCounts[glyph]++;
      if (pn.proj.harness) backends[pn.proj.harness]++;
    }
  }

  // A conflict row that did not fit still counts: one `⚠` per child, however many claims were left out.
  for (const relation of omitted) {
    if (counted.has(relation.childKey)) continue;
    counted.add(relation.childKey);
    conflictKeys.add(relation.childKey);
    counts.warn++;
    delegatedCounts.warn++;
    const harness = conflictGroupOf(relation.childKey).harness;
    if (harness) backends[harness]++;
  }

  const sessions = nodes
    .slice(0, drawn)
    .filter((pn) => pn.node!.identity.kind === 'session')
    .map((pn) => {
      const ref = (pn.node!.identity as { ref: import('../../core/types/identity.js').SessionRef }).ref;
      const spent = pn.node!.observation?.spent.costUsd;
      const unknown: Metric<number> = { value: null, quality: 'unknown', source: 'none', asOf: 0 };
      return { ref, costUsd: spent ?? unknown };
    });
  // A render never throws: a session ref the identity check rejects leaves the sum unknown.
  let spend: CostTotal;
  try {
    spend = sumCostUsd(sessions);
  } catch {
    spend = {
      value: null,
      knownCount: 0,
      missingCount: sessions.length,
      coverage: 'partial',
      quality: 'unknown',
      isLowerBound: false,
    };
  }

  const roots = nodes.filter((pn) => pn.parent === null);
  roots.sort((a, b) => Number(!a.proj.isRoot) - Number(!b.proj.isRoot) || a.index - b.index);

  return {
    vm,
    nodes,
    byKey,
    roots,
    crossHarness: harnesses.size > 1,
    counts,
    delegatedCounts,
    backends,
    toClose,
    spend,
    conflictKeys,
    omittedConflictRows: omitted.length,
  };
}

function syntheticConflictRow(
  relation: LinkRelationProjection,
  parent: PNode,
  index: number,
  info: { name: string; harness: HarnessMark | null }
): PNode {
  const link = relation.link;
  const since = relation.conflict?.since ?? null;
  const proj: NodeProjection = {
    key: `conflict:${link.linkId}:${relation.parentKey}`,
    marker: {
      glyph: 'warn',
      role: 'warning',
      words: ['conflict'],
      rank: 0,
      trouble: true,
      fadesAfterMs: null,
      muteName: 'never',
      sinceMs: since,
      sinceBasis: 'observed',
      clock: { kind: 'dwell', at: since, approx: true },
      historyEligible: false,
      finishedAt: null,
      closePane: false,
      stopInPane: false,
      supervisorLost: false,
      alertWord: null,
      notLoaded: false,
      uncertain: false,
      stale: false,
    },
    // The session the records name, when they name one; the backend profile is only a hint.
    harness: info.harness,
    name: monitorText(info.name),
    headless: false,
    unconfirmed: true,
    isRoot: false,
    isNative: false,
    summary: null,
    reportAt: null,
    cancelRequestedAt: null,
    model: null,
    effort: null,
    contextPercent: null,
    createdAt: link.createdAt,
    paneLabel: null,
  };
  return {
    node: null,
    relation,
    key: proj.key,
    proj,
    parent,
    children: [],
    depth: parent.depth + 1,
    childrenUnknown: false,
    sub: leafSubtree(proj),
    index,
  };
}

/** `$3.40`, `≥$0.12`, `~$0.12`, or '' when nothing is known (§1 "树级累计花费"); `>=` in ASCII. */
export function spendText(total: CostTotal, ascii = false): string {
  if (total.value === null || total.knownCount === 0) return '';
  const amount = total.value >= 1000 ? `${(total.value / 1000).toFixed(1)}k` : total.value.toFixed(2);
  if (total.quality === 'estimated') return `~$${amount}`;
  return total.missingCount > 0 || total.coverage === 'partial' ? `${ascii ? '>=' : '≥'}$${amount}` : `$${amount}`;
}

import { canonicalJson } from '../canonical.js';
import { sameSessionRef, sessionRefKey } from '../identity.js';
import { displayNodeKey, runExecutionProjection } from '../observation.js';
import type { LedgerReadRun, LedgerReadSnapshot } from '../ledger-read.js';
import type { MergeInput } from '../status/merge.js';
import type { DisplayNodeIdentity, ObservationView } from '../types/observation.js';
import { linkExecution } from './execution.js';
import { linkTreeBudget } from './budget.js';
import { combineConflicts, ledgerConflicts } from './conflicts.js';
import { projectLinkHost } from './host.js';
import { verifyLinkEvidence } from './verify.js';
import type {
  CollectedLinkSession,
  LinkConflict,
  LinkContinuation,
  LinkRelationProjection,
  LinkTreeInput,
  LinkTreeNode,
  LinkTreeProjection,
} from './types.js';

export * from './types.js';
export { LINK_TREE_LIMITS } from './budget.js';
export { linkEvidenceKey } from './evidence-key.js';
export { planLinkRead } from './read-plan.js';

const sessionIdentity = (ref: import('../types/identity.js').SessionRef): DisplayNodeIdentity => ({
  kind: 'session',
  ref,
});
const intentIdentity = (linkId: string): DisplayNodeIdentity => ({ kind: 'delegationIntent', linkId });
const childIdentity = (link: LedgerReadSnapshot['links'][number]): DisplayNodeIdentity =>
  link.childRef && !['pending', 'claimed', 'failed'].includes(link.state)
    ? sessionIdentity(link.childRef)
    : intentIdentity(link.linkId);
const emptySnapshot: LedgerReadSnapshot = {
  ledgerId: '',
  asOfSeq: 0,
  links: [],
  runs: [],
  claims: [],
  bindings: [],
  reports: [],
  events: [],
  evidence: [],
  slots: [],
};
interface Edge {
  parent: string;
  child: string;
  kind: 'delegated' | 'native' | 'intent';
  records: string[];
  since: number;
  relation?: LinkRelationProjection;
  native?: LinkTreeNode['native'];
}

function topologyValid(session: CollectedLinkSession | undefined): boolean {
  return Boolean(
    session?.topology?.loaded &&
    session.topology.sourceGeneration === session.sourceGeneration &&
    sameSessionRef(session.topology.ref, session.evidence.ref)
  );
}
function topologyComplete(session: CollectedLinkSession | undefined): boolean {
  return (
    topologyValid(session) &&
    session!.topology!.coverage.state === 'complete' &&
    session!.topology!.coverage.gaps.length === 0
  );
}

function currentObservation(
  session: CollectedLinkSession | undefined,
  run: LedgerReadRun | null
): ObservationView | null {
  if (!session || !Number.isSafeInteger(session.sourceGeneration) || session.sourceGeneration < 1) return null;
  const view = session.evidence.observation;
  if (view.nodeIdentity.kind !== 'session' || !sameSessionRef(view.nodeIdentity.ref, session.evidence.ref)) return null;
  const stamp = view.statusProjection.observationStamp;
  if (
    stamp &&
    (!sameSessionRef(stamp.ref, session.evidence.ref) || stamp.sourceGeneration !== session.sourceGeneration)
  )
    return null;
  if (run) {
    if (!stamp || stamp.runId !== run.runId || stamp.bindingGeneration !== run.expectedGeneration) return null;
  } else if (stamp?.runId !== undefined || stamp?.bindingGeneration !== undefined || view.currentRun) return null;
  return view;
}

/** A process-local sample may accompany only the exact committed current observation. */
export function committedReaderRate(
  session: CollectedLinkSession | undefined,
  observation: ObservationView | null,
  nowMs: number,
  ledgerAvailable: boolean
) {
  if (!session || !observation || observation.nodeIdentity.kind !== 'session') return undefined;
  try {
    if (!sameSessionRef(session.evidence.ref, observation.nodeIdentity.ref)) return undefined;
  } catch {
    return undefined;
  }
  const receipt = session?.committedRate;
  const stamp = observation?.statusProjection.observationStamp;
  const rate = receipt?.rate;
  if (!stamp || stamp.sourceGeneration !== session.sourceGeneration) return undefined;
  try {
    if (!sameSessionRef(stamp.ref, session.evidence.ref)) return undefined;
  } catch {
    return undefined;
  }
  return ledgerAvailable &&
    session?.loaded &&
    session.committedOnly &&
    stamp &&
    receipt &&
    canonicalJson(stamp) === canonicalJson(receipt.stamp) &&
    rate?.source === 'codex.turn_wallclock_proxy' &&
    Number.isFinite(rate.tokensPerSecond) &&
    rate.tokensPerSecond >= 0 &&
    Number.isFinite(rate.sampleMs) &&
    rate.sampleMs > 0 &&
    Number.isFinite(rate.sampledAt) &&
    rate.sampledAt >= 0 &&
    rate.sampledAt <= nowMs
    ? rate
    : undefined;
}

/** A native action follows the same exact committed identity and stamp rules as the rate. */
export function committedReaderAction(
  session: CollectedLinkSession | undefined,
  observation: ObservationView | null,
  nowMs: number,
  ledgerAvailable: boolean
) {
  const receipt = session?.committedAction;
  if (
    !receipt ||
    !session ||
    !observation ||
    observation.nodeIdentity.kind !== 'session' ||
    !ledgerAvailable ||
    !session.loaded ||
    !session.committedOnly
  )
    return undefined;
  const stamp = observation.statusProjection.observationStamp;
  try {
    if (
      !stamp ||
      stamp.sourceGeneration !== session.sourceGeneration ||
      !sameSessionRef(session.evidence.ref, observation.nodeIdentity.ref) ||
      !sameSessionRef(stamp.ref, session.evidence.ref) ||
      canonicalJson(stamp) !== canonicalJson(receipt.stamp)
    )
      return undefined;
  } catch {
    return undefined;
  }
  const action = receipt.action;
  return action.name && Number.isFinite(action.startedAt) && action.startedAt >= 0 && action.startedAt <= nowMs
    ? action
    : undefined;
}

/** Pure entry point for B10 and B16. No reader, adapter, writer, clock or filesystem calls. */
export function projectLinkTree(input: LinkTreeInput): LinkTreeProjection {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new TypeError('invalid_link_clock');
  const limits = linkTreeBudget(input.budget);
  const available = input.ledger.state === 'available';
  const snapshot = input.ledger.state === 'available' ? input.ledger.snapshot : emptySnapshot;
  const verification = verifyLinkEvidence(
    snapshot,
    input.sessions,
    input.ledger.state === 'available' ? input.ledger.claimChecks : []
  );
  const conflicts = ledgerConflicts(
    snapshot,
    input.ledger.state === 'available' ? input.ledger.conflictTargets : undefined
  );
  for (const [id, conflict] of verification.conflicts)
    conflicts.set(id, combineConflicts(conflicts.get(id), conflict)!);
  const runs = new Map<string, LedgerReadRun>();
  for (const run of snapshot.runs) {
    const previous = runs.get(run.linkId);
    if (!previous || run.runSeq > previous.runSeq) runs.set(run.linkId, run);
  }
  const identities = new Map<string, DisplayNodeIdentity>();
  const addIdentity = (identity: DisplayNodeIdentity) => {
    const key = displayNodeKey(identity);
    identities.set(key, identity);
    return key;
  };
  const sessions = new Map<string, CollectedLinkSession>();
  const charged = new Set<CollectedLinkSession>();
  let bytesRead = 0,
    recordsRead = 0,
    costUnknown = false;
  const charge = (bytes: number, records: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(records) || records < 0) {
      costUnknown = true;
      return;
    }
    bytesRead += bytes;
    recordsRead += records;
  };
  for (const session of input.sessions) {
    if (charged.has(session)) continue;
    charged.add(session);
    charge(session.bytesRead, session.recordsRead);
    if (session.topology) charge(session.topology.bytesRead, session.topology.recordsRead);
    const key = addIdentity(sessionIdentity(session.evidence.ref));
    // Repeated envelope objects reuse the same observation; conflicting envelopes are unavailable, not newest-wins.
    const previous = sessions.get(key);
    if (!previous) sessions.set(key, session);
    else if (previous.evidence !== session.evidence) {
      sessions.set(key, { ...previous, loaded: false, linkEvidenceCurrent: false, topology: undefined });
    }
  }
  const selectionMap: Record<string, string> = { ...input.selectionMap };
  const relations: LinkRelationProjection[] = [];
  const edges: Edge[] = [];
  const runsByNode = new Map<string, LedgerReadRun>();
  for (const link of snapshot.links) {
    const identity = childIdentity(link);
    const child = addIdentity(identity);
    const parent = link.parentRef ? addIdentity(sessionIdentity(link.parentRef)) : null;
    const run = runs.get(link.linkId) ?? null;
    const confirmed =
      link.currentOwner &&
      ['bound', 'reported'].includes(link.state) &&
      link.parentRef !== null &&
      link.childRef !== null;
    const isIntent = identity.kind === 'delegationIntent';
    const conflict = conflicts.get(link.linkId) ?? null;
    let offline: LinkRelationProjection['parentOffline'] = null;
    for (const event of snapshot.events) {
      if (
        event.runId !== run?.runId ||
        event.linkId !== link.linkId ||
        event.kind !== 'parent.offline' ||
        typeof event.payload.since !== 'number' ||
        !Number.isFinite(event.payload.since) ||
        event.payload.since < 0
      )
        continue;
      if (!offline || event.seq > offline.seq)
        offline = { since: event.payload.since, seq: event.seq, orphanPolicy: run!.orphanPolicy };
    }
    const relation: LinkRelationProjection = {
      link,
      currentRun: run,
      parentKey: parent,
      childKey: child,
      attribution: conflict ? 'conflict' : confirmed ? 'confirmed' : isIntent ? 'intent' : 'history',
      verification: conflict
        ? 'conflict'
        : verification.corroborated.has(link.linkId)
          ? 'corroborated'
          : 'not_observed',
      conflict,
      parentOffline: offline,
      host: projectLinkHost(run, input.hosts ?? [], input.nowMs, Boolean(conflict)),
    };
    relations.push(relation);
    if (identity.kind === 'session') selectionMap[displayNodeKey(intentIdentity(link.linkId))] = child;
    if ((confirmed || isIntent) && run) runsByNode.set(child, run);
    if (parent && ((confirmed && !conflict) || isIntent))
      edges.push({
        parent,
        child,
        kind: isIntent ? 'intent' : 'delegated',
        records: [`link:${link.linkId}`],
        since: link.boundAt ?? link.createdAt,
        relation,
      });
  }
  for (const [parent, session] of sessions) {
    const topology = session.topology;
    if (!topologyValid(session)) continue;
    for (const ref of topology!.children) {
      const child = addIdentity(sessionIdentity(ref));
      edges.push({
        parent,
        child,
        kind: 'native',
        native: topology!.nativeMetadata?.[ref.sessionId] ?? { title: null, kind: null },
        records: [`native:${parent}:${child}`],
        since: session.evidence.observation.statusProjection.lastEvidenceAt ?? input.nowMs,
      });
    }
  }
  const byChild = new Map<string, Edge[]>();
  for (const edge of edges) {
    const group = byChild.get(edge.child) ?? [];
    group.push(edge);
    byChild.set(edge.child, group);
  }
  const nodeConflicts = new Map<string, LinkConflict>();
  for (const relation of relations)
    if (relation.conflict)
      nodeConflicts.set(relation.childKey, combineConflicts(nodeConflicts.get(relation.childKey), relation.conflict)!);
  const markConflict = (key: string, group: Edge[]) => {
    const ids = [...new Set(group.flatMap((edge) => edge.records))];
    const value = { count: ids.length, recordIds: ids, since: Math.min(...group.map((edge) => edge.since)) };
    nodeConflicts.set(key, combineConflicts(nodeConflicts.get(key), value)!);
    for (const edge of group)
      if (edge.relation) {
        edge.relation.attribution = 'conflict';
        edge.relation.verification = 'conflict';
        edge.relation.conflict = combineConflicts(edge.relation.conflict, value);
        edge.relation.host.currentState = null;
      }
  };
  const parents = new Map<string, Edge>();
  for (const [child, group] of byChild) {
    if (new Set(group.map((edge) => edge.parent)).size > 1) {
      markConflict(child, group);
      continue;
    }
    // An identical native/ledger edge is one edge, with the stronger ledger metadata retained.
    const edge = group.find((value) => value.kind !== 'native') ?? group[0];
    if (edge.parent === child) {
      markConflict(child, group);
      continue;
    }
    if (!nodeConflicts.has(child)) parents.set(child, edge);
  }
  // Each child has at most one parent now; detect entire cycles before queue order can choose attribution.
  const finished = new Set<string>();
  for (const start of parents.keys()) {
    if (finished.has(start)) continue;
    const path: string[] = [],
      seen = new Map<string, number>();
    let key: string | undefined = start;
    while (key !== undefined && parents.has(key) && !finished.has(key)) {
      const cycleStart = seen.get(key);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const cycleEdges = cycle.map((child) => parents.get(child)!);
        for (const child of cycle) {
          markConflict(child, cycleEdges);
          parents.delete(child);
        }
        break;
      }
      seen.set(key, path.length);
      path.push(key);
      key = parents.get(key)?.parent;
    }
    for (const child of path) finished.add(child);
  }
  const children = new Map<string, Edge[]>();
  for (const edge of parents.values()) {
    const group = children.get(edge.parent) ?? [];
    group.push(edge);
    children.set(edge.parent, group);
  }
  for (const group of children.values()) group.sort((a, b) => a.child.localeCompare(b.child));
  const registeredIntents = new Set(
    relations
      .filter((relation) => relation.currentRun && relation.attribution === 'intent')
      .map((relation) => relation.childKey)
  );
  const rootKeys = input.roots
    .filter((identity) => identity.kind !== 'delegationIntent' || registeredIntents.has(displayNodeKey(identity)))
    .map(addIdentity);
  if (!rootKeys.length) {
    for (const relation of relations) {
      if (relation.attribution === 'confirmed' || relation.attribution === 'intent')
        rootKeys.push(relation.parentKey ?? relation.childKey);
    }
  } else
    for (const relation of relations) {
      if (!relation.parentKey && relation.attribution === 'intent') rootKeys.push(relation.childKey);
    }
  const selectedRoots = new Set(rootKeys);
  const topRoots = [...selectedRoots].filter((root) => {
    let cursor = parents.get(root)?.parent;
    while (cursor !== undefined) {
      if (selectedRoots.has(cursor)) return false;
      cursor = parents.get(cursor)?.parent;
    }
    return true;
  });
  const queue = topRoots
    .sort()
    .map((key) => ({ key, parentKey: null as string | null, depth: 0, cross: 0, edge: null as Edge | null }));
  const visited = new Set<string>(),
    deferred = new Map<string, LinkContinuation>();
  const nodes: LinkTreeNode[] = [];
  const overspent = costUnknown || bytesRead > limits.maxBytes;
  let unknownDescendants = false;
  const defer = (key: string, reason: LinkContinuation['reason']) => {
    if (!deferred.has(key)) deferred.set(key, { key, identity: identities.get(key)!, reason });
  };
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (visited.has(item.key)) continue;
    visited.add(item.key);
    if (nodes.length >= limits.maxNodes) {
      defer(item.key, 'nodes');
      continue;
    }
    const identity = identities.get(item.key)!;
    const session = sessions.get(item.key);
    const crossExceeded = item.cross > limits.maxCrossHarnessDepth;
    const loaded =
      identity.kind === 'delegationIntent' ||
      (identity.kind === 'session' && Boolean(session?.loaded) && !crossExceeded && !overspent);
    const reason = crossExceeded ? 'depth' : overspent ? 'bytes' : 'unloaded';
    if (!loaded) defer(item.key, reason);
    const run = nodeConflicts.has(item.key) ? null : (runsByNode.get(item.key) ?? null);
    const nodeRelations = relations.filter((relation) => relation.childKey === item.key);
    const currentRelation = nodeRelations.find(
      (relation) => relation.attribution === 'confirmed' || relation.attribution === 'intent'
    );
    const observation = loaded && !nodeConflicts.has(item.key) ? currentObservation(session, run) : null;
    const committedRate = committedReaderRate(session, observation, input.nowMs, available);
    const committedAction = committedReaderAction(session, observation, input.nowMs, available);
    const coverage = session?.evidence.observation.coverage;
    nodes.push({
      identity,
      key: item.key,
      parentKey: item.parentKey,
      edge: item.edge?.kind ?? null,
      native: item.edge?.kind === 'native' ? (item.edge.native ?? { title: null, kind: null }) : null,
      depth: item.depth,
      crossHarnessDepth: item.cross,
      loaded,
      coverage: {
        state: !loaded
          ? 'partial'
          : (coverage?.state ?? (identity.kind === 'delegationIntent' ? 'complete' : 'partial')),
        skipped: { ...coverage?.skipped },
        gaps: [...(coverage?.gaps ?? [])],
        loaded,
        ...(!loaded ? { reason } : {}),
      },
      observation,
      ...(committedRate ? { committedRate } : {}),
      ...(committedAction ? { committedAction } : {}),
      lastObservation: session?.committedOnly
        ? (session.lastCommitted ?? null)
        : (session?.evidence.observation ?? null),
      currentRun: run,
      execution: linkExecution(run, snapshot.events),
      conflict: nodeConflicts.get(item.key) ?? null,
      links: nodeRelations.map((relation) => relation.link.linkId),
      host: currentRelation?.host ?? null,
      parent: null,
    });
    if (!loaded || identity.kind !== 'session') {
      if (identity.kind === 'session') {
        unknownDescendants = true;
        // In the unscoped panel, a missing native observation must not hide
        // delegation relationships already established by the ledger. Native
        // topology remains unavailable until its source is loaded.
        if (!crossExceeded)
          for (const edge of children.get(item.key) ?? []) {
            if (visited.has(edge.child)) continue;
            if (!input.roots.length && !overspent && edge.kind !== 'native') {
              const child = identities.get(edge.child)!;
              const cross =
                item.cross + (child.kind === 'session' && child.ref.harness !== identity.ref.harness ? 1 : 0);
              queue.push({ key: edge.child, parentKey: item.key, depth: item.depth + 1, cross, edge });
            } else defer(edge.child, reason);
          }
      }
      continue;
    }
    if (!topologyComplete(session)) {
      unknownDescendants = true;
      defer(item.key, 'native_topology');
    }
    for (const edge of children.get(item.key) ?? []) {
      const child = identities.get(edge.child)!;
      const cross = item.cross + (child.kind === 'session' && child.ref.harness !== identity.ref.harness ? 1 : 0);
      queue.push({ key: edge.child, parentKey: item.key, depth: item.depth + 1, cross, edge });
    }
  }
  const nodeMap = new Map(nodes.map((node) => [node.key, node]));
  // Count all already-known reachable identities, independently of the bounded rendered frontier.
  // This walks metadata only; it neither reads nor admits an omitted node's body.
  const known = new Set<string>();
  const knownQueue = [...topRoots];
  for (let index = 0; index < knownQueue.length; index++) {
    const key = knownQueue[index];
    if (known.has(key)) continue;
    known.add(key);
    for (const edge of children.get(key) ?? []) knownQueue.push(edge.child);
    const identity = identities.get(key)!;
    const session = sessions.get(key);
    if (identity.kind === 'session' && !topologyComplete(session)) unknownDescendants = true;
  }
  const knownOmitted = [...known].filter((key) => !nodeMap.has(key)).length;
  for (const node of nodes) {
    const parent = node.parentKey ? nodeMap.get(node.parentKey) : undefined;
    if (!parent) continue;
    const label =
      relations.find((relation) => relation.childKey === parent.key && relation.attribution === 'confirmed')?.link
        .label ?? null;
    node.parent = {
      identity: parent.identity,
      harness: parent.identity.kind === 'session' ? parent.identity.ref.harness : null,
      name: label,
      liveness: parent.observation?.statusProjection.liveness ?? 'unknown',
      paneLabel: typeof parent.host?.currentState?.label === 'string' ? parent.host.currentState.label : null,
    };
  }
  // Compose old intent mappings even when its row disappeared after binding; mappings never create edges.
  for (const key of Object.keys(selectionMap)) {
    const seen = new Set([key]);
    let target = selectionMap[key];
    while (selectionMap[target] && !seen.has(target)) {
      seen.add(target);
      target = selectionMap[target];
    }
    if (!seen.has(target)) selectionMap[key] = target;
    else delete selectionMap[key];
  }
  const candidates = new Map<string, LinkTreeProjection['candidates'][number]>();
  for (const hint of input.candidates ?? [])
    candidates.set(canonicalJson([hint.recordId, hint.ref, hint.linkId]), { ...hint, reason: 'candidate_only' });
  for (const hint of verification.candidates)
    candidates.set(canonicalJson([hint.recordId, hint.ref, hint.linkId]), hint);
  let conflictRecordsTruncated = 0;
  const boundedConflict = (value: LinkConflict | null): LinkConflict | null => {
    if (!value) return null;
    conflictRecordsTruncated += Math.max(0, value.count - Math.min(200, value.recordIds.length));
    return { ...value, recordIds: value.recordIds.slice(0, 200) };
  };
  for (const node of nodes) node.conflict = boundedConflict(node.conflict);
  for (const relation of relations) relation.conflict = boundedConflict(relation.conflict);
  const allCandidates = [...candidates.values()].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const allDeferred = [...deferred.values()];
  const partial =
    !available ||
    overspent ||
    deferred.size > 0 ||
    unknownDescendants ||
    nodes.some((node) => node.coverage.state !== 'complete' || node.coverage.gaps.length > 0);
  return {
    ledger: {
      state: input.ledger.state,
      ledgerId: available ? snapshot.ledgerId : null,
      asOfSeq: available ? snapshot.asOfSeq : null,
      reason: input.ledger.reason,
    },
    nodes,
    relations,
    candidates: allCandidates.slice(0, 200),
    selectionMap,
    continuation: allDeferred.slice(0, 200),
    truncation: {
      candidates: verification.omittedCandidates + Math.max(0, allCandidates.length - 200),
      conflictRecords: conflictRecordsTruncated,
      continuation: Math.max(0, allDeferred.length - 200),
    },
    counts: {
      confirmedSessions: nodes.filter((node) => node.identity.kind === 'session').length,
      delegationIntents: nodes.filter((node) => node.identity.kind === 'delegationIntent').length,
      jobs: nodes.filter((node) => node.identity.kind === 'job').length,
      knownUnloaded: knownOmitted + nodes.filter((node) => !node.loaded).length,
      omitted: knownOmitted,
      unknownDescendants,
    },
    io: {
      bytesRead: costUnknown ? null : bytesRead,
      recordsRead: costUnknown ? null : recordsRead,
      remainingBytes: costUnknown ? 0 : Math.max(0, limits.maxBytes - bytesRead),
      exceeded: overspent,
    },
    coverage: {
      state: partial ? 'partial' : 'complete',
      skipped: {},
      gaps: costUnknown ? ['collection_cost_unknown'] : [],
      loaded: !partial,
      ...(partial
        ? {
            reason: !available
              ? (input.ledger.reason ?? 'ledger_unavailable')
              : overspent
                ? 'collection_budget_exceeded'
                : 'tree_incomplete',
          }
        : {}),
    },
  };
}

/** B16 supplies its exact target, raw facts, compatible stamp and continuity; this is only the relationship fragment. */
export function linkStatusInput(
  tree: LinkTreeProjection,
  key: string
): Pick<MergeInput, 'asOfSeq' | 'link' | 'conflict'> {
  const node = tree.nodes.find((value) => value.key === key);
  const relation = tree.relations.find((value) => value.childKey === key && value.attribution !== 'history');
  return { asOfSeq: tree.ledger.asOfSeq, link: relation?.link, conflict: node?.conflict ?? relation?.conflict ?? null };
}

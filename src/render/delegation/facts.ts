/**
 * The facts one node's projection is made of (design §6 #2): the single list
 * of everything the marker, the name, the harness and the badge facts read
 * from the view model, as plain values.
 *
 * The marker (`marker.ts`) and the node projection (`projection.ts`) read
 * *only* this object, never the node, its details or its relation. The cache
 * key is this object (`factsEqual`: every field, by value), so what a
 * projection reads and what invalidates it cannot drift apart: a field added
 * here is read and keyed in the same stroke, and a field read from anywhere
 * else would be a type error. `tests/unit/b10b-cache.test.ts` changes each
 * fact in turn and compares a warm projection with a cold one.
 */

import type { LinkRelationProjection, LinkTreeNode } from '../../core/link/types.js';
import type { DelegationNodeDetails } from '../../core/link/view-model.js';
import type { DisplayNodeIdentity } from '../../core/types/observation.js';
import type { HarnessMark } from './glyphs.js';

export type Fact = string | number | boolean | null;

export interface NodeFacts {
  // Identity.
  key: string;
  idKind: DisplayNodeIdentity['kind'];
  /** The session's harness; null for a job and for an intent that has no session yet. */
  idHarness: HarnessMark | null;
  /** `codex:51aa`, the job key's head or the link id's head: the name of last resort (§3.4). */
  shortRef: string;
  isRoot: boolean;
  edge: string | null;
  loaded: boolean;
  conflictCount: number;
  conflictSince: number | null;
  /** The shared label of the conflicting records, or their child's short form; null with no conflict (§3.4). */
  conflictName: string | null;
  /** `pane 4`, only from a verified host state (§1). */
  paneLabel: string | null;

  // The observation.
  evidenceStamp: string | null;
  model: string | null;
  effort: string | null;
  contextPercent: number | null;

  // The ledger's run.
  runId: string | null;
  runState: string | null;
  runMode: string | null;
  runCreatedAt: number | null;
  runEndedAt: number | null;
  runCancelRequestedAt: number | null;
  runHeartbeatAt: number | null;
  runExitSource: string | null;
  runExitCode: number | null;
  runExitSignal: string | null;

  // What the execution projection says of the run.
  isRunTerminal: boolean | null;
  reconciliationCause: string | null;
  requestedCause: string | null;
  launchFailed: boolean;

  // The current relation (label, role, link state, backend, child).
  linkId: string | null;
  linkState: string | null;
  linkLabel: string | null;
  linkRole: string | null;
  linkBackend: string | null;
  linkCreatedAt: number | null;
  /** The harness of `link.childRef`, when the link names its child. */
  childHarness: HarnessMark | null;

  // The status the observation published.
  observationUnavailableReason: string | null;
  hasStatus: boolean;
  statusAsOfSeq: number | null;
  commitSeq: number | null;
  stateKey: string | null;
  stateSince: number | null;
  stateSinceBasis: string | null;
  freshnessState: string | null;
  freshnessReason: string | null;
  clockAnomaly: boolean;
  liveness: string | null;
  activity: string | null;
  pendingReason: string | null;
  lastTurnOutcome: string | null;
  lastEvidenceAt: number | null;

  // The report of this run.
  reportId: string | null;
  reportStatus: string | null;
  reportCreatedAt: number | null;
  reportSummary: string | null;
}

const SHORT_ID = /[0-9A-Za-z]/g;

/** The short form of a node's identity (§3.4): `codex:51aa`, a job key's head, an intent's link id head. */
export function shortRefOf(identity: DisplayNodeIdentity): string {
  if (identity.kind === 'session') {
    const alnum = identity.ref.sessionId.match(SHORT_ID);
    return `${identity.ref.harness}:${(alnum ?? []).slice(0, 4).join('')}`;
  }
  if (identity.kind === 'job') return identity.ref.key.slice(0, 12);
  return identity.linkId.slice(0, 8);
}

/** A usable metric value: reported or estimated, never `unknown` and never empty. */
function metric<T>(m: { quality: string; value: T | null } | null | undefined): T | null {
  return m && m.quality !== 'unknown' && m.value !== null && m.value !== undefined ? m.value : null;
}

/**
 * Every fact a projection reads. `conflictName` is derived from the whole conflict group of the child, which
 * the caller holds (§3.4): it is a fact of this node's projection like the others.
 */
export function nodeFacts(
  node: LinkTreeNode,
  detail: DelegationNodeDetails | undefined,
  relation: LinkRelationProjection | undefined,
  isRoot: boolean,
  conflictName: string | null
): NodeFacts {
  const status = detail?.status ?? null;
  const run = node.currentRun;
  const exec = node.execution;
  const report = detail?.latestReportForRun ?? null;
  const observation = node.observation;
  const link = relation?.link;
  const host = node.host?.currentState;
  const context = metric(observation?.context);
  return {
    key: node.key,
    idKind: node.identity.kind,
    idHarness: node.identity.kind === 'session' ? node.identity.ref.harness : null,
    shortRef: shortRefOf(node.identity),
    isRoot,
    edge: node.edge ?? null,
    loaded: node.loaded,
    conflictCount: node.conflict?.count ?? 0,
    conflictSince: node.conflict?.since ?? null,
    conflictName,
    paneLabel: host && typeof host.label === 'string' ? host.label : null,

    evidenceStamp: observation?.evidenceStamp ?? null,
    model: metric(observation?.model),
    effort: metric(observation?.effort),
    contextPercent: context ? context.percent : null,

    runId: run?.runId ?? null,
    runState: run?.state ?? null,
    runMode: run?.mode ?? null,
    runCreatedAt: run?.createdAt ?? null,
    runEndedAt: run?.endedAt ?? null,
    runCancelRequestedAt: run?.cancelRequestedAt ?? null,
    runHeartbeatAt: run?.heartbeatAt ?? null,
    runExitSource: run?.exitSource ?? null,
    runExitCode: run?.exitCode ?? null,
    runExitSignal: run?.exitSignal ?? null,

    isRunTerminal: exec.isRunTerminal ?? null,
    reconciliationCause: exec.reconciliation?.cause ?? null,
    requestedCause: exec.terminal?.termination?.requestedCause ?? null,
    launchFailed: (exec.launchFailure ?? null) !== null,

    linkId: link?.linkId ?? null,
    linkState: link?.state ?? null,
    linkLabel: link?.label ?? null,
    linkRole: link?.role ?? null,
    linkBackend: link?.backend ?? null,
    linkCreatedAt: link?.createdAt ?? null,
    childHarness: link?.childRef?.harness ?? null,

    observationUnavailableReason: detail?.observationUnavailableReason ?? null,
    hasStatus: status !== null,
    statusAsOfSeq: status?.asOfSeq ?? null,
    commitSeq: status?.observationStamp?.commitSeq ?? null,
    stateKey: status?.stateKey ?? null,
    stateSince: status?.stateSince ?? null,
    stateSinceBasis: status?.stateSinceBasis ?? null,
    freshnessState: status?.freshness?.state ?? null,
    freshnessReason: status?.freshness?.reason ?? null,
    clockAnomaly: status?.freshness?.clockAnomaly === true,
    liveness: status?.liveness ?? null,
    activity: status?.activity ?? null,
    pendingReason: status?.pendingReason ?? null,
    lastTurnOutcome: status?.lastTurnOutcome ?? null,
    lastEvidenceAt: status?.lastEvidenceAt ?? null,

    reportId: report?.reportId ?? null,
    reportStatus: report?.status ?? null,
    reportCreatedAt: report?.createdAt ?? null,
    reportSummary: report?.summary ?? null,
  };
}

/**
 * Whether two nodes' facts are the same, field by field. Every fact is a primitive, so `!==` is exact; the keys
 * are those of the one constructor, in its one order, and are read once.
 */
let factKeys: ReadonlyArray<keyof NodeFacts> | null = null;
export function factsEqual(a: NodeFacts, b: NodeFacts): boolean {
  const keys = (factKeys ??= Object.keys(a) as Array<keyof NodeFacts>);
  for (let i = 0; i < keys.length; i++) if (a[keys[i]] !== b[keys[i]]) return false;
  return true;
}

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
import type { AgentTaskKind } from '../../types.js';
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
  /** A native child's display name and kind of work (`LinkTreeNode.native`, §7 #33); null when absent. */
  nativeTitle: string | null;
  nativeKind: AgentTaskKind | null;

  // The observation.
  evidenceStamp: string | null;
  /** `spent.costUsd`, when reported or estimated (§1 "花费"). */
  costValue: number | null;
  costQuality: string | null;
  /** The observed workspace (§1 "工作目录 / 工作树"), for the delegation line's `in <dir>`. */
  worktreeRoot: string | null;
  worktreeName: string | null;
  workspaceCwd: string | null;
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
  runSeq: number | null;

  // What the execution projection says of the run.
  isRunTerminal: boolean | null;
  reconciliationCause: string | null;
  requestedCause: string | null;
  launchFailed: boolean;
  /** `reconciliation.missing`, joined by U+0001 (a primitive, so the facts compare by value). */
  reconciliationMissing: string | null;
  terminalNote: string | null;

  // The current relation (label, role, link state, backend, child).
  linkId: string | null;
  linkState: string | null;
  linkLabel: string | null;
  linkRole: string | null;
  linkBackend: string | null;
  linkCreatedAt: number | null;
  linkBoundAt: number | null;
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
    nativeTitle: node.edge === 'native' && typeof node.native?.title === 'string' ? node.native.title : null,
    nativeKind: node.edge === 'native' ? (node.native?.kind ?? null) : null,

    evidenceStamp: observation?.evidenceStamp ?? null,
    costValue: metric(observation?.spent?.costUsd),
    costQuality: metric(observation?.spent?.costUsd) !== null ? (observation?.spent?.costUsd.quality ?? null) : null,
    worktreeRoot: observation?.workspace?.worktreeRoot ?? null,
    worktreeName: observation?.workspace?.worktree ?? null,
    workspaceCwd: observation?.workspace?.cwd ?? null,
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
    runSeq: typeof run?.runSeq === 'number' ? run.runSeq : null,

    isRunTerminal: exec.isRunTerminal ?? null,
    reconciliationCause: exec.reconciliation?.cause ?? null,
    requestedCause: exec.terminal?.termination?.requestedCause ?? null,
    launchFailed: (exec.launchFailure ?? null) !== null,
    reconciliationMissing: exec.reconciliation ? exec.reconciliation.missing.join('\u0001') : null,
    terminalNote: exec.terminal?.note ?? null,

    linkId: link?.linkId ?? null,
    linkState: link?.state ?? null,
    linkLabel: link?.label ?? null,
    linkRole: link?.role ?? null,
    linkBackend: link?.backend ?? null,
    linkCreatedAt: link?.createdAt ?? null,
    linkBoundAt: link?.boundAt ?? null,
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
let compare: ((a: NodeFacts, b: NodeFacts) => boolean) | null = null;
export function factsEqual(a: NodeFacts, b: NodeFacts): boolean {
  // One straight-line comparison of every field, built once from the constructor's own keys: a loop of keyed
  // loads over sixty names is the hot spot of a changed tick, where every node of a fresh tree is compared (B10B-s2
  // review F1). The keys are this module's own identifiers, never input.
  compare ??= comparatorFor(Object.keys(a) as Array<keyof NodeFacts>);
  return compare(a, b);
}

function comparatorFor(keys: ReadonlyArray<keyof NodeFacts>): (a: NodeFacts, b: NodeFacts) => boolean {
  if (!keys.every((key) => /^[A-Za-z]+$/.test(key))) throw new Error('fact names are identifiers');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('a', 'b', `return ${keys.map((key) => `a.${key} === b.${key}`).join(' && ')};`) as (
    a: NodeFacts,
    b: NodeFacts
  ) => boolean;
}

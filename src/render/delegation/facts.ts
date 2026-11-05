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

  // A native action from this observation's committed display receipt, never raw reader evidence.
  actionId: string | null;
  actionName: string | null;
  actionTarget: string | null;
  actionStartedAt: number | null;
  actionSource: string | null;
  actionAsOf: number | null;

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

/** A fresh fixed-shape record, private until the complete extraction below fills every field. */
export function newNodeFacts(): NodeFacts {
  return {
    key: '',
    idKind: 'session',
    idHarness: null,
    shortRef: '',
    isRoot: false,
    edge: null,
    loaded: false,
    conflictCount: 0,
    conflictSince: null,
    conflictName: null,
    paneLabel: null,
    nativeTitle: null,
    nativeKind: null,
    evidenceStamp: null,
    costValue: null,
    costQuality: null,
    worktreeRoot: null,
    worktreeName: null,
    workspaceCwd: null,
    model: null,
    effort: null,
    contextPercent: null,
    actionId: null,
    actionName: null,
    actionTarget: null,
    actionStartedAt: null,
    actionSource: null,
    actionAsOf: null,
    runId: null,
    runState: null,
    runMode: null,
    runCreatedAt: null,
    runEndedAt: null,
    runCancelRequestedAt: null,
    runHeartbeatAt: null,
    runExitSource: null,
    runExitCode: null,
    runExitSignal: null,
    runSeq: null,
    isRunTerminal: null,
    reconciliationCause: null,
    requestedCause: null,
    launchFailed: false,
    reconciliationMissing: null,
    terminalNote: null,
    linkId: null,
    linkState: null,
    linkLabel: null,
    linkRole: null,
    linkBackend: null,
    linkCreatedAt: null,
    linkBoundAt: null,
    childHarness: null,
    observationUnavailableReason: null,
    hasStatus: false,
    statusAsOfSeq: null,
    commitSeq: null,
    stateKey: null,
    stateSince: null,
    stateSinceBasis: null,
    freshnessState: null,
    freshnessReason: null,
    clockAnomaly: false,
    liveness: null,
    activity: null,
    pendingReason: null,
    lastTurnOutcome: null,
    lastEvidenceAt: null,
    reportId: null,
    reportStatus: null,
    reportCreatedAt: null,
    reportSummary: null,
  };
}

/**
 * Every fact a projection reads. `conflictName` is derived from the whole conflict group of the child, which
 * the caller holds (§3.4): it is a fact of this node's projection like the others.
 * An opt-in buffer must be exclusively owned by the caller; every field is overwritten.
 * Without it, each call returns a fresh independent record.
 */
export function nodeFacts(
  node: LinkTreeNode,
  detail: DelegationNodeDetails | undefined,
  relation: LinkRelationProjection | undefined,
  isRoot: boolean,
  conflictName: string | null,
  buffer?: NodeFacts,
  ledgerAvailable = true
): NodeFacts {
  const status = detail?.status ?? null;
  const run = node.currentRun;
  const exec = node.execution;
  const report = detail?.latestReportForRun ?? null;
  const observation = node.observation;
  const link = relation?.link;
  const host = node.host?.currentState;
  const context = metric(observation?.context);
  const facts = buffer ?? newNodeFacts();

  facts.key = node.key;
  facts.idKind = node.identity.kind;
  facts.idHarness = node.identity.kind === 'session' ? node.identity.ref.harness : null;
  facts.shortRef = shortRefOf(node.identity);
  facts.isRoot = isRoot;
  facts.edge = node.edge ?? null;
  facts.loaded = node.loaded;
  facts.conflictCount = node.conflict?.count ?? 0;
  facts.conflictSince = node.conflict?.since ?? null;
  facts.conflictName = conflictName;
  facts.paneLabel = host && typeof host.label === 'string' ? host.label : null;
  facts.nativeTitle = node.edge === 'native' && typeof node.native?.title === 'string' ? node.native.title : null;
  facts.nativeKind = node.edge === 'native' ? (node.native?.kind ?? null) : null;

  facts.evidenceStamp = observation?.evidenceStamp ?? null;
  facts.costValue = metric(observation?.spent?.costUsd);
  facts.costQuality =
    metric(observation?.spent?.costUsd) !== null ? (observation?.spent?.costUsd.quality ?? null) : null;
  facts.worktreeRoot = observation?.workspace?.worktreeRoot ?? null;
  facts.worktreeName = observation?.workspace?.worktree ?? null;
  facts.workspaceCwd = observation?.workspace?.cwd ?? null;
  facts.model = metric(observation?.model);
  facts.effort = metric(observation?.effort);
  facts.contextPercent = context ? context.percent : null;

  const candidate =
    ledgerAvailable && node.loaded && observation && !detail?.observationUnavailableReason ? detail?.action : undefined;
  // Use the committed status boundary, not the paint clock: action-row presence must stay stable for a
  // projection (rich-card heights are memoized by projection identity).
  const observedAt = status?.observedAt ?? -1;
  const action =
    candidate &&
    Number.isFinite(observedAt) &&
    Number.isFinite(candidate.startedAt) &&
    candidate.startedAt >= 0 &&
    candidate.startedAt <= observedAt &&
    (candidate.source !== 'claude.background.last_confirmed' ||
      (typeof candidate.asOf === 'number' &&
        Number.isFinite(candidate.asOf) &&
        candidate.asOf >= candidate.startedAt &&
        candidate.asOf <= observedAt))
      ? candidate
      : undefined;
  facts.actionId = action?.id ?? null;
  facts.actionName = action?.name ?? null;
  facts.actionTarget = action?.target ?? null;
  facts.actionStartedAt = action?.startedAt ?? null;
  facts.actionSource = action?.source ?? null;
  facts.actionAsOf = action?.asOf ?? null;

  facts.runId = run?.runId ?? null;
  facts.runState = run?.state ?? null;
  facts.runMode = run?.mode ?? null;
  facts.runCreatedAt = run?.createdAt ?? null;
  facts.runEndedAt = run?.endedAt ?? null;
  facts.runCancelRequestedAt = run?.cancelRequestedAt ?? null;
  facts.runHeartbeatAt = run?.heartbeatAt ?? null;
  facts.runExitSource = run?.exitSource ?? null;
  facts.runExitCode = run?.exitCode ?? null;
  facts.runExitSignal = run?.exitSignal ?? null;
  facts.runSeq = typeof run?.runSeq === 'number' ? run.runSeq : null;

  facts.isRunTerminal = exec.isRunTerminal ?? null;
  facts.reconciliationCause = exec.reconciliation?.cause ?? null;
  facts.requestedCause = exec.terminal?.termination?.requestedCause ?? null;
  facts.launchFailed = (exec.launchFailure ?? null) !== null;
  facts.reconciliationMissing = exec.reconciliation ? exec.reconciliation.missing.join('\u0001') : null;
  facts.terminalNote = exec.terminal?.note ?? null;

  facts.linkId = link?.linkId ?? null;
  facts.linkState = link?.state ?? null;
  facts.linkLabel = link?.label ?? null;
  facts.linkRole = link?.role ?? null;
  facts.linkBackend = link?.backend ?? null;
  facts.linkCreatedAt = link?.createdAt ?? null;
  facts.linkBoundAt = link?.boundAt ?? null;
  facts.childHarness = link?.childRef?.harness ?? null;

  facts.observationUnavailableReason = detail?.observationUnavailableReason ?? null;
  facts.hasStatus = status !== null;
  facts.statusAsOfSeq = status?.asOfSeq ?? null;
  facts.commitSeq = status?.observationStamp?.commitSeq ?? null;
  facts.stateKey = status?.stateKey ?? null;
  facts.stateSince = status?.stateSince ?? null;
  facts.stateSinceBasis = status?.stateSinceBasis ?? null;
  facts.freshnessState = status?.freshness?.state ?? null;
  facts.freshnessReason = status?.freshness?.reason ?? null;
  facts.clockAnomaly = status?.freshness?.clockAnomaly === true;
  facts.liveness = status?.liveness ?? null;
  facts.activity = status?.activity ?? null;
  facts.pendingReason = status?.pendingReason ?? null;
  facts.lastTurnOutcome = status?.lastTurnOutcome ?? null;
  facts.lastEvidenceAt = status?.lastEvidenceAt ?? null;

  facts.reportId = report?.reportId ?? null;
  facts.reportStatus = report?.status ?? null;
  facts.reportCreatedAt = report?.createdAt ?? null;
  facts.reportSummary = report?.summary ?? null;
  return facts;
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
  compare ??= comparatorFor<NodeFacts>(Object.keys(a) as Array<keyof NodeFacts>);
  return compare(a, b);
}

/** A fact name is a plain JavaScript identifier: letters, digits, `_` and `$`, not starting with a digit. */
const FACT_NAME = /^[A-Za-z_$][\w$]*$/;

/** Exported for the test of the name guard; `factsEqual` is the one caller. */
export function comparatorFor<T extends object>(keys: ReadonlyArray<keyof T & string>): (a: T, b: T) => boolean {
  if (!keys.every((key) => FACT_NAME.test(key))) throw new Error('fact names are identifiers');
  return new Function('a', 'b', `return ${keys.map((key) => `a.${key} === b.${key}`).join(' && ')};`) as (
    a: T,
    b: T
  ) => boolean;
}

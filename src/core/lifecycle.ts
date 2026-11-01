import { digest, isCanonicalAbsolutePath, requireCanonicalAbsolutePath } from './canonical.js';
import { lookupIdempotency, isRunTerminal, validateRequestKey, validateRun } from './execution.js';
import { sameSessionRef, sessionOwnerKey, type ContextSelection } from './identity.js';
import type { ChildBinding, Claim, ControlInitiator, OwnerKey, SessionRef } from './types/identity.js';
import type { IdempotencyRecord, LedgerEvent, Run, RunMode } from './types/execution.js';
import type {
  ActionDescriptor,
  CommittedReport,
  FixedWait,
  Interaction,
  Link,
  Report,
  ResumePlan,
  RunHandshake,
  WaitPage,
  WaitUntil,
} from './types/lifecycle.js';
import type { ProjectOrigin, RunWorkspaceSnapshot } from './types/observation.js';

export type ControlAuthority =
  | { kind: 'mcp'; selection: ContextSelection }
  | {
      kind: 'local_user';
      uid: number;
      ownerUid: number;
      invocationId: string;
      hudHomeOwned: boolean;
      ledgerOwned: boolean;
      privatePaths: boolean;
    };
export type ControlAuthorization =
  { ok: true; actor: ControlInitiator; ownerKey: OwnerKey } | { ok: false; reason: string };
export function authorizeControl(
  operation: 'resume' | 'cancel' | 'predecessor' | 'report' | 'spawn',
  link: Link,
  registeredOwner: OwnerKey,
  authority: ControlAuthority
): ControlAuthorization {
  if (authority.kind === 'local_user') {
    if (operation !== 'resume') return { ok: false, reason: 'unsupported' };
    if (
      !Number.isSafeInteger(authority.uid) ||
      authority.uid < 0 ||
      authority.uid !== authority.ownerUid ||
      !authority.invocationId ||
      !authority.hudHomeOwned ||
      !authority.ledgerOwned ||
      !authority.privatePaths
    )
      return { ok: false, reason: 'unauthorized' };
    if (link.parentRef === null) return { ok: false, reason: 'parent_unconfirmed' };
    const ownerKey = sessionOwnerKey(link.parentRef);
    if (ownerKey !== registeredOwner) return { ok: false, reason: 'owner_mismatch' };
    return {
      ok: true,
      ownerKey,
      actor: {
        kind: 'local_user',
        uid: authority.uid,
        invocationId: authority.invocationId,
        representedOwner: ownerKey,
      },
    };
  }
  if (!authority.selection.ok) return { ok: false, reason: authority.selection.reason };
  if (link.parentRef !== null && sessionOwnerKey(link.parentRef) !== registeredOwner)
    return { ok: false, reason: 'owner_mismatch' };
  if (authority.selection.ownerKey !== registeredOwner)
    return { ok: false, reason: operation === 'predecessor' ? 'unsupported' : 'unauthorized' };
  const context = authority.selection.context;
  return {
    ok: true,
    ownerKey: authority.selection.ownerKey,
    actor: {
      kind: 'mcp',
      callerId: context.callerId,
      contextId: context.contextId,
      contextGeneration: context.generation,
    },
  };
}

export interface ResumeGateInput {
  link: Link;
  registeredOwner: OwnerKey;
  authority: ControlAuthority;
  currentRun: Run;
  expectedRun: string;
  taskDigest: string;
  slotHeld: boolean;
  unresolvedConflict: boolean;
  capabilityVerified: boolean;
}
export function resumeGate(input: ResumeGateInput): ControlAuthorization {
  const authorization = authorizeControl('resume', input.link, input.registeredOwner, input.authority);
  if (!authorization.ok) return authorization;
  if (input.link.state === 'closed') return { ok: false, reason: 'deferred' };
  if (
    (input.link.state !== 'bound' && input.link.state !== 'reported') ||
    !input.link.currentOwner ||
    input.link.childRef === null
  )
    return { ok: false, reason: 'not_current_owner' };
  if (input.expectedRun !== input.currentRun.runId) return { ok: false, reason: 'expected_run_mismatch' };
  if (
    input.link.childRef.sourceId !== input.currentRun.sourceId ||
    input.link.childRef.harness !== input.currentRun.harness
  )
    return { ok: false, reason: 'identity_conflict' };
  if (input.slotHeld || !isRunTerminal(input.currentRun)) return { ok: false, reason: 'slot_busy' };
  if (input.unresolvedConflict) return { ok: false, reason: 'unresolved_conflict' };
  if (input.taskDigest !== input.link.taskDigest) return { ok: false, reason: 'task_mismatch' };
  if (!input.capabilityVerified) return { ok: false, reason: 'capability_unverified' };
  return authorization;
}
/** Authorization precedes replay; replay precedes gates for a new intent. */
export function prepareResume(
  input: ResumeGateInput,
  records: readonly IdempotencyRecord[],
  requestKey: string,
  paramsDigest: string
):
  | { kind: 'rejected'; reason: string }
  | { kind: 'replay'; record: IdempotencyRecord; actor: ControlInitiator }
  | { kind: 'new'; actor: ControlInitiator; ownerKey: OwnerKey } {
  const authorization = authorizeControl('resume', input.link, input.registeredOwner, input.authority);
  if (!authorization.ok) return { kind: 'rejected', reason: authorization.reason };
  const replay = lookupIdempotency(records, authorization.ownerKey, requestKey, paramsDigest);
  if (replay.kind === 'conflict') return { kind: 'rejected', reason: replay.reason };
  if (replay.kind === 'replay') return { kind: 'replay', record: replay.record, actor: authorization.actor };
  const gate = resumeGate(input);
  return gate.ok
    ? { kind: 'new', actor: gate.actor, ownerKey: gate.ownerKey }
    : { kind: 'rejected', reason: gate.reason };
}

export function taskDigest(
  briefPath: string,
  briefContentHash: string,
  backend: string,
  sourceId: string,
  role: string
): string {
  requireCanonicalAbsolutePath(briefPath);
  return digest([briefPath, briefContentHash, backend, sourceId, role]);
}
export function deriveRunHandshake(
  run: Run,
  claim: Claim | null,
  binding: ChildBinding | null,
  nowMs: number
): RunHandshake {
  if (
    binding &&
    binding.isCurrent &&
    binding.revokedAt === null &&
    binding.runId === run.runId &&
    binding.bindingGeneration === run.expectedGeneration &&
    binding.sessionRef.sourceId === run.sourceId &&
    binding.sessionRef.harness === run.harness &&
    (run.targetSessionRef === null || sameSessionRef(run.targetSessionRef, binding.sessionRef))
  )
    return { state: 'bound', reason: null };
  if (
    claim?.runId === run.runId &&
    claim.sourceId === run.sourceId &&
    claim.expectedGeneration === run.expectedGeneration &&
    claim.state === 'redeemed' &&
    nowMs < claim.expiresAt
  )
    return { state: 'claimed', reason: null };
  return {
    state: 'pending',
    reason:
      claim === null
        ? 'claim_missing'
        : claim.state === 'revoked'
          ? 'claim_revoked'
          : claim.state === 'expired' || nowMs >= claim.expiresAt
            ? 'claim_expired'
            : null,
  };
}

export interface ResumeNext {
  runId: string;
  bindingGeneration: number;
  claimHash: string;
  launchTokenHash: string;
  launchDigest: string;
  launchCallId: string;
  launchCorrelationId: string;
  mode: RunMode;
  launchCwd: string;
  projectOrigin: ProjectOrigin | null;
  workspaceSnapshot: RunWorkspaceSnapshot | null;
  at: number;
}
/** This returns all changes for one intent transaction, without committing them. */
export function planResume(
  gate: ResumeGateInput,
  next: ResumeNext,
  oldClaim: Claim | null,
  oldBinding: ChildBinding | null
): ResumePlan {
  const allowed = resumeGate(gate);
  if (!allowed.ok) throw new TypeError(allowed.reason);
  if (
    next.runId === gate.currentRun.runId ||
    next.bindingGeneration <= gate.currentRun.expectedGeneration ||
    !next.launchCorrelationId ||
    next.launchCorrelationId === gate.currentRun.launchCorrelationId ||
    !next.launchCallId ||
    next.launchCallId === gate.currentRun.launchCallId ||
    next.launchTokenHash === gate.currentRun.launchTokenHash ||
    (oldClaim !== null && next.claimHash === oldClaim.claimHash) ||
    (allowed.actor.kind === 'local_user' && next.launchCallId !== `local:${allowed.actor.invocationId}`)
  )
    throw new TypeError('new_run_anchors_required');
  requireCanonicalAbsolutePath(next.launchCwd);
  const run: Run = {
    ...gate.currentRun,
    runId: next.runId,
    runSeq: gate.currentRun.runSeq + 1,
    operation: 'resume',
    targetSessionRef: gate.link.childRef,
    expectedGeneration: next.bindingGeneration,
    mode: next.mode,
    launchCwd: next.launchCwd,
    projectOrigin: next.projectOrigin,
    workspaceSnapshot: next.workspaceSnapshot,
    supervisionStrategy: next.mode === 'headless' ? 'headless' : 'wrapper',
    state: 'starting',
    scopeRef: null,
    locator: null,
    launchTokenHash: next.launchTokenHash,
    launchDigest: next.launchDigest,
    launchPhase: 'reserved',
    launchCallId: next.launchCallId,
    launchCorrelationId: next.launchCorrelationId,
    launchMessageId: null,
    supervisor: null,
    heartbeatAt: null,
    heartbeatSeq: 0,
    heartbeatMonoMs: null,
    cancelRequestedAt: null,
    submissionFencedAt: null,
    createdAt: next.at,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    exitSource: null,
    shellStatus: null,
    shellSignal: null,
    terminalEvidenceId: null,
  };
  validateRun(run);
  const claim: Claim = {
    runId: run.runId,
    claimHash: next.claimHash,
    sourceId: run.sourceId,
    expectedGeneration: run.expectedGeneration,
    supervisor: null,
    state: 'issued',
    issuedAt: next.at,
    expiresAt: next.at + 1800000,
    redeemedContextId: null,
    redeemedGeneration: null,
    redeemedSessionRef: null,
    redeemedAt: null,
  };
  return {
    actor: allowed.actor,
    ownerKey: allowed.ownerKey,
    link: { ...gate.link, state: 'bound' },
    run,
    claim,
    revokedClaim: oldClaim ? { ...oldClaim, state: 'revoked' } : null,
    revokedBinding: oldBinding ? { ...oldBinding, isCurrent: false, revokedAt: next.at } : null,
    runHandshake: { state: 'pending', reason: null },
  };
}

export interface HandoverGateInput extends Omit<ResumeGateInput, 'expectedRun' | 'taskDigest'> {
  newParentRef: SessionRef;
  graph: readonly Link[];
  graphBudget: number;
}
export function handoverGate(input: HandoverGateInput): ControlAuthorization {
  const allowed = authorizeControl('predecessor', input.link, input.registeredOwner, input.authority);
  if (!allowed.ok) return allowed;
  if (sessionOwnerKey(input.newParentRef) !== allowed.ownerKey) return { ok: false, reason: 'unsupported' };
  if (
    !input.link.currentOwner ||
    (input.link.state !== 'bound' && input.link.state !== 'reported') ||
    input.link.childRef === null
  )
    return { ok: false, reason: 'historical_predecessor' };
  if (input.slotHeld || !isRunTerminal(input.currentRun)) return { ok: false, reason: 'slot_busy' };
  if (input.unresolvedConflict) return { ok: false, reason: 'unresolved_conflict' };
  if (!input.capabilityVerified) return { ok: false, reason: 'capability_unverified' };
  if (
    input.graph.some(
      (edge) =>
        edge.linkId !== input.link.linkId &&
        edge.currentOwner &&
        edge.childRef !== null &&
        sameSessionRef(edge.childRef, input.link.childRef!)
    )
  )
    return { ok: false, reason: 'duplicate_current_parent' };
  const pending = [input.link.childRef];
  const seen: SessionRef[] = [];
  let visited = 0;
  while (pending.length > 0) {
    if (visited++ >= input.graphBudget) return { ok: false, reason: 'graph_budget_exhausted' };
    const ref = pending.pop()!;
    if (sameSessionRef(ref, input.newParentRef)) return { ok: false, reason: 'cycle' };
    if (seen.some((entry) => sameSessionRef(entry, ref))) continue;
    seen.push(ref);
    for (const edge of input.graph)
      if (edge.currentOwner && edge.parentRef && edge.childRef && sameSessionRef(edge.parentRef, ref))
        pending.push(edge.childRef);
  }
  return allowed;
}
export function planHandover(
  input: HandoverGateInput,
  newLinkId: string,
  at: number
): { oldLink: Link; newLink: Link } {
  const gate = handoverGate(input);
  if (!gate.ok) throw new TypeError(gate.reason);
  if (newLinkId === input.link.linkId) throw new TypeError('new_link_required');
  return {
    oldLink: { ...input.link, state: 'handed_over', currentOwner: false },
    newLink: {
      ...input.link,
      linkId: newLinkId,
      state: 'bound',
      parentRef: input.newParentRef,
      predecessor: input.link.linkId,
      currentOwner: true,
      createdAt: at,
      claimedAt: null,
      boundAt: at,
      closedAt: null,
    },
  };
}

export function advanceLink(
  link: Link,
  event:
    | { kind: 'claimed'; at: number }
    | { kind: 'bound'; ref: SessionRef; at: number }
    | { kind: 'non_execution'; firstRun: boolean }
    | { kind: 'revoke' }
): Link {
  if (event.kind === 'revoke') {
    if (!['pending', 'claimed', 'bound', 'reported'].includes(link.state))
      throw new TypeError('invalid_link_transition');
    return { ...link, state: 'revoked', currentOwner: false };
  }
  if (event.kind === 'non_execution')
    return event.firstRun &&
      link.childRef === null &&
      !link.currentOwner &&
      (link.state === 'pending' || link.state === 'claimed')
      ? { ...link, state: 'failed' }
      : link;
  if (event.kind === 'claimed') {
    if (link.state !== 'pending' && link.state !== 'claimed') throw new TypeError('invalid_link_transition');
    return { ...link, state: 'claimed', claimedAt: link.claimedAt ?? event.at };
  }
  if (
    !['pending', 'claimed', 'bound', 'reported'].includes(link.state) ||
    (link.childRef !== null && !sameSessionRef(link.childRef, event.ref)) ||
    (link.parentRef !== null && sameSessionRef(link.parentRef, event.ref))
  )
    throw new TypeError('invalid_link_binding');
  return { ...link, state: 'bound', childRef: event.ref, currentOwner: true, boundAt: link.boundAt ?? event.at };
}

export function reportPolicy(
  report: Report,
  run: Run,
  binding: ChildBinding | null,
  selection: ContextSelection
): { accepted: boolean; reason: string | null } {
  if (!selection.ok || !binding || !binding.isCurrent || binding.revokedAt !== null)
    return { accepted: false, reason: 'unauthorized' };
  const context = selection.context;
  if (
    report.runId !== run.runId ||
    report.linkId !== run.linkId ||
    binding.runId !== run.runId ||
    binding.bindingId !== report.childBindingId ||
    binding.bindingGeneration !== run.expectedGeneration ||
    binding.sessionRef.sourceId !== run.sourceId ||
    binding.sessionRef.harness !== run.harness ||
    binding.callerId !== context.callerId ||
    report.callerId !== context.callerId ||
    binding.callerContextId !== context.contextId ||
    report.callerContextId !== context.contextId ||
    binding.contextGeneration !== context.generation ||
    report.contextGeneration !== context.generation ||
    context.sessionRef === null ||
    !sameSessionRef(binding.sessionRef, context.sessionRef) ||
    (run.targetSessionRef !== null && !sameSessionRef(binding.sessionRef, run.targetSessionRef))
  )
    return { accepted: false, reason: 'stale_binding' };
  if (
    !['completed', 'failed', 'blocked', 'interrupted'].includes(report.status) ||
    (report.path !== null && !isCanonicalAbsolutePath(report.path))
  )
    return { accepted: false, reason: 'invalid_report' };
  return { accepted: true, reason: null };
}
export function linkAfterReport(link: Link, report: Report, currentRun: Run): Link {
  return report.linkId === link.linkId &&
    report.runId === currentRun.runId &&
    (link.state === 'bound' || link.state === 'reported')
    ? { ...link, state: 'reported' }
    : link;
}
export function latestReportForRun(reports: readonly CommittedReport[], runId: string): Report | null {
  return [...reports].filter((entry) => entry.report.runId === runId).sort((a, b) => b.seq - a.seq)[0]?.report ?? null;
}
export function dedupeReports(reports: readonly CommittedReport[]): CommittedReport[] {
  const ids = new Set<string>();
  return reports.filter((entry) => !ids.has(entry.report.reportId) && !!ids.add(entry.report.reportId));
}

export function effectiveWaitMs(
  requestedMs: number,
  clientToolTimeoutMs: number | null,
  responseMarginMs: number | null,
  timeoutVerified = true
): { effectiveWaitMs: number; reason: 'timeout_configuration_unverified' | null } {
  if (!Number.isSafeInteger(requestedMs) || requestedMs < 0 || requestedMs > 120000)
    throw new TypeError('invalid_wait_timeout');
  if (
    !timeoutVerified ||
    clientToolTimeoutMs === null ||
    responseMarginMs === null ||
    !Number.isFinite(clientToolTimeoutMs) ||
    !Number.isFinite(responseMarginMs) ||
    responseMarginMs <= 0 ||
    clientToolTimeoutMs <= responseMarginMs
  )
    return { effectiveWaitMs: 0, reason: 'timeout_configuration_unverified' };
  return { effectiveWaitMs: Math.min(requestedMs, 120000, clientToolTimeoutMs - responseMarginMs), reason: null };
}
export function resolveWaitTarget(
  request: Record<string, unknown>,
  runs: readonly Run[],
  canRead: (run: Run) => boolean
): { ok: true; fixed: FixedWait } | { ok: false; reason: string } {
  const fields = ['linkId', 'runId', 'afterSeq', 'until', 'timeoutMs'];
  if (
    Object.keys(request).some((field) => !fields.includes(field)) ||
    (typeof request.linkId === 'string') === (typeof request.runId === 'string') ||
    ('linkId' in request && typeof request.linkId !== 'string') ||
    ('runId' in request && typeof request.runId !== 'string')
  )
    return { ok: false, reason: 'invalid' };
  const afterSeq = request.afterSeq ?? 0;
  const timeoutMs = request.timeoutMs ?? 120000;
  const until = request.until ?? ['report', 'run_terminal', 'uncertain'];
  if (
    !Number.isSafeInteger(afterSeq) ||
    (afterSeq as number) < 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < 0 ||
    (timeoutMs as number) > 120000 ||
    !Array.isArray(until) ||
    until.some((entry) => !['report', 'run_terminal', 'uncertain'].includes(entry))
  )
    return { ok: false, reason: 'invalid' };
  const run =
    typeof request.runId === 'string'
      ? runs.find((entry) => entry.runId === request.runId)
      : [...runs].filter((entry) => entry.linkId === request.linkId).sort((a, b) => b.runSeq - a.runSeq)[0];
  if (!run) return { ok: false, reason: 'no_run' };
  if (!canRead(run)) return { ok: false, reason: 'unauthorized' };
  return {
    ok: true,
    fixed: {
      runId: run.runId,
      afterSeq: afterSeq as number,
      timeoutMs: timeoutMs as number,
      until: until as WaitUntil[],
    },
  };
}
export function waitPage(
  fixed: FixedWait,
  snapshot: { highWaterSeq: number; events: readonly LedgerEvent[]; run: Run },
  timedOut = false
): WaitPage {
  if (snapshot.run.runId !== fixed.runId) throw new TypeError('fixed_run_mismatch');
  const relevant = snapshot.events
    .filter((event) => event.runId === fixed.runId && event.seq > fixed.afterSeq && event.seq <= snapshot.highWaterSeq)
    .sort((a, b) => a.seq - b.seq);
  const events = relevant.slice(0, 200);
  const matched =
    (fixed.until.includes('report') &&
      events.some((event) => event.kind === 'report.received' && typeof event.payload.reportId === 'string')) ||
    (fixed.until.includes('run_terminal') && isRunTerminal(snapshot.run)) ||
    (fixed.until.includes('uncertain') && snapshot.run.state === 'uncertain');
  return {
    runId: fixed.runId,
    events,
    nextSeq: events.at(-1)?.seq ?? fixed.afterSeq,
    matched,
    timedOut: timedOut && !matched,
    current: snapshot.run,
    hasMore: relevant.length > events.length,
    asOfSeq: snapshot.highWaterSeq,
  };
}

export type ActionInput = {
  linkId: string;
  runId: string;
  reason: string;
  hudHome: string;
  entryVerified: boolean;
} & ({ operation: 'resume'; expectedRun: string; mode: RunMode; requestKey: string } | { operation: 'reconcile' });
function shellQuote(value: string): string {
  if (value.includes('\0')) throw new TypeError('nul_command_argument');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
export function createActionDescriptor(input: ActionInput): ActionDescriptor | null {
  if (!input.entryVerified) return null;
  requireCanonicalAbsolutePath(input.hudHome);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.runId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.linkId))
    throw new TypeError('invalid_action_target');
  const base = {
    linkId: input.linkId,
    runId: input.runId,
    reason: input.reason,
    subject: 'local_user' as const,
    delivery: 'copy_only' as const,
    hudHome: input.hudHome,
  };
  const prefix = `HUD_HOME=${shellQuote(input.hudHome)} hud run`;
  if (input.operation === 'reconcile')
    return { ...base, operation: 'reconcile', displayCommand: `${prefix} reconcile ${shellQuote(input.runId)}` };
  validateRequestKey(input.requestKey);
  if (input.expectedRun !== input.runId || (input.mode !== 'headless' && input.mode !== 'visible'))
    throw new TypeError('fixed_action_target_required');
  return {
    ...base,
    operation: 'resume',
    expectedRun: input.expectedRun,
    mode: input.mode,
    requestKey: input.requestKey,
    displayCommand: `${prefix} resume ${shellQuote(input.linkId)} --request-key ${shellQuote(input.requestKey)} --expected-run ${shellQuote(input.expectedRun)} --mode ${shellQuote(input.mode)}`,
  };
}
export function actionTargetMatches(action: ActionDescriptor, currentRunId: string): boolean {
  return action.runId === currentRunId && (action.operation !== 'resume' || action.expectedRun === currentRunId);
}
export function interactionPolicy(input: {
  run: Run;
  unresolvedConflict: boolean;
  occupantMatches: boolean | null;
  focusVerified: boolean;
  inputVerified: boolean;
  foregroundInteractive: boolean;
  resumable: boolean;
}): Interaction {
  if (input.run.state === 'uncertain' || input.unresolvedConflict) return { focus: false, input: false, resume: false };
  const interactive = input.run.mode === 'visible' && input.occupantMatches === true && input.foregroundInteractive;
  return {
    focus: interactive && input.focusVerified,
    input: interactive && input.inputVerified,
    resume: input.resumable,
  };
}

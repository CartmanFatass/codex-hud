import assert from 'node:assert/strict';
import { canonicalJson, digest } from '../../../src/core/canonical.js';
import {
  claimTransport,
  closeIdentityGeneration,
  makeProcessKey,
  makeSourceId,
  planOwnerAlias,
  procOwnerKey,
  redeemClaim,
  resolveBinding,
  sameSessionRef,
  selectCallContext,
  sessionOwnerKey,
  sessionRefKey,
  validateTranscript,
  type BindingInput,
  type CurrentCallEvidence,
  type TranscriptCheck,
} from '../../../src/core/identity.js';
import {
  captureWorkspace,
  heartbeatQuality,
  isRunTerminal,
  ledgerMetadataChange,
  lookupIdempotency,
  makeRunSlot,
  mvpOperationPolicy,
  normalizeRequest,
  planSlotMigration,
  prepareRunContext,
  reconcileRun,
  requestDigest,
  updateRun,
  validateRun,
} from '../../../src/core/execution.js';
import {
  advanceLink,
  authorizeControl,
  dedupeReports,
  deriveRunHandshake,
  effectiveWaitMs,
  handoverGate,
  latestReportForRun,
  linkAfterReport,
  planHandover,
  planResume,
  prepareResume,
  reportPolicy,
  resolveWaitTarget,
  resumeGate,
  taskDigest,
  waitPage,
  type ControlAuthority,
  type HandoverGateInput,
  type ResumeGateInput,
  type ResumeNext,
} from '../../../src/core/lifecycle.js';
import { leaseReleasePolicy } from '../../../src/core/supervision.js';
import type {
  CallerContext,
  CallerScope,
  ChildBinding,
  Claim,
  OwnerAlias,
  SessionRef,
} from '../../../src/core/types/identity.js';
import type {
  IdempotencyRecord,
  LedgerEvent,
  ReconcileEvidence,
  ReconcileFact,
  Run,
} from '../../../src/core/types/execution.js';
import type { FixedWait, Link, Report, ReportStatus } from '../../../src/core/types/lifecycle.js';
import type { ProcessScope, ProcessStamp } from '../../../src/core/types/supervision.js';
import type { RunWorkspaceSnapshot } from '../../../src/core/types/observation.js';

export const FIXTURE_NOW = 1_700_000_000_000;
export const FIXTURE_SOURCE = makeSourceId('codex', '/synthetic/home-a');
export const FIXTURE_PARENT: SessionRef = {
  harness: 'codex',
  sourceId: FIXTURE_SOURCE,
  sessionId: 'parent-a',
  threadId: null,
};
export const FIXTURE_CHILD: SessionRef = { ...FIXTURE_PARENT, sessionId: 'child-a' };
export const FIXTURE_SUPERVISOR: ProcessStamp = {
  pid: 120,
  proc_start: '10001',
  boot_id: 'synthetic-boot-a',
  pid_domain: 'synthetic-machine-a/boot-a/pidns-a',
};
export const FIXTURE_PROCESS_KEY = makeProcessKey('codex', FIXTURE_SOURCE, FIXTURE_SUPERVISOR.pid_domain, 121, '10002');
export const FIXTURE_SCOPE: ProcessScope = {
  scope_id: 'synthetic-scope-a',
  scope_kind: 'pgid',
  pid_domain: FIXTURE_SUPERVISOR.pid_domain,
  boot_id: FIXTURE_SUPERVISOR.boot_id,
  pgid: 121,
  sid: 119,
  group_leader: { ...FIXTURE_SUPERVISOR, pid: 121, proc_start: '10002' },
};
export function fixtureRun(patch: Partial<Run> = {}): Run {
  return {
    runId: 'run-a',
    linkId: 'link-a',
    runSeq: 1,
    operation: 'spawn',
    targetSessionRef: FIXTURE_CHILD,
    sourceId: FIXTURE_SOURCE,
    harness: 'codex',
    expectedGeneration: 1,
    mode: 'headless',
    launchCwd: '/synthetic/repo-a',
    workspaceSnapshot: null,
    projectOrigin: null,
    supervisionStrategy: 'headless',
    scopeKind: 'pgid',
    scopeRef: FIXTURE_SCOPE,
    state: 'running',
    locator: null,
    launchTokenHash: digest('ticket-a'),
    launchDigest: digest('launch-a'),
    launchPhase: 'submitted',
    launchCallId: 'call-a',
    launchCorrelationId: 'correlation-a',
    launchMessageId: 'message-a',
    supervisor: FIXTURE_SUPERVISOR,
    heartbeatAt: FIXTURE_NOW,
    heartbeatSeq: 1,
    heartbeatMonoMs: 1000,
    cancelRequestedAt: null,
    submissionFencedAt: null,
    createdAt: FIXTURE_NOW - 1000,
    startedAt: FIXTURE_NOW - 500,
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    exitSource: null,
    shellStatus: null,
    shellSignal: null,
    terminalEvidenceId: null,
    orphanPolicy: 'continue',
    ...patch,
  };
}
export function fixtureEndedRun(patch: Partial<Run> = {}): Run {
  return fixtureRun({
    state: 'ended',
    endedAt: FIXTURE_NOW,
    submissionFencedAt: FIXTURE_NOW,
    terminalEvidenceId: 'evidence-end-a',
    ...patch,
  });
}
export function fixtureLink(patch: Partial<Link> = {}): Link {
  return {
    linkId: 'link-a',
    state: 'bound',
    parentCaller: 'caller-a',
    parentContextId: 'context-a',
    parentContextGeneration: 1,
    parentRef: FIXTURE_PARENT,
    childRef: FIXTURE_CHILD,
    currentOwner: true,
    backend: 'synthetic-backend',
    role: 'implementer',
    label: 'Synthetic task',
    briefPath: '/synthetic/brief-a.md',
    taskDigest: taskDigest(
      '/synthetic/brief-a.md',
      digest('brief-a'),
      'synthetic-backend',
      FIXTURE_SOURCE,
      'implementer'
    ),
    reportPath: null,
    predecessor: null,
    routing: null,
    createdAt: FIXTURE_NOW - 1000,
    claimedAt: FIXTURE_NOW - 900,
    boundAt: FIXTURE_NOW - 800,
    closedAt: null,
    ...patch,
  };
}
export function fixtureContext(patch: Partial<CallerContext> = {}): CallerContext {
  return {
    contextId: 'context-a',
    generation: 1,
    callerId: 'caller-a',
    contextKey: 'stdio',
    kind: 'dedicated',
    harness: 'codex',
    sourceId: FIXTURE_SOURCE,
    processKey: FIXTURE_PROCESS_KEY,
    procGeneration: 1,
    sessionRef: FIXTURE_PARENT,
    selectionEvidenceId: null,
    boundBy: 'trusted_session',
    bindingEvidenceId: 'evidence-identity-a',
    createdAt: FIXTURE_NOW - 1000,
    closedAt: null,
    ...patch,
  } as CallerContext;
}
export function fixtureCallEvidence(patch: Partial<CurrentCallEvidence> = {}): CurrentCallEvidence {
  return {
    physicalCallerVerified: true,
    pidDomainVisible: true,
    profileObservesSessionSwitch: true,
    topology: 'direct_stdio',
    logicalSource: 'root',
    processKey: FIXTURE_PROCESS_KEY,
    procGeneration: 1,
    sessionRef: FIXTURE_PARENT,
    ...patch,
  };
}
export function fixtureSelection(context = fixtureContext()) {
  return selectCallContext(context, fixtureCallEvidence({ sessionRef: context.sessionRef }));
}
export function fixtureClaim(patch: Partial<Claim> = {}): Claim {
  return {
    runId: 'run-a',
    claimHash: digest('claim-a'),
    sourceId: FIXTURE_SOURCE,
    expectedGeneration: 1,
    supervisor: FIXTURE_SUPERVISOR,
    state: 'armed',
    issuedAt: FIXTURE_NOW,
    expiresAt: FIXTURE_NOW + 1800000,
    redeemedContextId: null,
    redeemedGeneration: null,
    redeemedSessionRef: null,
    redeemedAt: null,
    ...patch,
  };
}
export function fixtureBinding(patch: Partial<ChildBinding> = {}): ChildBinding {
  return {
    bindingId: 'binding-a',
    runId: 'run-a',
    sessionRef: FIXTURE_CHILD,
    bindingGeneration: 1,
    callerId: 'caller-a',
    callerContextId: 'context-a',
    contextGeneration: 1,
    boundBy: 'receipt',
    capabilities: 'mcp',
    evidenceId: 'evidence-bind-a',
    isCurrent: true,
    createdAt: FIXTURE_NOW,
    revokedAt: null,
    ...patch,
  };
}
export function fixtureReconcileEvidence(
  fact: ReconcileFact,
  patch: Partial<ReconcileEvidence> = {}
): ReconcileEvidence {
  return {
    evidenceId: `evidence-${fact.kind}`,
    runId: 'run-a',
    sourceId: FIXTURE_SOURCE,
    bindingGeneration: 1,
    supervisor: FIXTURE_SUPERVISOR,
    validation: 'accepted',
    asOf: fact.kind === 'heartbeat' ? fact.at : FIXTURE_NOW,
    observedAt: FIXTURE_NOW,
    fact,
    ...patch,
  };
}
export function fixtureScope(patch: Partial<CallerScope> = {}): CallerScope {
  return {
    processKey: FIXTURE_PROCESS_KEY,
    generation: 1,
    harness: 'codex',
    sourceId: FIXTURE_SOURCE,
    pidDomain: FIXTURE_SUPERVISOR.pid_domain,
    harnessPid: 121,
    harnessProcStart: '10002',
    sessionRef: FIXTURE_PARENT,
    boundBy: 'trusted_session',
    bindingEvidenceId: 'evidence-identity-a',
    createdAt: FIXTURE_NOW - 1000,
    closedAt: null,
    ...patch,
  } as CallerScope;
}
export function fixtureResumeGate(patch: Partial<ResumeGateInput> = {}): ResumeGateInput {
  const link = fixtureLink();
  return {
    link,
    registeredOwner: sessionOwnerKey(FIXTURE_PARENT),
    authority: { kind: 'mcp', selection: fixtureSelection() },
    currentRun: fixtureEndedRun(),
    expectedRun: 'run-a',
    taskDigest: link.taskDigest,
    slotHeld: false,
    unresolvedConflict: false,
    capabilityVerified: true,
    ...patch,
  };
}
export function fixtureLocalAuthority(
  patch: Partial<Extract<ControlAuthority, { kind: 'local_user' }>> = {}
): ControlAuthority {
  return {
    kind: 'local_user',
    uid: 1000,
    ownerUid: 1000,
    invocationId: 'invocation-a',
    hudHomeOwned: true,
    ledgerOwned: true,
    privatePaths: true,
    ...patch,
  };
}
export function fixtureNextResume(patch: Partial<ResumeNext> = {}): ResumeNext {
  return {
    runId: 'run-b',
    bindingGeneration: 2,
    claimHash: digest('claim-b'),
    launchTokenHash: digest('ticket-b'),
    launchDigest: digest('launch-b'),
    launchCallId: 'call-b',
    launchCorrelationId: 'correlation-b',
    mode: 'headless',
    launchCwd: '/synthetic/repo-b',
    projectOrigin: null,
    workspaceSnapshot: null,
    at: FIXTURE_NOW + 1000,
    ...patch,
  };
}
export function fixtureRecord(patch: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    ownerKey: sessionOwnerKey(FIXTURE_PARENT),
    originOwnerKey: sessionOwnerKey(FIXTURE_PARENT),
    requestKey: 'request-a',
    paramsVersion: 1,
    paramsDigest: digest('params-a'),
    linkId: 'link-a',
    runId: 'run-a',
    outcome: { accepted: true, state: 'starting' },
    at: FIXTURE_NOW,
    ...patch,
  };
}
export function fixtureReport(patch: Partial<Report> = {}): Report {
  return {
    reportId: 'report-a',
    runId: 'run-a',
    linkId: 'link-a',
    childBindingId: 'binding-a',
    callerId: 'caller-a',
    callerContextId: 'context-a',
    contextGeneration: 1,
    status: 'completed',
    summary: 'Synthetic result',
    path: null,
    createdAt: FIXTURE_NOW,
    ...patch,
  };
}
export function fixtureWorkspace(patch: Partial<RunWorkspaceSnapshot> = {}): RunWorkspaceSnapshot {
  return {
    worktreeRoot: '/synthetic/repo-a',
    gitCommonDir: '/synthetic/repo-a/.git',
    repoId: digest(['git-common-dir-v1', '/synthetic/repo-a/.git']),
    identityKind: 'git-common-dir-v1',
    scope: 'local',
    cwdSource: 'launch',
    cwdAsOf: FIXTURE_NOW,
    gitCapturedAt: FIXTURE_NOW,
    gitMissingReason: null,
    ...patch,
  };
}
function bindingInput(patch: Partial<BindingInput> = {}): BindingInput {
  return {
    hasMcp: true,
    registered: true,
    claimValid: true,
    currentSourceVerified: true,
    independentLaunchVerified: true,
    independentSessionVerified: true,
    contradictoryEvidence: false,
    candidateRefs: [FIXTURE_CHILD],
    expectedRef: null,
    currentBinding: null,
    otherUnboundClaimant: false,
    ...patch,
  };
}
function claimRequest(context = fixtureContext()) {
  return {
    selection: fixtureSelection(context),
    run: {
      runId: 'run-a',
      sourceId: FIXTURE_SOURCE,
      bindingGeneration: 1,
      supervisor: FIXTURE_SUPERVISOR,
      launchCallId: 'call-a',
      launchCorrelationId: 'correlation-a',
    },
    claimHash: digest('claim-a'),
  };
}
function transcript(patch: Partial<TranscriptCheck> = {}): TranscriptCheck {
  return {
    existingLinkRun: true,
    writer: 'reconciler',
    independentEvidenceVerified: true,
    parentInitiator: 'mcp',
    issuedAt: FIXTURE_NOW,
    harness: 'codex',
    sourceId: FIXTURE_SOURCE,
    parentCallId: 'parent-call-a',
    launchCallId: 'call-a',
    launchCorrelationId: 'correlation-a',
    nativeMessageId: 'message-a',
    candidates: [
      {
        ref: FIXTURE_CHILD,
        eventAt: FIXTURE_NOW,
        parentCallId: 'parent-call-a',
        launchCallId: 'call-a',
        launchCorrelationId: 'correlation-a',
        nativeMessageId: 'message-a',
        kind: 'tool_result',
      },
    ],
    ...patch,
  };
}
function handover(patch: Partial<HandoverGateInput> = {}): HandoverGateInput {
  return { ...fixtureResumeGate(), newParentRef: FIXTURE_PARENT, graph: [fixtureLink()], graphBudget: 200, ...patch };
}
function event(seq: number, runId: string | null = 'run-a', kind = 'progress'): LedgerEvent {
  return {
    seq,
    linkId: 'link-a',
    runId,
    kind,
    payload: kind === 'report.received' ? { reportId: `report-${seq}` } : {},
    at: FIXTURE_NOW + seq,
  };
}
function fixedWait(patch: Partial<FixedWait> = {}): FixedWait {
  return { runId: 'run-a', afterSeq: 0, until: ['report', 'run_terminal', 'uncertain'], timeoutMs: 120000, ...patch };
}
const scopeAlive = () =>
  fixtureReconcileEvidence({
    kind: 'scope',
    state: 'alive',
    complete: true,
    harnessTerminated: false,
    launchersSealed: false,
  });
const scopeGone = () =>
  fixtureReconcileEvidence({
    kind: 'scope',
    state: 'gone',
    complete: true,
    harnessTerminated: true,
    launchersSealed: true,
  });
const launchStarted = () =>
  fixtureReconcileEvidence({
    kind: 'launch',
    childStarted: true,
    originalExecutorValid: true,
    observedAt: FIXTURE_NOW,
  });
const receipt = (kind: 'receipt' | 'scope_reconciled' = 'receipt') =>
  fixtureReconcileEvidence({ kind, complete: true, harnessTerminated: true, launchersSealed: true, nativeExit: null });
const neverSubmitted = () =>
  fixtureReconcileEvidence({ kind: 'never_submitted', permanentFence: true, launchersSealed: true, noExecution: true });
const request = () => ({
  backend: 'synthetic-backend',
  profile: 'synthetic-profile',
  sourceId: FIXTURE_SOURCE,
  role: 'implementer',
  mode: 'headless',
  launchCwd: '/synthetic/repo-a',
  briefPath: '/synthetic/brief-a.md',
  briefContentHash: digest('brief-a'),
  profileDigest: digest('profile-a'),
});
function assertDenied(result: { ok: boolean }, expected = false) {
  assert.equal(result.ok, expected);
}

export const identityExecutionCases: Record<string, () => void> = {
  'T-01-1': () => {
    const a = { ...FIXTURE_PARENT, sessionId: 'synthetic-s' };
    const b = { ...a, sourceId: makeSourceId('codex', '/synthetic/home-b') };
    assert.equal(sameSessionRef(a, b), false);
    assert.notEqual(sessionOwnerKey(a), sessionOwnerKey(b));
    assert.equal(makeSourceId('codex', '/synthetic/home-a'), FIXTURE_SOURCE);
    assert.throws(() => makeSourceId('codex', 'relative/home'), /absolute/);
    // A resolved symlink must be supplied as its real root; no filesystem resolution is claimed.
    assert.equal(JSON.parse(sessionOwnerKey(a))[1], sessionRefKey(a));
    assert.equal(typeof JSON.parse(sessionOwnerKey(a))[1], 'string');
  },
  'T-01-2': () => {
    const root: SessionRef = {
      harness: 'claude',
      sourceId: makeSourceId('claude', '/synthetic/claude-a'),
      sessionId: 'synthetic-s',
      threadId: null,
    };
    const refs = [root, { ...root, threadId: 'agent-a' }, { ...root, threadId: 'agent-b' }];
    assert.equal(new Set(refs.map(sessionRefKey)).size, 3);
    assert.equal(new Set([...refs, { ...root, threadId: '' }].map(sessionRefKey)).size, 3);
    assert.equal(sessionRefKey(root), JSON.stringify(['claude', root.sourceId, 'synthetic-s', null]));
  },
  'T-01-6': () => {
    const changedStart = makeProcessKey('codex', FIXTURE_SOURCE, FIXTURE_SUPERVISOR.pid_domain, 121, '20002');
    const changedBoot = makeProcessKey('codex', FIXTURE_SOURCE, 'synthetic-machine-a/boot-b/pidns-a', 121, '10002');
    assert.notEqual(changedStart, FIXTURE_PROCESS_KEY);
    assert.notEqual(changedBoot, FIXTURE_PROCESS_KEY);
    assertDenied(selectCallContext(fixtureContext(), fixtureCallEvidence({ processKey: changedStart })));
    assertDenied(selectCallContext(fixtureContext(), fixtureCallEvidence({ pidDomainVisible: false })));
    assert.throws(() => makeProcessKey('codex', FIXTURE_SOURCE, '', 121, '10002'), /process_key/);
  },
  'T-01-7': () => {
    const plan = planResume(fixtureResumeGate(), fixtureNextResume(), fixtureClaim(), fixtureBinding());
    assert.equal(plan.link.linkId, 'link-a');
    assert.equal(plan.link.state, 'bound');
    assert.equal(plan.run.runId, 'run-b');
    assert.equal(plan.run.expectedGeneration, 2);
    assert.equal(plan.claim.state, 'issued');
    assert.equal(plan.revokedClaim?.state, 'revoked');
    assert.equal(plan.revokedBinding?.isCurrent, false);
    assert.notEqual(plan.run.launchCorrelationId, fixtureRun().launchCorrelationId);
    assert.equal(
      reportPolicy(
        fixtureReport(),
        plan.run,
        fixtureBinding(),
        fixtureSelection(fixtureContext({ sessionRef: FIXTURE_CHILD }))
      ).accepted,
      false
    );
  },
  'T-01-8': () => {
    const claim = fixtureClaim();
    const req = claimRequest();
    const variants = [
      fixtureClaim({ state: 'issued' }),
      fixtureClaim({ sourceId: makeSourceId('codex', '/synthetic/home-b') }),
      fixtureClaim({ runId: 'run-other' }),
      fixtureClaim({ expectedGeneration: 2 }),
      fixtureClaim({ supervisor: { ...FIXTURE_SUPERVISOR, proc_start: 'other-start' } }),
    ];
    for (const invalid of variants) assert.equal(redeemClaim(invalid, req, FIXTURE_NOW).ok, false);
    assert.equal(redeemClaim(claim, req, claim.expiresAt).ok, false);
    assert.equal(redeemClaim(claim, { ...req, claimHash: digest('wrong-claim') }, FIXTURE_NOW).ok, false);
    assert.equal(claim.state, 'armed');
  },
  'T-01-9': () => {
    const claim = fixtureClaim();
    const result = redeemClaim(claim, claimRequest(), claim.expiresAt - 1);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.consumed, true);
    assert.equal(result.handshake, 'claimed');
    assert.equal(result.claim.redeemedContextId, 'context-a');
    assert.equal(redeemClaim(claim, claimRequest(), claim.expiresAt).ok, false);
  },
  'T-01-10': () => {
    const context = fixtureContext({ sessionRef: FIXTURE_CHILD });
    const first = redeemClaim(fixtureClaim(), claimRequest(context), FIXTURE_NOW);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const repeated = redeemClaim(first.claim, claimRequest(context), FIXTURE_NOW + 1);
    assert.equal(repeated.ok && repeated.consumed, false);
    const restarted = fixtureContext({
      callerId: 'caller-restarted',
      contextId: 'context-restarted',
      sessionRef: FIXTURE_CHILD,
    });
    const binding = fixtureBinding({ callerId: restarted.callerId, callerContextId: restarted.contextId });
    const afterTtl = redeemClaim(
      first.claim,
      { ...claimRequest(restarted), currentBinding: binding },
      first.claim.expiresAt + 1
    );
    assert.equal(afterTtl.ok && afterTtl.handshake, 'bound');
    assert.equal(afterTtl.ok && afterTtl.consumed, false);
    assert.equal(
      redeemClaim(
        { ...first.claim, state: 'revoked' },
        { ...claimRequest(restarted), currentBinding: binding },
        FIXTURE_NOW + 2
      ).ok,
      false
    );
    assert.equal(
      redeemClaim(
        first.claim,
        { ...claimRequest(context), run: { ...claimRequest(context).run, bindingGeneration: 2 } },
        FIXTURE_NOW + 2
      ).ok,
      false
    );
  },
  'T-01-11': () => {
    const fork = fixtureContext({ contextId: 'fork-context', sessionRef: { ...FIXTURE_CHILD, sessionId: 'fork-a' } });
    const redeemed = redeemClaim(fixtureClaim(), claimRequest(fork), FIXTURE_NOW);
    assert.equal(redeemed.ok && redeemed.handshake, 'claimed');
    const candidate = resolveBinding(
      bindingInput({ candidateRefs: [fork.sessionRef!], independentLaunchVerified: false })
    );
    assert.equal(candidate.state, 'claimed');
    assert.equal(candidate.sessionRef, null);
    assert.equal(reportPolicy(fixtureReport(), fixtureRun(), null, fixtureSelection(fork)).accepted, false);
  },
  'T-01-12': () => {
    const fork = fixtureContext({ contextId: 'fork-context', sessionRef: { ...FIXTURE_CHILD, sessionId: 'fork-a' } });
    const first = redeemClaim(fixtureClaim(), claimRequest(fork), FIXTURE_NOW);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const ordinary = redeemClaim(
      first.claim,
      claimRequest(fixtureContext({ sessionRef: FIXTURE_CHILD })),
      FIXTURE_NOW + 1
    );
    assert.equal(!ordinary.ok && ordinary.reason, 'claim_conflict');
    const takeover = resolveBinding(bindingInput({ otherUnboundClaimant: true }));
    assert.equal(takeover.state, 'bound');
    assert.equal(takeover.replaceUnboundClaimant, true);
    assert.equal(sameSessionRef(takeover.sessionRef!, FIXTURE_CHILD), true);
    const noEvidence = resolveBinding(bindingInput({ otherUnboundClaimant: true, independentLaunchVerified: false }));
    assert.equal(noEvidence.replaceUnboundClaimant, false);
  },
  'T-01-13': () => {
    const two = resolveBinding(
      bindingInput({ candidateRefs: [FIXTURE_CHILD, { ...FIXTURE_CHILD, sessionId: 'child-b' }] })
    );
    assert.equal(two.state, 'conflict');
    assert.equal(two.sessionRef, null);
    const contradiction = resolveBinding(
      bindingInput({ contradictoryEvidence: true, currentBinding: fixtureBinding() })
    );
    assert.equal(contradiction.revokeCurrent, true);
    assert.equal(contradiction.state, 'conflict');
  },
  'T-01-14': () => {
    for (const [offset, expected] of [
      [-5000, 'matched'],
      [600000, 'matched'],
      [-5001, 'rejected'],
      [600001, 'rejected'],
    ] as const) {
      const input = transcript();
      input.candidates = [{ ...input.candidates[0], eventAt: FIXTURE_NOW + offset }];
      assert.equal(validateTranscript(input).state, expected);
    }
    const missingEventTime = transcript();
    missingEventTime.candidates[0].eventAt = null;
    assert.equal(validateTranscript(missingEventTime).state, 'rejected');
  },
  'T-01-15': () => {
    const result = validateTranscript(transcript());
    assert.equal(result.state, 'matched');
    assert.equal(result.boundBy, 'transcript');
    assert.equal(sameSessionRef(result.ref!, FIXTURE_CHILD), true);
    assert.equal(validateTranscript(transcript({ existingLinkRun: false })).state, 'rejected');
    assert.equal(validateTranscript(transcript({ writer: 'hud' })).state, 'rejected');
    assert.equal(validateTranscript(transcript({ independentEvidenceVerified: false })).state, 'rejected');
  },
  'T-01-16': () => {
    const input = transcript();
    assert.equal(
      validateTranscript({ ...input, candidates: [...input.candidates, { ...input.candidates[0] }] }).state,
      'conflict'
    );
    for (const patch of [
      { parentCallId: 'wrong-call' },
      { launchCorrelationId: 'old-run' },
      { ref: { ...FIXTURE_CHILD, sourceId: makeSourceId('codex', '/synthetic/home-b') } },
      { ref: { ...FIXTURE_CHILD, harness: 'pi' as const } },
      { kind: 'shell' as const },
      { kind: 'label' as const },
      { kind: 'env' as const },
      { kind: 'private' as const },
    ]) {
      assert.equal(
        validateTranscript({ ...input, candidates: [{ ...input.candidates[0], ...patch }] }).state,
        'rejected'
      );
    }
  },
  'T-01-17': () => {
    const stranger = fixtureContext({ sessionRef: { ...FIXTURE_PARENT, sessionId: 'stranger' } });
    const authority: ControlAuthority = { kind: 'mcp', selection: fixtureSelection(stranger) };
    for (const op of ['resume', 'cancel', 'predecessor'] as const)
      assertDenied(authorizeControl(op, fixtureLink(), sessionOwnerKey(FIXTURE_PARENT), authority));
    assert.equal(fixtureLink().currentOwner, true);
  },
  'T-01-19': () => {
    const runB = fixtureRun({ runId: 'run-b', runSeq: 2, expectedGeneration: 2 });
    const selection = fixtureSelection(fixtureContext({ sessionRef: FIXTURE_CHILD }));
    assert.equal(reportPolicy(fixtureReport(), runB, fixtureBinding(), selection).accepted, false);
    assert.equal(latestReportForRun([{ report: fixtureReport(), seq: 5 }], 'run-b'), null);
    const old = transcript();
    assert.equal(
      validateTranscript({ ...old, launchCallId: 'call-b', launchCorrelationId: 'correlation-b' }).state,
      'rejected'
    );
    assert.equal(
      waitPage(fixedWait({ runId: 'run-b', until: ['report'] }), {
        highWaterSeq: 10,
        events: [event(5, 'run-a', 'report.received')],
        run: runB,
      }).matched,
      false
    );
  },
  'T-01-20': () => {
    const transfer = planHandover(handover(), 'link-b', FIXTURE_NOW + 1);
    assert.equal(transfer.oldLink.state, 'handed_over');
    assert.equal(transfer.oldLink.currentOwner, false);
    assert.equal(transfer.newLink.currentOwner, true);
    assert.equal(transfer.newLink.predecessor, 'link-a');
    assert.equal(sameSessionRef(transfer.newLink.childRef!, FIXTURE_CHILD), true);
    assert.equal([transfer.oldLink, transfer.newLink].filter((link) => link.currentOwner).length, 1);
    assert.equal(transfer.oldLink.childRef, FIXTURE_CHILD);
  },
  'T-01-21': () => {
    assertDenied(handoverGate(handover({ slotHeld: true, currentRun: fixtureRun({ state: 'uncertain' }) })));
    const stranger = fixtureSelection(
      fixtureContext({ sessionRef: { ...FIXTURE_PARENT, sessionId: 'foreign-parent' } })
    );
    const result = handoverGate(handover({ authority: { kind: 'mcp', selection: stranger } }));
    assert.equal(!result.ok && result.reason, 'unsupported');
    assert.throws(() => planHandover(handover({ unresolvedConflict: true }), 'link-b', FIXTURE_NOW), /conflict/);
  },
  'T-01-22': () => {
    assertDenied(handoverGate(handover({ newParentRef: FIXTURE_CHILD })));
    const descendant = { ...FIXTURE_CHILD, sessionId: 'descendant-a' };
    assertDenied(
      handoverGate(
        handover({
          newParentRef: descendant,
          graph: [fixtureLink({ linkId: 'descendant-edge', parentRef: FIXTURE_CHILD, childRef: descendant })],
        })
      )
    );
    assertDenied(handoverGate(handover({ graph: [fixtureLink(), fixtureLink({ linkId: 'duplicate-parent' })] })));
    const cycle = handoverGate(
      handover({ graph: [fixtureLink({ linkId: 'back-edge', parentRef: FIXTURE_CHILD, childRef: FIXTURE_PARENT })] })
    );
    assert.equal(!cycle.ok && cycle.reason, 'cycle');
    assert.throws(() => advanceLink(fixtureLink(), { kind: 'bound', ref: FIXTURE_PARENT, at: FIXTURE_NOW }), /binding/);
  },
  'T-01-24': () => {
    const unbound = fixtureScope({ sessionRef: null, boundBy: null, bindingEvidenceId: null });
    assertDenied(planOwnerAlias(unbound, [], [], 'evidence-a', FIXTURE_NOW));
    const origin = procOwnerKey(FIXTURE_PROCESS_KEY, 1);
    const row = fixtureRecord({ ownerKey: origin, originOwnerKey: origin });
    const merged = planOwnerAlias(fixtureScope(), [], [row], 'evidence-a', FIXTURE_NOW);
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.equal(merged.records[0].ownerKey, sessionOwnerKey(FIXTURE_PARENT));
    assert.equal(merged.records[0].originOwnerKey, origin);
    assert.equal(merged.records[0].outcome, row.outcome);
    assert.equal(merged.records[0].at, row.at);
    assert.equal(JSON.parse(origin)[1], FIXTURE_PROCESS_KEY);
  },
  'T-01-25': () => {
    const alias: OwnerAlias = {
      processKey: FIXTURE_PROCESS_KEY,
      generation: 1,
      sessionRef: FIXTURE_CHILD,
      evidenceId: 'evidence-a',
      createdAt: FIXTURE_NOW,
      closedAt: null,
    };
    assertDenied(planOwnerAlias(fixtureScope(), [alias], [], 'evidence-b', FIXTURE_NOW));
    const from = procOwnerKey(FIXTURE_PROCESS_KEY, 1);
    const rows = [
      fixtureRecord({ ownerKey: from, originOwnerKey: from }),
      fixtureRecord({ paramsDigest: digest('changed') }),
    ];
    assertDenied(planOwnerAlias(fixtureScope(), [], rows, 'evidence-b', FIXTURE_NOW));
    assert.equal(rows[0].ownerKey, from);
    const sameParamsDifferentOutcome = [rows[0], fixtureRecord({ runId: 'different-run' })];
    assertDenied(planOwnerAlias(fixtureScope(), [], sameParamsDifferentOutcome, 'evidence-b', FIXTURE_NOW));
  },
  'T-01-26': () => {
    const first = planOwnerAlias(fixtureScope(), [], [], 'evidence-a', FIXTURE_NOW);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const closed = closeIdentityGeneration(fixtureScope(), [fixtureContext()], [first.alias], FIXTURE_NOW + 1);
    assert.equal(closed.nextGeneration, 2);
    assert.equal(closed.aliases[0].closedAt, FIXTURE_NOW + 1);
    assert.equal(closed.contexts[0].closedAt, FIXTURE_NOW + 1);
    assert.notEqual(procOwnerKey(FIXTURE_PROCESS_KEY, 2), procOwnerKey(FIXTURE_PROCESS_KEY, 1));
    assert.equal(
      lookupIdempotency([fixtureRecord()], procOwnerKey(FIXTURE_PROCESS_KEY, 2), 'request-a', digest('params-a')).kind,
      'new'
    );
    const next = fixtureScope({ generation: 2, sessionRef: FIXTURE_CHILD });
    assert.equal(planOwnerAlias(next, closed.aliases, [], 'evidence-next', FIXTURE_NOW + 2).ok, true);
  },
  'T-01-28': () => {
    for (const topology of ['shared', 'unverified_daemon'] as const) {
      const selected = selectCallContext(fixtureContext(), fixtureCallEvidence({ topology }));
      assert.equal(selected.ok, false);
      assert.equal(redeemClaim(fixtureClaim(), { ...claimRequest(), selection: selected }, FIXTURE_NOW).ok, false);
    }
    // Daemon presence is not a topology classification; verified direct stdio remains usable.
    assert.equal(selectCallContext(fixtureContext(), fixtureCallEvidence()).ok, true);
  },
  'T-01-29': () => {
    const observed = resolveBinding(bindingInput({ hasMcp: false }));
    assert.equal(observed.state, 'pending');
    assert.equal(observed.sessionRef, null);
    assert.equal(reportPolicy(fixtureReport(), fixtureRun(), null, fixtureSelection()).accepted, false);
    assertDenied(
      resumeGate(fixtureResumeGate({ link: fixtureLink({ state: 'pending', childRef: null, currentOwner: false }) }))
    );
  },
  'T-01-30': () => {
    for (const patch of [
      { independentLaunchVerified: false },
      { independentSessionVerified: false },
      { candidateRefs: [] },
      { candidateRefs: [{ ...FIXTURE_CHILD, sessionId: 'fork-a' }] },
    ]) {
      const observed = resolveBinding(bindingInput({ ...patch, hasMcp: false }));
      assert.equal(observed.state, 'pending');
      assert.equal(observed.sessionRef, null);
    }
    const ended = reconcileRun(fixtureRun(), [receipt('scope_reconciled')], FIXTURE_NOW);
    assert.equal(ended.state, 'ended');
    assert.equal(ended.releaseSlot, true);
    assert.equal(resolveBinding(bindingInput({ hasMcp: false })).sessionRef, null);
  },
  'T-01-31': () => {
    assert.equal(resolveBinding(bindingInput({ hasMcp: false, registered: false })).state, 'pending');
    assert.equal(
      reportPolicy(fixtureReport(), fixtureRun(), null, { ok: false, reason: 'identity_unverified', invalidate: false })
        .accepted,
      false
    );
    const registeredButUnclaimed = resolveBinding(bindingInput({ hasMcp: true, registered: true, claimValid: false }));
    assert.equal(registeredButUnclaimed.state, 'pending');
    const lateMcp = redeemClaim(fixtureClaim(), claimRequest(), FIXTURE_NOW);
    assert.equal(lateMcp.ok && lateMcp.handshake, 'claimed');
  },
  'T-01-32': () => {
    for (const envArrived of [true, false]) {
      const plan = claimTransport({
        harness: 'codex',
        hasMcp: true,
        configEnvAvailable: true,
        envArrived,
        taskAlreadyAccepted: true,
      });
      assert.equal(plan.transport, 'config_leaves');
      assert.equal(plan.resubmitTask, false);
    }
    assert.equal(
      claimTransport({
        harness: 'codex',
        hasMcp: true,
        configEnvAvailable: false,
        envArrived: false,
        taskAlreadyAccepted: true,
      }).transport,
      'current_message'
    );
    assert.equal(
      claimTransport({
        harness: 'codex',
        hasMcp: false,
        configEnvAvailable: false,
        envArrived: false,
        taskAlreadyAccepted: true,
      }).transport,
      'unsupported'
    );
  },
  'T-01-35': () => {
    for (const patch of [
      { topology: 'shared' as const },
      { logicalSource: 'native_child' as const },
      { logicalSource: 'missing' as const },
    ]) {
      const selected = selectCallContext(fixtureContext(), fixtureCallEvidence(patch));
      assert.equal(selected.ok, false);
      if (!selected.ok) assert.equal(selected.invalidate, false);
      assert.equal(redeemClaim(fixtureClaim(), { ...claimRequest(), selection: selected }, FIXTURE_NOW).ok, false);
      assertDenied(
        authorizeControl('resume', fixtureLink(), sessionOwnerKey(FIXTURE_PARENT), { kind: 'mcp', selection: selected })
      );
    }
    assert.equal(fixtureContext().generation, 1);
  },
  'T-01-36': () => {
    const switched = selectCallContext(
      fixtureContext(),
      fixtureCallEvidence({ sessionRef: { ...FIXTURE_PARENT, sessionId: 'parent-b' } })
    );
    assert.equal(switched.ok, false);
    if (!switched.ok) {
      assert.equal(switched.invalidate, true);
      assert.equal(switched.nextGeneration, 2);
    }
    assertDenied(selectCallContext(fixtureContext({ closedAt: FIXTURE_NOW }), fixtureCallEvidence()));
    assertDenied(selectCallContext(fixtureContext(), fixtureCallEvidence({ procGeneration: 2 })));
    assertDenied(selectCallContext(fixtureContext(), fixtureCallEvidence({ logicalSource: 'missing' })));
    assertDenied(selectCallContext(fixtureContext(), fixtureCallEvidence({ profileObservesSessionSwitch: false })));
    assert.equal(fixtureLink().childRef, FIXTURE_CHILD);
  },
  'T-01-37': () => {
    const mismatch = resolveBinding(
      bindingInput({ expectedRef: FIXTURE_CHILD, candidateRefs: [{ ...FIXTURE_CHILD, sessionId: 'child-b' }] })
    );
    assert.equal(mismatch.reason, 'resume_ref_mismatch');
    assert.equal(mismatch.sessionRef, null);
    const same = resolveBinding(bindingInput({ expectedRef: FIXTURE_CHILD }));
    assert.equal(same.state, 'bound');
    const resumed = planResume(fixtureResumeGate(), fixtureNextResume(), fixtureClaim(), fixtureBinding());
    assert.equal(resumed.link.state, 'bound');
    assert.equal(resumed.runHandshake.state, 'pending');
    assert.equal(sameSessionRef(resumed.run.targetSessionRef!, FIXTURE_CHILD), true);
  },
  'T-01-38': () => {
    const owner = sessionOwnerKey(FIXTURE_PARENT);
    const valid = authorizeControl('resume', fixtureLink(), owner, fixtureLocalAuthority());
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.deepEqual(valid.actor, {
        kind: 'local_user',
        uid: 1000,
        invocationId: 'invocation-a',
        representedOwner: owner,
      });
      assert.equal('callerId' in valid.actor, false);
    }
    for (const authority of [
      fixtureLocalAuthority({ uid: 1001 }),
      fixtureLocalAuthority({ privatePaths: false }),
      fixtureLocalAuthority({ ledgerOwned: false }),
    ])
      assertDenied(authorizeControl('resume', fixtureLink(), owner, authority));
    assertDenied(authorizeControl('resume', fixtureLink({ parentRef: null }), owner, fixtureLocalAuthority()));
    assertDenied(
      authorizeControl('resume', fixtureLink(), owner, {
        kind: 'mcp',
        selection: { ok: false, reason: 'identity_source_missing', invalidate: false },
      })
    );
  },
  'T-01-39': () => {
    const link = fixtureLink();
    const owner = sessionOwnerKey(FIXTURE_PARENT);
    for (const operation of ['report', 'spawn', 'predecessor'] as const)
      assertDenied(authorizeControl(operation, link, owner, fixtureLocalAuthority()));
    assertDenied(authorizeControl('resume', link, sessionOwnerKey(FIXTURE_CHILD), fixtureLocalAuthority()));
    const oldMcp = { kind: 'mcp' as const, selection: fixtureSelection(fixtureContext({ closedAt: FIXTURE_NOW })) };
    assertDenied(resumeGate(fixtureResumeGate({ authority: oldMcp })));
    assert.equal(resumeGate(fixtureResumeGate({ authority: fixtureLocalAuthority() })).ok, true);
    assert.equal(link.parentCaller, 'caller-a');
    assert.equal(link.parentRef, FIXTURE_PARENT);
  },
  'T-02-2': () => {
    const original = requestDigest('spawn', request());
    for (const patch of [
      { briefContentHash: digest('changed-brief') },
      { mode: 'visible' },
      { promptHash: digest('supplement') },
      { profileDigest: digest('changed-profile') },
    ]) {
      const changed = requestDigest('spawn', { ...request(), ...patch });
      assert.notEqual(changed, original);
      assert.equal(
        lookupIdempotency(
          [fixtureRecord({ paramsDigest: original })],
          sessionOwnerKey(FIXTURE_PARENT),
          'request-a',
          changed
        ).kind,
        'conflict'
      );
    }
    assert.notEqual(requestDigest('resume', request()), original);
    assert.equal(requestDigest('spawn', Object.fromEntries(Object.entries(request()).reverse())), original);
    assert.equal(
      lookupIdempotency(
        [fixtureRecord({ paramsDigest: original })],
        sessionOwnerKey(FIXTURE_CHILD),
        'request-a',
        original
      ).kind,
      'new'
    );
    assert.equal(canonicalJson({ '10': 'a', '2': 'b' }), '{"10":"a","2":"b"}');
    assert.notEqual(digest({ optional: null }), digest({}));
    assert.notEqual(digest(['a', 'b']), digest(['b', 'a']));
    assert.notEqual(digest('é'), digest('e\u0301'));
    for (const value of [NaN, Infinity, -Infinity, undefined]) assert.throws(() => canonicalJson({ value }));
    assert.throws(() => normalizeRequest('spawn', { ...request(), admin: true }), /unknown_request_field/);
    assert.equal(normalizeRequest('spawn', request()).paramsVersion, 1);
    assert.equal(normalizeRequest('spawn', { ...request(), requestKey: '🔑'.repeat(256) }).paramsVersion, 1);
    assert.throws(() => normalizeRequest('spawn', { ...request(), requestKey: '🔑'.repeat(257) }), /request_key/);
  },
  'T-02-9': () => {
    const a = makeRunSlot('run-a', null, 'spawn', true, 'ticket-a', FIXTURE_NOW);
    const b = makeRunSlot('run-b', null, 'spawn', true, 'ticket-b', FIXTURE_NOW);
    const first = planSlotMigration([a, b], 'run-a', FIXTURE_CHILD);
    assert.equal(first.ok, true);
    const conflict = planSlotMigration(first.slots, 'run-b', FIXTURE_CHILD);
    assert.equal(conflict.ok, false);
    assert.deepEqual(conflict.uncertainRunIds.sort(), ['run-a', 'run-b']);
    assert.deepEqual(conflict.slots, first.slots);
    assert.equal(conflict.slots.find((slot) => slot.runId === 'run-b')?.sessionRef, null);
    assert.equal(sameSessionRef(conflict.blockedRef!, FIXTURE_CHILD), true);
    const decision = reconcileRun(
      fixtureRun(),
      [scopeAlive(), launchStarted(), fixtureReconcileEvidence({ kind: 'conflict', cause: 'provisional_conflict' })],
      FIXTURE_NOW
    );
    assert.equal(decision.state, 'uncertain');
    assert.equal(decision.releaseSlot, false);
  },
  'T-02-10': () => {
    const provisional = fixtureRun({ targetSessionRef: null, heartbeatAt: FIXTURE_NOW - 30001 });
    const lost = reconcileRun(provisional, [], FIXTURE_NOW);
    assert.equal(lost.state, 'uncertain');
    assert.equal(lost.releaseSlot, false);
    for (const op of ['resume', 'handover'] as const)
      assert.throws(() => makeRunSlot('run-b', null, op, false, 'ticket-b', FIXTURE_NOW), /real_session_ref/);
    assert.equal(reconcileRun(provisional, [receipt('scope_reconciled')], FIXTURE_NOW).releaseSlot, true);
  },
  'T-02-11': () => {
    const original = fixtureRun();
    const timeout = waitPage(fixedWait({ until: ['report'] }), { highWaterSeq: 0, events: [], run: original }, true);
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.current, original);
    assert.equal(timeout.current.state, 'running');
    assert.equal(timeout.nextSeq, 0);
    const unknownSubmission = fixtureRun({
      state: 'starting',
      launchPhase: 'submitting',
      heartbeatAt: null,
      heartbeatSeq: 0,
      heartbeatMonoMs: null,
    });
    assert.equal(reconcileRun(unknownSubmission, [], FIXTURE_NOW).state, 'uncertain');
    const startup = fixtureRun({ state: 'starting', launchPhase: 'armed' });
    const continuing = reconcileRun(
      startup,
      [
        fixtureReconcileEvidence({
          kind: 'launch',
          childStarted: false,
          originalExecutorValid: true,
          observedAt: FIXTURE_NOW,
        }),
      ],
      FIXTURE_NOW
    );
    assert.equal(continuing.row, 'R-02-7');
    assert.equal(continuing.state, 'starting');
    assert.equal(continuing.releaseSlot, false);
  },
  'T-02-13': () => {
    const oldAlive = fixtureReconcileEvidence(scopeAlive().fact, {
      evidenceId: 'alive-at-t',
      asOf: FIXTURE_NOW,
      observedAt: FIXTURE_NOW + 3000,
    });
    const laterUnknown = fixtureReconcileEvidence(
      { kind: 'scope', state: 'unknown', complete: false, harnessTerminated: false, launchersSealed: false },
      { evidenceId: 'unknown-at-t-plus-1', asOf: FIXTURE_NOW + 1000, observedAt: FIXTURE_NOW + 1100 }
    );
    for (const history of [
      [oldAlive, laterUnknown],
      [laterUnknown, oldAlive],
    ]) {
      const currentUnknown = reconcileRun(fixtureRun(), [...history, launchStarted()], FIXTURE_NOW + 4000);
      assert.equal(currentUnknown.state, 'uncertain');
      assert.equal(currentUnknown.releaseSlot, false);
      assert.deepEqual(currentUnknown.auditEvidenceIds, ['alive-at-t']);
    }
    const goneAtSameTime = fixtureReconcileEvidence(scopeGone().fact, { evidenceId: 'gone-at-t', asOf: FIXTURE_NOW });
    for (const history of [
      [oldAlive, goneAtSameTime],
      [goneAtSameTime, oldAlive],
    ]) {
      const tied = reconcileRun(fixtureRun(), [...history, launchStarted()], FIXTURE_NOW + 4000);
      assert.equal(tied.row, 'R-02-1');
      assert.equal(tied.releaseSlot, false);
    }
    const laterReceipt = fixtureReconcileEvidence(receipt().fact, {
      evidenceId: 'receipt-after-scope-conflict',
      asOf: FIXTURE_NOW + 1000,
    });
    const newerGone = { ...goneAtSameTime, evidenceId: 'gone-after-scope-conflict', asOf: FIXTURE_NOW + 2000 };
    for (const newer of [laterReceipt, laterUnknown, newerGone]) {
      for (const history of [
        [oldAlive, goneAtSameTime, newer],
        [newer, goneAtSameTime, oldAlive],
      ]) {
        const unresolved = reconcileRun(fixtureRun(), [...history, launchStarted()], FIXTURE_NOW + 4000);
        assert.equal(unresolved.row, 'R-02-1');
        assert.equal(unresolved.cause, 'scope_conflict');
        assert.equal(unresolved.releaseSlot, false);
        assert.equal(unresolved.blockNewOperations, true);
        assert.ok(unresolved.evidenceIds.includes(oldAlive.evidenceId));
        assert.ok(unresolved.evidenceIds.includes(goneAtSameTime.evidenceId));
      }
    }
    const terminalReplay = reconcileRun(
      fixtureEndedRun({ terminalEvidenceId: laterReceipt.evidenceId, endedAt: FIXTURE_NOW + 3000 }),
      [newerGone, laterUnknown],
      FIXTURE_NOW + 4000,
      {
        slotHeld: false,
        ticketConsumed: true,
        terminalBasis: { evidence: [oldAlive, goneAtSameTime, laterReceipt], terminalNote: null },
      }
    );
    assert.equal(terminalReplay.row, 'R-02-0');
    assert.equal(terminalReplay.state, 'ended');
    assert.equal(terminalReplay.cause, 'scope_conflict');
    assert.equal(terminalReplay.blockNewOperations, true);
    assert.equal(terminalReplay.releaseSlot, false);
    assert.equal(terminalReplay.emitTransition, false);
    // Same-time missing evidence yields unknown G, without manufacturing a substantive conflict (E04).
    for (const known of [oldAlive, goneAtSameTime]) {
      const unknown = { ...laterUnknown, asOf: FIXTURE_NOW };
      for (const history of [
        [known, unknown],
        [unknown, known],
      ]) {
        const tied = reconcileRun(fixtureRun(), [...history, launchStarted()], FIXTURE_NOW + 4000);
        assert.equal(tied.state, 'uncertain');
        assert.notEqual(tied.row, 'R-02-1');
        assert.equal(tied.cause, 'scope_unknown');
        assert.equal(tied.releaseSlot, false);
      }
    }
    assert.equal(
      reconcileRun(fixtureRun(), [receipt(), { ...laterUnknown, asOf: FIXTURE_NOW }], FIXTURE_NOW + 4000).state,
      'ended'
    );
    const missingTime = fixtureReconcileEvidence(laterUnknown.fact, { evidenceId: 'scope-time-unknown', asOf: null });
    assert.equal(
      reconcileRun(fixtureRun(), [oldAlive, missingTime, launchStarted()], FIXTURE_NOW + 4000).state,
      'uncertain'
    );
    for (const age of [30000, 30001]) {
      for (const state of ['alive', 'gone', 'unknown'] as const) {
        const run = fixtureRun({ heartbeatAt: FIXTURE_NOW - age });
        const group = fixtureReconcileEvidence({
          kind: 'scope',
          state,
          complete: true,
          harnessTerminated: state === 'gone',
          launchersSealed: state === 'gone',
        });
        const result = reconcileRun(run, [group, launchStarted()], FIXTURE_NOW);
        assert.equal(result.state, age === 30000 && state === 'alive' ? 'running' : 'uncertain');
        if (age === 30001) assert.equal(result.row, 'R-02-6');
      }
    }
    assert.equal(heartbeatQuality(FIXTURE_NOW - 30000, FIXTURE_NOW), 'fresh');
    assert.equal(heartbeatQuality(FIXTURE_NOW - 30001, FIXTURE_NOW), 'stale');
    assert.equal(heartbeatQuality(FIXTURE_NOW + 1, FIXTURE_NOW), 'unknown');
    assert.equal(
      reconcileRun(
        fixtureRun(),
        [scopeAlive(), launchStarted(), fixtureReconcileEvidence({ kind: 'supervisor', state: 'dead' })],
        FIXTURE_NOW
      ).cause,
      'supervisor_dead'
    );
    assert.equal(reconcileRun(fixtureRun(), [], FIXTURE_NOW).state, 'uncertain');
    assert.equal(
      reconcileRun(
        fixtureRun({ heartbeatAt: FIXTURE_NOW - 30001 }),
        [receipt('scope_reconciled'), fixtureReconcileEvidence({ kind: 'supervisor', state: 'dead' })],
        FIXTURE_NOW
      ).state,
      'ended'
    );
    assert.equal(reconcileRun(fixtureRun(), [receipt(), scopeAlive()], FIXTURE_NOW).row, 'R-02-1');
    const notExecuted = fixtureRun({ state: 'starting', launchPhase: 'armed' });
    assert.equal(reconcileRun(notExecuted, [scopeGone(), neverSubmitted()], FIXTURE_NOW).state, 'failed');
    for (const asOf of [-1, NaN, FIXTURE_NOW + 1]) {
      const unknownProofTime = reconcileRun(notExecuted, [scopeGone(), { ...neverSubmitted(), asOf }], FIXTURE_NOW);
      assert.equal(unknownProofTime.state, 'uncertain');
      assert.equal(unknownProofTime.releaseSlot, false);
    }
    for (const age of [0, 30000, 30001]) {
      const run = fixtureRun({
        state: 'starting',
        launchPhase: 'reserved',
        supervisor: null,
        scopeRef: null,
        heartbeatAt: null,
        heartbeatSeq: 0,
        heartbeatMonoMs: null,
        createdAt: FIXTURE_NOW - age,
      });
      assert.equal(reconcileRun(run, [], FIXTURE_NOW).state, age <= 30000 ? 'starting' : 'uncertain');
    }
    const cancelled = fixtureRun({ cancelRequestedAt: FIXTURE_NOW - 1 });
    for (const kind of ['receipt', 'scope_reconciled'] as const) {
      for (const timing of [[], [fixtureReconcileEvidence({ kind: 'cancel', chronology: 'unknown' })]]) {
        const ended = reconcileRun(cancelled, [receipt(kind), ...timing], FIXTURE_NOW);
        assert.equal(ended.row, 'R-02-3');
        assert.equal(ended.state, 'ended');
        assert.equal(ended.releaseSlot, true);
        assert.equal(ended.blockNewOperations, false);
        assert.equal(ended.cause, null);
        assert.equal(ended.terminalNote, 'cancel_timing_unknown');
      }
      const unknown = fixtureReconcileEvidence({ kind: 'cancel', chronology: 'unknown' });
      const before = fixtureReconcileEvidence({ kind: 'cancel', chronology: 'before_exit' });
      const after = fixtureReconcileEvidence({ kind: 'cancel', chronology: 'after_exit' });
      for (const timing of [
        [unknown, before],
        [before, unknown],
        [unknown, after],
        [after, unknown],
      ]) {
        const result = reconcileRun(cancelled, [receipt(kind), ...timing], FIXTURE_NOW);
        assert.equal(result.state, timing.includes(before) ? 'cancelled' : 'ended');
        assert.equal(result.terminalNote, null);
        assert.equal(result.releaseSlot, true);
      }
      for (const timing of [
        [before, after],
        [after, before],
      ]) {
        const result = reconcileRun(cancelled, [receipt(kind), ...timing], FIXTURE_NOW);
        assert.equal(result.row, 'R-02-1');
        assert.equal(result.releaseSlot, false);
        assert.equal(result.terminalNote, null);
      }
    }
    // A failed historical control channel does not invalidate a later complete termination proof.
    assert.equal(
      reconcileRun(
        cancelled,
        [receipt(), fixtureReconcileEvidence({ kind: 'cancel_channel', valid: false })],
        FIXTURE_NOW
      ).state,
      'ended'
    );
    for (const facts of [[scopeAlive(), launchStarted()], []]) {
      const active = reconcileRun(cancelled, facts, FIXTURE_NOW);
      assert.equal(active.releaseSlot, false);
      assert.equal(active.terminalNote, null);
    }
    assert.equal(
      reconcileRun(
        cancelled,
        [receipt(), fixtureReconcileEvidence({ kind: 'cancel', chronology: 'before_exit' })],
        FIXTURE_NOW
      ).state,
      'cancelled'
    );
    assert.equal(
      reconcileRun(
        cancelled,
        [receipt(), fixtureReconcileEvidence({ kind: 'cancel', chronology: 'after_exit' })],
        FIXTURE_NOW
      ).state,
      'ended'
    );
  },
  'T-02-17': () => {
    const oldAlive = fixtureReconcileEvidence(scopeAlive().fact, {
      evidenceId: 'old-alive',
      asOf: FIXTURE_NOW,
      observedAt: FIXTURE_NOW + 4000,
    });
    const laterEnd = fixtureReconcileEvidence(receipt().fact, {
      evidenceId: 'later-end-proof',
      asOf: FIXTURE_NOW + 1000,
      observedAt: FIXTURE_NOW + 1100,
    });
    for (const history of [
      [oldAlive, laterEnd],
      [laterEnd, oldAlive],
    ]) {
      const ended = reconcileRun(fixtureRun(), history, FIXTURE_NOW + 5000);
      assert.equal(ended.state, 'ended');
      assert.equal(ended.releaseSlot, true);
      assert.deepEqual(ended.evidenceIds, ['later-end-proof']);
      assert.deepEqual(ended.auditEvidenceIds, ['old-alive']);
    }
    const laterAlive = fixtureReconcileEvidence(scopeAlive().fact, {
      evidenceId: 'alive-after-end-proof',
      asOf: FIXTURE_NOW + 2000,
      observedAt: FIXTURE_NOW + 2100,
    });
    const latestUnknown = fixtureReconcileEvidence(
      { kind: 'scope', state: 'unknown', complete: false, harnessTerminated: false, launchersSealed: false },
      { evidenceId: 'latest-unknown', asOf: FIXTURE_NOW + 3000, observedAt: FIXTURE_NOW + 3100 }
    );
    const lateImportedEnd = { ...laterEnd, observedAt: FIXTURE_NOW + 4500 };
    for (const history of [
      [lateImportedEnd, laterAlive],
      [laterAlive, lateImportedEnd],
      [laterAlive, latestUnknown, lateImportedEnd],
    ]) {
      const conflict = reconcileRun(fixtureRun(), history, FIXTURE_NOW + 5000);
      assert.equal(conflict.row, 'R-02-1');
      assert.equal(conflict.releaseSlot, false);
      assert.equal(conflict.evidenceIds.includes(laterAlive.evidenceId), true);
      assert.equal(conflict.blockNewOperations, true);
    }
    const immutableTerminal = reconcileRun(fixtureEndedRun(), [lateImportedEnd, laterAlive], FIXTURE_NOW + 5000);
    assert.equal(immutableTerminal.state, 'ended');
    assert.equal(immutableTerminal.blockNewOperations, true);
    const tiedAlive = { ...laterAlive, asOf: laterEnd.asOf };
    assert.equal(reconcileRun(fixtureRun(), [laterEnd, tiedAlive], FIXTURE_NOW + 5000).row, 'R-02-1');
    for (const asOf of [null, -1, NaN, FIXTURE_NOW + 5001]) {
      const unknownTime = reconcileRun(fixtureRun(), [{ ...laterEnd, asOf }], FIXTURE_NOW + 5000);
      assert.equal(unknownTime.state, 'uncertain');
      assert.equal(unknownTime.releaseSlot, false);
    }
    const q = fixtureReconcileEvidence(receipt('scope_reconciled').fact, {
      evidenceId: 'q-with-unknown-native',
      asOf: FIXTURE_NOW + 1000,
    });
    const r7 = fixtureReconcileEvidence(
      {
        kind: 'receipt',
        complete: true,
        harnessTerminated: true,
        launchersSealed: true,
        nativeExit: { code: 7, signal: null, source: 'wait_status' },
      },
      { evidenceId: 'r-with-native-7', asOf: FIXTURE_NOW + 1000 }
    );
    for (const history of [
      [q, r7],
      [r7, q],
    ]) {
      const compatible = reconcileRun(fixtureRun(), history, FIXTURE_NOW + 5000);
      assert.equal(compatible.state, 'ended');
      assert.equal(compatible.exitCode, 7);
      assert.equal(compatible.exitSignal, null);
      assert.equal(compatible.exitSource, 'wait_status');
    }
    const r0 = fixtureReconcileEvidence(
      {
        kind: 'receipt',
        complete: true,
        harnessTerminated: true,
        launchersSealed: true,
        nativeExit: { code: 0, signal: null, source: 'trusted_harness_result' },
      },
      { evidenceId: 'r-with-native-0', asOf: FIXTURE_NOW + 1000 }
    );
    const r7AlternativeSource = fixtureReconcileEvidence(
      {
        kind: 'receipt',
        complete: true,
        harnessTerminated: true,
        launchersSealed: true,
        nativeExit: { code: 7, signal: null, source: 'trusted_harness_result' },
      },
      { evidenceId: 'alternative-r-with-native-7', asOf: FIXTURE_NOW + 1000 }
    );
    const sources = new Set<string | null>();
    for (const history of [
      [r7, r7AlternativeSource],
      [r7AlternativeSource, r7],
    ]) {
      const compatible = reconcileRun(fixtureRun(), history, FIXTURE_NOW + 5000);
      assert.equal(compatible.state, 'ended');
      assert.equal(compatible.exitCode, 7);
      sources.add(compatible.exitSource);
    }
    assert.equal(sources.size, 1);
    for (const history of [
      [r7, r0],
      [r0, r7],
      [q, r0, r7],
    ]) {
      const conflictingNative = reconcileRun(fixtureRun(), history, FIXTURE_NOW + 5000);
      assert.equal(conflictingNative.row, 'R-02-1');
      assert.equal(conflictingNative.releaseSlot, false);
      assert.equal(conflictingNative.exitCode, null);
    }
    for (const patch of [
      { runId: 'run-old' },
      { sourceId: makeSourceId('codex', '/synthetic/home-b') },
      { bindingGeneration: 0 },
      { supervisor: { ...FIXTURE_SUPERVISOR, proc_start: 'old-start' } },
      { validation: 'pending' as const },
    ]) {
      const stale = fixtureReconcileEvidence(receipt().fact, patch);
      const result = reconcileRun(fixtureRun(), [stale], FIXTURE_NOW);
      assert.equal(result.state, 'uncertain');
      assert.deepEqual(result.evidenceIds, []);
      assert.deepEqual(result.auditEvidenceIds, [stale.evidenceId]);
    }
    assert.equal(reconcileRun(fixtureRun(), [receipt(), scopeAlive()], FIXTURE_NOW).state, 'uncertain');
    assert.equal(reconcileRun(fixtureRun(), [neverSubmitted(), scopeGone()], FIXTURE_NOW).state, 'uncertain');
    for (const kind of ['receipt', 'scope_reconciled'] as const) {
      const result = reconcileRun(
        fixtureRun({ launchPhase: 'submitting' }),
        [neverSubmitted(), scopeGone(), receipt(kind)],
        FIXTURE_NOW
      );
      assert.equal(result.row, 'R-02-1');
      assert.equal(result.releaseSlot, false);
    }
    const repeated = reconcileRun(fixtureEndedRun(), [receipt()], FIXTURE_NOW + 1);
    assert.equal(repeated.state, 'ended');
    assert.equal(repeated.emitTransition, false);
    assert.equal(repeated.releaseSlot, false);
    const contradicted = reconcileRun(fixtureEndedRun(), [receipt(), scopeAlive()], FIXTURE_NOW + 1);
    assert.equal(contradicted.state, 'ended');
    assert.equal(contradicted.blockNewOperations, true);
    assert.equal(contradicted.cause, 'scope_conflict');
    // Incremental callers load the verified terminal basis, never substitute the import/commit time.
    const savedTerminal = fixtureEndedRun();
    const terminalBasis = {
      evidence: [{ ...receipt(), evidenceId: savedTerminal.terminalEvidenceId! }],
      terminalNote: null,
    };
    const ownership = { slotHeld: false, ticketConsumed: true, terminalBasis };
    for (const offset of [-1, 0, 1000]) {
      const incrementalAlive = fixtureReconcileEvidence(scopeAlive().fact, {
        evidenceId: `incremental-alive-${offset}`,
        asOf: FIXTURE_NOW + offset,
        observedAt: FIXTURE_NOW + 1500,
      });
      const result = reconcileRun(savedTerminal, [incrementalAlive], FIXTURE_NOW + 2000, ownership);
      assert.equal(result.row, 'R-02-0');
      assert.equal(result.state, 'ended');
      assert.equal(result.blockNewOperations, offset >= 0);
      assert.equal(result.cause, offset >= 0 ? 'scope_conflict' : null);
      assert.equal(result.emitTransition, false);
      assert.equal(result.releaseSlot, false);
      if (offset < 0) {
        assert.deepEqual(result.auditEvidenceIds, [incrementalAlive.evidenceId]);
        assert.deepEqual(result.evidenceIds, [savedTerminal.terminalEvidenceId]);
      }
    }
    const delayedCommit = fixtureEndedRun({ endedAt: FIXTURE_NOW + 4500, terminalEvidenceId: laterEnd.evidenceId });
    const delayedOwnership = {
      ...ownership,
      terminalBasis: { evidence: [laterEnd], terminalNote: 'cancel_timing_unknown' as const },
    };
    const incremental = reconcileRun(delayedCommit, [laterAlive], FIXTURE_NOW + 5000, delayedOwnership);
    assert.equal(incremental.state, 'ended');
    assert.equal(incremental.blockNewOperations, true);
    assert.equal(incremental.cause, 'scope_conflict');
    assert.equal(incremental.terminalNote, 'cancel_timing_unknown');
    assert.equal(incremental.releaseSlot, false);
    const replayed = reconcileRun(
      delayedCommit,
      [fixtureReconcileEvidence({ kind: 'cancel', chronology: 'before_exit' })],
      FIXTURE_NOW + 5000,
      delayedOwnership
    );
    assert.equal(replayed.state, 'ended');
    assert.equal(replayed.terminalNote, 'cancel_timing_unknown');
    assert.equal(replayed.emitTransition, false);
    assert.equal(reconcileRun(delayedCommit, [laterAlive], FIXTURE_NOW + 5000).blockNewOperations, true);
    for (const asOf of [null, -1, NaN, FIXTURE_NOW + 2001]) {
      const incomparableAlive = fixtureReconcileEvidence(scopeAlive().fact, { asOf });
      const result = reconcileRun(savedTerminal, [incomparableAlive], FIXTURE_NOW + 2000);
      assert.equal(result.state, 'ended');
      assert.equal(result.blockNewOperations, true);
      assert.equal(result.releaseSlot, false);
    }
    for (const state of ['ended', 'cancelled'] as const) {
      const savedNative = fixtureEndedRun({ state, exitCode: 7, exitSignal: null, exitSource: 'wait_status' });
      const nativeConflict = reconcileRun(savedNative, [r0], FIXTURE_NOW + 2000);
      assert.equal(nativeConflict.row, 'R-02-0');
      assert.equal(nativeConflict.state, state);
      assert.equal(nativeConflict.blockNewOperations, true);
      assert.equal(nativeConflict.cause, 'scope_conflict');
      assert.equal(nativeConflict.exitCode, 7);
      assert.equal(nativeConflict.exitSignal, null);
      assert.equal(nativeConflict.exitSource, 'wait_status');
      assert.equal(nativeConflict.releaseSlot, false);
      for (const compatible of [r7, r7AlternativeSource, q]) {
        const result = reconcileRun(savedNative, [compatible], FIXTURE_NOW + 2000);
        assert.equal(result.state, state);
        assert.equal(result.blockNewOperations, false);
        assert.equal(result.exitCode, 7);
        assert.equal(result.exitSource, 'wait_status');
      }
    }
    const savedSignal = fixtureEndedRun({ exitCode: null, exitSignal: 'SIGTERM', exitSource: 'wait_status' });
    const sameSignal = fixtureReconcileEvidence(
      {
        kind: 'receipt',
        complete: true,
        harnessTerminated: true,
        launchersSealed: true,
        nativeExit: { code: null, signal: 'SIGTERM', source: 'trusted_harness_result' },
      },
      { asOf: FIXTURE_NOW + 1000 }
    );
    assert.equal(reconcileRun(savedSignal, [sameSignal], FIXTURE_NOW + 2000).blockNewOperations, false);
    const signalConflict = reconcileRun(savedSignal, [r7], FIXTURE_NOW + 2000);
    assert.equal(signalConflict.blockNewOperations, true);
    assert.equal(signalConflict.exitCode, null);
    assert.equal(signalConflict.exitSignal, 'SIGTERM');
    assert.equal(signalConflict.exitSource, 'wait_status');
    const unknownStoredResult = reconcileRun(savedTerminal, [r7], FIXTURE_NOW + 2000);
    assert.equal(unknownStoredResult.blockNewOperations, false);
    assert.equal(unknownStoredResult.exitCode, null);
    assert.equal(unknownStoredResult.exitSource, null);
    const savedNonExecution = fixtureEndedRun({
      state: 'failed',
      launchPhase: 'never_submitted',
      scopeRef: null,
      startedAt: null,
    });
    const incrementalStarted = fixtureReconcileEvidence(
      { kind: 'launch', childStarted: true, originalExecutorValid: true, observedAt: FIXTURE_NOW + 1000 },
      { asOf: FIXTURE_NOW + 1000 }
    );
    for (const executionProof of [r0, q, incrementalStarted]) {
      const result = reconcileRun(savedNonExecution, [executionProof], FIXTURE_NOW + 2000);
      assert.equal(result.row, 'R-02-0');
      assert.equal(result.state, 'failed');
      assert.equal(result.blockNewOperations, true);
      assert.equal(result.cause, 'scope_conflict');
      assert.equal(result.exitCode, null);
      assert.equal(result.exitSignal, null);
      assert.equal(result.exitSource, null);
      assert.equal(result.emitTransition, false);
      assert.equal(result.releaseSlot, false);
    }
  },
  'T-02-18': () => {
    const first = planHandover(handover(), 'link-b', FIXTURE_NOW);
    assertDenied(handoverGate(handover({ link: first.oldLink, graph: [first.oldLink, first.newLink] })));
    assert.equal(first.newLink.currentOwner, true);
    assertDenied(handoverGate(handover({ slotHeld: true })));
    const stranger = fixtureSelection(
      fixtureContext({ sessionRef: { ...FIXTURE_PARENT, sessionId: 'foreign-owner' } })
    );
    assertDenied(handoverGate(handover({ authority: { kind: 'mcp', selection: stranger } })));
  },
  'T-02-19': () => {
    const a = fixtureRun();
    const resolved = resolveWaitTarget({ linkId: 'link-a', until: ['report'], afterSeq: 2 }, [a], () => true);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const b = fixtureRun({ runId: 'run-b', runSeq: 2 });
    const page = waitPage(resolved.fixed, {
      highWaterSeq: 10,
      run: a,
      events: [event(3, b.runId, 'report.received'), event(4, a.runId, 'report.received'), event(9, null)],
    });
    assert.equal(page.runId, 'run-a');
    assert.deepEqual(
      page.events.map((entry) => entry.seq),
      [4]
    );
    assert.equal(page.nextSeq, 4);
    assert.equal(page.matched, true);
    assert.deepEqual(effectiveWaitMs(120000, 60000, 2000), { effectiveWaitMs: 58000, reason: null });
    const continuation = waitPage(
      { ...resolved.fixed, afterSeq: page.nextSeq },
      { highWaterSeq: 10, run: a, events: [] },
      true
    );
    assert.equal(continuation.nextSeq, 4);
    assert.equal(continuation.current.state, 'running');
  },
  'T-02-20': () => {
    for (const operation of ['jev_send', 'browser_control'] as const)
      assert.deepEqual(mvpOperationPolicy(operation), { allowed: false, reason: 'unsupported', dispatches: 0 });
    for (const outcome of ['needs_human', 'unknown'] as const)
      for (const reconciled of [false, true])
        assert.equal(leaseReleasePolicy({ kind: 'browser', outcome, reconciled }), 'hold');
    assert.equal(leaseReleasePolicy({ kind: 'browser', outcome: 'answered', reconciled: false }), 'hold');
  },
  'T-02-23': () => {
    const slot = makeRunSlot('run-a', FIXTURE_CHILD, 'spawn', true, 'ticket-a', FIXTURE_NOW);
    assert.equal(Object.hasOwn(slot, 'expiresAt'), false);
    assert.equal(Object.hasOwn(slot, 'expires_at'), false);
    assert.equal(leaseReleasePolicy({ kind: 'run', terminalProof: false }), 'hold');
    assert.equal(leaseReleasePolicy({ kind: 'collect', expired: true, clockKnown: true }), 'takeover');
    assert.equal(leaseReleasePolicy({ kind: 'collect', expired: true, clockKnown: false }), 'read_only');
    assert.equal(slot.runId, 'run-a');
  },
  'T-02-27': () => {
    for (const patch of [
      { topology: 'shared' as const },
      { logicalSource: 'native_child' as const },
      { logicalSource: 'missing' as const },
    ]) {
      const selection = selectCallContext(fixtureContext(), fixtureCallEvidence(patch));
      const gate = fixtureResumeGate({ authority: { kind: 'mcp', selection } });
      const result = prepareResume(gate, [fixtureRecord()], 'request-a', digest('params-a'));
      assert.equal(result.kind, 'rejected');
      assert.equal(reportPolicy(fixtureReport(), fixtureRun(), fixtureBinding(), selection).accepted, false);
    }
  },
  'T-02-28': () => {
    const run = fixtureRun({ operation: 'resume' });
    const other = { ...FIXTURE_CHILD, sessionId: 'child-b' };
    assert.throws(() => updateRun(run, { targetSessionRef: other }), /known_target/);
    assert.throws(() => updateRun(run, { supervisionStrategy: 'wrapper' }), /scope_immutable/);
    assert.throws(() => updateRun(run, { scopeRef: { ...FIXTURE_SCOPE, pgid: 200 } }), /scope_immutable/);
    const beforeDiscovery = fixtureRun({ scopeRef: null });
    assert.equal(updateRun(beforeDiscovery, { scopeRef: FIXTURE_SCOPE }).scopeRef, FIXTURE_SCOPE);
    assert.throws(() => updateRun(beforeDiscovery, { scopeKind: 'other' as 'pgid' }), /scope_immutable/);
    const rejected = resolveBinding(bindingInput({ expectedRef: run.targetSessionRef, candidateRefs: [other] }));
    assert.equal(rejected.reason, 'resume_ref_mismatch');
    assert.equal(sameSessionRef(run.targetSessionRef!, FIXTURE_CHILD), true);
  },
  'T-02-30': () => {
    for (const launchCwd of ['', 'relative/repo', '/synthetic/../repo', '/synthetic//repo'])
      assert.throws(() => validateRun(fixtureRun({ launchCwd })), /absolute/);
    assert.throws(() => validateRun({ ...fixtureRun(), launchCwd: undefined } as unknown as Run), /absolute/);
    assert.throws(() => updateRun(fixtureRun(), { launchCwd: '/synthetic/repo-b' }), /launch_context/);
    const oldRun = fixtureEndedRun();
    const resumed = planResume(
      fixtureResumeGate({ currentRun: oldRun }),
      fixtureNextResume({ launchCwd: '/synthetic/repo-b' }),
      null,
      null
    );
    assert.equal(resumed.run.launchCwd, '/synthetic/repo-b');
    assert.equal(oldRun.launchCwd, '/synthetic/repo-a');
  },
  'T-02-31': () => {
    const origin = { repoId: digest('declared-origin'), basis: 'declared' as const, declaredAt: FIXTURE_NOW };
    const original = fixtureRun({ projectOrigin: origin });
    const snapshot = fixtureWorkspace({
      worktreeRoot: null,
      gitCommonDir: null,
      repoId: null,
      gitCapturedAt: null,
      gitMissingReason: 'timeout',
    });
    const captured = captureWorkspace(original, snapshot, FIXTURE_NOW + 1);
    assert.equal(captured.run.workspaceSnapshot?.gitMissingReason, 'timeout');
    assert.equal(captured.run.projectOrigin, origin);
    assert.equal(captured.event.kind, 'workspace.captured');
    assert.equal(captured.event.runId, original.runId);
    assert.equal(captured.restartHarness, false);
    assert.throws(() => captureWorkspace(captured.run, fixtureWorkspace(), FIXTURE_NOW + 2), /already_captured/);
    assert.throws(() => updateRun(captured.run, { workspaceSnapshot: null }), /first_capture/);
    assert.equal(original.workspaceSnapshot, null);
  },
  'T-02-32': () => {
    const metadata = ledgerMetadataChange(null, 'initialize', 'synthetic-ledger-a');
    assert.equal(ledgerMetadataChange(metadata, 'restore'), metadata);
    for (const operation of ['initialize', 'replace', 'delete'] as const)
      assert.throws(() => ledgerMetadataChange(metadata, operation, 'replacement'), /immutable/);
    const other = ledgerMetadataChange(null, 'initialize', 'synthetic-ledger-b');
    assert.notEqual(`${metadata.ledgerId}:run-a`, `${other.ledgerId}:run-a`);
    assert.throws(() => ledgerMetadataChange(null, 'initialize', ''), /immutable/);
  },
  'T-02-33': () => {
    const params = { ...request(), originRepoId: digest('origin') };
    const a = prepareRunContext('spawn', params, {
      workspaceSnapshot: null,
      projectOrigin: { repoId: digest('origin'), basis: 'declared', declaredAt: FIXTURE_NOW },
    });
    const b = prepareRunContext('spawn', params, {
      workspaceSnapshot: fixtureWorkspace({ worktree: 'changed-name', gitCapturedAt: FIXTURE_NOW + 1000 }),
      projectOrigin: { repoId: digest('origin'), basis: 'declared', declaredAt: FIXTURE_NOW + 1000 },
    });
    assert.equal(a.paramsDigest, b.paramsDigest);
    assert.notDeepEqual(a.workspaceSnapshot, b.workspaceSnapshot);
    assert.notEqual(requestDigest('spawn', { ...params, launchCwd: '/synthetic/repo-b' }), a.paramsDigest);
    assert.notEqual(requestDigest('spawn', { ...params, originRepoId: digest('other-origin') }), a.paramsDigest);
    assert.throws(
      () =>
        prepareRunContext('spawn', request(), {
          workspaceSnapshot: null,
          projectOrigin: { repoId: digest('origin'), basis: 'declared', declaredAt: FIXTURE_NOW },
        }),
      /origin_request_mismatch/
    );
    const history = fixtureRun({ workspaceSnapshot: fixtureWorkspace() });
    assert.equal(history.launchCwd, '/synthetic/repo-a');
    assert.equal(history.workspaceSnapshot?.gitCapturedAt, FIXTURE_NOW);
  },
  'T-02-34': () => {
    const params = { ...request(), linkId: 'link-a', expectedRun: 'run-a' };
    const hash = requestDigest('resume', params);
    const record = fixtureRecord({ paramsDigest: hash });
    const gate = fixtureResumeGate({
      authority: fixtureLocalAuthority(),
      currentRun: fixtureEndedRun({ runId: 'run-b', runSeq: 2 }),
    });
    const replay = prepareResume(gate, [record], 'request-a', hash);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') assert.equal(replay.record, record);
    const stale = prepareResume(gate, [record], 'fresh-key', hash);
    assert.equal(stale.kind === 'rejected' && stale.reason, 'expected_run_mismatch');
    for (const changed of [
      { ...params, expectedRun: 'run-b' },
      { ...params, mode: 'visible' },
    ])
      assert.equal(prepareResume(gate, [record], 'request-a', requestDigest('resume', changed)).kind, 'rejected');
    assert.equal(
      prepareResume({ ...gate, authority: fixtureLocalAuthority({ privatePaths: false }) }, [record], 'request-a', hash)
        .kind,
      'rejected'
    );
  },
  'T-03-1': () => {
    const initial = fixtureLink({
      state: 'pending',
      childRef: null,
      currentOwner: false,
      claimedAt: null,
      boundAt: null,
    });
    const declaration = redeemClaim(fixtureClaim(), claimRequest(), FIXTURE_NOW);
    assert.equal(declaration.ok && declaration.handshake, 'claimed');
    const claimed = advanceLink(initial, { kind: 'claimed', at: FIXTURE_NOW });
    assert.equal(claimed.state, 'claimed');
    assert.equal(claimed.childRef, null);
    const evidence = resolveBinding(bindingInput());
    assert.equal(evidence.state, 'bound');
    const bound = advanceLink(claimed, { kind: 'bound', ref: evidence.sessionRef!, at: FIXTURE_NOW + 1 });
    assert.equal(bound.state, 'bound');
    assert.equal(bound.currentOwner, true);
    assert.equal(resolveBinding(bindingInput({ hasMcp: false })).sessionRef, null);
    assert.throws(() => validateRun(fixtureRun({ state: 'pending' as Run['state'] })), /invalid_run_state/);
  },
  'T-03-2': () => {
    const run = fixtureRun();
    const selection = fixtureSelection(fixtureContext({ sessionRef: FIXTURE_CHILD }));
    for (const status of ['completed', 'failed', 'blocked', 'interrupted'] as ReportStatus[]) {
      const report = fixtureReport({ status });
      assert.equal(reportPolicy(report, run, fixtureBinding(), selection).accepted, true);
      assert.equal(linkAfterReport(fixtureLink(), report, run).state, 'reported');
      const active = reconcileRun(run, [scopeAlive(), launchStarted()], FIXTURE_NOW);
      assert.equal(active.state, 'running');
      assert.equal(active.releaseSlot, false);
    }
    assert.equal(isRunTerminal(run), false);
  },
  'T-03-3': () => {
    const run = fixtureRun({ state: 'starting', launchPhase: 'armed' });
    const failure = reconcileRun(run, [scopeGone(), neverSubmitted()], FIXTURE_NOW);
    assert.equal(failure.state, 'failed');
    const pending = fixtureLink({ state: 'pending', childRef: null, currentOwner: false });
    assert.equal(advanceLink(pending, { kind: 'non_execution', firstRun: true }).state, 'failed');
    assert.equal(advanceLink(fixtureLink(), { kind: 'non_execution', firstRun: false }).state, 'bound');
    const nonzero = fixtureReconcileEvidence({
      kind: 'receipt',
      complete: true,
      harnessTerminated: true,
      launchersSealed: true,
      nativeExit: { code: 7, signal: null, source: 'wait_status' },
    });
    const ended = reconcileRun(fixtureRun(), [nonzero], FIXTURE_NOW);
    assert.equal(ended.state, 'ended');
    assert.equal(ended.exitCode, 7);
    assert.equal(advanceLink(fixtureLink(), { kind: 'non_execution', firstRun: false }).currentOwner, true);
  },
  'T-03-4': () => {
    const original = fixtureLink();
    const revoked = advanceLink(original, { kind: 'revoke' });
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.currentOwner, false);
    assert.equal(revoked.childRef, original.childRef);
    const stillAlive = reconcileRun(
      fixtureRun(),
      [scopeAlive(), fixtureReconcileEvidence({ kind: 'conflict', cause: 'identity_conflict' })],
      FIXTURE_NOW
    );
    assert.equal(stillAlive.state, 'uncertain');
    assert.equal(stillAlive.releaseSlot, false);
    assertDenied(resumeGate(fixtureResumeGate({ link: revoked })));
  },
  'T-03-5': () => {
    for (const state of ['bound', 'reported'] as const) {
      const plan = planResume(
        fixtureResumeGate({ link: fixtureLink({ state }) }),
        fixtureNextResume(),
        fixtureClaim(),
        fixtureBinding()
      );
      assert.equal(plan.link.state, 'bound');
      assert.equal(plan.link.linkId, 'link-a');
      assert.equal(plan.run.runSeq, 2);
      assert.equal(plan.run.state, 'starting');
      assert.equal(plan.runHandshake.state, 'pending');
      assert.equal(plan.revokedClaim?.state, 'revoked');
      assert.equal(plan.revokedBinding?.revokedAt, FIXTURE_NOW + 1000);
      assert.notEqual(plan.claim.claimHash, fixtureClaim().claimHash);
      assert.equal(plan.run.launchMessageId, null);
    }
    assert.throws(
      () => planResume(fixtureResumeGate(), fixtureNextResume({ bindingGeneration: 1 }), null, null),
      /new_run_anchors/
    );
  },
  'T-03-6': () => {
    const historical = fixtureLink({ state: 'closed', closedAt: FIXTURE_NOW });
    const gate = resumeGate(fixtureResumeGate({ link: historical }));
    assert.equal(!gate.ok && gate.reason, 'deferred');
    assert.deepEqual(mvpOperationPolicy('close'), { allowed: false, reason: 'unsupported', dispatches: 0 });
    assert.equal(historical.state, 'closed');
    assert.throws(
      () => planResume(fixtureResumeGate({ link: historical }), fixtureNextResume(), null, null),
      /deferred/
    );
  },
  'T-03-7': () => {
    const link = fixtureLink();
    const base = [
      '/synthetic/brief-a.md',
      digest('brief-a'),
      'synthetic-backend',
      FIXTURE_SOURCE,
      'implementer',
    ] as const;
    for (const changed of [
      taskDigest(base[0], digest('new-content'), base[2], base[3], base[4]),
      taskDigest('/synthetic/other-task.md', base[1], base[2], base[3], base[4]),
      taskDigest(base[0], base[1], base[2], base[3], 'reviewer'),
      taskDigest(base[0], base[1], base[2], makeSourceId('codex', '/synthetic/home-b'), base[4]),
    ]) {
      const result = resumeGate(fixtureResumeGate({ taskDigest: changed }));
      assert.equal(!result.ok && result.reason, 'task_mismatch');
    }
    assert.equal(resumeGate(fixtureResumeGate({ taskDigest: taskDigest(...base) })).ok, true);
    assert.notEqual(
      requestDigest('resume', { ...request(), promptHash: digest('new-supplement') }),
      requestDigest('resume', request())
    );
    assert.equal(link.taskDigest, taskDigest(...base));
  },
  'T-03-8': () => {
    const run = fixtureRun({ operation: 'resume' });
    const fork = { ...FIXTURE_CHILD, sessionId: 'fork-new-id' };
    const result = resolveBinding(bindingInput({ expectedRef: run.targetSessionRef, candidateRefs: [fork] }));
    assert.equal(result.state, 'conflict');
    assert.equal(result.reason, 'resume_ref_mismatch');
    assert.deepEqual(result.candidates, [fork]);
    assert.equal(result.sessionRef, null);
    assert.throws(() => updateRun(run, { targetSessionRef: fork }), /known_target/);
    assert.throws(() => advanceLink(fixtureLink(), { kind: 'bound', ref: fork, at: FIXTURE_NOW }), /binding/);
    assert.equal(
      reconcileRun(run, [fixtureReconcileEvidence({ kind: 'conflict', cause: 'resume_ref_mismatch' })], FIXTURE_NOW)
        .state,
      'uncertain'
    );
  },
  'T-03-9': () => {
    const transfer = planHandover(handover(), 'link-b', FIXTURE_NOW);
    const wrong = resolveBinding(
      bindingInput({
        expectedRef: transfer.newLink.childRef,
        candidateRefs: [{ ...FIXTURE_CHILD, sessionId: 'new-file-id' }],
      })
    );
    assert.equal(wrong.reason, 'resume_ref_mismatch');
    const provedContinuation = resolveBinding(bindingInput({ expectedRef: transfer.newLink.childRef }));
    assert.equal(provedContinuation.state, 'bound');
    assert.equal(sameSessionRef(provedContinuation.sessionRef!, FIXTURE_CHILD), true);
    assert.equal(
      resolveBinding(bindingInput({ expectedRef: FIXTURE_CHILD, independentSessionVerified: false })).state,
      'claimed'
    );
  },
  'T-03-10': () => {
    const child = fixtureSelection(fixtureContext({ sessionRef: FIXTURE_CHILD }));
    assert.equal(reportPolicy(fixtureReport(), fixtureRun(), fixtureBinding(), child).accepted, true);
    for (const binding of [
      null,
      fixtureBinding({ isCurrent: false, revokedAt: FIXTURE_NOW }),
      fixtureBinding({ sessionRef: FIXTURE_PARENT }),
      fixtureBinding({ callerContextId: 'other-context' }),
      fixtureBinding({ contextGeneration: 2 }),
      fixtureBinding({ bindingGeneration: 2 }),
    ])
      assert.equal(reportPolicy(fixtureReport(), fixtureRun(), binding, child).accepted, false);
    for (const report of [
      fixtureReport({ callerContextId: 'other-context' }),
      fixtureReport({ contextGeneration: 2 }),
      fixtureReport({ runId: 'run-b' }),
      fixtureReport({ path: 'relative-report' }),
    ])
      assert.equal(reportPolicy(report, fixtureRun(), fixtureBinding(), child).accepted, false);
    assert.equal(
      reportPolicy(fixtureReport(), fixtureRun(), fixtureBinding(), {
        ok: false,
        reason: 'identity_source_missing',
        invalidate: false,
      }).accepted,
      false
    );
  },
  'T-03-11': () => {
    const report = fixtureReport();
    const child = fixtureSelection(fixtureContext({ sessionRef: FIXTURE_CHILD }));
    assert.equal(reportPolicy(report, fixtureRun(), fixtureBinding(), child).accepted, true);
    const reported = linkAfterReport(fixtureLink(), report, fixtureRun());
    const resumed = planResume(
      fixtureResumeGate({ link: reported }),
      fixtureNextResume(),
      fixtureClaim(),
      fixtureBinding()
    );
    assert.equal(reportPolicy(report, fixtureRun(), resumed.revokedBinding, child).accepted, false);
    assert.equal(latestReportForRun([{ report, seq: 10 }], resumed.run.runId), null);
    assert.equal(resumed.runHandshake.state, 'pending');
    assert.equal(linkAfterReport(resumed.link, report, resumed.run).state, 'bound');
  },
  'T-03-12': () => {
    const old = fixtureReport();
    const committed = [
      { report: old, seq: 2 },
      { report: old, seq: 2 },
      { report: fixtureReport({ reportId: 'report-retry', createdAt: FIXTURE_NOW - 10 }), seq: 3 },
    ];
    assert.equal(dedupeReports(committed).length, 2);
    assert.equal(latestReportForRun(committed, 'run-a')?.reportId, 'report-retry');
    for (const state of ['closed', 'handed_over', 'revoked'] as const)
      assert.equal(linkAfterReport(fixtureLink({ state }), old, fixtureRun()).state, state);
    const b = fixtureRun({ runId: 'run-b', runSeq: 2 });
    const page = waitPage(fixedWait({ runId: b.runId, until: ['report'] }), {
      highWaterSeq: 5,
      events: [event(4, 'run-a', 'report.received')],
      run: b,
    });
    assert.equal(page.matched, false);
    assert.equal(page.nextSeq, 0);
  },
  'T-03-14': () => {
    const a = fixtureRun();
    const fixed = resolveWaitTarget({ linkId: 'link-a' }, [a], () => true);
    assert.equal(fixed.ok, true);
    if (!fixed.ok) return;
    const all = [a, fixtureRun({ runId: 'run-b', runSeq: 2 })];
    assert.equal(fixed.fixed.runId, 'run-a');
    assert.equal(resolveWaitTarget({ runId: fixed.fixed.runId }, all, () => true).ok, true);
    assert.deepEqual(
      resolveWaitTarget({ linkId: 'link-a', runId: 'run-a' }, all, () => true),
      { ok: false, reason: 'invalid' }
    );
    assert.deepEqual(
      resolveWaitTarget({ linkId: 'link-a' }, [], () => true),
      { ok: false, reason: 'no_run' }
    );
    assert.deepEqual(
      resolveWaitTarget({ runId: 'run-a' }, all, () => false),
      { ok: false, reason: 'unauthorized' }
    );
    assert.deepEqual(
      resolveWaitTarget({ runId: 'run-a', afterSeq: -1 }, all, () => true),
      { ok: false, reason: 'invalid' }
    );
  },
  'T-03-15': () => {
    const events = [
      event(1, 'run-old', 'report.received'),
      event(2, null, 'report.received'),
      event(3, 'run-b', 'report.received'),
      event(4, 'run-a', 'report.rejected'),
      event(5, 'run-a', 'report.received'),
      event(6, 'run-a', 'report.received'),
    ];
    const page = waitPage(fixedWait({ afterSeq: 2, until: ['report'] }), {
      highWaterSeq: 5,
      events,
      run: fixtureRun(),
    });
    assert.deepEqual(
      page.events.map((entry) => entry.seq),
      [4, 5]
    );
    assert.equal(page.nextSeq, 5);
    assert.equal(page.matched, true);
    const rejectedOnly = waitPage(fixedWait({ until: ['report'] }), { highWaterSeq: 4, events, run: fixtureRun() });
    assert.equal(rejectedOnly.matched, false);
    assert.equal(rejectedOnly.nextSeq, 4);
  },
  'T-03-16': () => {
    for (const reportPosition of [100, 201]) {
      const events = Array.from({ length: 201 }, (_, index) =>
        event(index + 1, 'run-a', index + 1 === reportPosition ? 'report.received' : 'progress')
      );
      const fixed = fixedWait({ until: ['report'] });
      const first = waitPage(fixed, { highWaterSeq: 201, events, run: fixtureRun() });
      assert.equal(first.events.length, 200);
      assert.equal(first.nextSeq, 200);
      assert.equal(first.hasMore, true);
      assert.equal(first.matched, reportPosition === 100);
      const second = waitPage({ ...fixed, afterSeq: first.nextSeq }, { highWaterSeq: 201, events, run: fixtureRun() });
      assert.equal(second.nextSeq, 201);
      assert.equal(second.matched, reportPosition === 201);
      assert.equal(second.hasMore, false);
      const terminal = waitPage(fixedWait({ until: ['run_terminal'] }), {
        highWaterSeq: 201,
        events,
        run: fixtureEndedRun(),
      });
      assert.equal(terminal.matched, true);
      assert.equal(terminal.hasMore, true);
    }
    const empty = waitPage(
      fixedWait({ afterSeq: 20, until: ['report'] }),
      { highWaterSeq: 30, events: [], run: fixtureRun() },
      true
    );
    assert.equal(empty.nextSeq, 20);
    assert.equal(empty.timedOut, true);
  },
  'T-03-17': () => {
    assert.equal(resolveWaitTarget({ runId: 'run-a', timeoutMs: 120000 }, [fixtureRun()], () => true).ok, true);
    assert.equal(resolveWaitTarget({ runId: 'run-a', timeoutMs: 120001 }, [fixtureRun()], () => true).ok, false);
    assert.equal(effectiveWaitMs(120000, 60000, 2000).effectiveWaitMs, 58000);
    for (const [timeout, margin] of [
      [null, 2000],
      [1000, 1000],
      [1000, 0],
    ] as const)
      assert.deepEqual(effectiveWaitMs(120000, timeout, margin), {
        effectiveWaitMs: 0,
        reason: 'timeout_configuration_unverified',
      });
    const a = fixtureRun();
    const page = waitPage(
      fixedWait({ until: ['report'], afterSeq: 10 }),
      { highWaterSeq: 15, events: [], run: a },
      true
    );
    const resumed = resolveWaitTarget(
      { runId: page.runId, afterSeq: page.nextSeq },
      [a, fixtureRun({ runId: 'run-b', runSeq: 2 })],
      () => true
    );
    assert.equal(resumed.ok && resumed.fixed.runId, 'run-a');
    assert.equal(resumed.ok && resumed.fixed.afterSeq, 10);
    assert.equal(page.current, a);
    assert.equal(page.current.state, 'running');
  },
  'T-03-19': () => {
    const descendant = { ...FIXTURE_CHILD, sessionId: 'descendant-a' };
    const attempts = [
      handover({ slotHeld: true }),
      handover({ currentRun: fixtureRun({ state: 'uncertain' }) }),
      handover({ link: fixtureLink({ state: 'handed_over', currentOwner: false }) }),
      handover({ newParentRef: FIXTURE_CHILD }),
      handover({ graphBudget: 0 }),
      handover({
        newParentRef: descendant,
        graph: [fixtureLink({ parentRef: FIXTURE_CHILD, childRef: descendant, linkId: 'descendant' })],
      }),
    ];
    for (const input of attempts) {
      const old = canonicalJson(input.link);
      assertDenied(handoverGate(input));
      assert.equal(canonicalJson(input.link), old);
    }
    assert.equal(fixtureLink({ state: 'handed_over', currentOwner: false }).childRef, FIXTURE_CHILD);
  },
  'T-03-20': () => {
    const strangerRef = { ...FIXTURE_PARENT, sessionId: 'knows-claim-and-link' };
    const stranger = { kind: 'mcp' as const, selection: fixtureSelection(fixtureContext({ sessionRef: strangerRef })) };
    const result = handoverGate(handover({ authority: stranger }));
    assert.equal(!result.ok && result.reason, 'unsupported');
    assert.throws(() => planHandover(handover({ authority: stranger }), 'link-b', FIXTURE_NOW), /unsupported/);
    assertDenied(handoverGate(handover({ authority: fixtureLocalAuthority() })));
    assert.equal(fixtureLink().currentOwner, true);
  },
  'T-03-26': () => {
    for (const state of [
      'pending',
      'claimed',
      'bound',
      'reported',
      'closed',
      'failed',
      'revoked',
      'handed_over',
    ] as const) {
      for (const runState of [
        'starting',
        'running',
        'cancelling',
        'uncertain',
        'ended',
        'failed',
        'cancelled',
      ] as const) {
        const link = fixtureLink({ state });
        const run = fixtureRun({ state: runState });
        assert.deepEqual(mvpOperationPolicy('close'), { allowed: false, reason: 'unsupported', dispatches: 0 });
        assert.equal(link.state, state);
        assert.equal(run.state, runState);
      }
    }
    const alive = reconcileRun(fixtureRun(), [scopeAlive(), launchStarted()], FIXTURE_NOW);
    assert.equal(alive.releaseSlot, false);
  },
};

import { canonicalJson, digest, requireCanonicalAbsolutePath, type JsonObject } from './canonical.js';
import { sameSessionRef, sessionRefKey } from './identity.js';
import type { SessionRef } from './types/identity.js';
import type {
  HeartbeatQuality,
  IdempotencyRecord,
  LedgerEvent,
  LedgerMetadata,
  ReconcileDecision,
  ReconcileEvidence,
  ReconciliationCause,
  Run,
  RunOperation,
  RunSlot,
  TerminalNote,
} from './types/execution.js';
import type { ProjectOrigin, RunWorkspaceSnapshot } from './types/observation.js';
import type { ProcessStamp } from './types/supervision.js';

export function isRunTerminal(run: { state: Run['state'] }): boolean {
  return run.state === 'ended' || run.state === 'failed' || run.state === 'cancelled';
}
export function heartbeatQuality(at: number | null, nowMs: number): HeartbeatQuality {
  if (at === null || !Number.isFinite(at) || !Number.isFinite(nowMs) || nowMs < at) return 'unknown';
  return nowMs - at > 30000 ? 'stale' : 'fresh';
}
function sameStamp(a: ProcessStamp | null, b: ProcessStamp | null): boolean {
  return a === null || b === null
    ? a === b
    : a.pid === b.pid && a.proc_start === b.proc_start && a.boot_id === b.boot_id && a.pid_domain === b.pid_domain;
}

/** First-match R-02 policy. Inputs are validated snapshots, never process probes. */
export function reconcileRun(
  run: Run,
  evidence: readonly ReconcileEvidence[],
  nowMs: number,
  ownership: {
    slotHeld: boolean;
    ticketConsumed: boolean;
    /** Verified terminal_evidence_id basis, including earlier adopted proofs and unresolved conflicts. */
    terminalBasis?: { evidence: readonly ReconcileEvidence[]; terminalNote: TerminalNote };
  } = {
    slotHeld: true,
    ticketConsumed: run.launchPhase !== 'reserved',
  }
): ReconcileDecision {
  const terminal = isRunTerminal(run);
  const inputs = [...(terminal ? (ownership.terminalBasis?.evidence ?? []) : []), ...evidence];
  const matched = inputs.filter(
    (entry) =>
      entry.validation === 'accepted' &&
      entry.runId === run.runId &&
      entry.sourceId === run.sourceId &&
      entry.bindingGeneration === run.expectedGeneration &&
      sameStamp(entry.supervisor, run.supervisor)
  );
  // Reduce mutable observations by validated fact time, never discovery/commit time (E04).
  // Scope checks use checked_at; R uses ended_at; Q/N use their composite proof asOf.
  const usableFactTime = (asOf: number | null): asOf is number =>
    asOf !== null && Number.isFinite(asOf) && asOf >= 0 && Number.isFinite(nowMs) && asOf <= nowMs;
  const hasFactTime = (entry: ReconcileEvidence): boolean => usableFactTime(entry.asOf);
  const completionEntries = matched.filter(
    (entry) => entry.fact.kind === 'receipt' || entry.fact.kind === 'scope_reconciled'
  );
  const fullCompletionEntries = completionEntries.filter(
    (entry) =>
      (entry.fact.kind === 'receipt' || entry.fact.kind === 'scope_reconciled') &&
      entry.fact.complete &&
      entry.fact.harnessTerminated &&
      entry.fact.launchersSealed
  );
  const datedCompletionEntries = fullCompletionEntries.filter(hasFactTime);
  const neverSubmittedEntries = matched.filter(
    ({ fact }) => fact.kind === 'never_submitted' && fact.permanentFence && fact.launchersSealed && fact.noExecution
  );
  const neverSubmitted = neverSubmittedEntries.find(hasFactTime)?.fact;
  const neverSubmittedTimeUnknown = neverSubmittedEntries.some((entry) => !hasFactTime(entry));
  // N is irreversible too: later mutable observations cannot erase its counter-evidence.
  const proofBoundaries = [...datedCompletionEntries, ...neverSubmittedEntries.filter(hasFactTime)].map(
    (entry) => entry.asOf!
  );
  const scopeEntries = matched.filter((entry) => entry.fact.kind === 'scope');
  const undatedScopes = scopeEntries.filter((entry) => !hasFactTime(entry));
  const datedScopes = scopeEntries.filter(hasFactTime);
  const scopeBoundary = Math.max(...datedScopes.map((entry) => entry.asOf!), ...proofBoundaries);
  const latestScopes = datedScopes.filter((entry) => entry.asOf === scopeBoundary);
  const isScopeCounter = (entry: ReconcileEvidence): boolean =>
    entry.fact.kind === 'scope' &&
    (entry.fact.state === 'alive' ||
      (entry.fact.state !== 'unknown' && entry.fact.complete && !entry.fact.launchersSealed));
  const scopeCounterEvidence = datedScopes.filter(
    (entry) => isScopeCounter(entry) && proofBoundaries.some((boundary) => entry.asOf! >= boundary)
  );
  // A substantive tie is an unresolved conflict, even after a newer mutable observation or receipt.
  const scopeStatesByTime = new Map<number, Set<'alive' | 'gone'>>();
  for (const entry of datedScopes) {
    const fact = entry.fact;
    if (
      fact.kind === 'scope' &&
      (fact.state === 'alive' ||
        (fact.state === 'gone' && fact.complete && fact.harnessTerminated && fact.launchersSealed))
    ) {
      const states = scopeStatesByTime.get(entry.asOf!) ?? new Set<'alive' | 'gone'>();
      states.add(fact.state);
      scopeStatesByTime.set(entry.asOf!, states);
    }
  }
  const conflictingScopeTimes = new Set(
    [...scopeStatesByTime].filter(([, states]) => states.size > 1).map(([asOf]) => asOf)
  );
  const scopeTiesConflict = conflictingScopeTimes.size > 0;
  const tiedScopes = datedScopes.filter((entry) => conflictingScopeTimes.has(entry.asOf!));
  const proofCounters = matched.filter(
    (entry) =>
      (entry.fact.kind === 'receipt' ||
        entry.fact.kind === 'scope_reconciled' ||
        entry.fact.kind === 'never_submitted') &&
      (!entry.fact.launchersSealed || ('harnessTerminated' in entry.fact && !entry.fact.harnessTerminated))
  );
  const proofConflict = proofCounters.some(
    (entry) => hasFactTime(entry) && proofBoundaries.some((boundary) => entry.asOf! >= boundary)
  );
  const completionTimeUnknown = fullCompletionEntries.some((entry) => !hasFactTime(entry));
  const liveTimeUnknown =
    proofBoundaries.length > 0 &&
    (undatedScopes.some(isScopeCounter) || proofCounters.some((entry) => !hasFactTime(entry)));
  const scopeTimeUnknown = undatedScopes.length > 0 && proofBoundaries.length === 0;
  const currentScopes = new Set([...latestScopes, ...undatedScopes, ...scopeCounterEvidence, ...tiedScopes]);
  const heartbeatEntries = matched.filter((entry) => entry.fact.kind === 'heartbeat');
  const heartbeatTimeUnknown = heartbeatEntries.some((entry) => !hasFactTime(entry));
  const latestHeartbeatAt = Math.max(...heartbeatEntries.filter(hasFactTime).map((entry) => entry.asOf!));
  const current = matched.filter((entry) =>
    entry.fact.kind === 'scope'
      ? currentScopes.has(entry)
      : entry.fact.kind !== 'heartbeat' || !hasFactTime(entry) || entry.asOf === latestHeartbeatAt
  );
  const auditEvidenceIds = inputs.filter((entry) => !current.includes(entry)).map((entry) => entry.evidenceId);
  const facts = current.map((entry) => entry.fact);
  const scoped = facts.filter((fact) => fact.kind === 'scope');
  const scopeUnknown =
    scopeTimeUnknown || latestScopes.some((entry) => entry.fact.kind === 'scope' && entry.fact.state === 'unknown');
  const alive = !scopeUnknown && scoped.some((fact) => fact.state === 'alive');
  const gone =
    !scopeUnknown &&
    !alive &&
    scoped.some((fact) => fact.state === 'gone' && fact.complete && fact.harnessTerminated && fact.launchersSealed);
  const knownNativeResults = datedCompletionEntries.flatMap((entry) =>
    (entry.fact.kind === 'receipt' || entry.fact.kind === 'scope_reconciled') && entry.fact.nativeExit !== null
      ? [{ entry, native: entry.fact.nativeExit }]
      : []
  );
  const nativeWellFormed = (native: (typeof knownNativeResults)[number]['native']): boolean =>
    (native.source === 'wait_status' || native.source === 'trusted_harness_result') &&
    (native.code === null
      ? typeof native.signal === 'string' && native.signal.length > 0
      : Number.isSafeInteger(native.code) && native.signal === null);
  const nativeResults = [
    ...knownNativeResults.map(({ native }) => native),
    ...(terminal && run.exitSource !== null
      ? [{ code: run.exitCode, signal: run.exitSignal, source: run.exitSource }]
      : []),
  ];
  const nativeConflict =
    nativeResults.some((native) => !nativeWellFormed(native)) ||
    new Set(
      nativeResults
        .filter(nativeWellFormed)
        .map((native) => canonicalJson({ code: native.code, signal: native.signal }))
    ).size > 1;
  const nativeCandidates = knownNativeResults.map(({ entry }) => entry);
  const compatibleProofs = nativeCandidates.length > 0 ? nativeCandidates : datedCompletionEntries;
  const proofKey = (entry: ReconcileEvidence): string =>
    canonicalJson([
      entry.evidenceId,
      entry.fact.kind,
      entry.fact.kind === 'receipt' || entry.fact.kind === 'scope_reconciled'
        ? (entry.fact.nativeExit?.source ?? null)
        : null,
    ]);
  const validCompletionEntry = [...compatibleProofs].sort((a, b) => {
    const aKey = proofKey(a);
    const bKey = proofKey(b);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  })[0];
  const validCompletion =
    validCompletionEntry &&
    (validCompletionEntry.fact.kind === 'receipt' || validCompletionEntry.fact.kind === 'scope_reconciled')
      ? validCompletionEntry.fact
      : undefined;
  const launches = facts.filter((fact) => fact.kind === 'launch');
  const started = launches.some((fact) => fact.childStarted);
  const conflict = facts.find((fact) => fact.kind === 'conflict');
  const cancelAccepted = run.cancelRequestedAt !== null;
  const cancelChronologies = new Set(
    facts.flatMap((fact) => (fact.kind === 'cancel' && fact.chronology !== 'unknown' ? [fact.chronology] : []))
  );
  const persistedExecutionConflict =
    terminal && (run.state === 'failed' ? fullCompletionEntries.length > 0 || started : neverSubmitted !== undefined);
  const contradictory =
    conflict !== undefined ||
    (cancelAccepted && cancelChronologies.size > 1) ||
    nativeConflict ||
    scopeCounterEvidence.length > 0 ||
    scopeTiesConflict ||
    proofConflict ||
    persistedExecutionConflict ||
    (neverSubmitted !== undefined && (started || run.launchPhase === 'submitted' || validCompletion !== undefined));
  const decide = (
    row: string,
    state: Run['state'],
    cause: ReconciliationCause | null = null,
    block = !isRunTerminal({ state }),
    terminalNote: TerminalNote = null
  ): ReconcileDecision => {
    const native = validCompletion?.nativeExit;
    return {
      row,
      state,
      releaseSlot: !isRunTerminal(run) && isRunTerminal({ state }),
      emitTransition: state !== run.state,
      blockNewOperations: block,
      evidenceIds: current.map((entry) => entry.evidenceId),
      auditEvidenceIds,
      cause,
      terminalNote: terminal ? (ownership.terminalBasis?.terminalNote ?? null) : terminalNote,
      exitCode: isRunTerminal(run)
        ? run.exitCode
        : state === 'ended' || state === 'cancelled'
          ? (native?.code ?? null)
          : null,
      exitSignal: isRunTerminal(run)
        ? run.exitSignal
        : state === 'ended' || state === 'cancelled'
          ? (native?.signal ?? null)
          : null,
      exitSource: isRunTerminal(run)
        ? run.exitSource
        : state === 'ended' || state === 'cancelled'
          ? (native?.source ?? null)
          : null,
    };
  };
  if (terminal) {
    const terminalTimeUnknown =
      liveTimeUnknown ||
      completionTimeUnknown ||
      neverSubmittedTimeUnknown ||
      (proofBoundaries.length === 0 &&
        scopeEntries.some((entry) => entry.fact.kind === 'scope' && entry.fact.state === 'alive'));
    const timeCause =
      matched.some(
        (entry) => entry.asOf !== null && (!Number.isFinite(entry.asOf) || entry.asOf < 0 || entry.asOf > nowMs)
      ) ||
      (run.endedAt !== null && !usableFactTime(run.endedAt))
        ? 'clock_anomaly'
        : 'scope_unknown';
    return decide(
      'R-02-0',
      run.state,
      contradictory ? (conflict?.cause ?? 'scope_conflict') : terminalTimeUnknown ? timeCause : null,
      contradictory || terminalTimeUnknown
    );
  }
  if (contradictory) return decide('R-02-1', 'uncertain', conflict?.cause ?? 'scope_conflict');
  if (completionTimeUnknown || neverSubmittedTimeUnknown || liveTimeUnknown || scopeTimeUnknown)
    return decide(
      'R-02-9',
      'uncertain',
      matched.some((entry) => entry.asOf !== null && entry.asOf > nowMs) ? 'clock_anomaly' : 'scope_unknown'
    );
  if (validCompletion) {
    return cancelAccepted && cancelChronologies.has('before_exit')
      ? decide('R-02-2', 'cancelled')
      : decide(
          'R-02-3',
          'ended',
          null,
          false,
          cancelAccepted && cancelChronologies.size === 0 ? 'cancel_timing_unknown' : null
        );
  }
  if (neverSubmitted && gone) return decide('R-02-4', 'failed');
  const age = nowMs - run.createdAt;
  if (
    run.state === 'starting' &&
    run.launchPhase === 'reserved' &&
    !ownership.ticketConsumed &&
    run.supervisor === null &&
    run.heartbeatAt === null &&
    ownership.slotHeld &&
    !cancelAccepted &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 30000
  )
    return decide('R-02-4a', 'starting');
  const heartbeat = [...current]
    .sort((a, b) => (b.asOf ?? -Infinity) - (a.asOf ?? -Infinity))
    .find((entry) => entry.fact.kind === 'heartbeat')?.fact;
  const h =
    heartbeatTimeUnknown || (heartbeat?.kind === 'heartbeat' && heartbeat.clockAnomaly)
      ? 'unknown'
      : heartbeatQuality(heartbeat?.kind === 'heartbeat' ? heartbeat.at : run.heartbeatAt, nowMs);
  const supervisorDead = facts.some((fact) => fact.kind === 'supervisor' && fact.state === 'dead');
  const clockAnomaly =
    !Number.isFinite(age) ||
    age < 0 ||
    (heartbeat?.kind === 'heartbeat' && (heartbeat.clockAnomaly || heartbeat.at > nowMs)) ||
    (run.heartbeatAt !== null && run.heartbeatAt > nowMs);
  if (!supervisorDead && h === 'fresh' && alive && started)
    return decide('R-02-5', cancelAccepted ? 'cancelling' : 'running');
  if (supervisorDead || h === 'stale')
    return decide('R-02-6', 'uncertain', supervisorDead ? 'supervisor_dead' : 'supervisor_stale');
  const validStartup = launches.some(
    (fact) =>
      fact.originalExecutorValid &&
      !fact.childStarted &&
      Number.isFinite(nowMs - fact.observedAt) &&
      nowMs - fact.observedAt >= 0 &&
      nowMs - fact.observedAt <= 30000
  );
  if (
    run.state === 'starting' &&
    (run.launchPhase === 'reserved' || run.launchPhase === 'armed') &&
    validStartup &&
    !cancelAccepted &&
    !clockAnomaly
  )
    return decide('R-02-7', 'starting');
  if (run.state === 'cancelling' && facts.some((fact) => fact.kind === 'cancel_channel' && fact.valid) && !clockAnomaly)
    return decide('R-02-8', 'cancelling');
  return decide(
    'R-02-9',
    'uncertain',
    clockAnomaly
      ? 'clock_anomaly'
      : run.launchPhase === 'submitting'
        ? 'submission_unknown'
        : run.launchPhase === 'reserved' && age > 30000
          ? 'launch_timeout'
          : 'scope_unknown'
  );
}

const requestFields = new Set([
  'requestKey',
  'backend',
  'profile',
  'sourceId',
  'role',
  'model',
  'effort',
  'mode',
  'layout',
  'launchCwd',
  'originRepoId',
  'briefPath',
  'reportPath',
  'briefContentHash',
  'linkId',
  'promptHash',
  'expectedRun',
  'predecessor',
  'authorization',
  'resources',
  'profileDigest',
  'orphanPolicy',
]);
/** Version 1 accepts only resolved control-request fields, never writer metadata. */
export function normalizeRequest(operation: RunOperation, params: Record<string, unknown>): JsonObject {
  if (!['spawn', 'resume', 'handover'].includes(operation)) throw new TypeError('invalid_operation');
  if (params === null || Array.isArray(params) || Object.getPrototypeOf(params) !== Object.prototype)
    throw new TypeError('invalid_request');
  for (const field of Object.keys(params))
    if (!requestFields.has(field)) throw new TypeError(`unknown_request_field:${field}`);
  if ('requestKey' in params) validateRequestKey(params.requestKey);
  requireCanonicalAbsolutePath(params.launchCwd);
  if ('briefPath' in params) requireCanonicalAbsolutePath(params.briefPath);
  if (params.reportPath !== undefined && params.reportPath !== null) requireCanonicalAbsolutePath(params.reportPath);
  if (params.mode !== 'headless' && params.mode !== 'visible') throw new TypeError('mode_required');
  if (params.orphanPolicy !== undefined && params.orphanPolicy !== 'continue' && params.orphanPolicy !== 'stop')
    throw new TypeError('invalid_orphan_policy');
  const { requestKey: _requestKey, ...stable } = params;
  const normalized = { ...stable, orphanPolicy: stable.orphanPolicy ?? 'continue', operation, paramsVersion: 1 };
  canonicalJson(normalized);
  return JSON.parse(canonicalJson(normalized)) as JsonObject;
}
export function requestDigest(operation: RunOperation, params: Record<string, unknown>): string {
  return digest(normalizeRequest(operation, params));
}
export function prepareRunContext(
  operation: RunOperation,
  params: Record<string, unknown>,
  metadata: { workspaceSnapshot: RunWorkspaceSnapshot | null; projectOrigin: ProjectOrigin | null }
): {
  paramsVersion: 1;
  paramsDigest: string;
  launchCwd: string;
  workspaceSnapshot: RunWorkspaceSnapshot | null;
  projectOrigin: ProjectOrigin | null;
} {
  const normalized = normalizeRequest(operation, params);
  if (metadata.projectOrigin !== null && metadata.projectOrigin.repoId !== params.originRepoId)
    throw new TypeError('project_origin_request_mismatch');
  return {
    paramsVersion: 1,
    paramsDigest: digest(normalized),
    launchCwd: normalized.launchCwd as string,
    workspaceSnapshot: metadata.workspaceSnapshot,
    projectOrigin: metadata.projectOrigin,
  };
}
export function validateRequestKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Array.from(value).length < 1 || Array.from(value).length > 256)
    throw new TypeError('invalid_request_key');
}
export function lookupIdempotency(
  records: readonly IdempotencyRecord[],
  ownerKey: string,
  requestKey: string,
  paramsDigest: string,
  paramsVersion = 1
):
  | { kind: 'new' }
  | { kind: 'conflict'; reason: 'idempotency_conflict' }
  | { kind: 'replay'; record: IdempotencyRecord } {
  validateRequestKey(requestKey);
  const record = records.find((entry) => entry.ownerKey === ownerKey && entry.requestKey === requestKey);
  if (!record) return { kind: 'new' };
  return record.paramsVersion === paramsVersion && record.paramsDigest === paramsDigest
    ? { kind: 'replay', record }
    : { kind: 'conflict', reason: 'idempotency_conflict' };
}

export function makeRunSlot(
  runId: string,
  targetRef: SessionRef | null,
  operation: RunOperation,
  newSession: boolean,
  holder: string,
  acquiredAt: number
): RunSlot {
  if (!holder || !runId || (targetRef === null && (operation !== 'spawn' || !newSession)))
    throw new TypeError('real_session_ref_required');
  return {
    slotKey: targetRef === null ? `provisional:${runId}` : sessionRefKey(targetRef),
    sessionRef: targetRef,
    runId,
    holder,
    acquiredAt,
  };
}
export function planSlotMigration(
  slots: readonly RunSlot[],
  runId: string,
  ref: SessionRef
): { ok: boolean; slots: RunSlot[]; uncertainRunIds: string[]; blockedRef: SessionRef | null } {
  const own = slots.find((slot) => slot.runId === runId);
  if (!own) throw new TypeError('slot_missing');
  if (own.sessionRef !== null && !sameSessionRef(own.sessionRef, ref)) throw new TypeError('known_slot_ref_immutable');
  const conflict = slots.find((slot) => slot.runId !== runId && slot.slotKey === sessionRefKey(ref));
  if (conflict) return { ok: false, slots: [...slots], uncertainRunIds: [runId, conflict.runId], blockedRef: ref };
  return {
    ok: true,
    slots: slots.map((slot) =>
      slot.runId === runId ? { ...slot, slotKey: sessionRefKey(ref), sessionRef: ref } : slot
    ),
    uncertainRunIds: [],
    blockedRef: null,
  };
}

export function updateRun(run: Run, patch: Partial<Run>): Run {
  const next = { ...run, ...patch };
  if (run.supervisor !== null && !sameStamp(run.supervisor, next.supervisor))
    throw new TypeError('supervisor_instance_immutable');
  requireCanonicalAbsolutePath(next.launchCwd);
  if (next.launchCwd !== run.launchCwd || canonicalJson(next.projectOrigin) !== canonicalJson(run.projectOrigin))
    throw new TypeError('launch_context_immutable');
  if (run.workspaceSnapshot !== null && canonicalJson(next.workspaceSnapshot) !== canonicalJson(run.workspaceSnapshot))
    throw new TypeError('workspace_first_capture_only');
  if (
    run.targetSessionRef !== null &&
    (next.targetSessionRef === null || !sameSessionRef(run.targetSessionRef, next.targetSessionRef))
  )
    throw new TypeError('known_target_immutable');
  if (
    next.scopeKind !== run.scopeKind ||
    next.supervisionStrategy !== run.supervisionStrategy ||
    (run.scopeRef !== null && canonicalJson(next.scopeRef) !== canonicalJson(run.scopeRef))
  )
    throw new TypeError('scope_immutable');
  if (run.submissionFencedAt !== null && next.submissionFencedAt !== run.submissionFencedAt)
    throw new TypeError('submission_fence_permanent');
  validateRun(next);
  return next;
}
export function validateRun(run: Run): void {
  requireCanonicalAbsolutePath(run.launchCwd);
  if (
    !['starting', 'running', 'cancelling', 'uncertain', 'ended', 'failed', 'cancelled'].includes(run.state) ||
    !['reserved', 'armed', 'submitting', 'submitted', 'never_submitted'].includes(run.launchPhase)
  )
    throw new TypeError('invalid_run_state');
  if ((run.operation === 'resume' || run.operation === 'handover') && run.targetSessionRef === null)
    throw new TypeError('real_session_ref_required');
  if (
    run.targetSessionRef !== null &&
    (run.targetSessionRef.sourceId !== run.sourceId || run.targetSessionRef.harness !== run.harness)
  )
    throw new TypeError('target_source_mismatch');
  if (
    (run.mode === 'headless' && run.supervisionStrategy !== 'headless') ||
    (run.mode === 'visible' && run.supervisionStrategy !== 'wrapper')
  )
    throw new TypeError('mode_strategy_mismatch');
  if ((run.exitCode !== null || run.exitSignal !== null) && run.exitSource === null)
    throw new TypeError('native_exit_source_required');
  if (run.exitSource !== null && (run.exitCode === null) === (run.exitSignal === null))
    throw new TypeError('native_exit_code_xor_signal');
  if (run.state === 'failed' && run.exitSource !== null) throw new TypeError('failed_is_non_execution');
  if (run.shellStatus !== null && run.shellSignal !== null) throw new TypeError('shell_status_xor_signal');
  if (isRunTerminal(run)) {
    if (run.endedAt === null || run.terminalEvidenceId === null || run.submissionFencedAt === null)
      throw new TypeError('terminal_evidence_required');
  } else if (
    run.endedAt !== null ||
    run.terminalEvidenceId !== null ||
    run.exitCode !== null ||
    run.exitSignal !== null ||
    run.exitSource !== null ||
    run.shellStatus !== null ||
    run.shellSignal !== null
  )
    throw new TypeError('active_run_has_exit_result');
  if (
    run.heartbeatAt === null
      ? run.heartbeatSeq !== 0 || run.heartbeatMonoMs !== null
      : run.supervisor === null || run.heartbeatSeq < 1 || run.heartbeatMonoMs === null || run.heartbeatMonoMs < 0
  )
    throw new TypeError('invalid_heartbeat_tuple');
}
export function captureWorkspace(
  run: Run,
  snapshot: RunWorkspaceSnapshot,
  at: number
): { run: Run; event: Omit<LedgerEvent, 'seq'>; restartHarness: false } {
  if (run.workspaceSnapshot !== null) throw new TypeError('workspace_already_captured');
  return {
    run: updateRun(run, { workspaceSnapshot: snapshot }),
    event: {
      linkId: run.linkId,
      runId: run.runId,
      kind: 'workspace.captured',
      payload: { capturedAt: at, snapshot: JSON.parse(canonicalJson(snapshot)) },
      at,
    },
    restartHarness: false,
  };
}
export function ledgerMetadataChange(
  current: LedgerMetadata | null,
  operation: 'initialize' | 'restore' | 'replace' | 'delete',
  suppliedId?: string
): LedgerMetadata {
  if (operation === 'restore' && current !== null) return current;
  if (operation !== 'initialize' || current !== null || !suppliedId) throw new TypeError('ledger_metadata_immutable');
  return { ledgerId: suppliedId };
}
/** Deferred operations have no dispatch or run-intent plan in MVP. */
export function mvpOperationPolicy(operation: 'jev_send' | 'browser_control' | 'close'): {
  allowed: false;
  reason: 'unsupported';
  dispatches: 0;
} {
  void operation;
  return { allowed: false, reason: 'unsupported', dispatches: 0 };
}

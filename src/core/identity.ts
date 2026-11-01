import { canonicalJson, digest, requireCanonicalAbsolutePath } from './canonical.js';
import type {
  CallerContext,
  CallerScope,
  ChildBinding,
  Claim,
  ClaimRunAnchor,
  Harness,
  OwnerAlias,
  OwnerKey,
  ProcessKey,
  SessionRef,
  SourceId,
} from './types/identity.js';
import type { IdempotencyRecord } from './types/execution.js';
import type { ProcessStamp } from './types/supervision.js';

const harnesses: readonly string[] = ['claude', 'codex', 'pi'];
const sha256 = /^[0-9a-f]{64}$/;
export function validateSessionRef(ref: SessionRef): void {
  if (
    !harnesses.includes(ref.harness) ||
    !sha256.test(ref.sourceId) ||
    typeof ref.sessionId !== 'string' ||
    ref.sessionId.length === 0 ||
    (ref.threadId !== null && typeof ref.threadId !== 'string')
  )
    throw new TypeError('invalid_session_ref');
}
/** realpath is deliberately outside this pure API; unresolved roots cannot be supplied. */
export function makeSourceId(harness: Harness, alreadyCanonicalAbsoluteRoot: string): SourceId {
  if (!harnesses.includes(harness)) throw new TypeError('invalid_harness');
  requireCanonicalAbsolutePath(alreadyCanonicalAbsoluteRoot);
  return digest([harness, alreadyCanonicalAbsoluteRoot]);
}
export function sessionRefKey(ref: SessionRef): string {
  validateSessionRef(ref);
  return JSON.stringify([ref.harness, ref.sourceId, ref.sessionId, ref.threadId === '' ? null : ref.threadId]);
}
export function sameSessionRef(a: SessionRef, b: SessionRef): boolean {
  return sessionRefKey(a) === sessionRefKey(b);
}
export function sessionOwnerKey(ref: SessionRef): OwnerKey {
  return JSON.stringify(['session', sessionRefKey(ref)]);
}
export function procOwnerKey(processKey: ProcessKey, generation: number): OwnerKey {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('invalid_generation');
  const key: unknown = JSON.parse(processKey);
  if (!Array.isArray(key) || key.length !== 5) throw new TypeError('invalid_process_key');
  if (makeProcessKey(key[0], key[1], key[2], key[3], key[4]) !== processKey) throw new TypeError('invalid_process_key');
  return JSON.stringify(['proc', processKey, generation]);
}
export function makeProcessKey(
  harness: Harness,
  sourceId: SourceId,
  pidDomain: string,
  harnessPid: number,
  harnessProcStart: string
): ProcessKey {
  if (
    !harnesses.includes(harness) ||
    !sha256.test(sourceId) ||
    typeof pidDomain !== 'string' ||
    pidDomain.length === 0 ||
    !Number.isSafeInteger(harnessPid) ||
    harnessPid <= 0 ||
    typeof harnessProcStart !== 'string' ||
    harnessProcStart.length === 0
  )
    throw new TypeError('invalid_process_key');
  // The resolver must have verified machine, boot and PID namespace in pidDomain.
  return JSON.stringify([harness, sourceId, pidDomain, harnessPid, harnessProcStart]);
}
function sameStamp(a: ProcessStamp | null, b: ProcessStamp | null): boolean {
  return a === null || b === null
    ? a === b
    : a.pid === b.pid && a.proc_start === b.proc_start && a.boot_id === b.boot_id && a.pid_domain === b.pid_domain;
}

export interface CurrentCallEvidence {
  physicalCallerVerified: boolean;
  pidDomainVisible: boolean;
  profileObservesSessionSwitch: boolean;
  topology: 'direct_stdio' | 'shared' | 'unverified_daemon';
  logicalSource: 'root' | 'native_child' | 'missing' | 'conflict';
  processKey: ProcessKey;
  procGeneration: number;
  sessionRef: SessionRef | null;
}
export type ContextSelection =
  | { ok: true; context: CallerContext; ownerKey: OwnerKey }
  | { ok: false; reason: string; invalidate: boolean; nextGeneration?: number };
/** Must precede idempotency lookup, claim consumption and tool authorization. */
export function selectCallContext(context: CallerContext, evidence: CurrentCallEvidence): ContextSelection {
  const deny = (reason: string, invalidate = false): ContextSelection => ({
    ok: false,
    reason,
    invalidate,
    ...(invalidate ? { nextGeneration: context.generation + 1 } : {}),
  });
  if (context.kind !== 'dedicated' || evidence.topology !== 'direct_stdio') return deny('unsupported');
  if (!evidence.physicalCallerVerified || !evidence.pidDomainVisible) return deny('identity_unverified');
  if (evidence.logicalSource === 'native_child') return deny('identity_unverified');
  if (evidence.logicalSource === 'missing') return deny('identity_source_missing');
  if (evidence.logicalSource === 'conflict') return deny('identity_unverified', true);
  if (!evidence.profileObservesSessionSwitch) return deny('identity_unverified');
  if (
    context.closedAt !== null ||
    context.generation !== context.procGeneration ||
    context.processKey !== evidence.processKey ||
    context.procGeneration !== evidence.procGeneration
  )
    return deny('stale_context');
  if (evidence.sessionRef === null) return deny('identity_source_missing');
  if (evidence.sessionRef.harness !== context.harness || evidence.sessionRef.sourceId !== context.sourceId)
    return deny('identity_unverified', true);
  if (context.sessionRef !== null && !sameSessionRef(context.sessionRef, evidence.sessionRef))
    return deny('identity_unverified', true);
  return {
    ok: true,
    context,
    ownerKey:
      context.sessionRef === null
        ? procOwnerKey(context.processKey, context.procGeneration)
        : sessionOwnerKey(context.sessionRef),
  };
}

export interface ClaimRedemption {
  selection: ContextSelection;
  run: ClaimRunAnchor;
  claimHash: string;
  currentBinding?: ChildBinding | null;
}
export type ClaimDecision =
  { ok: true; claim: Claim; consumed: boolean; handshake: 'claimed' | 'bound' } | { ok: false; reason: string };
export function redeemClaim(claim: Claim, request: ClaimRedemption, nowMs: number): ClaimDecision {
  if (!request.selection.ok) return { ok: false, reason: request.selection.reason };
  const context = request.selection.context;
  const run = request.run;
  if (claim.state === 'revoked' || context.closedAt !== null) return { ok: false, reason: 'claim_revoked' };
  if (claim.claimHash !== request.claimHash) return { ok: false, reason: 'claim_invalid' };
  if (
    claim.runId !== run.runId ||
    claim.sourceId !== run.sourceId ||
    claim.sourceId !== context.sourceId ||
    claim.expectedGeneration !== run.bindingGeneration ||
    !sameStamp(claim.supervisor, run.supervisor)
  )
    return { ok: false, reason: 'claim_anchor_mismatch' };
  const binding = request.currentBinding;
  if (
    binding &&
    binding.isCurrent &&
    binding.revokedAt === null &&
    binding.runId === run.runId &&
    binding.bindingGeneration === run.bindingGeneration &&
    binding.callerId === context.callerId &&
    binding.callerContextId === context.contextId &&
    binding.contextGeneration === context.generation &&
    context.sessionRef !== null &&
    sameSessionRef(binding.sessionRef, context.sessionRef)
  ) {
    return { ok: true, claim, consumed: false, handshake: 'bound' };
  }
  if (claim.state === 'redeemed') {
    const sameSubject =
      claim.redeemedContextId === context.contextId &&
      claim.redeemedGeneration === context.generation &&
      (claim.redeemedSessionRef === null
        ? context.sessionRef === null
        : context.sessionRef !== null && sameSessionRef(claim.redeemedSessionRef, context.sessionRef));
    if (sameSubject && Number.isFinite(nowMs) && nowMs < claim.expiresAt)
      return { ok: true, claim, consumed: false, handshake: 'claimed' };
    return { ok: false, reason: sameSubject ? 'claim_expired' : 'claim_conflict' };
  }
  if (claim.state !== 'armed' || claim.supervisor === null)
    return { ok: false, reason: claim.state === 'expired' ? 'claim_expired' : 'claim_not_armed' };
  if (!Number.isFinite(nowMs) || nowMs < claim.issuedAt || nowMs >= claim.expiresAt)
    return { ok: false, reason: 'claim_expired' };
  return {
    ok: true,
    consumed: true,
    handshake: 'claimed',
    claim: {
      ...claim,
      state: 'redeemed',
      redeemedContextId: context.contextId,
      redeemedGeneration: context.generation,
      redeemedSessionRef: context.sessionRef,
      redeemedAt: nowMs,
    },
  };
}

export interface BindingInput {
  hasMcp: boolean;
  registered: boolean;
  claimValid: boolean;
  currentSourceVerified: boolean;
  independentLaunchVerified: boolean;
  independentSessionVerified: boolean;
  contradictoryEvidence: boolean;
  candidateRefs: SessionRef[];
  expectedRef: SessionRef | null;
  currentBinding: ChildBinding | null;
  otherUnboundClaimant: boolean;
}
export interface BindingDecision {
  state: 'pending' | 'claimed' | 'bound' | 'conflict';
  sessionRef: SessionRef | null;
  candidates: SessionRef[];
  reason: string | null;
  revokeCurrent: boolean;
  replaceUnboundClaimant: boolean;
}
export function resolveBinding(input: BindingInput): BindingDecision {
  const result = (
    state: BindingDecision['state'],
    reason: string | null,
    ref: SessionRef | null = null,
    revokeCurrent = false,
    replaceUnboundClaimant = false
  ): BindingDecision => ({
    state,
    reason,
    sessionRef: ref,
    candidates: input.candidateRefs,
    revokeCurrent,
    replaceUnboundClaimant,
  });
  if (!input.hasMcp || !input.registered || !input.currentSourceVerified)
    return result('pending', 'identity_unverified');
  if (input.contradictoryEvidence || input.candidateRefs.length > 1)
    return result('conflict', 'identity_conflict', null, input.currentBinding !== null);
  if (!input.claimValid) return result('pending', 'claim_invalid');
  const ref = input.candidateRefs[0];
  if (!ref || !input.independentLaunchVerified || !input.independentSessionVerified)
    return result('claimed', 'independent_evidence_missing');
  if (input.expectedRef !== null && !sameSessionRef(input.expectedRef, ref))
    return result('conflict', 'resume_ref_mismatch', null, input.currentBinding !== null);
  if (input.currentBinding !== null && !sameSessionRef(input.currentBinding.sessionRef, ref))
    return result('conflict', 'identity_conflict', null, true);
  return result('bound', null, ref, false, input.otherUnboundClaimant && input.currentBinding === null);
}

export interface TranscriptCandidate {
  ref: SessionRef;
  eventAt: number | null;
  parentCallId: string;
  launchCallId: string;
  launchCorrelationId: string;
  nativeMessageId: string | null;
  kind: 'tool_result' | 'launch_message' | 'shell' | 'label' | 'env' | 'private';
}
export interface TranscriptCheck {
  existingLinkRun: boolean;
  writer: 'reconciler' | 'hud' | 'hud-mcp' | 'hud-run';
  independentEvidenceVerified: boolean;
  parentInitiator: 'mcp' | 'local_user';
  issuedAt: number;
  harness: Harness;
  sourceId: SourceId;
  parentCallId: string;
  launchCallId: string;
  launchCorrelationId: string;
  nativeMessageId: string | null;
  candidates: TranscriptCandidate[];
}
export function validateTranscript(input: TranscriptCheck): {
  state: 'matched' | 'conflict' | 'rejected';
  ref: SessionRef | null;
  reason: string | null;
  boundBy: 'transcript' | null;
} {
  const reject = (reason: string) => ({ state: 'rejected' as const, ref: null, reason, boundBy: null });
  if (!input.existingLinkRun) return reject('no_link_run');
  if (input.writer !== 'reconciler') return reject('writer_forbidden');
  if (input.parentInitiator !== 'mcp') return reject('no_parent_tool_result');
  if (!input.independentEvidenceVerified || input.nativeMessageId === null)
    return reject('independent_evidence_missing');
  const matches = input.candidates.filter(
    (entry) =>
      (entry.kind === 'tool_result' || entry.kind === 'launch_message') &&
      entry.ref.harness === input.harness &&
      entry.ref.sourceId === input.sourceId &&
      entry.parentCallId === input.parentCallId &&
      entry.launchCallId === input.launchCallId &&
      entry.launchCorrelationId === input.launchCorrelationId &&
      entry.nativeMessageId === input.nativeMessageId &&
      entry.eventAt !== null &&
      Number.isFinite(entry.eventAt) &&
      entry.eventAt >= input.issuedAt - 5000 &&
      entry.eventAt <= input.issuedAt + 600000
  );
  if (matches.length > 1) return { state: 'conflict', ref: null, reason: 'transcript_conflict', boundBy: null };
  if (matches.length === 0) return reject('transcript_unqualified');
  return { state: 'matched', ref: matches[0].ref, reason: null, boundBy: 'transcript' };
}

export type AliasPlan = { ok: true; records: IdempotencyRecord[]; alias: OwnerAlias } | { ok: false; reason: string };
/** A transaction plan only: real atomic rekey/rollback remains a SQLite obligation. */
export function planOwnerAlias(
  scope: CallerScope,
  aliases: OwnerAlias[],
  records: IdempotencyRecord[],
  evidenceId: string,
  nowMs: number
): AliasPlan {
  if (
    scope.closedAt !== null ||
    scope.sessionRef === null ||
    scope.bindingEvidenceId === null ||
    scope.boundBy === null
  )
    return { ok: false, reason: 'bound_evidence_required' };
  const existing = aliases.find(
    (entry) => entry.processKey === scope.processKey && entry.generation === scope.generation
  );
  if (existing && (existing.closedAt !== null || !sameSessionRef(existing.sessionRef, scope.sessionRef)))
    return { ok: false, reason: 'alias_conflict' };
  const from = procOwnerKey(scope.processKey, scope.generation);
  const to = sessionOwnerKey(scope.sessionRef);
  const procRows = records.filter((entry) => entry.ownerKey === from);
  for (const row of procRows) {
    const target = records.find((entry) => entry.ownerKey === to && entry.requestKey === row.requestKey);
    if (
      target &&
      (target.paramsVersion !== row.paramsVersion ||
        target.paramsDigest !== row.paramsDigest ||
        target.linkId !== row.linkId ||
        target.runId !== row.runId ||
        canonicalJson(target.outcome) !== canonicalJson(row.outcome))
    )
      return { ok: false, reason: 'idempotency_conflict' };
  }
  const keys = new Set(procRows.map((entry) => entry.requestKey));
  const rekeyed = records
    .filter((entry) => !(entry.ownerKey === to && keys.has(entry.requestKey)))
    .map((entry) => (entry.ownerKey === from ? { ...entry, ownerKey: to } : entry));
  return {
    ok: true,
    records: rekeyed,
    alias: existing ?? {
      processKey: scope.processKey,
      generation: scope.generation,
      sessionRef: scope.sessionRef,
      evidenceId,
      createdAt: nowMs,
      closedAt: null,
    },
  };
}
export function closeIdentityGeneration(
  scope: CallerScope,
  contexts: CallerContext[],
  aliases: OwnerAlias[],
  nowMs: number
): { scope: CallerScope; contexts: CallerContext[]; aliases: OwnerAlias[]; nextGeneration: number } {
  return {
    scope: { ...scope, closedAt: scope.closedAt ?? nowMs },
    contexts: contexts.map((context) =>
      context.kind === 'dedicated' &&
      context.processKey === scope.processKey &&
      context.procGeneration === scope.generation
        ? { ...context, closedAt: context.closedAt ?? nowMs }
        : context
    ),
    aliases: aliases.map((alias) =>
      alias.processKey === scope.processKey && alias.generation === scope.generation
        ? { ...alias, closedAt: alias.closedAt ?? nowMs }
        : alias
    ),
    nextGeneration: scope.generation + 1,
  };
}

export function claimTransport(input: {
  harness: Harness;
  hasMcp: boolean;
  configEnvAvailable: boolean;
  envArrived: boolean;
  taskAlreadyAccepted: boolean;
}): { transport: 'config_leaves' | 'env' | 'current_message' | 'unsupported'; resubmitTask: false } {
  if (!input.hasMcp) return { transport: 'unsupported', resubmitTask: false };
  if (input.harness === 'codex' && input.configEnvAvailable) return { transport: 'config_leaves', resubmitTask: false };
  return { transport: input.envArrived ? 'env' : 'current_message', resubmitTask: false };
}

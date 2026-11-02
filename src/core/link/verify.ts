import { canonicalJson } from '../canonical.js';
import { sameSessionRef, sessionRefKey, validateSessionRef } from '../identity.js';
import type { LinkEvidence } from '../interfaces/session-evidence.js';
import type { LedgerReadRun, LedgerReadSnapshot } from '../ledger-read.js';
import type { ClaimFingerprintCheck } from '../link-ledger-read.js';
import type { SessionRef } from '../types/identity.js';
import type { ProcessStamp } from '../types/supervision.js';
import { combineConflicts } from './conflicts.js';
import { linkEvidenceKey } from './evidence-key.js';
import type { CollectedLinkSession, LinkCandidate, LinkConflict } from './types.js';

interface ProvenRef {
  ref: SessionRef;
  recordIds: string[];
  since: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function stamp(value: unknown): value is ProcessStamp {
  return (
    record(value) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    ['proc_start', 'boot_id', 'pid_domain'].every((field) => typeof value[field] === 'string' && value[field] !== '')
  );
}
function proofRef(payload: Record<string, unknown>, run: LedgerReadRun): SessionRef | null {
  const ref = payload.sessionRef;
  if (!record(ref)) return null;
  try {
    validateSessionRef(ref as unknown as SessionRef);
  } catch {
    return null;
  }
  if (
    !run.supervisor ||
    !stamp(payload.supervisor) ||
    !stamp(payload.harness) ||
    canonicalJson(payload.supervisor) !== canonicalJson(run.supervisor) ||
    payload.harness.boot_id !== run.supervisor.boot_id ||
    payload.harness.pid_domain !== run.supervisor.pid_domain ||
    payload.sourceId !== run.sourceId ||
    payload.bindingGeneration !== run.expectedGeneration ||
    ref.sourceId !== run.sourceId ||
    ref.harness !== run.harness ||
    typeof payload.contextId !== 'string' ||
    !payload.contextId ||
    !Number.isSafeInteger(payload.generation) ||
    Number(payload.generation) < 1 ||
    typeof payload.processKey !== 'string'
  )
    return null;
  try {
    const key: unknown = JSON.parse(payload.processKey);
    if (
      !Array.isArray(key) ||
      key.length !== 5 ||
      key[0] !== run.harness ||
      key[1] !== run.sourceId ||
      typeof key[2] !== 'string' ||
      !key[2] ||
      key[3] !== payload.harness.pid ||
      key[4] !== payload.harness.proc_start
    )
      return null;
  } catch {
    return null;
  }
  return ref as unknown as SessionRef;
}

/** Only the existing run-scoped B5 receipt shape. Global trusted_session and transcript cannot prove themselves. */
function independentRefs(snapshot: LedgerReadSnapshot): Map<string, Map<string, ProvenRef>> {
  const runs = new Map(snapshot.runs.map((run) => [run.runId, run]));
  const result = new Map<string, Map<string, ProvenRef>>();
  for (const entry of snapshot.evidence) {
    if (
      entry.kind !== 'launch_receipt' ||
      entry.producer !== 'reconciler' ||
      entry.validation !== 'accepted' ||
      entry.validatedAt === null ||
      !entry.runId
    )
      continue;
    const run = runs.get(entry.runId);
    if (!run || entry.linkId !== run.linkId) continue;
    const ref = proofRef(entry.payload, run);
    if (!ref) continue;
    const refs = result.get(run.runId) ?? new Map<string, ProvenRef>();
    const key = sessionRefKey(ref);
    const previous = refs.get(key);
    refs.set(key, {
      ref,
      recordIds: [...new Set([...(previous?.recordIds ?? []), entry.evidenceId])],
      since: Math.min(previous?.since ?? entry.observedAt, entry.observedAt),
    });
    result.set(run.runId, refs);
  }
  return result;
}

export interface LinkVerification {
  conflicts: Map<string, LinkConflict>;
  candidates: LinkCandidate[];
  corroborated: Set<string>;
  omittedCandidates: number;
}

export function verifyLinkEvidence(
  snapshot: LedgerReadSnapshot,
  sessions: readonly CollectedLinkSession[],
  claimChecks: readonly ClaimFingerprintCheck[]
): LinkVerification {
  const links = new Map(snapshot.links.map((link) => [link.linkId, link]));
  const runs = new Map(snapshot.runs.map((run) => [run.runId, run]));
  const claims = new Map(snapshot.claims.map((claim) => [claim.runId, claim]));
  const byLaunch = new Map<string, LedgerReadRun[]>();
  const launchKey = (linkId: string, call: string | undefined, correlation: string | undefined) =>
    JSON.stringify([linkId, call ?? null, correlation ?? null]);
  for (const run of snapshot.runs) {
    const key = launchKey(run.linkId, run.launchCallId, run.launchCorrelationId);
    const group = byLaunch.get(key) ?? [];
    group.push(run);
    byLaunch.set(key, group);
  }
  const proofs = independentRefs(snapshot);
  const checks = new Map(
    claimChecks
      .filter((check) => check.ledgerId === snapshot.ledgerId && check.asOfSeq === snapshot.asOfSeq)
      .map((check) => [JSON.stringify([check.runId, check.bindingGeneration, check.recordId]), check.result])
  );
  const conflicts = new Map<string, LinkConflict>();
  const candidates: LinkCandidate[] = [];
  let omittedCandidates = 0;
  const corroborated = new Set<string>();
  const toolNames = new Map<string, string | null>();
  const logicalTool = (name: string): string | null => {
    if (toolNames.has(name)) return toolNames.get(name)!;
    const tool = ['delegate_spawn', 'delegate_resume', 'delegate_whoami'].includes(name)
      ? name
      : (/^mcp__.+__(delegate_spawn|delegate_resume|delegate_whoami)$/.exec(name)?.[1] ?? null);
    toolNames.set(name, tool);
    return tool;
  };
  const equalRef = (a: SessionRef, b: SessionRef) =>
    a === b ||
    (a.harness === b.harness &&
      a.sourceId === b.sourceId &&
      a.sessionId === b.sessionId &&
      (a.threadId || null) === (b.threadId || null));
  const prepared = sessions.map((session) => {
    const ref = session.evidence.ref;
    const stamp = session.evidence.observation.statusProjection.observationStamp;
    const current =
      session.linkEvidenceCurrent &&
      Number.isSafeInteger(session.sourceGeneration) &&
      session.sourceGeneration >= 1 &&
      (!stamp || (equalRef(stamp.ref, ref) && stamp.sourceGeneration === session.sourceGeneration));
    const refKey = sessionRefKey(ref);
    return { session, ref, refKey, current, groupKey: JSON.stringify([refKey, session.sourceGeneration, current]) };
  });
  const inWindow = (entry: LinkEvidence, run: LedgerReadRun) => {
    const claim = claims.get(run.runId);
    return Boolean(
      claim &&
      claim.sourceId === run.sourceId &&
      claim.expectedGeneration === run.expectedGeneration &&
      Number.isFinite(entry.eventAt) &&
      entry.eventAt >= 0 &&
      entry.eventAt >= claim.issuedAt - 5000 &&
      entry.eventAt <= claim.issuedAt + 600000
    );
  };
  const isParent = (entry: LinkEvidence, item: (typeof prepared)[number], run: LedgerReadRun) => {
    if (entry.kind !== 'tool_result' || !['delegate_spawn', 'delegate_resume'].includes(logicalTool(entry.tool) ?? ''))
      return false;
    const parent = links.get(run.linkId)?.parentRef;
    return (
      entry.kind === 'tool_result' &&
      item.current &&
      equalRef(entry.ref, item.ref) &&
      parent &&
      equalRef(parent, item.ref) &&
      logicalTool(entry.tool) === (run.operation === 'resume' ? 'delegate_resume' : 'delegate_spawn') &&
      !run.launchCallId.startsWith('local:') &&
      entry.callId === run.launchCallId &&
      inWindow(entry, run)
    );
  };
  // Qualification happens before any cryptographic annotation ID is materialized.
  // This pass is linear in bounded metadata, with no transcript/body/ledger reads.
  const parentMatched = new Set<string>();
  for (const item of prepared)
    for (const entry of item.session.evidence.linkEvidence) {
      if (
        entry.kind !== 'tool_result' ||
        !['delegate_spawn', 'delegate_resume'].includes(logicalTool(entry.tool) ?? '')
      )
        continue;
      const run = runs.get(entry.runId);
      if (run && run.linkId === entry.linkId && isParent(entry, item, run)) parentMatched.add(run.runId);
    }
  const addCandidate = (entry: LinkEvidence, observedAt: number, reason: string) => {
    if (candidates.length >= 200) {
      omittedCandidates++;
      return;
    }
    candidates.push({
      ref: entry.ref,
      linkId: entry.linkId,
      kind: 'transcript',
      recordId: linkEvidenceKey(entry),
      asOf: Number.isFinite(entry.eventAt) ? entry.eventAt : null,
      observedAt,
      reason,
    });
  };
  for (const [runId, refs] of proofs) {
    const run = runs.get(runId)!;
    const values = [...refs.values()];
    const expected = links.get(run.linkId)?.childRef ?? run.targetSessionRef;
    const contradicts = expected && values.some((value) => !equalRef(value.ref, expected));
    if (refs.size < 2 && !contradicts) continue;
    const ids = values.flatMap((value) => value.recordIds);
    if (refs.size < 2) ids.push(`link:${run.linkId}`);
    conflicts.set(
      run.linkId,
      combineConflicts(conflicts.get(run.linkId), {
        count: ids.length,
        recordIds: ids,
        since: Math.min(...values.map((value) => value.since)),
      })!
    );
  }
  interface Match {
    ref: SessionRef;
    entries: LinkEvidence[];
    since: number;
    observedAt: number;
  }
  const matches = new Map<string, Map<string, Match>>();
  const samePayload = (a: LinkEvidence, b: LinkEvidence): boolean => {
    if (a === b) return true;
    if (
      a.kind !== b.kind ||
      !equalRef(a.ref, b.ref) ||
      a.linkId !== b.linkId ||
      (a.nativeMessageId ?? null) !== (b.nativeMessageId ?? null) ||
      (Number.isFinite(a.eventAt) ? a.eventAt : null) !== (Number.isFinite(b.eventAt) ? b.eventAt : null) ||
      a.launchCallId !== b.launchCallId ||
      a.launchCorrelationId !== b.launchCorrelationId
    )
      return false;
    return a.kind === 'tool_result' && b.kind === 'tool_result'
      ? a.runId === b.runId && a.tool === b.tool && a.callId === b.callId
      : a.kind === 'launch_message' && b.kind === 'launch_message' && a.claimFingerprint === b.claimFingerprint;
  };
  const seen = new Map<string, Map<string, LinkEvidence | LinkEvidence[]>>();
  for (const item of prepared) {
    const group = seen.get(item.groupKey) ?? new Map<string, LinkEvidence | LinkEvidence[]>();
    seen.set(item.groupKey, group);
    const batch = item.session.evidence.linkEvidence;
    for (let index = 0; index < batch.length; index++) {
      const entry = batch[index];
      const sameRef = equalRef(entry.ref, item.ref);
      // Native identity indexes exact primitive payload comparison. An altered payload under
      // the same call/message is retained alongside the original, never overwritten.
      const native = entry.nativeMessageId || (entry.kind === 'tool_result' ? entry.callId : null);
      const identity = `${entry.kind}:${native || `unanchored:${index}`}`;
      const previous = group.get(identity);
      if (previous) {
        if (Array.isArray(previous)) {
          if (previous.some((value) => samePayload(value, entry))) continue;
          previous.push(entry);
        } else {
          if (samePayload(previous, entry)) continue;
          group.set(identity, [previous, entry]);
        }
      } else group.set(identity, entry);
      const link = links.get(entry.linkId);
      const possible =
        entry.kind === 'launch_message'
          ? (byLaunch.get(launchKey(entry.linkId, entry.launchCallId, entry.launchCorrelationId)) ?? [])
          : [];
      const run =
        entry.kind === 'tool_result' ? runs.get(entry.runId) : possible.length === 1 ? possible[0] : undefined;
      let reason: string | null = null;
      if (!link || !run || run.linkId !== entry.linkId)
        reason = possible.length > 1 ? 'launch_run_ambiguous' : 'existing_link_run_missing';
      else if (!item.current || !sameRef) reason = 'reading_lineage_unverified';
      else if (!inWindow(entry, run)) reason = 'event_outside_issuance_window';
      else if (isParent(entry, item, run)) continue;
      else if (entry.ref.harness !== run.harness || entry.ref.sourceId !== run.sourceId) reason = 'source_mismatch';
      else if (!parentMatched.has(run.runId)) reason = 'parent_anchor_unverified';
      else if (
        !entry.nativeMessageId ||
        entry.launchCallId !== run.launchCallId ||
        entry.launchCorrelationId !== run.launchCorrelationId
      )
        reason = 'launch_anchor_unverified';
      else if (
        entry.kind === 'launch_message' &&
        (run.launchMessageId === null || entry.nativeMessageId !== run.launchMessageId)
      )
        reason = 'launch_message_mismatch';
      else if (entry.kind === 'tool_result' && (logicalTool(entry.tool) !== 'delegate_whoami' || !entry.callId))
        reason = 'child_tool_unqualified';
      else if (!proofs.get(run.runId)?.has(item.refKey)) reason = 'independent_run_proof_missing';
      else if (entry.kind === 'launch_message') {
        const check = checks.get(JSON.stringify([run.runId, run.expectedGeneration, linkEvidenceKey(entry)]));
        if (check !== 'verified')
          reason = check === 'mismatch' ? 'claim_fingerprint_mismatch' : 'claim_fingerprint_unverifiable';
      }
      if (reason) {
        addCandidate(entry, item.session.evidence.observation.statusProjection.observedAt, reason);
        continue;
      }
      const refs = matches.get(run!.runId) ?? new Map<string, Match>();
      const match = refs.get(item.refKey) ?? {
        ref: entry.ref,
        entries: [],
        since: entry.eventAt,
        observedAt: item.session.evidence.observation.statusProjection.observedAt,
      };
      match.entries.push(entry);
      match.observedAt = Math.min(match.observedAt, item.session.evidence.observation.statusProjection.observedAt);
      match.since = Math.min(match.since, entry.eventAt);
      refs.set(item.refKey, match);
      matches.set(run!.runId, refs);
    }
  }
  for (const [runId, refs] of matches) {
    const run = runs.get(runId)!;
    const link = links.get(run.linkId)!;
    const values = [...refs.values()];
    const expected = link.childRef;
    if (refs.size > 1 || (expected && values.some((value) => !equalRef(value.ref, expected)))) {
      const entries = values.flatMap((value) => value.entries);
      conflicts.set(
        link.linkId,
        combineConflicts(conflicts.get(link.linkId), {
          count: entries.length,
          recordIds: entries.slice(0, 200).map(linkEvidenceKey),
          since: Math.min(...values.map((value) => value.since)),
        })!
      );
    } else if (expected && values.some((value) => equalRef(value.ref, expected))) corroborated.add(link.linkId);
    else
      for (const value of values)
        for (const entry of value.entries) addCandidate(entry, value.observedAt, 'qualified_awaiting_reconciler');
  }
  return { conflicts, candidates, corroborated, omittedCandidates };
}

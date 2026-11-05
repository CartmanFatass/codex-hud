import { CallBudget, sharedRenewalBudget } from './call-budget.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson, digest } from '../core/canonical.js';
import { isRunTerminal, planSlotMigration } from '../core/execution.js';
import { redeemClaim, resolveBinding, sameSessionRef, sessionRefKey } from '../core/identity.js';
import { advanceLink, linkAfterReport, reportPolicy } from '../core/lifecycle.js';
import { touchHint } from '../core/wait/hints.js';
import type { CallerContext, ChildBinding, Claim, SessionRef } from '../core/types/identity.js';
import type { Evidence, Run, RunSlot } from '../core/types/execution.js';
import type { Link, Report, ReportStatus } from '../core/types/lifecycle.js';
import type { RunMeta } from '../core/types/supervision.js';
import type { Ledger } from './ledger.js';
import { currentAuthority, hasConflict } from './intents.js';
import { isWakeWorthyEvent } from './notify-events.js';
import { decodeRecord, insertRecord, readContext, readLink, readRun, refValue } from './records.js';
import { LedgerBusyError, type LedgerTransaction } from './transaction.js';
import type { IntentAuthority } from './types.js';

interface LegacyChildWriteBudget {
  deadline: number;
  lockBudgetMs: number;
}
export type ChildWriteBudget = LegacyChildWriteBudget | CallBudget;
function childTransaction<T>(
  ledger: Ledger,
  callback: (tx: LedgerTransaction) => T,
  budget?: ChildWriteBudget
): Promise<T> {
  const shared = sharedRenewalBudget(budget);
  if (shared) return ledger.transaction(callback, shared);
  const check = () => {
    if (budget && 'deadline' in budget && performance.now() >= budget.deadline) throw new LedgerBusyError();
  };
  check();
  return ledger.transaction(
    (tx) => {
      check();
      const result = callback(tx);
      check();
      return result;
    },
    budget && 'deadline' in budget
      ? Math.min(20, budget.lockBudgetMs, Math.max(0, budget.deadline - performance.now()))
      : ledger.busyBudgetMs
  );
}

export type ChildAuthority = Extract<IntentAuthority, { kind: 'mcp' }>;
export interface HandshakeSnapshot {
  run: Run;
  link: Link;
  claim: Claim;
  binding: ChildBinding | null;
  context: CallerContext;
  previousContext: CallerContext | null;
  meta: RunMeta | null;
  version: string;
}
export type HandshakeResult =
  | { ok: false; code: string }
  | { ok: true; state: 'pending' | 'claimed' | 'bound'; linkId: string; runId: string; reason: string | null };

function selection(tx: LedgerTransaction, authority: ChildAuthority) {
  const current = currentAuthority(tx, authority);
  if (current.kind !== 'mcp' || !current.selection.ok)
    throw new Error(current.kind === 'mcp' && !current.selection.ok ? current.selection.reason : 'unauthorized');
  if (current.selection.context.sessionRef === null) throw new Error('identity_source_missing');
  return current.selection;
}
function contextRows(tx: LedgerTransaction, authority: ChildAuthority) {
  const context = readContext(tx, authority.contextId, authority.generation);
  return {
    context,
    caller: tx.get('SELECT * FROM callers WHERE caller_id=?', context.callerId),
    scope: tx.get(
      'SELECT * FROM caller_scopes WHERE process_key=? AND generation=?',
      context.processKey,
      context.procGeneration
    ),
  };
}
function parentChain(tx: LedgerTransaction, parent: SessionRef | null): string[] {
  if (!parent) return [];
  // Current-child uniqueness gives each node at most one parent. Refuse an over-budget
  // chain rather than scanning unrelated delegations or accepting an unknown cycle.
  const rows = tx.all(
    `WITH RECURSIVE ancestry(ref,depth) AS (
    SELECT ?,0 UNION ALL SELECT l.parent_ref,a.depth+1 FROM links l JOIN ancestry a ON l.child_ref=a.ref
    WHERE l.current_owner=1 AND l.parent_ref IS NOT NULL AND a.depth<200)
    SELECT ref FROM ancestry ORDER BY depth`,
    refValue(parent)
  );
  if (rows.length > 200) throw new Error('graph_budget');
  return rows.map((row) => String(row.ref));
}
function assemble(tx: LedgerTransaction, runId: string, authority: ChildAuthority): HandshakeSnapshot {
  const run = readRun(tx, runId);
  const link = readLink(tx, run.linkId);
  const row = tx.get('SELECT * FROM claims WHERE run_id=?', runId);
  if (!row) throw new Error('claim_invalid');
  const claim = { ...decodeRecord<Claim>(row), supervisor: run.supervisor };
  const bindingRow = tx.get('SELECT * FROM child_bindings WHERE run_id=? AND is_current=1', runId);
  const binding = bindingRow ? decodeRecord<ChildBinding>(bindingRow) : null;
  const previousContext = binding ? readContext(tx, binding.callerContextId, binding.contextGeneration) : null;
  const anchors = tx.all(
    "SELECT * FROM events WHERE run_id=? AND kind IN ('supervisor.registered','run.startup') ORDER BY seq",
    runId
  );
  const startup = anchors.filter((event) => event.kind === 'run.startup');
  const meta = startup.length === 1 ? (JSON.parse(String(startup[0].payload)).meta as RunMeta) : null;
  const context = readContext(tx, authority.contextId, authority.generation);
  return {
    run,
    link,
    claim,
    binding,
    context,
    previousContext,
    meta,
    version: canonicalJson({
      run: tx.get('SELECT * FROM runs WHERE run_id=?', runId),
      link: tx.get('SELECT * FROM links WHERE link_id=?', link.linkId),
      latest: tx.get(
        'SELECT run_id,expected_generation FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1',
        link.linkId
      ),
      claim: row,
      binding: bindingRow ?? null,
      anchors,
      source: tx.get('SELECT * FROM sources WHERE source_id=?', run.sourceId),
      current: contextRows(tx, authority),
      previousContext,
      targetSlots: tx.all(
        'SELECT * FROM slots WHERE run_id=? OR session_ref=? ORDER BY slot_key',
        runId,
        refValue(context.sessionRef)
      ),
      owners: tx.all('SELECT link_id FROM links WHERE child_ref=? AND current_owner=1', refValue(context.sessionRef)),
      parentChain: parentChain(tx, link.parentRef),
    }),
  };
}
/** Authorization precedes even the claim lookup. The caller then obtains OS proof outside the write transaction. */
export async function readHandshakeSnapshot(
  ledger: Ledger,
  claimHash: string,
  authority: ChildAuthority,
  budget?: CallBudget
): Promise<HandshakeSnapshot> {
  return ledger.readSnapshot((tx) => {
    selection(tx, authority);
    const row = tx.get('SELECT run_id FROM claims WHERE claim_hash=?', claimHash);
    if (!row) throw new Error('claim_invalid');
    return assemble(tx, String(row.run_id), authority);
  }, budget);
}
function conflict(
  tx: LedgerTransaction,
  run: Run,
  ref: SessionRef,
  cause: 'provisional_conflict' | 'resume_ref_mismatch',
  at: number
) {
  const evidenceId = `handshake-conflict:${digest([run.runId, sessionRefKey(ref), cause])}`;
  if (!tx.get('SELECT 1 FROM evidence WHERE evidence_id=?', evidenceId)) {
    insertRecord(tx, 'evidence', {
      evidenceId,
      runId: run.runId,
      linkId: run.linkId,
      kind: 'conflict',
      producer: 'reconciler',
      fingerprint: digest([run.runId, ref, cause]),
      payload: { cause, sessionRef: refValue(ref) },
      observedAt: at,
      validatedAt: at,
      validation: 'accepted',
    });
    if (!isRunTerminal(run)) tx.run("UPDATE runs SET state='uncertain' WHERE run_id=?", run.runId);
    insertRecord(tx, 'events', {
      runId: run.runId,
      linkId: run.linkId,
      kind: 'run.conflict',
      payload: { evidenceId, cause },
      at,
    });
  }
}
/** Only a service that independently checked the registered launch instance may call this reconciler entry. */
export async function commitHandshake(
  ledger: Ledger,
  expected: HandshakeSnapshot,
  authority: ChildAuthority,
  claimHash: string,
  evidence: Evidence,
  at: number,
  budget?: ChildWriteBudget
): Promise<HandshakeResult> {
  const copy = structuredClone(expected),
    proof = structuredClone(evidence),
    auth = structuredClone(authority);
  if (
    proof.runId !== copy.run.runId ||
    proof.linkId !== copy.link.linkId ||
    proof.kind !== 'launch_receipt' ||
    proof.producer !== 'reconciler' ||
    proof.validation !== 'accepted' ||
    proof.validatedAt !== at ||
    !Number.isSafeInteger(at) ||
    at < 0
  )
    throw new TypeError('invalid_handshake_evidence');
  return childTransaction(
    ledger,
    (tx) => {
      const selected = selection(tx, auth);
      const current = assemble(tx, copy.run.runId, auth);
      if (current.version !== copy.version) throw new Error('stale_context');
      const { run, link, claim, context, binding } = current;
      if (
        tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', link.linkId)?.run_id !==
        run.runId
      )
        throw new Error('stale_binding');
      if (
        !['pending', 'claimed', 'bound', 'reported'].includes(link.state) ||
        hasConflict(tx, link.linkId, refValue(run.targetSessionRef))
      )
        throw new Error('identity_conflict');
      if (!run.supervisor) throw new Error('claim_not_armed');
      const ref = context.sessionRef!;
      const restored =
        binding &&
        current.previousContext &&
        binding.isCurrent &&
        binding.revokedAt === null &&
        binding.bindingGeneration === run.expectedGeneration &&
        current.previousContext.kind === 'dedicated' &&
        context.kind === 'dedicated' &&
        current.previousContext.closedAt === null &&
        current.previousContext.processKey === context.processKey &&
        current.previousContext.procGeneration === context.procGeneration &&
        current.previousContext.sessionRef !== null &&
        sameSessionRef(current.previousContext.sessionRef, ref) &&
        sameSessionRef(binding.sessionRef, ref);
      const mapped = restored
        ? {
            ...binding,
            callerId: context.callerId,
            callerContextId: context.contextId,
            contextGeneration: context.generation,
          }
        : binding;
      const redeemed = redeemClaim(
        claim,
        {
          selection: selected,
          claimHash,
          currentBinding: mapped,
          run: {
            runId: run.runId,
            sourceId: run.sourceId,
            bindingGeneration: run.expectedGeneration,
            supervisor: run.supervisor,
            launchCallId: run.launchCallId,
            launchCorrelationId: run.launchCorrelationId,
          },
        },
        at
      );
      if (!redeemed.ok) throw new Error(redeemed.reason);
      const resolved = resolveBinding({
        hasMcp: true,
        registered: true,
        claimValid: true,
        currentSourceVerified: true,
        independentLaunchVerified: true,
        independentSessionVerified: true,
        contradictoryEvidence: false,
        candidateRefs: [ref],
        expectedRef: run.targetSessionRef ?? link.childRef,
        currentBinding: binding,
        otherUnboundClaimant: false,
      });
      if (resolved.state !== 'bound') {
        if (resolved.reason === 'resume_ref_mismatch') {
          conflict(tx, run, ref, 'resume_ref_mismatch', at);
          return { ok: false, code: resolved.reason };
        }
        throw new Error(resolved.reason ?? 'identity_conflict');
      }
      if (parentChain(tx, link.parentRef).includes(sessionRefKey(ref))) throw new Error('delegation_cycle');
      if (
        tx.get('SELECT 1 FROM links WHERE child_ref=? AND current_owner=1 AND link_id<>?', refValue(ref), link.linkId)
      )
        throw new Error('identity_conflict');
      let repairedSlot = false;
      const ownSlot = tx.get('SELECT * FROM slots WHERE run_id=?', run.runId);
      if (ownSlot) {
        const slots = tx
          .all('SELECT * FROM slots WHERE run_id=? OR session_ref=?', run.runId, refValue(ref))
          .map((row) => decodeRecord<RunSlot>(row));
        const migration = planSlotMigration(slots, run.runId, ref);
        if (!migration.ok) {
          for (const id of migration.uncertainRunIds) conflict(tx, readRun(tx, id), ref, 'provisional_conflict', at);
          return { ok: false, code: 'provisional_conflict' };
        }
        if (ownSlot.slot_key !== sessionRefKey(ref) || ownSlot.session_ref !== refValue(ref)) {
          repairedSlot = true;
          tx.run(
            'UPDATE slots SET slot_key=?,session_ref=? WHERE run_id=?',
            sessionRefKey(ref),
            refValue(ref),
            run.runId
          );
        }
      } else if (!isRunTerminal(run)) throw new Error('slot_missing');
      if (
        binding &&
        mapped &&
        binding.callerId === context.callerId &&
        binding.callerContextId === context.contextId &&
        binding.contextGeneration === context.generation
      ) {
        const result = {
          ok: true as const,
          state: 'bound' as const,
          linkId: link.linkId,
          runId: run.runId,
          reason: null,
        };
        return repairedSlot ? result : tx.priorDurableResult(result);
      }
      insertRecord(tx, 'evidence', proof);
      if (redeemed.consumed) {
        tx.run(
          "UPDATE claims SET state='redeemed',redeemed_context_id=?,redeemed_generation=?,redeemed_session_ref=?,redeemed_at=? WHERE run_id=?",
          context.contextId,
          context.generation,
          refValue(ref),
          at,
          run.runId
        );
        insertRecord(tx, 'events', {
          runId: run.runId,
          linkId: link.linkId,
          kind: 'claim.redeemed',
          payload: { contextId: context.contextId, generation: context.generation },
          at,
        });
        if (link.state === 'pending' || link.state === 'claimed') {
          const claimed = advanceLink(link, { kind: 'claimed', at });
          tx.run(
            'UPDATE links SET state=?,claimed_at=? WHERE link_id=?',
            claimed.state,
            claimed.claimedAt,
            link.linkId
          );
        }
      }
      if (binding)
        tx.run('UPDATE child_bindings SET is_current=0,revoked_at=? WHERE binding_id=?', at, binding.bindingId);
      const newBinding: ChildBinding = {
        bindingId: randomUUID(),
        runId: run.runId,
        sessionRef: ref,
        bindingGeneration: run.expectedGeneration,
        callerId: context.callerId,
        callerContextId: context.contextId,
        contextGeneration: context.generation,
        boundBy: 'receipt',
        capabilities: 'mcp',
        evidenceId: proof.evidenceId,
        isCurrent: true,
        createdAt: at,
        revokedAt: null,
      };
      insertRecord(tx, 'child_bindings', newBinding);
      const nextLink = advanceLink(link, { kind: 'bound', ref, at });
      tx.run(
        'UPDATE links SET state=?,child_ref=?,current_owner=1,bound_at=? WHERE link_id=?',
        nextLink.state,
        refValue(ref),
        nextLink.boundAt,
        link.linkId
      );
      tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', refValue(ref), run.runId);
      insertRecord(tx, 'events', {
        runId: run.runId,
        linkId: link.linkId,
        kind: 'child.bound',
        payload: { bindingId: newBinding.bindingId, evidenceId: proof.evidenceId, restored: Boolean(restored) },
        at,
      });
      return { ok: true, state: 'bound', linkId: link.linkId, runId: run.runId, reason: null };
    },
    budget
  );
}

export interface ChildReportInput {
  runId: string;
  status: ReportStatus;
  summary: string;
  reportPath?: string;
}
export async function commitChildReport(
  ledger: Ledger,
  supplied: ChildReportInput,
  authority: ChildAuthority,
  at: number,
  budget?: ChildWriteBudget,
  home?: string
): Promise<{ ok: true; reportId: string; runId: string } | { ok: false; code: string }> {
  const input = structuredClone(supplied),
    auth = structuredClone(authority);
  if (!Number.isSafeInteger(at) || at < 0 || typeof input.summary !== 'string') throw new TypeError('invalid_report');
  let hintSeq: number | undefined;
  const result = await childTransaction(
    ledger,
    (tx) => {
      const selected = selection(tx, auth);
      const run = readRun(tx, input.runId),
        link = readLink(tx, run.linkId);
      const row = tx.get('SELECT * FROM child_bindings WHERE run_id=? AND is_current=1', run.runId);
      const binding = row ? decodeRecord<ChildBinding>(row) : null;
      const context = selected.context;
      const report: Report = {
        reportId: randomUUID(),
        runId: run.runId,
        linkId: link.linkId,
        childBindingId: binding?.bindingId ?? '',
        callerId: context.callerId,
        callerContextId: context.contextId,
        contextGeneration: context.generation,
        status: input.status,
        summary: input.summary,
        path: input.reportPath ?? null,
        createdAt: at,
      };
      const allowed = reportPolicy(report, run, binding, selected);
      const latest = tx.get(
        'SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1',
        link.linkId
      )?.run_id;
      const code = !allowed.accepted
        ? allowed.reason!
        : latest !== run.runId
          ? 'stale_binding'
          : !link.currentOwner || !['bound', 'reported'].includes(link.state)
            ? 'unauthorized'
            : hasConflict(tx, link.linkId, refValue(run.targetSessionRef))
              ? 'identity_conflict'
              : null;
      if (code) {
        insertRecord(tx, 'events', {
          runId: run.runId,
          linkId: link.linkId,
          kind: 'report.rejected',
          payload: { reason: code, contextId: context.contextId, generation: context.generation },
          at,
        });
        return { ok: false as const, code };
      }
      insertRecord(tx, 'reports', report);
      const next = linkAfterReport(link, report, run);
      tx.run('UPDATE links SET state=? WHERE link_id=?', next.state, link.linkId);
      const event = {
        runId: run.runId,
        linkId: link.linkId,
        kind: 'report.received',
        payload: { reportId: report.reportId },
        at,
      };
      insertRecord(tx, 'events', event);
      if (isWakeWorthyEvent(event)) hintSeq = Number(tx.get('SELECT last_insert_rowid() AS seq')!.seq);
      return { ok: true as const, reportId: report.reportId, runId: run.runId };
    },
    budget
  );
  if (home && hintSeq !== undefined) touchHint(home, input.runId, hintSeq);
  return result;
}

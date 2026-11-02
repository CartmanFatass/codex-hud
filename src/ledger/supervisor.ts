import { canonicalJson } from '../core/canonical.js';
import { procOwnerKey, sessionOwnerKey } from '../core/identity.js';
import { isRunTerminal } from '../core/execution.js';
import {
  heartbeatUpdateAllowed,
  sameProcessStamp,
  scopeUpdateAllowed,
  submissionAllowed,
  supervisorRegistrationEvent,
} from '../core/supervision.js';
import type { ProcessScope, ProcessStamp, RunMeta } from '../core/types/supervision.js';
import type { Ledger } from './ledger.js';
import { acceptedActor, hasConflict, linkOwner, requireParentControl, revalidateActor } from './intents.js';
import { insertRecord, readContext, readLink, readRun, refValue } from './records.js';
import type { IntentAuthority } from './types.js';
import type { LedgerTransaction } from './transaction.js';
import type { Run } from '../core/types/execution.js';
import type { PrivateLedgerGate } from './local-manager.js';

export interface SupervisorRegistration {
  runId: string;
  ticketHash: string;
  launchDigest: string;
  supervisor: ProcessStamp;
  authority: IntentAuthority | { kind: 'execution_ticket' };
  at: number;
  monoMs: number;
}

/** Execution revalidates the accepted typed actor, never invents a new MCP call.
 * The ticket/digest/slot checks below still gate the sole submission.
 */
function revalidateExecutor(
  tx: LedgerTransaction,
  run: Run,
  authority: SupervisorRegistration['authority'],
  gate?: PrivateLedgerGate
): void {
  const claim = tx.get('SELECT state,expected_generation,source_id FROM claims WHERE run_id=?', run.runId);
  if (
    !claim ||
    !['issued', 'armed'].includes(String(claim.state)) ||
    claim.expected_generation !== run.expectedGeneration ||
    claim.source_id !== run.sourceId
  )
    throw new Error('claim_not_current');
  if (authority.kind !== 'execution_ticket') {
    revalidateActor(tx, run, authority);
    return;
  }
  if (!gate) throw new Error('execution_gate_required');
  gate.check();
  const { actor, ownerKey } = acceptedActor(tx, run.runId);
  const link = readLink(tx, run.linkId);
  requireParentControl(link);
  if (linkOwner(tx, link) !== ownerKey) throw new Error('initiator_owner_changed');
  const latest = tx.get(
    'SELECT run_id,expected_generation FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1',
    link.linkId
  );
  if (latest?.run_id !== run.runId || latest.expected_generation !== run.expectedGeneration)
    throw new Error('stale_run');
  if (actor.kind === 'local_user') {
    if (
      run.operation !== 'resume' ||
      actor.uid !== process.getuid!() ||
      !actor.invocationId ||
      link.parentRef === null ||
      actor.representedOwner !== ownerKey ||
      run.launchCallId !== `local:${actor.invocationId}`
    )
      throw new Error('unauthorized');
    return;
  }
  if (actor.kind !== 'mcp') throw new Error('unauthorized');
  const context = readContext(tx, actor.contextId, actor.contextGeneration);
  const scope = tx.get(
    'SELECT * FROM caller_scopes WHERE process_key=? AND generation=?',
    context.processKey,
    context.procGeneration
  );
  const caller = tx.get('SELECT * FROM callers WHERE caller_id=?', actor.callerId);
  if (
    context.kind !== 'dedicated' ||
    context.closedAt !== null ||
    context.generation !== context.procGeneration ||
    context.callerId !== actor.callerId ||
    !scope ||
    scope.closed_at !== null ||
    !caller ||
    caller.retired_at !== null ||
    context.sourceId !== scope.source_id ||
    context.harness !== scope.harness ||
    caller.source_id !== context.sourceId ||
    caller.harness !== context.harness ||
    scope.session_ref !== refValue(context.sessionRef) ||
    (link.parentRef !== null && refValue(context.sessionRef) !== refValue(link.parentRef)) ||
    tx.get(
      'SELECT 1 FROM caller_scopes WHERE process_key=? AND generation>?',
      context.processKey,
      context.procGeneration
    ) ||
    tx.get('SELECT 1 FROM caller_contexts WHERE context_id=? AND generation>?', context.contextId, context.generation)
  )
    throw new Error('stale_context');
  const currentOwner =
    context.sessionRef === null
      ? procOwnerKey(context.processKey, context.procGeneration)
      : sessionOwnerKey(context.sessionRef);
  if (currentOwner !== ownerKey) throw new Error('initiator_owner_changed');
}
/** One winner consumes the reserved ticket; the full instance is committed before file metadata. */
export async function registerSupervisor(
  ledger: Ledger,
  supplied: SupervisorRegistration,
  gate?: PrivateLedgerGate
): Promise<void> {
  const input = JSON.parse(canonicalJson(supplied)) as SupervisorRegistration;
  if (!Number.isSafeInteger(input.monoMs) || input.monoMs < 0) throw new TypeError('invalid_heartbeat');
  await ledger.transaction((tx) => {
    const run = readRun(tx, input.runId);
    const event = supervisorRegistrationEvent(run, input.supervisor, input.at);
    revalidateExecutor(tx, run, input.authority, gate);
    if (
      run.state !== 'starting' ||
      run.launchPhase !== 'reserved' ||
      run.supervisor !== null ||
      run.launchTokenHash !== input.ticketHash ||
      run.launchDigest !== input.launchDigest ||
      run.cancelRequestedAt !== null ||
      run.submissionFencedAt !== null ||
      input.at < run.createdAt ||
      input.at - run.createdAt > 30000 ||
      !tx.get('SELECT 1 FROM slots WHERE run_id=?', run.runId) ||
      hasConflict(tx, run.linkId, refValue(run.targetSessionRef)) ||
      tx.get("SELECT 1 FROM events WHERE run_id=? AND kind='supervisor.registered'", run.runId)
    )
      throw new Error('ticket_unavailable');
    const claim = tx.get('SELECT state,source_id,expected_generation FROM claims WHERE run_id=?', run.runId);
    if (
      !claim ||
      claim.state !== 'issued' ||
      claim.source_id !== run.sourceId ||
      claim.expected_generation !== run.expectedGeneration
    )
      throw new Error('claim_not_issued');
    const changed = tx.run(
      `UPDATE runs SET launch_phase='armed',supervisor_pid=?,supervisor_proc_start=?,heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=?
      WHERE run_id=? AND launch_phase='reserved' AND supervisor_pid IS NULL AND cancel_requested_at IS NULL AND submission_fenced_at IS NULL`,
      input.supervisor.pid,
      input.supervisor.proc_start,
      input.at,
      input.monoMs,
      run.runId
    );
    if (changed !== 1) throw new Error('ticket_unavailable');
    tx.run(
      "UPDATE claims SET state='armed',supervisor_pid=?,supervisor_proc_start=? WHERE run_id=?",
      input.supervisor.pid,
      input.supervisor.proc_start,
      run.runId
    );
    insertRecord(tx, 'events', event);
  });
}

/** Created once by the registered producer. Each tick is exactly one runs CAS, with no periodic events. */
export function createHeartbeatWriter(
  ledger: Ledger,
  runId: string,
  producer: ProcessStamp,
  initialRun?: Run
): {
  tick(at: number, monoMs: number): Promise<{ cancelRequestedAt: number | null; seq: number } | null>;
} {
  const initial = initialRun ?? ledger.snapshot((tx) => readRun(tx, runId));
  if (initial.runId !== runId) throw new Error('producer_mismatch');
  if (!sameProcessStamp(producer, initial.supervisor) || isRunTerminal(initial)) throw new Error('producer_mismatch');
  let seq = initial.heartbeatSeq;
  let mono = initial.heartbeatMonoMs!;
  let wall = initial.heartbeatAt!;
  const registered = { ...initial.supervisor! };
  return {
    async tick(at, monoMs) {
      if (
        !Number.isSafeInteger(at) ||
        at < wall ||
        !Number.isSafeInteger(monoMs) ||
        monoMs < mono ||
        !heartbeatUpdateAllowed({
          terminal: false,
          recoveryObserver: false,
          storedSeq: seq,
          expectedSeq: seq,
          producer,
          registeredSupervisor: registered,
        })
      )
        throw new Error('invalid_heartbeat');
      const expectedSeq = seq;
      const result = await ledger.transaction((tx) =>
        tx.get(
          `UPDATE runs SET heartbeat_at=?,heartbeat_seq=heartbeat_seq+1,heartbeat_mono_ms=?
        WHERE run_id=? AND supervisor_pid=? AND supervisor_proc_start=? AND heartbeat_seq=?
          AND state IN ('starting','running','cancelling','uncertain') RETURNING cancel_requested_at,heartbeat_seq`,
          at,
          monoMs,
          runId,
          producer.pid,
          producer.proc_start,
          expectedSeq
        )
      );
      if (!result) return null;
      seq = Number(result.heartbeat_seq);
      mono = monoMs;
      wall = at;
      return {
        cancelRequestedAt: result.cancel_requested_at === null ? null : Number(result.cancel_requested_at),
        seq,
      };
    },
  };
}

/** Called before the sole external submission. Returning success never itself submits anything. */
export async function beginSubmission(
  ledger: Ledger,
  input: SupervisorRegistration,
  gate?: PrivateLedgerGate
): Promise<void> {
  await ledger.transaction((tx) => {
    const run = readRun(tx, input.runId);
    revalidateExecutor(tx, run, input.authority, gate);
    const authorized =
      run.launchTokenHash === input.ticketHash &&
      run.launchDigest === input.launchDigest &&
      run.cancelRequestedAt === null &&
      !hasConflict(tx, run.linkId, refValue(run.targetSessionRef)) &&
      Boolean(tx.get('SELECT 1 FROM slots WHERE run_id=?', run.runId)) &&
      run.state === 'starting';
    if (
      !submissionAllowed({
        phase: run.launchPhase,
        originalExecutor: sameProcessStamp(run.supervisor, input.supervisor),
        ticketConsumed: run.supervisor !== null,
        fenced: run.submissionFencedAt !== null,
        authorized,
        recoveryObserver: false,
      })
    )
      throw new Error('submission_forbidden');
    tx.run("UPDATE runs SET launch_phase='submitting' WHERE run_id=?", run.runId);
    insertRecord(tx, 'events', {
      runId: run.runId,
      linkId: run.linkId,
      kind: 'launch.submitting',
      payload: {},
      at: input.at,
    });
  });
}

/** Exact receipt metadata only; a submitting timeout has no retry path. */
export async function markSubmitted(
  ledger: Ledger,
  runId: string,
  producer: ProcessStamp,
  at: number,
  messageId: string | null = null
): Promise<void> {
  await ledger.transaction((tx) => {
    const run = readRun(tx, runId);
    if (!sameProcessStamp(run.supervisor, producer) || run.launchPhase !== 'submitting' || isRunTerminal(run))
      throw new Error('submission_forbidden');
    tx.run(
      "UPDATE runs SET launch_phase='submitted',launch_message_id=coalesce(launch_message_id,?) WHERE run_id=?",
      messageId,
      runId
    );
    insertRecord(tx, 'events', { runId, linkId: run.linkId, kind: 'launch.submitted', payload: { messageId }, at });
  });
}

export async function recordScope(
  ledger: Ledger,
  runId: string,
  producer: ProcessStamp,
  scope: ProcessScope | null,
  at: number,
  meta?: RunMeta
): Promise<void> {
  // Process discovery and scope verification belong to hud-run; this API enforces persistence immutability.
  const encoded = canonicalJson(scope);
  meta = meta === undefined ? undefined : JSON.parse(canonicalJson(meta));
  await ledger.transaction((tx) => {
    const run = readRun(tx, runId);
    if (!sameProcessStamp(run.supervisor, producer) || isRunTerminal(run) || !scopeUpdateAllowed(run.scopeRef, scope))
      throw new Error('scope_update_forbidden');
    if (meta) {
      if (
        meta.run_id !== runId ||
        meta.link_id !== run.linkId ||
        meta.source_id !== run.sourceId ||
        meta.binding_generation !== run.expectedGeneration ||
        !sameProcessStamp(meta.supervisor, producer) ||
        meta.launch_digest !== run.launchDigest ||
        meta.launch_cwd !== run.launchCwd ||
        meta.launch_call_id !== run.launchCallId ||
        meta.launch_correlation_id !== run.launchCorrelationId ||
        meta.mode !== run.mode ||
        meta.created_at !== run.createdAt ||
        canonicalJson(meta.project_origin) !== canonicalJson(run.projectOrigin) ||
        canonicalJson(meta.scope) !== encoded
      )
        throw new Error('startup_mismatch');
      const existing = tx.get("SELECT payload FROM events WHERE run_id=? AND kind='run.startup'", runId);
      if (existing) {
        if (canonicalJson(JSON.parse(String(existing.payload)).meta) !== canonicalJson(meta))
          throw new Error('startup_conflict');
        return;
      }
      tx.run('UPDATE runs SET started_at=coalesce(started_at,?) WHERE run_id=?', at, runId);
      insertRecord(tx, 'events', { runId, linkId: run.linkId, kind: 'run.startup', payload: { meta }, at });
    }
    if (run.scopeRef !== null) return;
    tx.run('UPDATE runs SET scope_ref=? WHERE run_id=?', encoded, runId);
    insertRecord(tx, 'events', {
      runId,
      linkId: run.linkId,
      kind: 'scope.recorded',
      payload: { scope: JSON.parse(encoded) },
      at,
    });
  });
}

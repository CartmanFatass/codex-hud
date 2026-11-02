import { canonicalJson } from '../core/canonical.js';
import { isRunTerminal } from '../core/execution.js';
import {
  heartbeatUpdateAllowed,
  sameProcessStamp,
  scopeUpdateAllowed,
  submissionAllowed,
  supervisorRegistrationEvent,
} from '../core/supervision.js';
import type { ProcessScope, ProcessStamp } from '../core/types/supervision.js';
import type { Ledger } from './ledger.js';
import { hasConflict, revalidateActor } from './intents.js';
import { insertRecord, readRun, refValue } from './records.js';
import type { IntentAuthority } from './types.js';

export interface SupervisorRegistration {
  runId: string;
  ticketHash: string;
  launchDigest: string;
  supervisor: ProcessStamp;
  authority: IntentAuthority;
  at: number;
  monoMs: number;
}
/** One winner consumes the reserved ticket; the full instance is committed before file metadata. */
export async function registerSupervisor(ledger: Ledger, supplied: SupervisorRegistration): Promise<void> {
  const input = JSON.parse(canonicalJson(supplied)) as SupervisorRegistration;
  if (!Number.isSafeInteger(input.monoMs) || input.monoMs < 0) throw new TypeError('invalid_heartbeat');
  await ledger.transaction((tx) => {
    const run = readRun(tx, input.runId);
    const event = supervisorRegistrationEvent(run, input.supervisor, input.at);
    revalidateActor(tx, run, input.authority);
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
  producer: ProcessStamp
): {
  tick(at: number, monoMs: number): Promise<{ cancelRequestedAt: number | null; seq: number } | null>;
} {
  const initial = ledger.snapshot((tx) => readRun(tx, runId));
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
export async function beginSubmission(ledger: Ledger, input: SupervisorRegistration): Promise<void> {
  await ledger.transaction((tx) => {
    const run = readRun(tx, input.runId);
    revalidateActor(tx, run, input.authority);
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
  scope: ProcessScope,
  at: number
): Promise<void> {
  // Process discovery and scope verification belong to hud-run; this API enforces persistence immutability.
  const encoded = canonicalJson(scope);
  await ledger.transaction((tx) => {
    const run = readRun(tx, runId);
    if (!sameProcessStamp(run.supervisor, producer) || isRunTerminal(run) || !scopeUpdateAllowed(run.scopeRef, scope))
      throw new Error('scope_update_forbidden');
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

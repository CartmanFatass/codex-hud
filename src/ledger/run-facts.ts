import { canonicalJson, digest } from '../core/canonical.js';
import { isRunTerminal } from '../core/execution.js';
import { inspectReceipt, sameProcessStamp } from '../core/supervision.js';
import { recordWakeRevoked, validateRetireRequest } from './notify-events.js';
import type { Termination, Run, LedgerEvent, ReconcileDecision, ReconcileEvidence } from '../core/types/execution.js';
import type { FinalExitReceipt, ProcessStamp, RunMeta } from '../core/types/supervision.js';
import type { Ledger } from './ledger.js';
import { acceptedActor } from './intents.js';
import { insertRecord, readRun, readEvents } from './records.js';
import type { LedgerTransaction } from './transaction.js';

export function requireRunWriter(tx: LedgerTransaction, runId: string, producer: ProcessStamp) {
  const run = readRun(tx, runId);
  if (!sameProcessStamp(run.supervisor, producer)) throw new Error('writer_not_registered');
  return run;
}
const rawKeys: Record<string, string[]> = {
  'launch.sealed': ['helper', 'command', 'scope'],
  'supervisor.signal': ['signal', 'observedAt'],
  'command.exited': ['command', 'code', 'signal', 'observedAt'],
  'submission.fenced': ['proof_ids'],
  'cancel.step': ['requestSeq', 'signal', 'ack'],
  'cancel.unconfirmed': ['requestSeq', 'reason'],
  'clock.anomaly': ['wallDeltaMs', 'monoDeltaMs'],
  'parent.offline': ['contextId', 'generation', 'since', 'orphanPolicy'],
};
/** Only raw observations; no state setter or slot release is available here. */
export async function appendRunFact(
  ledger: Ledger,
  runId: string,
  producer: ProcessStamp,
  kind: string,
  payload: Record<string, unknown>
): Promise<number> {
  const copy = JSON.parse(canonicalJson(payload));
  if (!rawKeys[kind] || Object.keys(copy).some((key) => !rawKeys[kind].includes(key)))
    throw new Error('raw_kind_forbidden');
  if (
    kind === 'supervisor.signal' &&
    (!['SIGHUP', 'SIGINT', 'SIGTERM'].includes(copy.signal) ||
      !Number.isSafeInteger(copy.observedAt) ||
      copy.observedAt < 0 ||
      copy.observedAt > Date.now())
  )
    throw new Error('supervisor_signal_invalid');
  return ledger.transaction((tx) => {
    const run = requireRunWriter(tx, runId, producer);
    // H07 observations may race the terminal import while the original start()
    // writer drains its callbacks. They cannot change state or reopen execution.
    if (isRunTerminal(run) && kind !== 'supervisor.signal') throw new Error('writer_terminal');
    if (kind === 'parent.offline') {
      const { actor } = acceptedActor(tx, runId);
      if (
        actor.kind !== 'mcp' ||
        copy.contextId !== actor.contextId ||
        copy.generation !== actor.contextGeneration ||
        copy.orphanPolicy !== run.orphanPolicy
      )
        throw new Error('parent_mismatch');
    }
    const at = Date.now();
    insertRecord(tx, 'events', { runId, linkId: run.linkId, kind, payload: copy, at });
    const seq = Number(tx.get('SELECT last_insert_rowid() AS seq')!.seq);
    if (kind === 'parent.offline') {
      const registrations = tx.all(
        `SELECT e.seq FROM events e WHERE e.link_id=? AND e.kind='wake.registered'
          AND json_extract(e.payload,'$.contextGeneration')=?
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.link_id=e.link_id AND r.kind='wake.revoked'
            AND json_extract(r.payload,'$.registrationSeq')=e.seq)`,
        run.linkId,
        copy.generation
      );
      for (const registration of registrations)
        recordWakeRevoked(
          tx,
          run.linkId,
          {
            registrationSeq: Number(registration.seq),
            reason: 'parent_offline',
          },
          at
        );
    }
    return seq;
  });
}
export async function recordRunReceipt(
  ledger: Ledger,
  runId: string,
  producer: ProcessStamp,
  receipt: FinalExitReceipt
): Promise<void> {
  const copy = JSON.parse(canonicalJson(receipt)) as FinalExitReceipt;
  await ledger.transaction((tx) => persistRunReceipt(tx, runId, producer, copy));
}

/** Validated final files can also be imported by the reconciler under its CAS gate. */
export function persistRunReceipt(
  tx: LedgerTransaction,
  runId: string,
  producer: ProcessStamp,
  copy: FinalExitReceipt
): void {
  const run = requireRunWriter(tx, runId, producer);
  const startup = tx.get("SELECT payload FROM events WHERE run_id=? AND kind='run.startup'", runId);
  if (!startup) throw new Error('startup_missing');
  const meta = JSON.parse(String(startup.payload)).meta as RunMeta;
  const result = inspectReceipt(
    { final: true, complete: true, fingerprint: digest(copy), receipt: copy },
    meta,
    new Map()
  );
  const fence = tx.get(
    "SELECT payload,at FROM events WHERE seq=? AND run_id=? AND kind='submission.fenced'",
    copy.submission_fence.event_seq,
    runId
  );
  if (
    result.decision !== 'adopt' ||
    !fence ||
    canonicalJson(JSON.parse(String(fence.payload)).proof_ids) !== canonicalJson(copy.submission_fence.proof_ids) ||
    copy.created_at !== run.createdAt ||
    copy.started_at !== run.startedAt ||
    copy.ended_at < (run.startedAt ?? run.createdAt) ||
    copy.recorded_at < copy.ended_at
  )
    throw new Error('receipt_invalid');
  const shell = copy.shell_exit;
  if (
    shell &&
    (!sameProcessStamp(shell.process, meta.command_leader) ||
      shell.status_source !== 'wait_status' ||
      (shell.exit_code !== null
        ? !Number.isInteger(shell.exit_code) || shell.signal !== null
        : typeof shell.signal !== 'string' || !shell.signal))
  )
    throw new Error('shell_receipt_invalid');
  const previous = tx.get("SELECT payload FROM events WHERE run_id=? AND kind='exit.receipt'", runId);
  if (previous) {
    if (canonicalJson(JSON.parse(String(previous.payload)).receipt) !== canonicalJson(copy))
      throw new Error('receipt_conflict');
    return;
  }
  insertRecord(tx, 'events', {
    runId,
    linkId: run.linkId,
    kind: 'exit.receipt',
    payload: { receipt: copy, fingerprint: digest(copy) },
    at: copy.recorded_at,
  });
}

export { terminalNote, terminationProjection } from '../core/link/terminal.js';

function recordObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: unknown, required: string[]): value is Record<string, any> {
  return (
    recordObject(value) &&
    Object.keys(value).length === required.length &&
    required.every((k) => Object.hasOwn(value, k))
  );
}
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function acceptedCancellation(tx: LedgerTransaction, run: Run, events: LedgerEvent[], nowMs: number) {
  // Existing cancellation API coalesces to its first canonical accepted request.
  const event = events.find((e) => e.kind === 'cancel.accepted');
  if (
    !event ||
    !exactKeys(event.payload, ['actor', 'runId', 'bindingGeneration', 'graceMs']) ||
    event.linkId !== run.linkId ||
    event.payload.runId !== run.runId ||
    event.payload.bindingGeneration !== run.expectedGeneration ||
    !natural(event.payload.graceMs) ||
    event.payload.graceMs > 60000 ||
    !natural(event.at) ||
    event.at > nowMs ||
    event.at < run.createdAt ||
    run.cancelRequestedAt !== event.at
  )
    return null;
  const actor: unknown = event.payload.actor;
  let cause: 'user_cancel' | 'orphan_policy' | null = null;
  if (
    exactKeys(actor, ['kind', 'callerId', 'contextId', 'contextGeneration']) &&
    actor.kind === 'mcp' &&
    identifier(actor.callerId) &&
    identifier(actor.contextId) &&
    natural(actor.contextGeneration) &&
    actor.contextGeneration > 0 &&
    tx.get(
      'SELECT 1 FROM caller_contexts WHERE context_id=? AND generation=? AND caller_id=?',
      actor.contextId,
      actor.contextGeneration,
      actor.callerId
    )
  )
    cause = 'user_cancel';
  if (
    exactKeys(actor, ['kind', 'uid', 'invocationId', 'representedOwner']) &&
    actor.kind === 'local_user' &&
    natural(actor.uid) &&
    identifier(actor.invocationId) &&
    identifier(actor.representedOwner)
  )
    cause = 'user_cancel';
  if (
    exactKeys(actor, ['kind', 'uid', 'invocationId']) &&
    actor.kind === 'trusted_local' &&
    natural(actor.uid) &&
    typeof actor.invocationId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(actor.invocationId)
  )
    cause = 'user_cancel';
  if (
    exactKeys(actor, ['kind', 'supervisor']) &&
    actor.kind === 'orphan_policy' &&
    recordObject(actor.supervisor) &&
    sameProcessStamp(actor.supervisor as ProcessStamp, run.supervisor) &&
    run.orphanPolicy === 'stop'
  ) {
    const original = acceptedActor(tx, run.runId).actor;
    if (
      original.kind === 'mcp' &&
      events.some(
        (e) =>
          e.kind === 'parent.offline' &&
          e.seq < event.seq &&
          e.linkId === run.linkId &&
          e.payload.contextId === original.contextId &&
          e.payload.generation === original.contextGeneration &&
          e.payload.orphanPolicy === 'stop' &&
          natural(e.payload.since) &&
          e.payload.since <= e.at &&
          e.at <= event.at
      )
    )
      cause = 'orphan_policy';
  }
  return cause ? { event, cause } : null;
}

/** Final metadata/classification within the existing R-02 terminal transaction.
 * B22: steps reference the retirement event seq; only a validated later alive
 * witness and later complete R/Q prove positive policy timing. Competing requests
 * and the intent-to-signal gap stay unknown without request-associated proof.
 */
export function finalizeTermination(
  tx: LedgerTransaction,
  run: Run,
  decision: ReconcileDecision,
  facts: ReconcileEvidence[],
  nowMs: number
): Termination {
  const events = readEvents(tx, run.runId);
  const cancel = acceptedCancellation(tx, run, events, nowMs);
  const requests = events.filter((e) => {
    if (
      e.kind !== 'retire.requested' ||
      e.linkId !== run.linkId ||
      !natural(e.at) ||
      e.at < run.createdAt ||
      e.at > nowMs
    )
      return false;
    try {
      validateRetireRequest(tx, run.runId, e.payload);
      return true;
    } catch {
      return false;
    }
  });
  const steps = events.filter(
    (e) =>
      e.kind === 'cancel.step' &&
      e.linkId === run.linkId &&
      exactKeys(e.payload, ['requestSeq', 'signal', 'ack']) &&
      natural(e.payload.requestSeq) &&
      e.payload.requestSeq > 0 &&
      typeof e.payload.signal === 'string' &&
      ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(e.payload.signal) &&
      typeof e.payload.ack === 'boolean' &&
      natural(e.at) &&
      e.at >= run.createdAt &&
      e.at <= nowMs
  );
  const operative = requests.filter((r) => steps.some((s) => s.payload.requestSeq === r.seq));
  const ambiguousPolicy = operative.length > 1 || (operative.length === 0 && requests.length > 1);
  const policy = operative.length === 1 ? operative[0] : requests.at(-1);
  const request = cancel?.event ?? policy;
  const cause = cancel?.cause ?? (policy?.payload.cause as Termination['requestedCause'] | undefined) ?? null;
  const envelopeMatched = facts.filter(
    (e) =>
      e.validation === 'accepted' &&
      e.runId === run.runId &&
      e.sourceId === run.sourceId &&
      e.bindingGeneration === run.expectedGeneration &&
      (e.supervisor === null ? run.supervisor === null : sameProcessStamp(e.supervisor, run.supervisor))
  );
  const matched = envelopeMatched.filter(
    (e) => e.asOf !== null && Number.isFinite(e.asOf) && e.asOf >= 0 && e.asOf <= nowMs
  );
  const complete = matched.filter(
    (e) =>
      (e.fact.kind === 'receipt' || e.fact.kind === 'scope_reconciled') &&
      e.fact.complete &&
      e.fact.harnessTerminated &&
      e.fact.launchersSealed
  );
  const scopeEvidence =
    decision.row === 'R-02-4'
      ? 'N'
      : complete.some((e) => e.fact.kind === 'receipt')
        ? 'R'
        : complete.some((e) => e.fact.kind === 'scope_reconciled')
          ? 'Q'
          : null;
  if (scopeEvidence === null) throw new Error('terminal_basis_missing');
  const acknowledged = request
    ? steps.filter((e) => e.payload.requestSeq === request.seq && e.payload.ack === true && e.seq > request.seq)
    : [];
  const ranks = { SIGINT: 1, SIGTERM: 2, SIGKILL: 3 } as const;
  const highest = acknowledged.reduce((rank, e) => Math.max(rank, ranks[e.payload.signal as keyof typeof ranks]), 0);
  let attribution: Termination['attribution'] = 'unknown';
  const clockGap =
    envelopeMatched.some(
      (e) =>
        (e.fact.kind === 'heartbeat' && e.fact.clockAnomaly === true) ||
        (e.fact.kind === 'conflict' && e.fact.cause === 'clock_anomaly')
    ) ||
    events.some(
      (e) =>
        e.kind === 'clock.anomaly' &&
        e.linkId === run.linkId &&
        exactKeys(e.payload, ['wallDeltaMs', 'monoDeltaMs']) &&
        typeof e.payload.wallDeltaMs === 'number' &&
        Number.isFinite(e.payload.wallDeltaMs) &&
        typeof e.payload.monoDeltaMs === 'number' &&
        Number.isFinite(e.payload.monoDeltaMs)
    );

  if (scopeEvidence !== 'N' && !clockGap) {
    if (cancel) {
      // Bare chronology belongs to the unique established control path only.
      if (requests.length === 0) {
        const chronology = new Set(
          matched.flatMap((e) =>
            e.fact.kind === 'cancel' && e.fact.chronology !== 'unknown' ? [e.fact.chronology] : []
          )
        );
        if (chronology.size === 1) attribution = chronology.has('before_exit') ? 'caused' : 'not_caused';
      }
    } else if (policy && !ambiguousPolicy) {
      if (complete.some((e) => e.asOf! < policy.at)) attribution = 'not_caused';
      else {
        const first = steps.find((e) => e.payload.requestSeq === policy.seq);
        if (
          first?.payload.signal === 'SIGINT' &&
          first.payload.ack === true &&
          first.seq > policy.seq &&
          first.at >= policy.at &&
          matched.some(
            (e) =>
              e.fact.kind === 'scope' &&
              e.fact.state === 'alive' &&
              e.asOf! > first.at &&
              complete.some((end) => end.asOf! > e.asOf!)
          )
        )
          attribution = 'caused';
      }
    }
  }
  if (decision.row === 'R-02-2' || decision.row === 'R-02-3') {
    decision.state = cancel && attribution === 'caused' ? 'cancelled' : 'ended';
    decision.row = decision.state === 'cancelled' ? 'R-02-2' : 'R-02-3';
  }
  decision.terminalNote =
    attribution === 'unknown' && cause !== null ? (cancel ? 'cancel_timing_unknown' : 'retire_timing_unknown') : null;
  const report = tx.get(
    `SELECT r.status FROM reports r JOIN events e ON e.run_id=r.run_id AND e.link_id=r.link_id
    AND e.kind='report.received' AND json_extract(e.payload,'$.reportId')=r.report_id
    WHERE r.run_id=? AND r.link_id=? ORDER BY e.seq DESC LIMIT 1`,
    run.runId,
    run.linkId
  );
  const outcome: Termination['outcome'] =
    report?.status === 'completed'
      ? 'completed'
      : report?.status === 'failed'
        ? 'failed'
        : report?.status === 'blocked' || report?.status === 'interrupted'
          ? 'blocked'
          : 'unknown';
  return {
    outcome,
    requestedCause: cause,
    observed: {
      exitCode: decision.exitCode,
      signal: decision.exitSignal,
      escalatedTo: highest === 3 ? 'KILL' : highest === 2 ? 'TERM' : highest === 1 ? 'INT' : null,
      scopeEvidence,
    },
    attribution,
  };
}

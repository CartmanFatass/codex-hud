import { terminalNote, terminationProjection } from './run-facts.js';
import { registeredSupervisor } from '../core/supervision.js';
import { isRunTerminal } from '../core/execution.js';
import { authorizeControl, deriveRunHandshake, resumeGate } from '../core/lifecycle.js';
import type { Claim, ChildBinding } from '../core/types/identity.js';
import type { LedgerEvent, ReconciliationCause, Run } from '../core/types/execution.js';
import type { LifecycleStatus, Report } from '../core/types/lifecycle.js';
import type { IntentAuthority } from './types.js';
import type { LedgerTransaction } from './transaction.js';
import { currentAuthority, hasConflict, linkOwner } from './intents.js';
import { decodeRecord, readLink, refValue } from './records.js';

export type DelegationTarget = { runId: string } | { linkId: string };
export type DelegationRead = Omit<LifecycleStatus, 'statusProjection'> & {
  currentRun: Run;
  isCurrent: boolean;
  isRunTerminal: boolean;
  slotHeld: boolean;
};
/** Decode only registration authority, never the complete event payload history. */
function projectionRun(tx: LedgerTransaction, runId: string): Run {
  const row = tx.get('SELECT * FROM runs WHERE run_id=?', runId);
  if (!row) throw new Error('no_run');
  const run = decodeRecord<Run>(row);
  const registrations = tx
    .all("SELECT * FROM events WHERE run_id=? AND kind='supervisor.registered' ORDER BY seq LIMIT 2", runId)
    .map((row) => decodeRecord<LedgerEvent>(row));
  const stamp = registeredSupervisor(run, registrations);
  const claim = tx.get('SELECT supervisor_pid,supervisor_proc_start FROM claims WHERE run_id=?', runId);
  run.supervisor =
    stamp &&
    stamp.pid === row.supervisor_pid &&
    stamp.proc_start === row.supervisor_proc_start &&
    claim?.supervisor_pid === stamp.pid &&
    claim.supervisor_proc_start === stamp.proc_start
      ? stamp
      : null;
  delete (run as unknown as Record<string, unknown>).supervisorPid;
  delete (run as unknown as Record<string, unknown>).supervisorProcStart;
  return run;
}
function lastEvent(tx: LedgerTransaction, runId: string, kinds: string[]): LedgerEvent | null {
  const row = tx.get(
    `SELECT * FROM events WHERE run_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 1`,
    runId,
    ...kinds
  );
  return row ? decodeRecord<LedgerEvent>(row) : null;
}
/** All lifecycle, report and permission facts come from the caller's ONE read transaction. */
export function readDelegationIn(
  tx: LedgerTransaction,
  target: DelegationTarget,
  authority: IntentAuthority
): DelegationRead {
  const permission = currentAuthority(tx, authority);
  const row =
    'runId' in target
      ? tx.get('SELECT run_id,link_id FROM runs WHERE run_id=?', target.runId)
      : tx.get('SELECT run_id,link_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', target.linkId);
  if (!row) throw new Error('no_run');
  const link = readLink(tx, String(row.link_id));
  const owner = linkOwner(tx, link);
  // Historical ownership permits reading this link, never the successor's records.
  const allowed = authorizeControl('resume', link, owner, permission);
  if (!allowed.ok) throw new Error(allowed.reason);
  const run = projectionRun(tx, String(row.run_id));
  const latestId = String(
    tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', link.linkId)!.run_id
  );
  const latest = latestId === run.runId ? run : projectionRun(tx, latestId);
  const claimRow = tx.get('SELECT * FROM claims WHERE run_id=?', run.runId);
  const claim = claimRow ? { ...decodeRecord<Claim>(claimRow), supervisor: run.supervisor } : null;
  const bindingRow = tx.get(
    'SELECT * FROM child_bindings WHERE run_id=? AND is_current=1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    run.runId
  );
  const binding = bindingRow ? decodeRecord<ChildBinding>(bindingRow) : null;
  const reportRow = tx.get(
    `SELECT r.* FROM reports r JOIN events e ON e.run_id=r.run_id AND e.link_id=r.link_id
    AND e.kind='report.received' AND json_extract(e.payload,'$.reportId')=r.report_id
    WHERE r.run_id=? ORDER BY e.seq DESC LIMIT 1`,
    run.runId
  );
  const terminal = lastEvent(tx, run.runId, ['run.terminal']);
  const state = lastEvent(tx, run.runId, ['run.state', 'run.terminal', 'run.reconciliation']);
  const offline = lastEvent(tx, run.runId, ['parent.offline']);
  const gate = resumeGate({
    link,
    registeredOwner: owner,
    authority: permission,
    currentRun: latest,
    expectedRun: run.runId,
    taskDigest: link.taskDigest,
    slotHeld: !!tx.get('SELECT 1 FROM slots WHERE run_id=? OR session_ref=?', latest.runId, refValue(link.childRef)),
    unresolvedConflict: hasConflict(tx, link.linkId, refValue(run.targetSessionRef)),
    // Capability attestation is not produced on a read path. Production manifest remains unverified.
    capabilityVerified: false,
  });
  const cause = typeof state?.payload.cause === 'string' ? (state.payload.cause as ReconciliationCause) : null;
  return {
    link,
    currentRun: run,
    isCurrent: latest.runId === run.runId,
    isRunTerminal: isRunTerminal(run),
    slotHeld: !!tx.get('SELECT 1 FROM slots WHERE run_id=?', run.runId),
    terminalNote: terminalNote(terminal?.payload.terminalNote),
    termination: terminationProjection(terminal?.payload.termination),
    runHandshake: deriveRunHandshake(run, claim, binding, Date.now()),
    latestReportForRun: reportRow ? decodeRecord<Report>(reportRow) : null,
    reconciliation: cause
      ? {
          cause,
          evidenceIds: (state?.payload.evidenceIds ?? []) as string[],
          missing: [cause],
          observedAt: state!.at,
          allowedActions: [],
        }
      : null,
    interaction: { focus: false, input: false, resume: false },
    parentOffline: offline
      ? { since: Number(offline.payload.since), seq: offline.seq, orphanPolicy: run.orphanPolicy }
      : null,
    resumable: { resumable: gate.ok, reason: gate.ok ? null : gate.reason, subject: 'mcp' },
    asOfSeq: Number(tx.get('SELECT coalesce(max(seq),0) AS seq FROM events')!.seq),
    observationStamp: null,
  };
}
/** Indexed cursor page pinned to a captured high-water; no unreturned event is consumed. */
export function readDelegationEventsIn(
  tx: LedgerTransaction,
  runId: string,
  afterSeq: number,
  throughSeq: number
): { events: LedgerEvent[]; validReportSeqs: number[] } {
  const events = tx
    .all('SELECT * FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 201', runId, afterSeq, throughSeq)
    .map((row) => decodeRecord<LedgerEvent>(row));
  const validReportSeqs = events
    .filter(
      (event) =>
        event.kind === 'report.received' &&
        typeof event.payload.reportId === 'string' &&
        !!tx.get(
          'SELECT 1 FROM reports WHERE report_id=? AND run_id=? AND link_id=?',
          event.payload.reportId,
          runId,
          event.linkId
        )
    )
    .map((event) => event.seq);
  return { events, validReportSeqs };
}

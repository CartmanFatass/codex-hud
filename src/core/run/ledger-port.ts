import { createHash } from 'node:crypto';
import { canonicalJson, digest } from '../canonical.js';
import { isRunTerminal } from '../execution.js';
import { deriveRunHandshake, latestReportForRun, resumeGate } from '../lifecycle.js';
import { projectFreshness } from '../observation.js';
import { inspectReceipt, sameProcessStamp } from '../supervision.js';
import type { ReconcileEvidence } from '../types/execution.js';
import type { ReconciliationCause } from '../types/execution.js';
import type { ChildBinding, Claim } from '../types/identity.js';
import type { Report } from '../types/lifecycle.js';
import type { FinalExitReceipt, ProcessStamp, RunMeta } from '../types/supervision.js';
import { openLedger, type Ledger } from '../../ledger/ledger.js';
import { PrivateLedgerGate } from '../../ledger/local-manager.js';
import { commitCompared, commitReconcile } from '../../ledger/reconcile.js';
import { decodeRecord, insertRecord, readEvents, readRun, refValue } from '../../ledger/records.js';
import { hasConflict, linkOwner } from '../../ledger/intents.js';
import { appendRunFact, persistRunReceipt, recordRunReceipt, requireRunWriter } from '../../ledger/run-facts.js';
import {
  beginSubmission,
  createHeartbeatWriter,
  markSubmitted,
  recordScope,
  registerSupervisor,
  type SupervisorRegistration,
} from '../../ledger/supervisor.js';
import type { ReconcileSnapshot, ValidatedEvidence } from '../../ledger/types.js';
import type { CancelIntent, LocalManager, RunFactPort, RunSnapshot } from './port.js';
import { inspectGroup, processState, proveGroupGone, readProcess } from './process.js';
import { RunArtifacts } from './artifacts.js';

const hashTicket = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
function cancelFrom(events: RunSnapshot['events']): CancelIntent | null {
  const e = events.find((event) => event.kind === 'cancel.accepted');
  return e ? { seq: e.seq, at: e.at, graceMs: Number(e.payload.graceMs ?? 10000) } : null;
}

/** Production adapter. Numeric revisions are opaque handles to the exact pre-probe B2 snapshot. */
export class LedgerRunFactPort implements RunFactPort {
  private revision = 0;
  private snapshots = new Map<number, ReconcileSnapshot>();
  private managers = new Map<string, LocalManager>();
  private registrations = new Map<string, SupervisorRegistration>();
  private heartbeats = new Map<
    string,
    { seq: number; wallAt: number; writer: ReturnType<typeof createHeartbeatWriter>; cancel: CancelIntent | null }
  >();
  constructor(
    readonly ledger: Ledger,
    readonly gate: PrivateLedgerGate
  ) {
    gate.check();
  }
  async close() {
    await this.ledger.close();
  }
  private originalWriter(runId: string, supervisor: ProcessStamp): void {
    const registration = this.registrations.get(runId);
    if (
      !registration ||
      !sameProcessStamp(supervisor, registration.supervisor) ||
      !sameProcessStamp(supervisor, readProcess(process.pid)?.stamp ?? null)
    )
      throw new Error('original_executor_required');
  }
  async read(runId: string): Promise<RunSnapshot> {
    this.gate.check();
    const { expected, result } = await this.ledger.readSnapshot((tx) => {
      // This is the SAME read transaction as the metadata, claim and slot projection.
      const expected = readReconcileSnapshotIn(tx, runId);
      const events = readEvents(tx, runId);
      const claim = tx.get('SELECT * FROM claims WHERE run_id=?', runId);
      if (!claim) throw new Error('claim_missing');
      const meta = events.find((e) => e.kind === 'run.startup')?.payload.meta as unknown as RunMeta | undefined;
      const receipt = events.find((e) => e.kind === 'exit.receipt')?.payload.receipt as unknown as
        FinalExitReceipt | undefined;
      const offline = [...events].reverse().find((e) => e.kind === 'parent.offline');
      const now = Date.now();
      const run = expected.run;
      const bindingRow = tx.get(
        'SELECT * FROM child_bindings WHERE run_id=? AND is_current=1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
        runId
      );
      const binding = bindingRow ? decodeRecord<ChildBinding>(bindingRow) : null;
      const typedClaim = { ...decodeRecord<Claim>(claim), supervisor: run.supervisor };
      const reports = tx.all('SELECT * FROM reports WHERE run_id=?', runId).map((row) => decodeRecord<Report>(row));
      const committedReports = events.flatMap((event) => {
        const report =
          event.kind === 'report.received'
            ? reports.find((r) => r.reportId === event.payload.reportId && r.linkId === event.linkId)
            : undefined;
        return report ? [{ report, seq: event.seq }] : [];
      });
      const latestState = [...events]
        .reverse()
        .find((event) => ['run.state', 'run.terminal', 'run.reconciliation'].includes(event.kind));
      const cause = latestState?.payload.cause as ReconciliationCause | null | undefined;
      const latestRunId = String(
        tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', run.linkId)!.run_id
      );
      const resume = resumeGate({
        link: expected.link,
        registeredOwner: linkOwner(tx, expected.link),
        authority: {
          kind: 'local_user',
          uid: process.getuid!(),
          ownerUid: process.getuid!(),
          invocationId: 'readonly-status',
          hudHomeOwned: true,
          ledgerOwned: true,
          privatePaths: true,
        },
        currentRun: latestRunId === runId ? run : readRun(tx, latestRunId),
        expectedRun: runId,
        taskDigest: expected.link.taskDigest,
        slotHeld: !!tx.get(
          'SELECT 1 FROM slots WHERE run_id=? OR session_ref=?',
          latestRunId,
          refValue(expected.link.childRef)
        ),
        unresolvedConflict: hasConflict(tx, run.linkId, refValue(run.targetSessionRef)),
        capabilityVerified: false,
      });
      const result: RunSnapshot = {
        revision: 0,
        run,
        events,
        facts: expected.evidence.flatMap((e) =>
          Array.isArray(e.payload.reconcileFacts) ? (e.payload.reconcileFacts as unknown as ReconcileEvidence[]) : []
        ),
        meta: meta ?? null,
        receipt: receipt ?? null,
        claimSupervisor:
          claim.supervisor_pid === null
            ? null
            : { pid: Number(claim.supervisor_pid), proc_start: String(claim.supervisor_proc_start) },
        claimState: claim.state as RunSnapshot['claimState'],
        slotHeld: !!tx.get('SELECT 1 FROM slots WHERE run_id=?', runId),
        status: {
          link: expected.link,
          currentRun: run,
          terminalNote: expected.terminalNote,
          runHandshake: deriveRunHandshake(run, typedClaim, binding, now),
          latestReportForRun: latestReportForRun(committedReports, runId),
          reconciliation: cause
            ? {
                cause,
                evidenceIds: (latestState?.payload.evidenceIds ?? []) as string[],
                missing: [cause],
                observedAt: latestState!.at,
                allowedActions: [],
              }
            : null,
          interaction: { focus: false, input: false, resume: false },
          parentOffline: offline
            ? { since: Number(offline.payload.since), seq: offline.seq, orphanPolicy: run.orphanPolicy }
            : null,
          // B4 owns verified launch profiles. Until it supplies that capability,
          // preserve the actual lifecycle gate reason without inventing availability.
          resumable: { resumable: resume.ok, reason: resume.ok ? null : resume.reason, subject: 'local_user' },
          asOfSeq: expected.asOfSeq,
          observationStamp: null,
          statusProjection: {
            activity: 'unknown',
            pendingReason: 'none',
            lastTurnOutcome: 'none',
            liveness: 'unknown',
            freshness: projectFreshness([], [], now),
            stateKey: 'unknown',
            stateSince: null,
            stateSinceBasis: 'unknown',
            isRunTerminal: isRunTerminal(run),
            asOfSeq: expected.asOfSeq,
            observationStamp: null,
            asOf: null,
            observedAt: now,
            lastEvidenceAt: null,
          },
        },
      };
      return { expected, result };
    });
    result.revision = ++this.revision;
    this.snapshots.set(result.revision, expected);
    // Bounded handles: callers retry when an old handle has expired.
    if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
    return result;
  }
  async authorizeManager(runId: string, actor: LocalManager, operation: 'reconcile') {
    if (operation !== 'reconcile') throw new Error('unsupported_management_operation');
    const copy = structuredClone(actor);
    await this.ledger.transaction((tx) => {
      this.gate.check(copy);
      const row = tx.get('SELECT link_id,expected_generation FROM runs WHERE run_id=?', runId);
      if (!row) throw new Error('run_not_found');
      if (
        !tx.get(
          "SELECT 1 FROM events WHERE run_id=? AND kind='manager.reconcile' AND json_extract(payload,'$.actor.invocationId')=?",
          runId,
          copy.invocationId
        )
      )
        insertRecord(tx, 'events', {
          runId,
          linkId: row.link_id,
          kind: 'manager.reconcile',
          payload: { actor: copy, runId, bindingGeneration: row.expected_generation },
          at: Date.now(),
        });
    });
    this.managers.set(runId, copy);
  }
  async register(runId: string, ticket: string, launchDigest: string, supervisor: ProcessStamp) {
    this.gate.check();
    if (!sameProcessStamp(supervisor, readProcess(process.pid)?.stamp ?? null))
      throw new Error('supervisor_instance_mismatch');
    const input: SupervisorRegistration = {
      runId,
      ticketHash: hashTicket(ticket),
      launchDigest,
      supervisor: structuredClone(supervisor),
      authority: { kind: 'execution_ticket' },
      at: Date.now(),
      monoMs: Math.floor(performance.now()),
    };
    await registerSupervisor(this.ledger, input, this.gate);
    this.registrations.set(runId, input);
    this.heartbeats.set(runId, {
      seq: 1,
      wallAt: input.at,
      writer: await this.ledger.readSnapshot((tx) =>
        createHeartbeatWriter(this.ledger, runId, supervisor, readRun(tx, runId))
      ),
      cancel: null,
    });
  }
  async phase(runId: string, supervisor: ProcessStamp, phase: 'submitting' | 'submitted') {
    const input = this.registrations.get(runId);
    if (!input || !sameProcessStamp(supervisor, input.supervisor)) throw new Error('original_executor_required');
    if (phase === 'submitting') await beginSubmission(this.ledger, { ...input, at: Date.now() }, this.gate);
    else if (phase === 'submitted') await markSubmitted(this.ledger, runId, supervisor, Date.now());
    else throw new Error('invalid_phase');
  }
  async startup(runId: string, supervisor: ProcessStamp, meta: RunMeta) {
    this.originalWriter(runId, supervisor);
    await recordScope(this.ledger, runId, supervisor, meta.scope, Date.now(), meta);
  }
  async heartbeat(runId: string, supervisor: ProcessStamp, expectedSeq: number, monoMs: number) {
    const h = this.heartbeats.get(runId),
      registration = this.registrations.get(runId);
    if (!h || !registration || !sameProcessStamp(supervisor, registration.supervisor) || h.seq !== expectedSeq)
      return null;
    // Preserve monotonic stored H through wall-clock rollback, allowing control's
    // existing anomaly detector to commit its diagnostic immediately after this tick.
    const wallAt = Math.max(h.wallAt, Date.now());
    const result = await h.writer.tick(wallAt, Math.floor(monoMs));
    if (!result) return null;
    h.seq = result.seq;
    h.wallAt = wallAt;
    if (result.cancelRequestedAt !== null && !h.cancel)
      h.cancel = await this.ledger.readSnapshot((tx) => cancelFrom(readEvents(tx, runId)));
    return { seq: result.seq, cancel: h.cancel };
  }
  async raw(runId: string, supervisor: ProcessStamp, kind: string, payload: Record<string, unknown>) {
    this.originalWriter(runId, supervisor);
    return appendRunFact(this.ledger, runId, supervisor, kind, payload);
  }
  async receipt(runId: string, supervisor: ProcessStamp, receipt: FinalExitReceipt) {
    this.originalWriter(runId, supervisor);
    return recordRunReceipt(this.ledger, runId, supervisor, receipt);
  }
  async acceptCancel(
    runId: string,
    actor: LocalManager | { kind: 'orphan_policy'; supervisor: ProcessStamp },
    graceMs: number
  ): Promise<CancelIntent | null> {
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60000) throw new Error('invalid_grace');
    const copy = structuredClone(actor);
    for (let n = 0; n < 3; n++) {
      const expected = await this.ledger.readSnapshot((tx) => readReconcileSnapshotIn(tx, runId));
      const result = await commitCompared(this.ledger, expected, (tx, current) => {
        if (copy.kind === 'trusted_local') this.gate.check(copy);
        else if (copy.kind === 'orphan_policy') {
          this.gate.check();
          requireRunWriter(tx, runId, copy.supervisor);
          if (
            current.run.orphanPolicy !== 'stop' ||
            !tx.get("SELECT 1 FROM events WHERE run_id=? AND kind='parent.offline'", runId)
          )
            throw new Error('unauthorized');
        } else throw new Error('unauthorized_local_manager');
        if (isRunTerminal(current.run)) return null;
        const existing = cancelFrom(readEvents(tx, runId));
        if (existing) return existing;
        const at = Date.now();
        tx.run("UPDATE runs SET cancel_requested_at=?,state='cancelling' WHERE run_id=?", at, runId);
        insertRecord(tx, 'events', {
          runId,
          linkId: current.run.linkId,
          kind: 'cancel.accepted',
          payload: { actor: copy, runId, bindingGeneration: current.run.expectedGeneration, graceMs },
          at,
        });
        return { seq: Number(tx.get('SELECT last_insert_rowid() AS seq')!.seq), at, graceMs };
      });
      if (result.committed) return result.result;
    }
    throw new Error('cancel_snapshot_changed');
  }
  async reconcile(runId: string, revision: number, observations: ReconcileEvidence[], nowMs: number) {
    const expected = this.snapshots.get(revision);
    this.snapshots.delete(revision);
    if (!expected || expected.run.runId !== runId) return null;
    const actor = this.managers.get(runId);
    if (!actor) throw new Error('manager_authorization_required');
    const events = await this.ledger.readSnapshot((tx) => readEvents(tx, runId));
    const meta = events.find((event) => event.kind === 'run.startup')?.payload.meta as unknown as RunMeta | undefined;
    // File/OS probes stay outside the short writer transaction. The retained version
    // covers the startup/registration authority on which all these probes depend.
    let importedReceipt: FinalExitReceipt | null = null;
    let gone: boolean | undefined;
    const requireGone = () => {
      if (gone === undefined)
        gone = !!(
          meta?.scope &&
          meta.harness &&
          meta.command_leader &&
          proveGroupGone(meta.scope, meta.harness, [meta.scope.group_leader, meta.command_leader])
        );
      if (!gone) throw new Error('scope_proof_invalid');
    };
    let supplied: ValidatedEvidence[];
    try {
      supplied = observations.map((fact) => {
        const value = fact.fact;
        const storedBoundary =
          (value.kind === 'heartbeat' && value.at === expected.run.heartbeatAt && fact.asOf === value.at) ||
          (value.kind === 'launch' && fact.asOf === expected.run.startedAt) ||
          value.kind === 'receipt';
        if (
          fact.runId !== runId ||
          fact.sourceId !== expected.run.sourceId ||
          fact.bindingGeneration !== expected.run.expectedGeneration ||
          ((fact.supervisor !== null || expected.run.supervisor !== null) &&
            !sameProcessStamp(fact.supervisor, expected.run.supervisor)) ||
          fact.validation !== 'accepted' ||
          !Number.isFinite(fact.observedAt) ||
          fact.observedAt > nowMs ||
          fact.observedAt < 0 ||
          (fact.asOf !== null &&
            (!Number.isFinite(fact.asOf) || fact.asOf < 0 || (fact.asOf > nowMs && !storedBoundary)))
        )
          throw new Error('evidence_provenance_mismatch');
        if (
          value.kind === 'supervisor' &&
          value.state !== (expected.run.supervisor ? processState(expected.run.supervisor) : 'unknown')
        )
          throw new Error('supervisor_proof_changed');
        if (
          value.kind === 'heartbeat' &&
          value.at !== expected.run.heartbeatAt &&
          !events.some((e) => e.kind === 'clock.anomaly' && e.at === fact.asOf)
        )
          throw new Error('heartbeat_proof_invalid');
        if (
          value.kind === 'launch' &&
          (!meta?.harness ||
            !meta.scope ||
            !value.childStarted ||
            !value.originalExecutorValid ||
            value.observedAt !== expected.run.startedAt)
        )
          throw new Error('launch_proof_invalid');
        if (value.kind === 'scope') {
          if (!meta?.scope || !meta.harness) throw new Error('startup_missing');
          if (value.state === 'gone' || value.complete || value.harnessTerminated || value.launchersSealed) {
            if (value.state === 'gone' || value.complete) requireGone();
            if (value.harnessTerminated && processState(meta.harness) !== 'dead')
              throw new Error('harness_proof_invalid');
            if (
              value.launchersSealed &&
              (!meta.command_leader ||
                processState(meta.command_leader) !== 'dead' ||
                processState(meta.scope.group_leader) !== 'dead')
            )
              throw new Error('seal_proof_invalid');
          }
          if (value.state === 'alive' && inspectGroup(meta.scope).result !== 'alive')
            throw new Error('scope_proof_changed');
        }
        if (value.kind === 'scope_reconciled') {
          requireGone();
          if (!value.complete || !value.harnessTerminated || !value.launchersSealed || value.nativeExit !== null)
            throw new Error('scope_proof_invalid');
        }
        if (value.kind === 'receipt') {
          const receipt = RunArtifacts.open(this.gate.home, runId).readExit();
          if (
            !receipt ||
            !meta ||
            inspectReceipt({ final: true, complete: true, fingerprint: digest(receipt), receipt }, meta, new Map())
              .decision !== 'adopt' ||
            fact.asOf !== receipt.ended_at ||
            canonicalJson(value.nativeExit) !==
              canonicalJson(
                receipt.native_exit
                  ? {
                      code: receipt.native_exit.exit_code,
                      signal: receipt.native_exit.signal,
                      source: receipt.native_exit.status_source,
                    }
                  : null
              )
          )
            throw new Error('receipt_proof_invalid');
          importedReceipt = receipt;
        }
        if (
          value.kind === 'cancel' &&
          value.chronology === 'before_exit' &&
          (!cancelFrom(events) ||
            !meta?.harness ||
            processState(meta.harness) !== 'alive' ||
            !events.some((e) => e.kind === 'cancel.step' && e.payload.ack === true))
        )
          throw new Error('cancel_proof_invalid');
        if (value.kind === 'never_submitted' || value.kind === 'cancel_channel') throw new Error('unsupported_proof');
        const kinds = {
          scope: 'group_check',
          scope_reconciled: 'scope_reconciled',
          receipt: 'exit_receipt',
          heartbeat: 'heartbeat',
          supervisor: 'heartbeat',
          launch: 'launch_receipt',
          cancel: 'group_check',
          cancel_channel: 'group_check',
          conflict: 'conflict',
          never_submitted: 'never_submitted',
        } as const;
        // Stable same-boundary facts remain idempotent despite control's per-probe UUIDs.
        const evidenceId = `run-fact:${digest({ ...fact, evidenceId: null, observedAt: null })}`;
        const old = expected.evidence.find((entry) => entry.evidenceId === evidenceId);
        if (old) return { record: old, facts: old.payload.reconcileFacts as unknown as ReconcileEvidence[] };
        const normalized = { ...fact, evidenceId };
        return {
          record: {
            evidenceId,
            runId,
            linkId: expected.run.linkId,
            kind: kinds[fact.fact.kind],
            producer: 'reconciler',
            fingerprint: digest(normalized),
            payload: {},
            observedAt: fact.observedAt,
            validatedAt: nowMs,
            validation: 'accepted',
          },
          facts: [normalized],
        };
      });
    } catch (error) {
      if (error instanceof Error && ['scope_proof_changed', 'supervisor_proof_changed'].includes(error.message))
        return null;
      throw error;
    }
    const result = await commitReconcile(
      this.ledger,
      expected,
      supplied,
      nowMs,
      (tx) => {
        this.gate.check(actor);
        if (importedReceipt) persistRunReceipt(tx, runId, expected.run.supervisor!, importedReceipt);
      },
      this.ledger.busyBudgetMs,
      this.gate.home
    );
    return result.committed ? result.decision : null;
  }
}

// B2 exposes its snapshot assembler so adapter projections share one consistent read.
import { snapshotInTransaction as readReconcileSnapshotIn } from '../../ledger/reconcile.js';
export async function createRunFactPort(hudHome: string): Promise<LedgerRunFactPort> {
  const gate = new PrivateLedgerGate(hudHome);
  const ledger = await openLedger(gate.path);
  try {
    gate.check();
    return new LedgerRunFactPort(ledger, gate);
  } catch (error) {
    await ledger.close();
    throw error;
  }
}

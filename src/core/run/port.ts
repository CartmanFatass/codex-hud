import type { RunControl } from '../interfaces/run-control.js';
import type { LedgerEvent, ReconcileDecision, ReconcileEvidence, Run } from '../types/execution.js';
import type { LifecycleStatus } from '../types/lifecycle.js';
import type { ProcessStamp, RunMeta, FinalExitReceipt } from '../types/supervision.js';

export interface RunSnapshot {
  revision: number;
  run: Run;
  events: LedgerEvent[];
  facts: ReconcileEvidence[];
  meta: RunMeta | null;
  receipt: FinalExitReceipt | null;
  claimSupervisor: { pid: number; proc_start: string } | null;
  claimState: 'issued' | 'armed' | 'revoked';
  slotHeld: boolean;
  status: LifecycleStatus;
}
/** Created by the trusted entry point, never by model-supplied tool arguments.
 * 待 ARCH 裁决: local cancel/reconcile uses contract 04's manager boundary;
 * authorizeControl's narrower local resume exception is intentionally unchanged.
 */
export interface LocalManager {
  kind: 'trusted_local';
  uid: number;
  invocationId: string;
}
export interface CancelIntent {
  seq: number;
  at: number;
  graceMs: number;
}
export interface HeartbeatResult {
  seq: number;
  cancel: CancelIntent | null;
}

/** B2 implements atomic transactions and validates the original typed initiator.
 * No generic patch/state setter is exposed to the hud-run writer.
 */
export interface RunFactPort {
  read(runId: string): Promise<RunSnapshot>;
  authorizeManager(runId: string, actor: LocalManager, operation: 'reconcile'): Promise<void>;
  register(runId: string, ticket: string, launchDigest: string, supervisor: ProcessStamp): Promise<void>;
  phase(runId: string, supervisor: ProcessStamp, phase: 'submitting' | 'submitted'): Promise<void>;
  startup(runId: string, supervisor: ProcessStamp, meta: RunMeta): Promise<void>;
  heartbeat(
    runId: string,
    supervisor: ProcessStamp,
    expectedSeq: number,
    monoMs: number
  ): Promise<HeartbeatResult | null>;
  raw(runId: string, supervisor: ProcessStamp, kind: string, payload: Record<string, unknown>): Promise<number>;
  receipt(runId: string, supervisor: ProcessStamp, receipt: FinalExitReceipt): Promise<void>;
  acceptCancel(
    runId: string,
    actor: LocalManager | { kind: 'orphan_policy'; supervisor: ProcessStamp },
    graceMs: number
  ): Promise<CancelIntent | null>;
  /** Reconciler validates facts and rechecks revision under the writer lock. */
  reconcile(
    runId: string,
    revision: number,
    observations: ReconcileEvidence[],
    nowMs: number
  ): Promise<ReconcileDecision | null>;
}
export interface RunPortModule {
  createRunFactPort(hudHome: string): Promise<RunFactPort> | RunFactPort;
}
export type { RunControl };

import { posix } from 'node:path';
import type { SourceId } from './types/identity.js';
import type { LaunchPhase, LedgerEvent, Run } from './types/execution.js';
import type {
  ExitObservation,
  FinalExitReceipt,
  HarnessCandidate,
  ProcessScope,
  ProcessStamp,
  RunMeta,
  ScopeFacts,
} from './types/supervision.js';

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_STALE_MS = 30_000;
export const RUN_DIRECTORY_MODE = 0o700;
export const RUN_FILE_MODE = 0o600;

export function sameProcessStamp(a: ProcessStamp | null, b: ProcessStamp | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.pid === b.pid &&
    a.proc_start === b.proc_start &&
    a.boot_id === b.boot_id &&
    a.pid_domain === b.pid_domain
  );
}

function isProcessStamp(value: unknown): value is ProcessStamp {
  if (value === null || typeof value !== 'object') return false;
  const stamp = value as Partial<ProcessStamp>;
  return (
    Number.isSafeInteger(stamp.pid) &&
    stamp.pid! > 0 &&
    typeof stamp.proc_start === 'string' &&
    /^\d+$/.test(stamp.proc_start) &&
    typeof stamp.boot_id === 'string' &&
    stamp.boot_id.length > 0 &&
    typeof stamp.pid_domain === 'string' &&
    stamp.pid_domain.length > 0
  );
}

type RegistrationRun = Pick<Run, 'runId' | 'linkId' | 'sourceId' | 'expectedGeneration'>;

/** Commit with ticket consumption, armed claim and first H; meta is only a later copy. */
export function supervisorRegistrationEvent(
  run: RegistrationRun,
  supervisor: ProcessStamp,
  at: number
): Omit<LedgerEvent, 'seq'> {
  if (!isProcessStamp(supervisor) || !Number.isFinite(at) || at < 0)
    throw new TypeError('invalid_supervisor_registration');
  return {
    runId: run.runId,
    linkId: run.linkId,
    kind: 'supervisor.registered',
    payload: { sourceId: run.sourceId, bindingGeneration: run.expectedGeneration, supervisor: { ...supervisor } },
    at,
  };
}

/** Read committed ledger events only. Missing, incomplete or competing registrations stay unknown. */
export function registeredSupervisor(run: RegistrationRun, events: readonly LedgerEvent[]): ProcessStamp | null {
  const records = events.filter((event) => event.runId === run.runId && event.kind === 'supervisor.registered');
  if (records.length !== 1) return null;
  const record = records[0];
  const stamp = record.payload.supervisor;
  if (
    record.linkId !== run.linkId ||
    record.payload.sourceId !== run.sourceId ||
    record.payload.bindingGeneration !== run.expectedGeneration ||
    !isProcessStamp(stamp)
  )
    return null;
  return { pid: stamp.pid, proc_start: stamp.proc_start, boot_id: stamp.boot_id, pid_domain: stamp.pid_domain };
}

/** Names, ancestry overlap and candidate order never select an instance. */
export function resolveHarness(candidates: readonly HarnessCandidate[], expectedSource: SourceId): ProcessStamp | null {
  if (candidates.some((candidate) => candidate.sourceId !== expectedSource)) return null;
  const proved = candidates.filter((candidate) => candidate.independentLaunchProof);
  if (proved.length === 0) return null;
  const stamp = proved[0].stamp;
  return proved.every((candidate) => sameProcessStamp(candidate.stamp, stamp)) ? { ...stamp } : null;
}

/** Complete old-boot proof never queries a reused PGID in the current boot. */
export function checkScope(facts: ScopeFacts): {
  result: 'alive' | 'gone' | 'unknown';
  conflict: boolean;
  inspectCurrentBootGroup: boolean;
} {
  const conflict = facts.escapedOriginalWriterAlive;
  if (!facts.scope || !facts.visibleDomain) {
    return { result: 'unknown', conflict, inspectCurrentBootGroup: false };
  }
  if (!facts.matchingBoot) {
    return {
      result:
        facts.sameMachinePreviousBootEnded && facts.harnessTerminated && facts.launchersSealed && !conflict
          ? 'gone'
          : 'unknown',
      conflict,
      inspectCurrentBootGroup: false,
    };
  }
  // Z is terminated but unreaped. S/T/D still represent executable workload.
  if (facts.memberStates.some((state) => state !== 'Z')) {
    return { result: 'alive', conflict, inspectCurrentBootGroup: true };
  }
  const gone = facts.visibility === 'complete' && facts.harnessTerminated && facts.launchersSealed && !conflict;
  return { result: gone ? 'gone' : 'unknown', conflict, inspectCurrentBootGroup: true };
}

export function scopeUpdateAllowed(before: ProcessScope | null, after: ProcessScope | null): boolean {
  if (before === null) return true;
  if (after === null) return false;
  return (
    before.scope_id === after.scope_id &&
    before.scope_kind === after.scope_kind &&
    before.pid_domain === after.pid_domain &&
    before.boot_id === after.boot_id &&
    before.pgid === after.pgid &&
    before.sid === after.sid &&
    sameProcessStamp(before.group_leader, after.group_leader)
  );
}

/** Inputs are verified filesystem facts, not a substitute for checking them. */
export function validateRunDirectory(input: {
  runId: string;
  hudHome: string;
  currentUid: number;
  ownerUid: number;
  symlinkEncountered: boolean;
  existingRunMatches: boolean;
  ticketWinner: boolean;
}): { allowed: boolean; reason: string | null; directoryMode: number; fileMode: number } {
  const reason = !/^[A-Za-z0-9_-]{1,128}$/.test(input.runId)
    ? 'invalid_run_id'
    : !posix.isAbsolute(input.hudHome) || posix.normalize(input.hudHome) !== input.hudHome
      ? 'invalid_hud_home'
      : input.symlinkEncountered
        ? 'symlink_rejected'
        : input.currentUid !== input.ownerUid
          ? 'owner_mismatch'
          : !input.existingRunMatches
            ? 'run_mismatch'
            : !input.ticketWinner
              ? 'ticket_not_owned'
              : null;
  return { allowed: reason === null, reason, directoryMode: RUN_DIRECTORY_MODE, fileMode: RUN_FILE_MODE };
}

export function nativeExit(observation: ExitObservation | null): ExitObservation | null {
  if (!observation || observation.subject !== 'harness') return null;
  if (!['wait_status', 'trusted_harness_result'].includes(observation.status_source)) return null;
  const code = observation.exit_code;
  const signal = observation.signal;
  if (code !== null ? !Number.isInteger(code) || signal !== null : typeof signal !== 'string' || signal.length === 0) {
    return null;
  }
  return { ...observation, process: { ...observation.process } };
}

/** Partial leader/shell/HUP observations do not meet the final scope contract. */
export function receiptEligibility(receipt: FinalExitReceipt): string | null {
  if (receipt.schema_version !== 1) return 'unknown_receipt_version';
  if (receipt.submission_fence.proof_ids.length === 0) return 'launcher_seal_missing';
  if (receipt.native_exit !== null && nativeExit(receipt.native_exit) === null) return 'native_source_invalid';
  if (receipt.native_exit !== null && !sameProcessStamp(receipt.native_exit.process, receipt.harness)) {
    return 'native_instance_mismatch';
  }
  if (receipt.shell_exit !== null && receipt.shell_exit.subject !== 'command_leader') return 'shell_subject_invalid';
  if (receipt.coverage === 'not_submitted') {
    return receipt.reason === 'preflight_failure' && receipt.native_exit === null && receipt.duration_ms === 0
      ? null
      : 'non_execution_proof_invalid';
  }
  const check = receipt.scope_check;
  if (!receipt.scope || !check || check.scope_id !== receipt.scope.scope_id) return 'scope_unknown';
  if (check.result !== 'gone' || check.visibility !== 'complete') return 'scope_not_ended';
  if (check.member_evidence_ids.length !== 0) return 'scope_has_workload';
  if (check.launcher_seal_evidence_ids.length === 0) return 'launcher_seal_missing';
  if (check.harness_termination_evidence_ids.length === 0) return 'harness_termination_missing';
  if (receipt.reason === 'cancel_confirmed' && receipt.cancel_request_seq === null) return 'cancel_not_accepted';
  if (receipt.reason === 'preflight_failure') return 'coverage_mismatch';
  if (receipt.reason === 'normal_exit' && receipt.native_exit?.exit_code !== 0) return 'native_result_missing';
  if (receipt.reason === 'nonzero_exit' && !(receipt.native_exit?.exit_code ?? 0)) return 'native_result_missing';
  if (receipt.reason === 'signal_exit' && !receipt.native_exit?.signal) return 'native_result_missing';
  return null;
}

export function inspectReceipt(
  artifact: {
    final: boolean;
    complete: boolean;
    fingerprint: string;
    receipt: FinalExitReceipt | null;
  },
  meta: Pick<
    RunMeta,
    | 'run_id'
    | 'link_id'
    | 'source_id'
    | 'binding_generation'
    | 'scope'
    | 'supervisor'
    | 'harness'
    | 'command_leader'
    | 'mode'
    | 'supervision_strategy'
  >,
  imported: ReadonlyMap<string, string>
): { decision: 'ignore' | 'audit' | 'reject' | 'duplicate' | 'adopt'; reason: string | null } {
  if (!artifact.final || !artifact.complete || !artifact.receipt) return { decision: 'ignore', reason: 'incomplete' };
  const receipt = artifact.receipt;
  if (!/^[0-9a-f]{64}$/.test(artifact.fingerprint)) return { decision: 'reject', reason: 'invalid_fingerprint' };
  const optionalStampMatches = (a: ProcessStamp | null, b: ProcessStamp | null) =>
    a === null || b === null ? a === b : sameProcessStamp(a, b);
  if (
    receipt.run_id !== meta.run_id ||
    receipt.link_id !== meta.link_id ||
    receipt.source_id !== meta.source_id ||
    receipt.binding_generation !== meta.binding_generation ||
    receipt.mode !== meta.mode ||
    receipt.strategy !== meta.supervision_strategy ||
    !optionalStampMatches(receipt.supervisor, meta.supervisor) ||
    !optionalStampMatches(receipt.command_leader, meta.command_leader) ||
    !optionalStampMatches(receipt.harness, meta.harness)
  ) {
    return { decision: 'audit', reason: 'instance_mismatch' };
  }
  if (
    receipt.coverage === 'scope' &&
    (!meta.scope || !receipt.scope || !scopeUpdateAllowed(meta.scope, receipt.scope))
  ) {
    return { decision: 'audit', reason: 'scope_mismatch' };
  }
  const previous = imported.get(receipt.receipt_id);
  if (previous !== undefined) {
    return previous === artifact.fingerprint
      ? { decision: 'duplicate', reason: null }
      : { decision: 'reject', reason: 'receipt_conflict' };
  }
  const reason = receiptEligibility(receipt);
  return { decision: reason === null ? 'adopt' : 'reject', reason };
}

export function heartbeatUpdateAllowed(input: {
  producer: ProcessStamp;
  registeredSupervisor: ProcessStamp | null;
  expectedSeq: number;
  storedSeq: number;
  terminal: boolean;
  recoveryObserver: boolean;
}): boolean {
  return (
    !input.terminal &&
    !input.recoveryObserver &&
    Number.isSafeInteger(input.storedSeq) &&
    input.storedSeq >= 1 &&
    input.expectedSeq === input.storedSeq &&
    sameProcessStamp(input.producer, input.registeredSupervisor)
  );
}

export function submissionAllowed(input: {
  phase: LaunchPhase;
  originalExecutor: boolean;
  ticketConsumed: boolean;
  fenced: boolean;
  authorized: boolean;
  recoveryObserver: boolean;
}): boolean {
  return (
    input.phase === 'armed' &&
    input.originalExecutor &&
    input.ticketConsumed &&
    !input.fenced &&
    input.authorized &&
    !input.recoveryObserver
  );
}

/** The three resources deliberately do not share an expiry release rule. */
export function leaseReleasePolicy(
  input:
    | { kind: 'run'; terminalProof: boolean }
    | { kind: 'browser'; outcome: 'answered' | 'failed' | 'needs_human' | 'unknown'; reconciled: boolean }
    | { kind: 'collect'; expired: boolean; clockKnown: boolean }
): 'release' | 'hold' | 'takeover' | 'read_only' {
  if (input.kind === 'run') return input.terminalProof ? 'release' : 'hold';
  if (input.kind === 'browser') {
    return input.reconciled && (input.outcome === 'answered' || input.outcome === 'failed') ? 'release' : 'hold';
  }
  return !input.clockKnown ? 'read_only' : input.expired ? 'takeover' : 'hold';
}

export function supervisionSupport(strategy: string, scopeKind: string, localDomain: boolean): string | null {
  if (strategy !== 'headless' && strategy !== 'wrapper') return 'unsupported';
  if (scopeKind !== 'pgid') return 'unsupported';
  return localDomain ? null : 'scope_unknown';
}

export function stdinPlan(
  mode: 'visible' | 'headless',
  stdin: string
): {
  accepted: boolean;
  closeAfterBrief: boolean;
  readTerminal: false;
} {
  return {
    accepted: mode === 'visible' ? stdin === 'tty' : stdin === 'brief' || stdin === 'closed',
    closeAfterBrief: mode === 'headless' && stdin === 'brief',
    readTerminal: false,
  };
}

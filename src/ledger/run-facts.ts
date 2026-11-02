import { canonicalJson, digest } from '../core/canonical.js';
import { isRunTerminal } from '../core/execution.js';
import { inspectReceipt, sameProcessStamp } from '../core/supervision.js';
import type { FinalExitReceipt, ProcessStamp, RunMeta } from '../core/types/supervision.js';
import type { Ledger } from './ledger.js';
import { acceptedActor } from './intents.js';
import { insertRecord, readRun } from './records.js';
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
    insertRecord(tx, 'events', { runId, linkId: run.linkId, kind, payload: copy, at: Date.now() });
    return Number(tx.get('SELECT last_insert_rowid() AS seq')!.seq);
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

import type { ReaderCheckpoint } from '../types/observation.js';
import type { RecoveryReadGrant } from '../types/checkpoint.js';
import type { NativeAction } from '../interfaces/session-evidence.js';
import type { CodexCheckpoint } from '../../harness/codex/index.js';
import { decodeRecoveryToolCall } from '../../harness/codex/recovery.js';

/** One metered lookup, pinned to the recovered checkpoint's exact current commit. */
export function checkpointAction(
  checkpoint: ReaderCheckpoint,
  grant: RecoveryReadGrant,
  now: number
): { kind: 'value'; action?: NativeAction } | { kind: 'retry' | 'stale' } {
  if (checkpoint.ref.harness !== 'codex') return { kind: 'value' };
  const rollout = (checkpoint as CodexCheckpoint).codex?.rollout;
  if (rollout?.version !== 3) return { kind: 'value' };
  const tail = rollout.state.runningTail;
  if (tail === null && rollout.state.runningCount === 0) return { kind: 'value' };
  if (
    typeof tail !== 'string' ||
    !tail ||
    !Number.isSafeInteger(rollout.state.runningCount) ||
    rollout.state.runningCount < 1
  )
    return { kind: 'value' };
  const lookup = checkpoint.recoveryIndex?.lookup;
  if (!lookup?.getMetered) return { kind: 'value' };
  const result = lookup.getMetered(grant, 'codex.running', tail);
  if (result.kind === 'stale') return { kind: 'stale' };
  if (result.kind === 'refused') return { kind: 'retry' };
  if (!result.value) return { kind: 'value' };
  const call = decodeRecoveryToolCall(result.value);
  const startedAt = call.timestamp.getTime();
  if (
    call.id !== tail ||
    call.status !== 'running' ||
    !call.name ||
    !Number.isFinite(startedAt) ||
    startedAt < 0 ||
    startedAt > now
  )
    return { kind: 'value' };
  // The index records only a bounded public target, never arguments or output.
  const target = (call as typeof call & { targetTruncated?: boolean }).targetTruncated ? undefined : call.target;
  return { kind: 'value', action: { id: call.id, name: call.name, startedAt, ...(target ? { target } : {}) } };
}

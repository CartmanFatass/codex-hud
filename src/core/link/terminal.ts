import type { TerminalNote, Termination } from '../types/execution.js';

/** Unknown additive terminal metadata is opaque to legacy state derivation. */
export function terminalNote(value: unknown): TerminalNote {
  return value === 'cancel_timing_unknown' || value === 'retire_timing_unknown' ? value : null;
}
/** Project only the closed terminal metadata, never arbitrary event payload fields. */
export function terminationProjection(value: unknown): Termination | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, any>;
  const o = p.observed;
  if (
    !['completed', 'failed', 'blocked', 'unknown'].includes(p.outcome) ||
    ![
      null,
      'user_cancel',
      'retire_after_report',
      'retire_idle',
      'retire_blocked_wait',
      'runtime_limit',
      'orphan_policy',
    ].includes(p.requestedCause) ||
    !['caused', 'not_caused', 'unknown'].includes(p.attribution) ||
    !o ||
    typeof o !== 'object' ||
    Array.isArray(o) ||
    !(o.exitCode === null || Number.isSafeInteger(o.exitCode)) ||
    !(o.signal === null || (typeof o.signal === 'string' && o.signal.length > 0)) ||
    ![null, 'INT', 'TERM', 'KILL'].includes(o.escalatedTo) ||
    !['R', 'Q', 'N'].includes(o.scopeEvidence)
  )
    return null;
  return {
    outcome: p.outcome,
    requestedCause: p.requestedCause,
    attribution: p.attribution,
    observed: { exitCode: o.exitCode, signal: o.signal, escalatedTo: o.escalatedTo, scopeEvidence: o.scopeEvidence },
  };
}

import type { JsonValue } from '../core/canonical.js';
import type { CurrentCallEvidence } from '../core/identity.js';
import type { ControlAuthority } from '../core/lifecycle.js';
import type { Claim, ControlInitiator } from '../core/types/identity.js';
import type { Evidence, ReconcileEvidence, Run, TerminalNote } from '../core/types/execution.js';
import type { Link } from '../core/types/lifecycle.js';

/** Caller verification/probes occur outside SQLite; the stored current generation is reloaded inside. */
export type IntentAuthority =
  | { kind: 'mcp'; contextId: string; generation: number; evidence: CurrentCallEvidence }
  | Extract<ControlAuthority, { kind: 'local_user' }>;

export interface PreparedIntent {
  requestKey: string;
  params: Record<string, unknown>;
  link: Link;
  run: Run;
  claim: Claim;
  authority: IntentAuthority;
  capabilityVerified: boolean;
  newSession: boolean;
  holder: string;
}
export interface IntentResult {
  replayed: boolean;
  outcome: JsonValue;
  linkId: string | null;
  runId: string | null;
}
export interface ReconcileSnapshot {
  run: Run;
  link: Link;
  evidence: Evidence[];
  /** Opaque content version of persisted rows; no schema revision columns are added. */
  version: string;
  asOfSeq: number;
  terminalNote: TerminalNote;
}
/** A reconciler validates OS/file facts before calling this persistence port. */
export interface ValidatedEvidence {
  record: Evidence;
  facts: ReconcileEvidence[];
}
export interface AcceptedActor {
  actor: ControlInitiator;
  ownerKey: string;
}

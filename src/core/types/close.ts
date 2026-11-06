import type { ControlInitiator, OwnerKey, SessionRef } from './identity.js';
import type { LinkState } from './lifecycle.js';
import type { RunState, TerminalNote } from './execution.js';

export interface CloseRequest {
  linkId: string;
  expectedRun: string;
  request_key: string;
  grace?: number;
}
export interface CloseRequested {
  version: 1;
  actor: Extract<ControlInitiator, { kind: 'mcp' }>;
  ownerKey: OwnerKey;
  linkId: string;
  runId: string;
  runSeq: number;
  bindingGeneration: number;
  targetSessionRef: SessionRef;
  requestedGraceMs: number;
  cancelSeq: number | null;
  effectiveGraceMs: number | null;
}
export interface LinkClosed {
  version: 1;
  closeRequestSeq: number;
  terminalEvidenceId: string;
  terminalSeq: number;
}
export interface CloseOutcome {
  operation: 'close';
  status: 'accepted' | 'already_closed';
  linkId: string;
  runId: string;
  runSeq: number;
  bindingGeneration: number;
  targetSessionRef: SessionRef;
  closeRequestSeq: number | null;
  closeRequestedAt: number | null;
  cancelSeq: number | null;
  effectiveGraceMs: number | null;
}
export interface CloseProgress {
  closeState: 'none' | 'pending' | 'closed' | 'incompatible';
  closeRequestSeq: number | null;
  runId: string;
  linkState: LinkState;
  runState: RunState;
  terminalEvidenceId: string | null;
  terminalNote: TerminalNote;
  slotHeld: boolean;
  reason: string | null;
  asOfSeq: number;
}

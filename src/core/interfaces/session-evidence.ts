import type { SessionRef } from '../types/identity.js';

/** Observed anchors only. Reconciler must verify an existing run, time window and independent identity. */
export interface ToolResultLinkEvidence {
  kind: 'tool_result';
  ref: SessionRef;
  tool: string;
  callId: string;
  nativeMessageId: string | null;
  linkId: string;
  runId: string;
  eventAt: number;
  launchCallId?: string;
  launchCorrelationId?: string;
}

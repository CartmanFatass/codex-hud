import type { SessionRef } from '../types/identity.js';
import type { Metric, ObservationView } from '../types/observation.js';

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

export interface LaunchMessageLinkEvidence {
  kind: 'launch_message';
  ref: SessionRef;
  nativeMessageId: string;
  linkId: string;
  /** SHA-256 of the original claim bytes; never the claim or prompt itself. */
  claimFingerprint: string;
  /** Valid event time from the native record, never the scan/first-observed time. */
  eventAt: number;
  launchCallId?: string;
  launchCorrelationId?: string;
}

export type LinkEvidence = ToolResultLinkEvidence | LaunchMessageLinkEvidence;

/** A public native transcript report, distinct from an authenticated ledger Report. */
export interface NativeReport {
  kind: 'message' | 'update' | 'reply';
  text: string;
  at: number;
}

export interface NativeAction {
  id: string;
  name: string;
  target?: string;
  startedAt: number;
}

export interface CodexExtras {
  quota: {
    primary?: { usedPercent: number; windowMinutes?: number; resetsAt?: number };
    secondary?: { usedPercent: number; windowMinutes?: number; resetsAt?: number };
  } | null;
  goals: { objective: string; status: string }[];
  plan: { steps: { step: string; status: string }[]; completed: number; total: number; asOf: number } | null;
  todos: { id: string; content: string; status: string; priority: string }[];
}

/** Native additions only: state, coverage, spent and workspace live once, in ObservationView. */
export interface SessionEvidence {
  ref: SessionRef;
  observation: ObservationView;
  cwd: string | null;
  cwdSource: 'session_meta' | 'transcript' | 'unknown';
  cwdAsOf: number | null;
  startedAt: number | null;
  version: string | null;
  model: Metric<{ id: string; provider?: string; effort?: string }>;
  context: Metric<{ used: number; window: number; afterCompaction?: boolean }>;
  action?: NativeAction;
  reports: NativeReport[];
  progress?: Metric<{ done: number; total: number; current?: string }>;
  native: SessionRef[];
  linkEvidence: LinkEvidence[];
  caps: { codex?: CodexExtras };
}

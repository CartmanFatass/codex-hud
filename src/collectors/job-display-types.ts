/** Reduced observation-only DTOs. No prompts, environment, fingerprints or credentials. */
import type { SessionRef } from '../core/types/identity.js';
import type { SubagentStatus } from '../types.js';
import type { JobAssociation } from '../roles/association.js';

export interface JobRequest {
  readonly id: string;
  readonly path: string;
  readonly state: 'unanswered' | 'written_consumption_unconfirmed';
  readonly current: boolean;
  readonly respondable: boolean;
  readonly observedAt: number;
}
export interface JobFreshness {
  readonly state: 'current' | 'stale' | 'unavailable';
  readonly observedAt: number;
  readonly lastSuccessfulReadAt: number | null;
  readonly evidenceAt: number | null;
  readonly liveDeadline: number | null;
  readonly reason: string | null;
}
export interface JobDisplay {
  readonly kind: 'role' | 'helper' | 'external';
  readonly id: string;
  readonly jobId: string;
  readonly root: string;
  readonly name: string;
  readonly role: string | null;
  readonly phase: string | null;
  readonly preset: string | null;
  readonly backend: Readonly<JobAssociation['backend']> | null;
  readonly location: Readonly<JobAssociation['herdr']>;
  /** Additive reduced work facts; absent in older snapshots means unknown. */
  readonly work?: {
    readonly facadeClosed: boolean;
    readonly facadeClosedAt: number | null;
    readonly settledAt: number | null;
    readonly runtimeTerminal: boolean;
    readonly homeNeedsHuman: boolean;
    readonly endedAt: number | null;
    readonly outputWritten: boolean | null;
  };
  readonly lifecycle: string;
  readonly runtimePhase: string | null;
  /** Dispatch session evidence, not a complete native binding or a join key. */
  readonly dispatchSession: string | null;
  readonly outcome: string | null;
  /** Judge answers have per-statement verdicts, not a fabricated aggregate success. */
  readonly judgments:
    | readonly { readonly name: string; readonly verdict: 'pass' | 'deny' | 'unsettled' | 'timeout' | 'needs_human' }[]
    | null;
  readonly status: SubagentStatus;
  readonly freshness: JobFreshness;
  readonly requests: readonly JobRequest[] | null;
  readonly report: { readonly path: string; readonly available: boolean | null } | null;
  readonly native: Readonly<SessionRef> | null;
  readonly createdAt: number | null;
  readonly closedAt: number | null;
  readonly decision: { readonly id: string; readonly model: string | null } | null;
  readonly observedModel: string | null;
  readonly observedEffort: string | null;
  readonly helpers: readonly JobDisplay[];
  readonly diagnostics: readonly string[];
  readonly coverage: 'partial' | 'complete';
  readonly summaryUnavailable: 'native_ref_required' | 'requires_authorization';
}
export interface JobCoverage {
  readonly entries: number;
  readonly files: number;
  readonly bytes: number;
  readonly incomplete: boolean;
  readonly omitted: number | null;
  readonly diagnostics: readonly string[];
}
export interface JobSnapshot {
  readonly generation: number;
  readonly root: string | null;
  readonly jobs: readonly JobDisplay[];
  readonly coverage: JobCoverage;
}

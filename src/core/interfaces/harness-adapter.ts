import type { RecoveryIndexHandoff } from '../types/checkpoint.js';
import type { SessionEvidence } from './session-evidence.js';
import type { LaunchProfile } from '../types/capabilities.js';
import type { Harness, SessionRef, SourceId } from '../types/identity.js';
import type { ObservationView, ReaderCheckpoint, ReaderContinuation } from '../types/observation.js';
import type { ProcessStamp } from '../types/supervision.js';
import type { RegistryRecord } from './registry-provider.js';
import type { SessionBinding, SurfaceLocator } from './session-binding.js';

/** Concept §6.3: evidence inputs only; ambiguous candidates must not bind. */
export interface BindContext {
  sourceId: SourceId;
  explicitSession: SessionRef | null;
  registry: readonly RegistryRecord[];
  locator: SurfaceLocator | null;
  processes: readonly ProcessStamp[];
  cwd: string | null;
  startedAt: number;
}

/** Concept §6.3; contract 06 “Reader、coverage 与树”: first exhausted limit stops the read. */
export interface ReaderBudget {
  maxBytes: number;
  maxRecords: number;
  budgetMs: number;
}

/** Minimal A5 transport; native concept §6.4 payloads are additive A6 work. */
export interface ReaderResult {
  /** Same reader-produced index handoff as checkpoint.recoveryIndex, when present. */
  recoveryIndex?: RecoveryIndexHandoff;
  observation: ObservationView;
  checkpoint: ReaderCheckpoint;
  /** Optional native additions; observation is the same object, not a second state projection. */
  evidence?: SessionEvidence;
  /** Actual read/assembly work; elapsedMs is measured, the time budget is soft. */
  stats?: { bytesRead: number; recordsRead: number; elapsedMs: number };
  /** Consult 5 G11: distinguish record-byte needs from bounded recovery progress and its coverage. */
  continuation?: ReaderContinuation;
}

export interface SessionReader {
  /** Concept §6.3; contract 06: defaults are 4 MiB/2000 records/soft 20 ms; cursor and state travel together. */
  read(budget?: ReaderBudget): Promise<ReaderResult>;
}

export interface HarnessAdapter {
  readonly id: Harness;
  readonly glyph: string;
  /** Concept §6.3; contract 05 I-05-2: resolve and verify the explicit profile source; never guess a home. */
  resolveSource(profile: LaunchProfile, env: Readonly<Record<string, string | undefined>>): Promise<SourceId>;
  /** Concept §6.3: explicit > registry > PID/cmdline > candidates; ambiguity returns null. */
  bind(context: BindContext): Promise<SessionBinding | null>;
  /** Concept §6.3: open a resumable reader; I/O is deferred to its asynchronous read. */
  open(ref: SessionRef, checkpoint?: ReaderCheckpoint): SessionReader;
  /** Concept §6.3/§6.5: sole native topology authority, returning full session identities. */
  children(ref: SessionRef): Promise<SessionRef[]>;
  readonly capabilities: {
    /** Concept §6.10: optional harness-native navigation; absent capabilities must not be guessed. */
    navigate?: (ref: SessionRef) => Promise<void>;
  };
}

import type { Harness, SourceId } from './identity.js';
import type { OrphanPolicy, RunMode, SupervisionStrategy } from './execution.js';
import type { HostLocator, LaunchCommand } from './capabilities.js';
import type { ProjectOrigin } from './observation.js';

/** Contract 04's private receipt spelling is deliberately distinct from domain fields. */
export interface ProcessStamp {
  pid: number;
  proc_start: string;
  boot_id: string;
  pid_domain: string;
}

export interface ProcessScope {
  scope_id: string;
  scope_kind: 'pgid';
  pid_domain: string;
  boot_id: string;
  pgid: number;
  sid: number;
  group_leader: ProcessStamp;
}

export type StdinMode = 'brief' | 'closed' | 'tty';
export type Capture = 'file' | 'tty_passthrough' | 'unavailable';
export type { SupervisionStrategy } from './execution.js';
export type { LaunchCommand } from './capabilities.js';

export interface RunLaunchInput {
  runId: string;
  mode: RunMode;
  launch: LaunchCommand;
  cwd: string;
  sourceId: SourceId;
  profileDigest: string;
  stdin: StdinMode;
  orphanPolicy: OrphanPolicy;
}

export interface RunMeta {
  schema_version: 1;
  run_id: string;
  link_id: string;
  source_id: SourceId;
  binding_generation: number;
  mode: RunMode;
  supervision_strategy: SupervisionStrategy;
  supervisor: ProcessStamp | null;
  command_leader: ProcessStamp | null;
  harness: ProcessStamp | null;
  scope: ProcessScope | null;
  launch_digest: string;
  profile_digest: string;
  launch_call_id: string;
  launch_correlation_id: string;
  created_at: number;
  stdin_mode: StdinMode;
  capture: Capture;
  readonly launch_cwd: string;
  readonly project_origin: ProjectOrigin | null;
}

export type ExitStatusSource = 'wait_status' | 'trusted_harness_result';
export interface ExitObservation {
  process: ProcessStamp;
  subject: 'command_leader' | 'harness';
  observed_at: number;
  exit_code: number | null;
  signal: string | null;
  status_source: ExitStatusSource;
  evidence_id: string;
}

export interface ScopeCheck {
  scope_id: string;
  checked_at: number;
  result: 'alive' | 'gone' | 'unknown';
  visibility: 'complete' | 'partial';
  member_evidence_ids: string[];
  zombie_evidence_ids: string[];
  launcher_seal_evidence_ids: string[];
  harness_termination_evidence_ids: string[];
}

export interface SubmissionFence {
  event_seq: number;
  at: number;
  proof_ids: string[];
}

export interface RunLogs {
  stdout: string | null;
  stderr: string | null;
  capture: Capture;
}

export type ExitReason =
  'scope_ended' | 'normal_exit' | 'nonzero_exit' | 'signal_exit' | 'cancel_confirmed' | 'preflight_failure';

export interface FinalExitReceipt {
  schema_version: 1;
  receipt_id: string;
  run_id: string;
  link_id: string;
  source_id: SourceId;
  binding_generation: number;
  mode: RunMode;
  strategy: SupervisionStrategy;
  supervisor: ProcessStamp | null;
  command_leader: ProcessStamp | null;
  harness: ProcessStamp | null;
  scope: ProcessScope | null;
  coverage: 'scope' | 'not_submitted';
  created_at: number;
  started_at: number | null;
  ended_at: number;
  recorded_at: number;
  duration_ms: number | null;
  native_exit: ExitObservation | null;
  shell_exit: ExitObservation | null;
  reason: ExitReason;
  scope_check: ScopeCheck | null;
  submission_fence: SubmissionFence;
  cancel_request_seq: number | null;
  logs: RunLogs;
}

/** Observations of supplied synthetic members; obtaining them is outside core. */
export interface ScopeFacts {
  scope: ProcessScope | null;
  visibleDomain: boolean;
  matchingBoot: boolean;
  sameMachinePreviousBootEnded: boolean;
  visibility: 'complete' | 'partial';
  memberStates: readonly string[];
  harnessTerminated: boolean;
  launchersSealed: boolean;
  escapedOriginalWriterAlive: boolean;
}

export interface HarnessCandidate {
  stamp: ProcessStamp;
  sourceId: SourceId;
  harness: Harness;
  independentLaunchProof: boolean;
}

/** Method result types remain the responsibility of the A5 control interface. */
export interface RunHandle<Status, CancelResult> {
  readonly runId: string;
  readonly locator: HostLocator | null;
  readonly bindingGeneration: number;
  status(): Promise<Status>;
  cancel(grace?: number): Promise<CancelResult>;
  sendInput?(text: string): Promise<void>;
  focus?(): Promise<void>;
}

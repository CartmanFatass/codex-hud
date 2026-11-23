/** The records exchanged in a HUD job directory. Types only: readers keep their
 * existing size limits, validation and treatment of missing/legacy evidence. */
import type { CliAgent } from '../roles/cli-kinds.js';
import type { Role, RolePlace, RouteMode, RouteTier, piSwitches } from '../roles/roster.js';
import type { QuietDecision } from './quiet-decision.js';
import type { SonicLimits } from './sonic-policy.js';

export type { ProgressEntry } from '../collectors/workboard-types.js';
export type { ReportMeta } from '../roles/report-meta.js';

export type PiOptions = Partial<Record<(typeof piSwitches)[number], boolean>> & { pi_args?: string[] };
export type JobRoute = { tier: RouteTier; mode: RouteMode; reason: string; source: 'decision' | 'default'; fallback?: string; mode_reason?: string };
export type LaunchAttempt = { index: number; place: string; reason?: string };
export type SendOutcome = { key: string; derived_key?: string; recorded_at?: string; exit_code: number | null; stderr_tail: string; resumed?: true };
export interface ManagedWorktree {
  main_root: string;
  root: string;
  branch: string;
  base_head: string;
  owner?: string;
}

/** job.json */
export interface Job extends PiOptions {
  job: string;
  role: string;
  request_key: string;
  cwd: string;
  project_root?: string;
  herdr_pane?: string; // Caller for tabbed jobs and older headless receipts.
  caller_pane?: string; // Headless workers have no pane of their own.
  created_at: string;
  queued_at?: string;
  overflow_from?: string;
  instructions_from?: string;
  borrowed_instructions?: { name: string; pi_role: string }; // Keep launch selectors across queueing and native resume.
  route?: JobRoute;
  scout_question?: string;
  headless?: boolean; // Older sonic receipts may own a herdr tab.
  headless_task_fence?: string; // Automatic follow-ups are part of the caller's existing task.
  package?: string;
  title?: string;
  ticket?: string;
  slice?: string;
  preset?: string;
  context_files?: string[];
  from_jobs?: string[];
  checks?: string[];
  repair_of?: string;
  retry_of?: string;
  land_turn?: string; // Only this repair turn's ordinary notices belong to the enclosing flow.
  target_hint?: string | null;
  task_length?: number;
  create_options?: Record<string, unknown>;
  model?: string | null;
  thinking?: string | null;
  thinking_source?: 'decision' | 'default' | 'explicit';
  model_source?: string | null;
  read_at?: string;
  parent_job?: string;
  scout_only?: true;
  scout_state?: 'scouting' | 'done' | 'failed';
  scout_error?: string;
  pi_sent_at?: string;
  resume_s?: number;
  observed_at?: string;
  reaped_at?: string;
  worktree?: ManagedWorktree;
  worktree_removed_at?: string;
  worktree_kept_reason?: string;
  worktree_checked_head?: string;
  place?: RolePlace;
  place_key?: string;
  exhaustion_marked?: boolean;
  bro?: RolePlace;
  jev?: Role;
  cli?: { agent: CliAgent; can_continue: boolean; idle_grace_s: number; state_trust?: 'turn' | 'advisory'; mcp_scope_warning?: string };
  attempts?: LaunchAttempt[];
  launch_agent_args?: { place: string; args: string[] }[];
  used_place?: string;
  dispatch_exit_code: number | null;
  dispatch_code?: 'untrusted_cwd' | 'unsupported_harness' | 'invalid_arguments';
  dispatch_path?: string;
  stderr_tail: string;
  message_keys?: string[]; // Legacy receipts only.
  send_outcomes?: SendOutcome[];
  role_skills?: { name: string; path: string }[];
  skipped_skills?: { name: string; reason: string }[];
  worker_prompt?: string | null;
}

/** STATUS.json ranges from minimal dispatch/scout updates to full harness receipts. */
export type JobStatus = {
  state: 'queued' | 'working' | 'waiting_helper' | 'waiting_orchestrator' | 'blocked' | 'idle_grace' | 'closed' | 'done' | 'failed' | 'stopped';
  version?: 1;
  task_dir?: string;
  slot?: string;
  role?: string;
  harness?: RolePlace['harness'];
  agent?: string;
  provider?: string;
  model?: string | null;
  thinking?: string | null;
  output_path?: string;
  output_written?: boolean;
  pid?: number | null;
  pid_start_time?: string | null;
  boot_id?: string;
  parent_started_at?: string;
  runner_exit_code?: number | null;
  runner_exit_signal?: NodeJS.Signals | null;
  stderr_tail?: string | null;
  stdout_bytes?: number;
  stdout_start?: number;
  stderr_bytes?: number;
  sonic_limits?: SonicLimits;
  supervisor_pid?: number | null;
  agent_session_id?: string | null;
  session_id?: string | null;
  session_file?: string | null;
  started_at?: string;
  settled_at?: string | null;
  idle_deadline_at?: string | null;
  ended_at?: string | null;
  updated_at?: string;
  exit_reason?: string | null;
  error?: string | null;
  blocked?: boolean;
  reason?: string | null;
  declared_report_sig?: string | null;
  quiet_decision?: QuietDecision & { at: string };
};

/** turn.json and its corresponding done.json receipt */
export interface Turn {
  seq: number;
  sent_at: string;
  report_sig: string | null;
  report_prompt_sent?: boolean;
  first_sent_at?: string;
  caller_token?: string; // HUD follow-ups keep the caller task but advance the report token.
  send?: { key: string; pid: number; start: string | null };
  // Only during live prompt submission. Keep one predecessor, not the turn history.
  pending_from?: Pick<Turn, 'seq' | 'sent_at' | 'report_sig'> & { pid: number; start: string };
}
export type DoneReceipt = Pick<Turn, 'seq' | 'sent_at'> & { report_sig: string; at: string };

/** checks.json */
export type CheckBinding = { turn: string; report_sig: string };
export type CheckResult = { command: string; exit_code: number | null; duration_ms: number; output_tail: string; timed_out?: boolean };
export type CheckReceipt = CheckBinding & {
  state: 'running' | 'done';
  pid?: number;
  start?: string;
  results: CheckResult[];
};

export type WorkerTreeSnapshot = {
  version: 2; bootId: string; pid: number; start: string; members: { pid: number; start: string }[];
};

export type SessionReceipt = Partial<Record<'TASK' | 'TAB' | 'TAB_NAME' | 'LEFT' | 'RIGHT' | 'ORCH' | 'BASE' | 'PRIMARY', string>>;
export type McpTaskMarker = { id: string; pane: string; pid: number; start?: string; expires: number };
export type BatchNotice = {
  task_id: string; fence: string; status: 'working' | 'completed' | 'failed' | 'cancelled';
  delivered_at: string; via: 'push' | 'changes';
};

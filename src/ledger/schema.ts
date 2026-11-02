/** Frozen contract 02 schema v1; verified byte-for-byte by ledger-schema.test.ts. */
export const SCHEMA_V1_DDL = String.raw`PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
-- 初始化/实时连接默认立即返回 busy；有限重试与总预算归06。
PRAGMA busy_timeout = 0;
BEGIN IMMEDIATE;

CREATE TABLE ledger_metadata (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  ledger_id TEXT NOT NULL CHECK (length(ledger_id) > 0)
) STRICT;
INSERT INTO ledger_metadata(singleton, ledger_id) VALUES (1, lower(hex(randomblob(16))));
CREATE TRIGGER ledger_metadata_keep_update BEFORE UPDATE ON ledger_metadata
BEGIN
  SELECT RAISE(ABORT, 'ledger metadata is immutable');
END;
CREATE TRIGGER ledger_metadata_keep_delete BEFORE DELETE ON ledger_metadata
BEGIN
  SELECT RAISE(ABORT, 'ledger metadata is immutable');
END;
CREATE TRIGGER ledger_metadata_keep_insert BEFORE INSERT ON ledger_metadata
WHEN EXISTS (SELECT 1 FROM ledger_metadata)
BEGIN
  SELECT RAISE(ABORT, 'ledger metadata already initialized');
END;

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY NOT NULL CHECK (length(source_id) = 64 AND source_id NOT GLOB '*[^0-9a-f]*'),
  harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'pi')),
  root_path TEXT NOT NULL CHECK (substr(root_path, 1, 1) = '/'),
  label TEXT NOT NULL,
  UNIQUE (harness, root_path),
  UNIQUE (source_id, harness)
) STRICT;

CREATE TABLE sessions (
  session_ref TEXT PRIMARY KEY NOT NULL,
  harness TEXT NOT NULL,
  source_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  thread_id TEXT NOT NULL DEFAULT '',
  CHECK (session_ref = json_array(harness, source_id, session_id, nullif(thread_id, ''))),
  UNIQUE (harness, source_id, session_id, thread_id),
  UNIQUE (session_ref, source_id, harness),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness)
) STRICT;

CREATE TABLE caller_scopes (
  process_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  harness TEXT NOT NULL,
  source_id TEXT NOT NULL,
  pid_domain TEXT NOT NULL CHECK (length(pid_domain) > 0),
  harness_pid INTEGER NOT NULL CHECK (harness_pid > 0),
  harness_proc_start TEXT NOT NULL CHECK (length(harness_proc_start) > 0),
  session_ref TEXT,
  bound_by TEXT CHECK (bound_by IN ('receipt', 'trusted_session', 'transcript')),
  binding_evidence_id TEXT REFERENCES evidence(evidence_id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (process_key, generation),
  CHECK (process_key = json_array(harness, source_id, pid_domain, harness_pid, harness_proc_start)),
  CHECK ((session_ref IS NULL AND bound_by IS NULL AND binding_evidence_id IS NULL)
    OR (session_ref IS NOT NULL AND bound_by IS NOT NULL AND binding_evidence_id IS NOT NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  UNIQUE (process_key, generation, source_id, harness),
  UNIQUE (process_key, generation, session_ref),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness),
  FOREIGN KEY (session_ref, source_id, harness) REFERENCES sessions(session_ref, source_id, harness)
) STRICT;
CREATE UNIQUE INDEX caller_scopes_current ON caller_scopes(process_key) WHERE closed_at IS NULL;

CREATE TABLE callers (
  caller_id TEXT PRIMARY KEY NOT NULL,
  instance_kind TEXT NOT NULL DEFAULT 'dedicated' CHECK (instance_kind IN ('dedicated', 'shared')),
  harness TEXT CHECK (harness IN ('claude', 'codex', 'pi')),
  source_id TEXT,
  pid INTEGER NOT NULL CHECK (pid > 0),
  proc_start TEXT NOT NULL CHECK (length(proc_start) > 0),
  ppid INTEGER NOT NULL CHECK (ppid > 0),
  parent_proc_start TEXT NOT NULL CHECK (length(parent_proc_start) > 0),
  cwd TEXT NOT NULL CHECK (substr(cwd, 1, 1) = '/'),
  env_pane TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  retired_at INTEGER,
  UNIQUE (caller_id, instance_kind),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness)
) STRICT;

CREATE TABLE caller_contexts (
  context_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  caller_id TEXT NOT NULL,
  context_key TEXT NOT NULL CHECK (length(context_key) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('dedicated', 'shared')),
  source_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  process_key TEXT,
  proc_generation INTEGER,
  session_ref TEXT,
  selection_evidence_id TEXT REFERENCES evidence(evidence_id),
  bound_by TEXT CHECK (bound_by IN ('receipt', 'trusted_session', 'transcript')),
  binding_evidence_id TEXT REFERENCES evidence(evidence_id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (context_id, generation),
  UNIQUE (caller_id, context_key, generation),
  UNIQUE (context_id, generation, caller_id),
  CHECK ((kind = 'dedicated' AND context_key = 'stdio' AND process_key IS NOT NULL
      AND proc_generation IS NOT NULL AND proc_generation = generation)
    OR (kind = 'shared' AND process_key IS NULL AND proc_generation IS NULL
      AND session_ref IS NOT NULL AND selection_evidence_id IS NOT NULL)),
  CHECK ((session_ref IS NULL AND bound_by IS NULL AND binding_evidence_id IS NULL)
    OR (session_ref IS NOT NULL AND bound_by IS NOT NULL AND binding_evidence_id IS NOT NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  FOREIGN KEY (caller_id, kind) REFERENCES callers(caller_id, instance_kind),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness),
  FOREIGN KEY (session_ref, source_id, harness) REFERENCES sessions(session_ref, source_id, harness),
  FOREIGN KEY (process_key, proc_generation, source_id, harness)
    REFERENCES caller_scopes(process_key, generation, source_id, harness),
  FOREIGN KEY (process_key, proc_generation, session_ref)
    REFERENCES caller_scopes(process_key, generation, session_ref)
) STRICT;
CREATE UNIQUE INDEX caller_contexts_current_id ON caller_contexts(context_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX caller_contexts_current_key ON caller_contexts(caller_id, context_key) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX caller_contexts_single_stdio ON caller_contexts(caller_id) WHERE kind = 'dedicated' AND closed_at IS NULL;

CREATE TABLE owner_aliases (
  process_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_ref TEXT NOT NULL REFERENCES sessions(session_ref),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (process_key, generation),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  FOREIGN KEY (process_key, generation, session_ref)
    REFERENCES caller_scopes(process_key, generation, session_ref)
) STRICT;
CREATE INDEX owner_aliases_session ON owner_aliases(session_ref);

CREATE TABLE links (
  link_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'bound', 'reported', 'closed', 'failed', 'revoked', 'handed_over')),
  parent_caller TEXT NOT NULL REFERENCES callers(caller_id),
  parent_context_id TEXT NOT NULL,
  parent_context_generation INTEGER NOT NULL,
  parent_ref TEXT REFERENCES sessions(session_ref),
  child_ref TEXT REFERENCES sessions(session_ref),
  current_owner INTEGER NOT NULL DEFAULT 0 CHECK (current_owner IN (0, 1)),
  backend TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT,
  brief_path TEXT NOT NULL CHECK (substr(brief_path, 1, 1) = '/'),
  task_digest TEXT NOT NULL CHECK (length(task_digest) = 64 AND task_digest NOT GLOB '*[^0-9a-f]*'),
  report_path TEXT CHECK (report_path IS NULL OR substr(report_path, 1, 1) = '/'),
  predecessor TEXT UNIQUE REFERENCES links(link_id),
  routing TEXT CHECK (routing IS NULL OR json_valid(routing)),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  bound_at INTEGER,
  closed_at INTEGER,
  CHECK (parent_ref IS NULL OR child_ref IS NULL OR parent_ref <> child_ref),
  CHECK (predecessor IS NULL OR predecessor <> link_id),
  CHECK (current_owner = 0 OR (child_ref IS NOT NULL AND state NOT IN ('handed_over', 'failed', 'revoked'))),
  CHECK (state <> 'closed' OR closed_at IS NOT NULL),
  FOREIGN KEY (parent_context_id, parent_context_generation, parent_caller)
    REFERENCES caller_contexts(context_id, generation, caller_id)
) STRICT;
CREATE UNIQUE INDEX links_current_child ON links(child_ref) WHERE current_owner = 1;
CREATE INDEX links_parent ON links(parent_ref);
CREATE TRIGGER links_keep_child BEFORE UPDATE OF child_ref ON links
WHEN OLD.child_ref IS NOT NULL AND NEW.child_ref IS NOT OLD.child_ref
BEGIN
  SELECT RAISE(ABORT, 'known child ref cannot be replaced');
END;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT NOT NULL REFERENCES links(link_id),
  run_seq INTEGER NOT NULL CHECK (run_seq >= 1),
  operation TEXT NOT NULL CHECK (operation IN ('spawn', 'resume', 'handover')),
  target_session_ref TEXT,
  source_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('visible', 'headless')),
  launch_cwd TEXT NOT NULL CHECK (substr(launch_cwd, 1, 1) = '/'),
  workspace_snapshot TEXT CHECK (workspace_snapshot IS NULL OR (json_valid(workspace_snapshot) AND json_type(workspace_snapshot) = 'object')),
  project_origin TEXT CHECK (project_origin IS NULL OR (json_valid(project_origin) AND json_type(project_origin) = 'object')),
  supervision_strategy TEXT NOT NULL DEFAULT 'headless' CHECK (supervision_strategy IN ('headless', 'wrapper')),
  scope_kind TEXT NOT NULL DEFAULT 'pgid' CHECK (scope_kind = 'pgid'),
  scope_ref TEXT CHECK (scope_ref IS NULL OR (json_valid(scope_ref) AND json_type(scope_ref) = 'object'
    AND json_extract(scope_ref, '$.scope_kind') IS scope_kind)),
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'cancelling', 'uncertain', 'ended', 'failed', 'cancelled')),
  locator TEXT CHECK (locator IS NULL OR json_valid(locator)),
  launch_token_hash TEXT NOT NULL UNIQUE CHECK (length(launch_token_hash) = 64 AND launch_token_hash NOT GLOB '*[^0-9a-f]*'),
  launch_digest TEXT NOT NULL CHECK (length(launch_digest) = 64 AND launch_digest NOT GLOB '*[^0-9a-f]*'),
  launch_phase TEXT NOT NULL DEFAULT 'reserved' CHECK (launch_phase IN ('reserved', 'armed', 'submitting', 'submitted', 'never_submitted')),
  launch_call_id TEXT NOT NULL,
  launch_correlation_id TEXT NOT NULL,
  launch_message_id TEXT,
  supervisor_pid INTEGER CHECK (supervisor_pid > 0),
  supervisor_proc_start TEXT,
  heartbeat_at INTEGER,
  heartbeat_seq INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat_seq >= 0),
  heartbeat_mono_ms INTEGER CHECK (heartbeat_mono_ms >= 0),
  cancel_requested_at INTEGER,
  submission_fenced_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  exit_signal TEXT,
  exit_source TEXT CHECK (exit_source IN ('wait_status', 'trusted_harness_result')),
  shell_status INTEGER,
  shell_signal TEXT,
  terminal_evidence_id TEXT REFERENCES evidence(evidence_id),
  orphan_policy TEXT NOT NULL DEFAULT 'continue' CHECK (orphan_policy IN ('continue', 'stop')),
  UNIQUE (link_id, run_seq),
  UNIQUE (run_id, link_id),
  UNIQUE (run_id, expected_generation),
  CHECK ((supervisor_pid IS NULL AND supervisor_proc_start IS NULL)
    OR (supervisor_pid IS NOT NULL AND supervisor_proc_start IS NOT NULL AND length(supervisor_proc_start) > 0)),
  CHECK ((heartbeat_at IS NULL AND heartbeat_seq = 0 AND heartbeat_mono_ms IS NULL)
    OR (supervisor_pid IS NOT NULL AND heartbeat_at IS NOT NULL AND heartbeat_seq >= 1 AND heartbeat_mono_ms IS NOT NULL)),
  CHECK (operation NOT IN ('resume', 'handover') OR target_session_ref IS NOT NULL),
  CHECK ((mode = 'headless' AND supervision_strategy = 'headless')
    OR (mode = 'visible' AND supervision_strategy = 'wrapper')),
  CHECK ((state IN ('ended', 'failed', 'cancelled') AND ended_at IS NOT NULL
      AND terminal_evidence_id IS NOT NULL AND submission_fenced_at IS NOT NULL)
    OR (state IN ('starting', 'running', 'cancelling', 'uncertain') AND ended_at IS NULL AND terminal_evidence_id IS NULL AND exit_code IS NULL AND exit_signal IS NULL
      AND exit_source IS NULL AND shell_status IS NULL AND shell_signal IS NULL)),
  CHECK ((exit_source IS NULL AND exit_code IS NULL AND exit_signal IS NULL)
    OR (exit_source IS NOT NULL AND ((exit_code IS NOT NULL AND exit_signal IS NULL)
      OR (exit_code IS NULL AND exit_signal IS NOT NULL)))),
  CHECK (state <> 'failed' OR exit_source IS NULL),
  CHECK (shell_status IS NULL OR shell_signal IS NULL),
  CHECK (ended_at IS NULL OR ended_at >= created_at),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness),
  FOREIGN KEY (target_session_ref, source_id, harness) REFERENCES sessions(session_ref, source_id, harness)
) STRICT;
CREATE INDEX runs_link_latest ON runs(link_id, run_seq DESC);
CREATE INDEX runs_reconcile ON runs(state, heartbeat_at);
CREATE INDEX runs_target ON runs(target_session_ref);
CREATE TRIGGER runs_keep_launch_context BEFORE UPDATE OF launch_cwd, project_origin ON runs
WHEN NEW.launch_cwd IS NOT OLD.launch_cwd OR NEW.project_origin IS NOT OLD.project_origin
BEGIN
  SELECT RAISE(ABORT, 'launch context is immutable');
END;
CREATE TRIGGER runs_capture_workspace_once BEFORE UPDATE OF workspace_snapshot ON runs
WHEN OLD.workspace_snapshot IS NOT NULL AND NEW.workspace_snapshot IS NOT OLD.workspace_snapshot
BEGIN
  SELECT RAISE(ABORT, 'workspace snapshot is first capture only');
END;
CREATE TRIGGER runs_keep_target BEFORE UPDATE OF target_session_ref ON runs
WHEN OLD.target_session_ref IS NOT NULL AND NEW.target_session_ref IS NOT OLD.target_session_ref
BEGIN
  SELECT RAISE(ABORT, 'known target ref cannot be replaced');
END;
CREATE TRIGGER runs_keep_scope BEFORE UPDATE OF scope_ref, scope_kind, supervision_strategy ON runs
WHEN NEW.scope_kind IS NOT OLD.scope_kind OR NEW.supervision_strategy IS NOT OLD.supervision_strategy
  OR (OLD.scope_ref IS NOT NULL AND NEW.scope_ref IS NOT OLD.scope_ref)
BEGIN
  SELECT RAISE(ABORT, 'established supervision scope cannot change');
END;
CREATE TRIGGER runs_keep_fence BEFORE UPDATE OF submission_fenced_at ON runs
WHEN OLD.submission_fenced_at IS NOT NULL AND NEW.submission_fenced_at IS NOT OLD.submission_fenced_at
BEGIN
  SELECT RAISE(ABORT, 'submission fence is permanent');
END;

CREATE TABLE claims (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(run_id),
  claim_hash TEXT NOT NULL UNIQUE CHECK (length(claim_hash) = 64 AND claim_hash NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  expected_generation INTEGER NOT NULL,
  supervisor_pid INTEGER CHECK (supervisor_pid > 0),
  supervisor_proc_start TEXT,
  state TEXT NOT NULL CHECK (state IN ('issued', 'armed', 'redeemed', 'revoked', 'expired')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_context_id TEXT,
  redeemed_generation INTEGER,
  redeemed_session_ref TEXT REFERENCES sessions(session_ref),
  redeemed_at INTEGER,
  CHECK (expires_at = issued_at + 1800000),
  CHECK ((supervisor_pid IS NULL AND supervisor_proc_start IS NULL)
    OR (supervisor_pid IS NOT NULL AND supervisor_proc_start IS NOT NULL)),
  CHECK (state NOT IN ('armed', 'redeemed') OR supervisor_pid IS NOT NULL),
  CHECK (state <> 'redeemed' OR (redeemed_at IS NOT NULL AND redeemed_context_id IS NOT NULL AND redeemed_generation IS NOT NULL)),
  FOREIGN KEY (run_id, expected_generation) REFERENCES runs(run_id, expected_generation),
  FOREIGN KEY (redeemed_context_id, redeemed_generation) REFERENCES caller_contexts(context_id, generation)
) STRICT;

CREATE TABLE child_bindings (
  binding_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  session_ref TEXT NOT NULL REFERENCES sessions(session_ref),
  binding_generation INTEGER NOT NULL,
  caller_id TEXT NOT NULL,
  caller_context_id TEXT NOT NULL,
  context_generation INTEGER NOT NULL,
  bound_by TEXT NOT NULL CHECK (bound_by IN ('receipt', 'trusted_session', 'transcript')),
  capabilities TEXT NOT NULL CHECK (capabilities = 'mcp'),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((is_current = 1 AND revoked_at IS NULL) OR (is_current = 0 AND revoked_at IS NOT NULL)),
  UNIQUE (run_id, binding_id, caller_id, caller_context_id, context_generation),
  FOREIGN KEY (caller_context_id, context_generation, caller_id)
    REFERENCES caller_contexts(context_id, generation, caller_id),
  FOREIGN KEY (run_id, binding_generation) REFERENCES runs(run_id, expected_generation)
) STRICT;
CREATE UNIQUE INDEX child_bindings_current ON child_bindings(run_id) WHERE is_current = 1;

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT REFERENCES runs(run_id),
  link_id TEXT REFERENCES links(link_id),
  kind TEXT NOT NULL CHECK (kind IN ('launch_receipt', 'trusted_session', 'transcript', 'exit_receipt', 'group_check', 'never_submitted', 'heartbeat', 'conflict', 'conflict_resolved', 'scope_reconciled')),
  producer TEXT NOT NULL CHECK (producer IN ('hud-mcp', 'hud-run', 'reconciler')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  observed_at INTEGER NOT NULL,
  validated_at INTEGER,
  validation TEXT NOT NULL DEFAULT 'pending' CHECK (validation IN ('pending', 'accepted', 'rejected')),
  CHECK ((validation = 'pending' AND validated_at IS NULL) OR (validation <> 'pending' AND validated_at IS NOT NULL))
) STRICT;
CREATE INDEX evidence_run ON evidence(run_id, observed_at);

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  child_binding_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  caller_context_id TEXT NOT NULL,
  context_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'blocked', 'interrupted')),
  summary TEXT NOT NULL,
  path TEXT CHECK (path IS NULL OR substr(path, 1, 1) = '/'),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id, link_id) REFERENCES runs(run_id, link_id),
  FOREIGN KEY (run_id, child_binding_id, caller_id, caller_context_id, context_generation)
    REFERENCES child_bindings(run_id, binding_id, caller_id, caller_context_id, context_generation)
) STRICT;
CREATE INDEX reports_run ON reports(run_id, created_at);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT REFERENCES links(link_id),
  run_id TEXT REFERENCES runs(run_id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX events_run_cursor ON events(run_id, seq);
CREATE INDEX events_link_cursor ON events(link_id, seq);

CREATE TABLE idempotency (
  owner_key TEXT NOT NULL CHECK (json_valid(owner_key)),
  origin_owner_key TEXT NOT NULL CHECK (json_valid(origin_owner_key)),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  params_version INTEGER NOT NULL DEFAULT 1 CHECK (params_version = 1),
  params_digest TEXT NOT NULL CHECK (length(params_digest) = 64 AND params_digest NOT GLOB '*[^0-9a-f]*'),
  link_id TEXT REFERENCES links(link_id),
  run_id TEXT,
  outcome TEXT NOT NULL CHECK (json_valid(outcome)),
  at INTEGER NOT NULL,
  PRIMARY KEY (owner_key, request_key),
  CHECK (run_id IS NULL OR link_id IS NOT NULL),
  FOREIGN KEY (run_id, link_id) REFERENCES runs(run_id, link_id)
) STRICT;

CREATE TABLE slots (
  slot_key TEXT PRIMARY KEY NOT NULL,
  session_ref TEXT REFERENCES sessions(session_ref),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  holder TEXT NOT NULL CHECK (length(holder) > 0),
  acquired_at INTEGER NOT NULL,
  CHECK ((session_ref IS NULL AND slot_key = 'provisional:' || run_id)
    OR (session_ref IS NOT NULL AND slot_key = session_ref))
) STRICT;
CREATE TRIGGER slots_confirmed_release BEFORE DELETE ON slots
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id
  AND state IN ('ended', 'failed', 'cancelled') AND terminal_evidence_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'slot requires confirmed terminal evidence');
END;
CREATE TRIGGER slots_keep_run BEFORE UPDATE OF run_id ON slots
WHEN OLD.run_id <> NEW.run_id
BEGIN
  SELECT RAISE(ABORT, 'slot run cannot be replaced');
END;

PRAGMA user_version = 1;
COMMIT;
`;

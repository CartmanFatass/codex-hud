import type { TokenRateSnapshot } from './collectors/token-rate.js';
import type { AgentReport } from './collectors/agent-report.js';
/**
 * Type definitions for codex-hud
 * Phase 3: Redesigned to match claude-hud structure
 */

// ============================================================================
// Constants (matching openai/codex protocol)
// ============================================================================

/**
 * Baseline tokens reserved for system prompts, tools and space to call compact.
 * This matches the BASELINE_TOKENS constant in codex-rs/protocol/src/protocol.rs
 */
export const BASELINE_TOKENS = 12000;

// ============================================================================
// Configuration Types
// ============================================================================

export interface CodexConfig {
  model?: string;
  model_reasoning_effort?: string;
  model_provider?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  mcp_servers?: Record<string, McpServerConfig>;
}

export interface McpServerConfig {
  command?: string[];
  url?: string;
  enabled?: boolean;
}

// ============================================================================
// Git Status (Extended)
// ============================================================================

export interface GitStatus {
  branch: string | null;
  isDirty: boolean;
  isGitRepo: boolean;
  // Extended git sync status
  ahead: number;
  behind: number;
  // File stats
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

// ============================================================================
// Project Information (Extended)
// ============================================================================

export interface ProjectInfo {
  cwd: string;
  projectName: string;
  agentsMdCount: number;
  hasCodexDir: boolean;
  // Extended config counts
  instructionsMdCount: number;  // .codex/INSTRUCTIONS.md
  rulesCount: number;           // .codex/rules/*.md
  mcpCount: number;             // From config
  // Codex-specific module status
  configsCount: number;         // Active configuration files
  extensionsCount: number;      // Loaded extensions/plugins
  workMode: 'development' | 'production' | 'unknown';  // Current work mode
}

// ============================================================================
// Context Usage (Token/Context Window)
// ============================================================================

export interface ContextUsage {
  used: number;
  total: number;
  percent: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  // Compact tracking
  compactCount: number;
  lastCompactTime?: Date;
}

// ============================================================================
// Display Mode
// ============================================================================

export type HudDisplayMode = 'single' | 'tree';

// ============================================================================
// Layout Configuration
// ============================================================================

export type LayoutMode = 'compact' | 'standard' | 'expanded';

export interface LayoutConfig {
  mode: LayoutMode;
  maxWidth?: number;
  showSeparators?: boolean;
  showDuration: boolean;
  showContextBar?: boolean;
  showGitStatus?: boolean;
  showToolActivity?: boolean;
  showPlanProgress?: boolean;
  showContextBreakdown?: boolean;  // Show token breakdown when usage >= 85%
  barWidth?: number;               // Width of context progress bar
  contextBarWidth?: number;
}

// ============================================================================
// Rollout Parsing Types
// ============================================================================

export interface RolloutLine {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'event_msg' | 'turn_context';
  payload: RolloutPayload;
}

export type RolloutPayload =
  | SessionMetaPayload
  | ResponseItemPayload
  | EventMsgPayload
  | TurnContextPayload;

export interface SessionMetaPayload {
  id: string;
  timestamp: string;
  cwd: string;
  originator: string;
  cli_version: string;
  instructions?: string;
  source?: string | Record<string, unknown>;
  thread_source?: string;
  parent_thread_id?: string;
  agent_nickname?: string;
  model_provider?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

export interface ResponseItemPayload {
  type: 'message' | 'function_call' | 'function_call_output' | 'custom_tool_call' | 'custom_tool_call_output';
  role?: 'user' | 'assistant' | 'developer';
  content?: ContentBlock[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  output?: FunctionOutput | string | ContentBlock[];
}

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface FunctionOutput {
  content?: string;
  success?: boolean;
  content_items?: ContentBlock[];
}

export interface EventMsgPayload {
  type:
    | 'plan_update'
    | 'token_count'
    | 'rate_limit'
    | 'context_compacted'
    | 'turn_started'
    | 'task_started'
    | 'task_complete'
    | 'turn_complete'
    | 'turn_aborted'
    | 'task_failed'
    | 'item_completed'
    | 'other';
  explanation?: string;
  plan?: PlanStep[];
  info?: TokenUsageInfo;
  rate_limits?: RateLimitSnapshot;
  item?: CollabAgentItem;
  // For context_compacted events
  compacted_items?: CompactedItem[];
  summary?: string;
  // For turn_started events
  model_context_window?: number;
  collaboration_mode_kind?: string;
}

export interface TurnContextPayload {
  model?: string;
  effort?: string;
  reasoning_effort?: string;
  approval_policy?: string;
  sandbox_policy?: {
    type?: string;
  };
  collaboration_mode?: {
    mode?: string;
    settings?: {
      model?: string;
      reasoning_effort?: string;
    };
  };
}

/**
 * Represents an item that was compacted/summarized during /compact
 */
export interface CompactedItem {
  type: string;
  id?: string;
}

export interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TokenUsageInfo {
  total_token_usage?: TokenUsage;
  last_token_usage?: TokenUsage;
  model_context_window?: number;
}

export interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CollabAgentItem {
  type?: string;
  tool?: string;
  status?: string;
  model?: string;
  effort?: string;
  reasoning_effort?: string;
  prompt?: string;
  receiver_thread_ids?: string[];
  receiver_agents?: Array<{
    thread_id?: string;
    agent_nickname?: string;
  }>;
  agents_states?: Record<string, unknown>;
}

export interface RateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  /**
   * Seen as an epoch (seconds or milliseconds), an RFC3339 string, and as a
   * count of seconds from now. `resolveResetTime` decides which by magnitude
   * rather than assuming one.
   */
  resets_at?: number | string;
  resets_in_seconds?: number;
}

export interface RateLimitCredits {
  has_credits?: boolean;
  unlimited?: boolean;
  balance?: string;
}

export interface RateLimitSnapshot {
  limit_id?: string;
  limit_name?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: RateLimitCredits | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
  // Legacy fields kept for older rollouts
  requests_remaining?: number;
  tokens_remaining?: number;
  reset_time?: string;
}

// ============================================================================
// Tool Activity Tracking
// ============================================================================

export type ToolStatus = 'running' | 'completed' | 'error';

export interface ToolCall {
  /** Explicit tool result; completion alone does not prove command success. */
  resultSuccess?: boolean;
  exitCode?: number;
  output?: string;
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  timestamp: Date;
  status: ToolStatus;
  duration?: number;
  target?: string;
}

export interface ToolActivity {
  recentCalls: ToolCall[];
  totalCalls: number;
  callsByType: Record<string, number>;
  lastUpdateTime: Date;
}

// ============================================================================
// Agent Activity (Similar to claude-hud)
// ============================================================================

export type AgentStatus = 'running' | 'completed' | 'error';

export interface AgentCall {
  id: string;
  type: string;        // e.g., 'explore', 'librarian', 'oracle'
  description: string;
  timestamp: Date;
  status: AgentStatus;
  duration?: number;
}

export interface AgentActivity {
  recentCalls: AgentCall[];
  totalCalls: number;
  lastUpdateTime: Date;
}

/**
 * `unknown` is a real answer: an agent the HUD can see exists but has no
 * terminal or progress event for. It must not be shown as running, and it must
 * not be counted as finished.
 */
export type SubagentStatus = 'starting' | 'running' | 'completed' | 'error' | 'unknown';

export interface SubagentInfo {
  task?: string;
  id: string;
  name: string;
  status: SubagentStatus;
  startedAt?: Date;
  model?: string;
  effort?: string;
  // Last time the main session exchanged a CollabAgent event with this agent.
  lastActivityAt?: Date;
}

export interface SubagentTreeNode {
  /** Public agent-authored excerpt; not verified completion or a file attribution. */
  lastReport?: AgentReport;
  task?: string;
  statusAt?: Date;
  /** Local rollout for inspecting this agent; never displayed as its task. */
  rolloutPath?: string;
  /** Latest observed turn start, distinct from agent creation and traffic. */
  turnStartedAt?: Date;
  id: string;
  name: string;
  status: SubagentStatus;
  startedAt?: Date;
  model?: string;
  effort?: string;
  /** Last main-to-agent exchange. */
  lastActivityAt?: Date;
  /**
   * Newest evidence of any kind about this agent, including its own rollout
   * being written to. Freshness is a separate axis from status: an agent can
   * be running and quiet, or unknown and recently active.
   */
  lastEventAt?: Date;
  depth: number;
  children: SubagentTreeNode[];
}

export interface SubagentTree {
  rootId: string;
  nodes: SubagentTreeNode[];
  totalCount: number;
  updatedAt: Date;
}

// ============================================================================
// Todo/Plan Progress
// ============================================================================

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
}

export interface PlanProgress {
  steps: PlanStep[];
  todos?: TodoItem[];
  completedSteps: number;
  totalSteps: number;
  completedTodos?: number;
  totalTodos?: number;
  // Backward compat aliases
  completed?: number;
  total?: number;
  lastUpdate: Date;
}

// ============================================================================
// Session Information
// ============================================================================

export interface SessionInfo {
  id: string;
  rolloutPath: string;
  startTime: Date;
  cwd: string;
  cliVersion: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  collaborationMode?: string;
  modelProvider?: string;
  parentThreadId?: string;
  threadSource?: string;
  git?: {
    branch?: string;
    commitHash?: string;
  };
}

// ============================================================================
// Complete HUD Data
// ============================================================================

export interface HudData {
  activity?: SessionActivity;
  tokenUsageAt?: Date;
  /** The latest collection failed; displayed values are the last good snapshot. */
  stale?: boolean;
  outputRate?: TokenRateSnapshot;
  // Core info
  config: CodexConfig;
  git: GitStatus;
  project: ProjectInfo;
  sessionStart: Date;
  
  // Session and rollout data
  session?: SessionInfo;
  runtimeSession?: Partial<SessionInfo>;
  
  // Context/token usage
  contextUsage?: ContextUsage;
  tokenUsage?: TokenUsageInfo;
  rateLimits?: RateLimitSnapshot;
  subagents?: SubagentInfo[];
  
  // Activity tracking
  toolActivity?: ToolActivity;
  agentActivity?: AgentActivity;
  planProgress?: PlanProgress;

  // Display mode
  displayMode?: HudDisplayMode;
  subagentTree?: SubagentTree;
}

export interface SessionActivity {
  state: 'working' | 'idle' | 'interrupted' | 'error';
  updatedAt: Date;
  turnStartedAt?: Date;
}

// ============================================================================
// Render Options
// ============================================================================

export interface RenderOptions {
  width: number;
  showDetails: boolean;
  layout?: LayoutConfig;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  mode: 'expanded',
  showSeparators: true,
  showDuration: true,
  showContextBar: false,
  showContextBreakdown: false,
  barWidth: 10,
};

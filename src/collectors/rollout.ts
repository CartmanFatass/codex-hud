import { taskText } from '../utils/task-text.js';
import { TokenRateTracker, type TokenRateSnapshot } from './token-rate.js';
import { sessionParentId } from '../utils/session-parent.js';
/**
 * Rollout file parser for extracting tool activity and plan updates
 * Parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files
 */

import * as fs from 'fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RolloutLine,
  ResponseItemPayload,
  EventMsgPayload,
  SessionMetaPayload,
  TurnContextPayload,
  ToolCall,
  ToolActivity,
  PlanProgress,
  SessionInfo,
  TokenUsageInfo,
  RateLimitSnapshot,
  SubagentInfo,
  SubagentStatus,
  CollabAgentItem,
  SessionActivity,
  PendingApproval,
} from '../types.js';

/** Approval summaries are pasted into the bar, so they carry no controls. */
function plainText(text: string, limit: number): string {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * What a recorded approval request is asking for.
 *
 * Only fields Codex actually wrote are read; an unrecognised shape yields no
 * summary rather than a guess at one.
 */
function approvalFromEvent(payload: EventMsgPayload, timestamp: Date): PendingApproval {
  const callId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : undefined;
  if (payload.type === 'apply_patch_approval_request') {
    const files = payload.changes && typeof payload.changes === 'object'
      ? Object.keys(payload.changes).length
      : 0;
    return {
      kind: 'patch',
      callId,
      since: timestamp,
      summary: files > 0 ? `${files} file${files === 1 ? '' : 's'}` : undefined,
    };
  }
  if (payload.type === 'request_user_input') {
    const first = payload.questions?.[0];
    const text = typeof first === 'string' ? first : first?.header ?? first?.question;
    return {
      kind: 'input',
      callId,
      since: timestamp,
      summary: typeof text === 'string' && text ? plainText(text, 60) : undefined,
    };
  }
  const command = Array.isArray(payload.command)
    ? payload.command.join(' ')
    : typeof payload.command === 'string'
      ? payload.command
      : '';
  return {
    kind: 'exec',
    callId,
    since: timestamp,
    summary: command ? plainText(command, 60) : undefined,
  };
}

function mergeTokenUsage(previous: TokenUsageInfo | null, next: TokenUsageInfo | null): TokenUsageInfo | null {
  if (!next) return previous;
  if (!previous) return next;
  return {
    model_context_window: next.model_context_window ?? previous.model_context_window,
    last_token_usage: next.last_token_usage ?? previous.last_token_usage,
    total_token_usage: next.total_token_usage ?? previous.total_token_usage,
  };
}

function hasUsableRateWindow(snapshot: RateLimitSnapshot | null | undefined): boolean {
  return Boolean(snapshot?.primary || snapshot?.secondary);
}

function inferSubagentStatus(state: unknown, tool?: string): SubagentStatus {
  if (tool === 'close_agent') {
    return 'completed';
  }
  if (state && typeof state === 'object') {
    const record = state as Record<string, unknown>;
    if (record.error || record.failed) {
      return 'error';
    }
    if (record.completed) {
      return 'completed';
    }
    if (record.running) {
      return 'running';
    }
  }
  if (state === 'pending_init') {
    return 'starting';
  }
  if (tool === 'wait' || tool === 'spawn_agent') {
    return 'running';
  }
  return 'running';
}

function effortFromState(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') {
    return undefined;
  }
  const record = state as Record<string, unknown>;
  const effort = record.effort ?? record.reasoning_effort;
  return typeof effort === 'string' && effort.length > 0 ? effort : undefined;
}

function applyCollabAgentItem(
  subagents: Map<string, SubagentInfo>,
  item: CollabAgentItem,
  timestamp: Date
): void {
  const agents = item.receiver_agents ?? [];
  const ids = agents.length > 0
    ? agents.map((agent) => agent.thread_id).filter((id): id is string => Boolean(id))
    : (item.receiver_thread_ids ?? []).filter(Boolean);

  for (const id of ids) {
    const listed = agents.find((agent) => agent.thread_id === id);
    const previous = subagents.get(id);
    const state = item.agents_states?.[id];
    const effort = item.effort ?? item.reasoning_effort ?? effortFromState(state);
    subagents.set(id, {
      id,
      name: listed?.agent_nickname || previous?.name || id.slice(0, 8),
      status: inferSubagentStatus(state, item.tool),
      task: taskText(item.prompt) ?? previous?.task,
      startedAt: previous?.startedAt ?? timestamp,
      model: item.model ?? previous?.model,
      effort: effort ?? previous?.effort,
      lastActivityAt: timestamp,
    });
  }
}

function mergeSubagents(previous: SubagentInfo[] | undefined, next: SubagentInfo[]): SubagentInfo[] {
  const merged = new Map<string, SubagentInfo>();
  for (const agent of previous ?? []) {
    merged.set(agent.id, agent);
  }
  for (const agent of next) {
    const existing = merged.get(agent.id);
    if (!existing) {
      merged.set(agent.id, agent);
      continue;
    }
    // Each incremental batch rebuilds SubagentInfo from a single event, so
    // fields that event does not carry arrive as explicit undefined. Skip
    // them, or they would clobber metadata merged from earlier batches
    // (model/effort from the spawn event lost on a later wait event).
    const patch: Partial<SubagentInfo> = {};
    for (const [key, value] of Object.entries(agent)) {
      if (value !== undefined) {
        (patch as Record<string, unknown>)[key] = value;
      }
    }
    merged.set(agent.id, {
      ...existing,
      ...patch,
      startedAt: existing.startedAt ?? agent.startedAt,
      // Fresh activity timestamps are the point of the merge.
      lastActivityAt: agent.lastActivityAt ?? existing.lastActivityAt,
    });
  }
  return [...merged.values()];
}

function mergeRateLimits(
  previous: RateLimitSnapshot | null,
  next: RateLimitSnapshot | null
): RateLimitSnapshot | null {
  if (!next) {
    return previous;
  }
  if (!previous) {
    return next;
  }
  if (!hasUsableRateWindow(next) && hasUsableRateWindow(previous)) {
    return {
      ...previous,
      ...next,
      primary: previous.primary,
      secondary: previous.secondary ?? next.secondary,
    };
  }
  return next;
}

function cloneSessionInfo(session: SessionInfo | null | undefined): SessionInfo | null {
  if (!session) {
    return null;
  }

  return {
    ...session,
    startTime: new Date(session.startTime),
    git: session.git ? { ...session.git } : undefined,
  };
}

/**
 * Result of parsing a rollout file
 */
export interface RolloutParseResult {
  activity?: SessionActivity;
  tokenUsageAt?: Date;
  outputRate?: TokenRateSnapshot;
  session: SessionInfo | null;
  toolActivity: ToolActivity;
  planProgress: PlanProgress | null;
  tokenUsage: TokenUsageInfo | null;
  rateLimits: RateLimitSnapshot | null;
  /** An approval request with nothing recorded after it that answers it. */
  pendingApproval: PendingApproval | null;
  subagents: SubagentInfo[];
  // Compact event tracking
  compactCount: number;
  lastCompactTime: Date | null;
  // Activity timestamps
  lastToolActivityTime: Date | null;
  lastAssistantMessageTime: Date | null;
  lastEventTime: Date | null;
  /**
   * Where the work happened: the directories commands ran in and edited files
   * sit in, distinct, oldest first and newest last. A session started above
   * its repository names that repository here and nowhere else.
   */
  workDirs: string[];
}

export interface RolloutParseOutput {
  result: RolloutParseResult;
  newOffset: number;
  runningCalls: Map<string, ToolCall>;
  wasTruncated: boolean;
  fileIdentity?: string;
}

export function computeNextOffset(
  startOffset: number,
  bytesRead: number,
  latestSize: number
): number {
  return Math.min(latestSize, startOffset + bytesRead);
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function toolResult(output: unknown): { success?: boolean; exitCode?: number; output?: string } {
  let text = '';
  let success: boolean | undefined;
  let exitCode: number | undefined;
  let remaining = 1000;
  const recordExit = (code: unknown) => {
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) return;
    // Any explicit failure wins over successful siblings in a batched exec.
    if (exitCode === undefined || exitCode === 0) exitCode = code;
    if (code !== 0) success = false;
    else if (success === undefined) success = true;
  };
  const visit = (data: unknown, depth: number): void => {
    if (depth > 8 || remaining-- <= 0) return;
    if (typeof data === 'string') {
      // Decode structured tool results, never the recorded executable input.
      if (data.length <= 128000) {
        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed && typeof parsed === 'object') { visit(parsed, depth + 1); return; }
        } catch { /* Plain tool output. */ }
      }
      for (const match of data.matchAll(/(?:Process exited with code|Exit code:)\s*(-?\d+)/gi)) recordExit(Number(match[1]));
      text = (text ? `${text}\n${data}` : data).slice(-8000);
    } else if (Array.isArray(data)) {
      for (const item of data) visit(item, depth + 1);
    } else if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (record.success === false || record.isError === true) success = false;
      else if (record.success === true && success === undefined) success = true;
      recordExit(record.exit_code ?? record.exitCode);
      if (record.type === 'text' || record.type === 'input_text' || record.type === 'output_text') visit(record.text, depth + 1);
      else {
        for (const [key, value] of Object.entries(record)) {
          if (['output', 'content', 'content_items'].includes(key) ||
              (!record.type && value && typeof value === 'object')) visit(value, depth + 1);
        }
      }
    }
  };
  visit(output, 0);
  return { success, exitCode, output: text || undefined };
}

const WORK_DIR_LIMIT = 12;

/** An absolute directory from a command's cwd, which Codex 0.157 records as a file:// URI. */
function localDir(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const dir = value.startsWith('file://') ? fileURLToPath(value) : value;
    return path.isAbsolute(dir) ? path.normalize(dir) : undefined;
  } catch {
    return undefined;
  }
}

/** Move `dir` to the newest end of the list, keeping the list short. */
function noteWorkDir(dirs: string[], dir: string | undefined): void {
  if (!dir) return;
  const at = dirs.indexOf(dir);
  if (at >= 0) dirs.splice(at, 1);
  dirs.push(dir);
  if (dirs.length > WORK_DIR_LIMIT) dirs.shift();
}

/** The folders of the files an edit touched, keyed by absolute path. */
function noteChangedFiles(dirs: string[], changes: unknown): void {
  if (!changes || typeof changes !== 'object') return;
  for (const file of Object.keys(changes)) {
    if (path.isAbsolute(file)) noteWorkDir(dirs, path.dirname(path.normalize(file)));
  }
}

export function mergeWorkDirs(older: readonly string[], newer: readonly string[]): string[] {
  const merged = [...older];
  for (const dir of newer) noteWorkDir(merged, dir);
  return merged;
}

/**
 * Extract target/path from tool arguments for display
 */
function extractToolTarget(toolName: string, argsStr?: string): string | undefined {
  if (!argsStr) return undefined;

  try {
    const args = JSON.parse(argsStr);
    switch (toolName.toLowerCase()) {
      case 'read':
      case 'write':
      case 'edit':
        return args.file_path ?? args.path ?? args.filePath;
      case 'glob':
      case 'grep':
        return args.pattern;
      case 'bash':
      case 'run_terminal_command':
        const cmd = args.command as string;
        if (cmd) {
          return cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
        }
        return undefined;
      case 'task':
        return args.description ?? args.subagent_type;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Parse a single rollout file incrementally
 * Supports reading from a specific byte offset for incremental updates
 */
export async function parseRolloutFile(
  rolloutPath: string,
  fromOffset: number = 0,
  maxRecentCalls: number = 10,
  runningCalls: Map<string, ToolCall> = new Map(),
  initialSession: SessionInfo | null = null,
  rateTracker: TokenRateTracker = new TokenRateTracker(),
  previousIdentity?: string,
  initialPendingApproval: PendingApproval | null = null
): Promise<RolloutParseOutput> {
  const toolActivity: ToolActivity = {
    recentCalls: [],
    totalCalls: 0,
    callsByType: {},
    lastUpdateTime: new Date(),
  };

  let session: SessionInfo | null = cloneSessionInfo(initialSession);
  let sessionModel: string | undefined;
  let sessionReasoningEffort: string | undefined;
  let sessionApprovalPolicy: string | undefined;
  let sessionSandboxMode: string | undefined;
  let sessionCollaborationMode: string | undefined;
  let planProgress: PlanProgress | null = null;
  let tokenUsage: TokenUsageInfo | null = null;
  let rateLimits: RateLimitSnapshot | null = null;
  const subagents = new Map<string, SubagentInfo>();
  let compactCount = 0;
  let lastCompactTime: Date | null = null;
  let lastToolActivityTime: Date | null = null;
  let lastAssistantMessageTime: Date | null = null;
  let lastEventTime: Date | null = null;
  const workDirs: string[] = [];
  let activity: SessionActivity | undefined;
  let tokenUsageAt: Date | undefined;
  // Carried in like `session` and `runningCalls`: the event that answers a
  // request usually lands in a later batch than the request itself.
  let pendingApproval: PendingApproval | null = initialPendingApproval;

  /**
   * Clear the request the given call answers. A request that recorded a call
   * id is only cleared by that same id; one that recorded none has no other
   * candidate, so any answering event clears it.
   */
  const clearApprovalFor = (callId: string | undefined): void => {
    if (!pendingApproval) return;
    if (!pendingApproval.callId || pendingApproval.callId === callId) {
      pendingApproval = null;
    }
  };

  // Open once: rename/unlink after open cannot invalidate an end-of-read stat.
  // Read a bounded snapshot; bytes appended meanwhile belong to the next poll.
  const handle = await fs.promises.open(rolloutPath, 'r');
  try {
    const stats = await handle.stat();
    const fileIdentity = `${stats.dev}:${stats.ino}`;
    const fileSize = stats.size;
    const wasTruncated = fromOffset > fileSize ||
      (previousIdentity !== undefined && previousIdentity !== fileIdentity);
    const startOffset = wasTruncated ? 0 : fromOffset;
    if (wasTruncated) {
      rateTracker.reset();
      runningCalls.clear();
      session = null;
      pendingApproval = null;
    }
    const processLine = (line: string) => {
      if (!line.trim()) return;

      try {
        const entry = JSON.parse(line) as RolloutLine;
        const timestamp = new Date(entry.timestamp);

        // Process based on entry type
        lastEventTime = timestamp;
        if (entry.type === 'session_meta') {
          const meta = entry.payload as SessionMetaPayload;
          const existingSession = session;
          session = {
            id: meta.id,
            rolloutPath,
            startTime: new Date(meta.timestamp),
            cwd: meta.cwd,
            cliVersion: meta.cli_version,
            model: sessionModel ?? existingSession?.model,
            reasoningEffort: sessionReasoningEffort ?? existingSession?.reasoningEffort,
            approvalPolicy: sessionApprovalPolicy ?? existingSession?.approvalPolicy,
            sandboxMode: sessionSandboxMode ?? existingSession?.sandboxMode,
            collaborationMode: sessionCollaborationMode ?? existingSession?.collaborationMode,
            modelProvider: meta.model_provider,
            parentThreadId: sessionParentId(meta),
            threadSource: typeof meta.thread_source === 'string' ? meta.thread_source : undefined,
            git: meta.git
              ? {
                  branch: meta.git.branch,
                  commitHash: meta.git.commit_hash,
                }
              : undefined,
          };
        } else if (entry.type === 'turn_context') {
          const payload = entry.payload as TurnContextPayload;
          const contextModel = payload.model ?? payload.collaboration_mode?.settings?.model;
          const reasoningEffort =
            payload.effort ??
            payload.reasoning_effort ??
            payload.collaboration_mode?.settings?.reasoning_effort;
          const approvalPolicy = payload.approval_policy;
          const sandboxMode = payload.sandbox_policy?.type;
          const collaborationMode = payload.collaboration_mode?.mode;

          if (contextModel) {
            sessionModel = contextModel;
            if (session) {
              session.model = contextModel;
            }
          }

          if (reasoningEffort) {
            sessionReasoningEffort = reasoningEffort;
            if (session) {
              session.reasoningEffort = reasoningEffort;
            }
          }

          if (approvalPolicy) {
            sessionApprovalPolicy = approvalPolicy;
            if (session) {
              session.approvalPolicy = approvalPolicy;
            }
          }

          if (sandboxMode) {
            sessionSandboxMode = sandboxMode;
            if (session) {
              session.sandboxMode = sandboxMode;
            }
          }

          if (collaborationMode) {
            sessionCollaborationMode = collaborationMode;
            if (session) {
              session.collaborationMode = collaborationMode;
            }
          }
        } else if (entry.type === 'response_item') {
          const payload = entry.payload as ResponseItemPayload;

          if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && payload.name) {
            // New tool call started
            lastToolActivityTime = timestamp;
            const toolCall: ToolCall = {
              id: payload.call_id ?? payload.id ?? `call_${Date.now()}`,
              name: payload.name,
              timestamp,
              status: 'running',
              target: extractToolTarget(payload.name, payload.arguments),
              arguments: payload.type === 'custom_tool_call' && typeof payload.input === 'string'
                ? { code: payload.input } : parseToolArguments(payload.arguments),
            };

            runningCalls.set(toolCall.id, toolCall);
            toolActivity.totalCalls++;
            toolActivity.callsByType[payload.name] =
              (toolActivity.callsByType[payload.name] ?? 0) + 1;

            // Add to recent calls (will update status when completed)
            toolActivity.recentCalls.push(toolCall);
            if (toolActivity.recentCalls.length > maxRecentCalls) {
              toolActivity.recentCalls.shift();
            }
          } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && payload.call_id) {
            // Tool call completed
            lastToolActivityTime = timestamp;
            // A result for the call is proof the approval was answered.
            clearApprovalFor(payload.call_id);
            const runningCall = runningCalls.get(payload.call_id);
            if (runningCall) {
              const outcome = toolResult(payload.output);
              runningCall.status = outcome.success === false ? 'error' : 'completed';
              runningCall.resultSuccess = outcome.success;
              runningCall.exitCode = outcome.exitCode;
              runningCall.output = outcome.output;
              runningCall.duration = timestamp.getTime() - runningCall.timestamp.getTime();
              runningCalls.delete(payload.call_id);

              // Update in recentCalls array
              const idx = toolActivity.recentCalls.findIndex(
                (c) => c.id === payload.call_id
              );
              if (idx >= 0) {
                toolActivity.recentCalls[idx] = runningCall;
              } else {
                toolActivity.recentCalls.push(runningCall);
                if (toolActivity.recentCalls.length > maxRecentCalls) {
                  toolActivity.recentCalls.shift();
                }
              }
            }
          } else if (payload.type === 'message' && payload.role === 'assistant') {
            lastAssistantMessageTime = timestamp;
          }
        } else if (entry.type === 'event_msg') {
          const payload = entry.payload as EventMsgPayload;
          if (payload.type === 'task_started' || payload.type === 'turn_started') {
            rateTracker.startTurn(timestamp);
            activity = { state: 'working', updatedAt: timestamp, turnStartedAt: timestamp };
          } else if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
            activity = { ...activity, state: 'idle', updatedAt: timestamp };
          } else if (payload.type === 'turn_aborted' || payload.type === 'task_failed') {
            activity = { ...activity, state: payload.type === 'turn_aborted' ? 'interrupted' : 'error', updatedAt: timestamp };
          }

          // Codex 0.157 reports commands and edits as completed items; older
          // versions as exec and patch events.
          if (payload.type === 'item_completed') {
            const item = payload.item as { type?: string; cwd?: unknown; changes?: unknown } | undefined;
            if (item?.type === 'CommandExecution') noteWorkDir(workDirs, localDir(item.cwd));
            else if (item?.type === 'FileChange') noteChangedFiles(workDirs, item.changes);
          } else if (payload.type === 'exec_command_begin') {
            noteWorkDir(workDirs, localDir(payload.cwd));
          } else if (payload.type === 'patch_apply_begin') {
            noteChangedFiles(workDirs, payload.changes);
          }

          // A turn that ended is no longer waiting on anyone, however it
          // ended. A command that started is the answer to its own request.
          if (payload.type === 'task_complete' || payload.type === 'turn_complete' ||
              payload.type === 'turn_aborted' || payload.type === 'task_failed') {
            pendingApproval = null;
          } else if (payload.type === 'exec_command_begin' || payload.type === 'exec_command_end') {
            clearApprovalFor(payload.call_id);
          } else if (payload.type === 'exec_approval_request' ||
                     payload.type === 'apply_patch_approval_request' ||
                     payload.type === 'request_user_input') {
            pendingApproval = approvalFromEvent(payload, timestamp);
          }

          if (payload.type === 'token_count' && typeof payload.info?.total_token_usage?.output_tokens === 'number') {
            rateTracker.observe(payload.info.total_token_usage.output_tokens, timestamp);
          }

          if (payload.type === 'plan_update' && payload.plan) {
            const completed = payload.plan.filter((s) => s.status === 'completed').length;
            planProgress = {
              steps: payload.plan,
              todos: [],
              completedSteps: completed,
              totalSteps: payload.plan.length,
              completedTodos: 0,
              totalTodos: 0,
              lastUpdate: timestamp,
            };
          } else if (payload.type === 'token_count') {
            if (payload.info?.last_token_usage) tokenUsageAt = timestamp;
            if (payload.info) {
              tokenUsage = mergeTokenUsage(tokenUsage, payload.info);
            }
            if (payload.rate_limits) {
              rateLimits = mergeRateLimits(rateLimits, payload.rate_limits);
            }
          } else if (payload.type === 'rate_limit' && payload.rate_limits) {
            rateLimits = mergeRateLimits(rateLimits, payload.rate_limits);
          } else if (payload.type === 'item_completed' && payload.item?.type === 'CollabAgentToolCall') {
            applyCollabAgentItem(subagents, payload.item, timestamp);
          } else if (payload.type === 'context_compacted') {
            // /compact command was executed - track it
            compactCount++;
            lastCompactTime = timestamp;
          } else if (payload.type === 'task_started') {
            if (payload.collaboration_mode_kind) {
              sessionCollaborationMode = payload.collaboration_mode_kind;
              if (session) {
                session.collaborationMode = payload.collaboration_mode_kind;
              }
            }

            if (payload.model_context_window) {
              if (!tokenUsage) {
                tokenUsage = { model_context_window: payload.model_context_window };
              } else {
                tokenUsage.model_context_window = payload.model_context_window;
              }
            }
          } else if (payload.type === 'turn_started' && payload.model_context_window) {
            // New turn started - update context window if provided
            if (!tokenUsage) {
              tokenUsage = { model_context_window: payload.model_context_window };
            } else {
              tokenUsage.model_context_window = payload.model_context_window;
            }
          }
        }

        toolActivity.lastUpdateTime = timestamp;
      } catch {
        // Skip malformed lines
      }
    };

    let committedOffset = startOffset;
    let position = startOffset;
    let pending: Buffer = Buffer.alloc(0);
    const buffer = Buffer.alloc(64 * 1024);
    while (position < fileSize) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, fileSize - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let start = 0;
      let newline: number;
      while ((newline = pending.indexOf(10, start)) !== -1) {
        processLine(pending.subarray(start, newline).toString('utf8'));
        committedOffset += newline - start + 1;
        start = newline + 1;
      }
      pending = pending.subarray(start);
    }
    // Support complete records without a final newline, but never consume a
    // partial JSON record (including a split UTF-8 codepoint).
    if (pending.length) {
      try {
        JSON.parse(pending.toString('utf8'));
        processLine(pending.toString('utf8'));
        committedOffset += pending.length;
      } catch { /* Retry this tail from the last complete record next time. */ }
    }
    return {
      result: { session, activity, tokenUsageAt, toolActivity, planProgress, tokenUsage, outputRate: rateTracker.snapshot,
        rateLimits, pendingApproval, subagents: [...subagents.values()], compactCount, lastCompactTime,
        lastToolActivityTime, lastAssistantMessageTime, lastEventTime, workDirs },
      newOffset: committedOffset, runningCalls, wasTruncated, fileIdentity,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Rollout parser with state tracking for incremental updates
 */
export class RolloutParser {
  private rolloutPath: string | null = null;
  private lastOffset: number = 0;
  private cachedResult: RolloutParseResult | null = null;
  private runningCalls: Map<string, ToolCall> = new Map();
  private rateTracker = new TokenRateTracker();
  private generation = 0;
  private fileIdentity?: string;
  private needsReplay = false;

  constructor(private maxRecentCalls: number = 10) {}

  /**
   * Set the rollout file to parse
   */
  setRolloutPath(path: string | null): void {
    if (this.rolloutPath === path) {
      return;
    }

    this.generation++;
    this.fileIdentity = undefined;
    this.needsReplay = false;
    this.rolloutPath = path;
    this.lastOffset = 0;
    this.cachedResult = null;
    this.runningCalls = new Map();
    this.rateTracker = new TokenRateTracker();
  }

  /**
   * Parse the rollout file, reading only new content since last parse
   */
  async parse(): Promise<RolloutParseResult | null> {
    if (!this.rolloutPath) {
      return null;
    }

    const generation = this.generation;
    const replay = this.needsReplay;
    // A failed or superseded read may not mutate the published snapshot.
    const tracker = replay ? new TokenRateTracker() : this.rateTracker.clone();
    const calls = replay ? new Map<string, ToolCall>() : new Map([...this.runningCalls].map(([id, call]) => [id, { ...call }]));
    const { result, newOffset, runningCalls, wasTruncated, fileIdentity } = await parseRolloutFile(
      this.rolloutPath,
      replay ? 0 : this.lastOffset,
      this.maxRecentCalls,
      calls,
      replay ? null : this.cachedResult?.session ?? null,
      tracker,
      this.fileIdentity,
      replay ? null : this.cachedResult?.pendingApproval ?? null
    ).catch(error => {
      if (generation === this.generation) this.needsReplay = true;
      throw error;
    });

    if (generation !== this.generation) return this.cachedResult;
    this.needsReplay = false;
    this.rateTracker = tracker;
    this.fileIdentity = fileIdentity;
    this.lastOffset = newOffset;
    this.runningCalls = runningCalls;

    if (wasTruncated || replay) {
      this.cachedResult = null;
    }

    // Merge with cached result for session info and accumulated stats
    if (this.cachedResult) {
      // Merge tool activity
      result.toolActivity.totalCalls += this.cachedResult.toolActivity.totalCalls;
      for (const [type, count] of Object.entries(
        this.cachedResult.toolActivity.callsByType
      )) {
        result.toolActivity.callsByType[type] =
          (result.toolActivity.callsByType[type] ?? 0) + count;
      }

      // Prepend cached recent calls, then trim
      const allCalls = [
        ...this.cachedResult.toolActivity.recentCalls,
        ...result.toolActivity.recentCalls,
      ];
      const deduped: ToolCall[] = [];
      const seen = new Set<string>();
      for (let i = allCalls.length - 1; i >= 0; i--) {
        const call = allCalls[i];
        if (seen.has(call.id)) {
          continue;
        }
        seen.add(call.id);
        deduped.unshift(call);
      }
      result.toolActivity.recentCalls = deduped.slice(-this.maxRecentCalls);

      result.planProgress ??= this.cachedResult.planProgress;

      // Merge compact tracking
      result.compactCount += this.cachedResult.compactCount;
      if (!result.lastCompactTime && this.cachedResult.lastCompactTime) {
        result.lastCompactTime = this.cachedResult.lastCompactTime;
      }

      // Window-only turn events and partial token reports carry no new usage.
      // Retain the last measurement until the same session reports another.
      result.tokenUsage = mergeTokenUsage(this.cachedResult.tokenUsage, result.tokenUsage);

      result.rateLimits = mergeRateLimits(this.cachedResult.rateLimits, result.rateLimits);
      // `pendingApproval` is not merged here: it was handed to the parse as
      // its starting state, so the batch already saw whether anything in it
      // answered the outstanding request.
      result.subagents = mergeSubagents(this.cachedResult.subagents, result.subagents);
      result.activity ??= this.cachedResult.activity;
      if (result.activity && !result.activity.turnStartedAt && this.cachedResult.activity?.turnStartedAt) {
        result.activity = { ...result.activity, turnStartedAt: this.cachedResult.activity.turnStartedAt };
      }
      result.tokenUsageAt ??= this.cachedResult.tokenUsageAt;
      result.lastEventTime ??= this.cachedResult.lastEventTime;
      result.lastToolActivityTime ??= this.cachedResult.lastToolActivityTime;
      result.lastAssistantMessageTime ??= this.cachedResult.lastAssistantMessageTime;
      result.workDirs = mergeWorkDirs(this.cachedResult.workDirs, result.workDirs);
    }

    this.cachedResult = result;
    return result;
  }

  /**
   * Force a full re-parse from the beginning
   */
  async fullParse(): Promise<RolloutParseResult | null> {
    const path = this.rolloutPath;
    this.setRolloutPath(null);
    this.setRolloutPath(path);
    return this.parse();
  }

  /**
   * Get the current cached result without re-parsing
   */
  getCached(): RolloutParseResult | null {
    return this.cachedResult;
  }
}

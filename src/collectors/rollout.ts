import { RecoveryIndexOverlay } from '../core/checkpoint.js';
import {
  isRecoveryIndexFailure,
  RecoveryMap,
  RecoverySet,
  RecoveryCalls,
  type RecoveryClearCoordinator,
  recoveryArray,
  recoveryCounts,
} from '../harness/codex/recovery-index.js';
import {
  compactPlan,
  compactToolCall,
  encodeRecoveryToolCall,
  decodeRecoveryToolCall,
  metadataToWire,
  metadataFromWire,
  validateRolloutRecovery,
  type RateRecovery,
  type RolloutRecovery,
  type PlanMaterialMissing,
} from '../harness/codex/recovery.js';
export { validateRolloutRecovery, validateCodexRecoveryIndexEntry } from '../harness/codex/recovery.js';
import { initialParserState } from '../core/observation.js';
import type { ReaderBudget } from '../core/interfaces/harness-adapter.js';
import type { RecoveryReadGrant } from '../core/types/checkpoint.js';
import type { ReaderParserState } from '../core/types/observation.js';
import { taskText, looksAutomatic } from '../utils/task-text.js';
import { extractAgentReport } from './agent-report.js';
import { TokenRateTracker, observeTokenRateRecord, type TokenRateSnapshot } from './token-rate.js';
import { sessionParentId } from '../utils/session-parent.js';
import { timeAsync } from '../utils/profile.js';
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
  const clean = text
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    const files = payload.changes && typeof payload.changes === 'object' ? Object.keys(payload.changes).length : 0;
    return {
      kind: 'patch',
      callId,
      since: timestamp,
      summary: files > 0 ? `${files} file${files === 1 ? '' : 's'}` : undefined,
    };
  }
  if (payload.type === 'request_user_input') {
    const first = payload.questions?.[0];
    const text = typeof first === 'string' ? first : (first?.header ?? first?.question);
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
    ...(command.trim() ? { command: command.replace(/\s+/g, ' ').trim().slice(0, 4000) } : {}),
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

function applyCollabAgentItem(subagents: Map<string, SubagentInfo>, item: CollabAgentItem, timestamp: Date): void {
  const agents = item.receiver_agents ?? [];
  const ids =
    agents.length > 0
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

function mergeRateLimits(previous: RateLimitSnapshot | null, next: RateLimitSnapshot | null): RateLimitSnapshot | null {
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
 * Something that happened to the session, as the rollout recorded it. Facts
 * only: a quiet stretch is not an event, and neither is a guess.
 */
export interface SessionEvent {
  kind:
    | 'approval-requested'
    | 'approval-answered'
    | 'compacted'
    | 'quota'
    | 'turn-finished'
    | 'turn-interrupted'
    | 'turn-failed';
  at: Date;
  /** What was asked for approval, or a finished turn's answer (its head). */
  text?: string;
  /** For a quota crossing: the threshold crossed, 80 or 95, and the window's length. */
  threshold?: number;
  windowMinutes?: number;
}
export const SESSION_EVENT_LIMIT = 60;
/** A finished turn's answer kept on its event, its first characters. */
export const TURN_TEXT_CHARS = 600;

/** One reading of a quota window's use, for a forecast. */
export interface QuotaSample {
  window: 'primary' | 'secondary';
  at: Date;
  percent: number;
  windowMinutes?: number;
  /** When the window resets, as the reading gave it. */
  resetsAt?: Date;
}
export const QUOTA_SAMPLE_LIMIT = 240;
const QUOTA_THRESHOLDS = [80, 95];

export function appendBounded<T>(older: readonly T[], newer: readonly T[], limit: number): T[] {
  const all = [...older, ...newer];
  return all.length > limit ? all.slice(all.length - limit) : all;
}

function resetTime(window: { resets_at?: number | string; resets_in_seconds?: number }, at: number): Date | undefined {
  const raw = window.resets_at;
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    if (raw < 1_000_000_000) return new Date(at + raw * 1000);
    return new Date(raw > 1_000_000_000_000 ? raw : raw * 1000);
  }
  const seconds = window.resets_in_seconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? new Date(at + seconds * 1000)
    : undefined;
}

/** Public entries of the main conversation kept for the recap. */
export const TRANSCRIPT_LIMIT = 12;

/**
 * One public entry of the main conversation: what the person asked (wrappers
 * and injected context stripped) or what the assistant said on a public
 * channel (`update` commentary, `reply` final answer, `message` when the
 * rollout did not say which). Never reasoning. Text is an excerpt.
 */
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  kind: 'prompt' | 'message' | 'update' | 'reply';
  text: string;
  at: Date;
}

/** The newest `TRANSCRIPT_LIMIT` entries, and when the newest one let go was written. */
export function appendTranscript(
  older: readonly TranscriptEntry[],
  newer: readonly TranscriptEntry[],
  droppedAt?: Date
): { entries: TranscriptEntry[]; droppedAt?: Date } {
  const all = [...older, ...newer];
  const cut = Math.max(0, all.length - TRANSCRIPT_LIMIT);
  let dropped = droppedAt;
  for (const entry of all.slice(0, cut)) if (!dropped || entry.at > dropped) dropped = entry.at;
  return { entries: all.slice(cut), droppedAt: dropped };
}

/** A main-conversation entry from one rollout record, or nothing. */
function transcriptEntry(entry: RolloutLine, timestamp: Date, redactLaunch = false): TranscriptEntry | undefined {
  const payload = entry.payload as ResponseItemPayload & { content?: unknown };
  if (entry.type !== 'response_item' || payload.type !== 'message') return undefined;
  if (payload.role === 'user' && Array.isArray(payload.content)) {
    const raw = payload.content
      .map((part) => {
        const block = part as { type?: unknown; text?: unknown } | null;
        return block && (block.type === 'input_text' || block.type === 'text') && typeof block.text === 'string'
          ? block.text
          : '';
      })
      .filter(Boolean)
      .join('\n');
    // Transport envelopes are extraction inputs, never public task text or checkpoint material.
    const publicText = redactLaunch
      ? raw
          .split('\n')
          .filter((line) => !line.startsWith('[hud-launch] '))
          .join('\n')
      : raw;
    const text = taskText(publicText);
    return text ? { role: 'user', kind: 'prompt', text, at: timestamp } : undefined;
  }
  if (payload.role === 'assistant') {
    const report = extractAgentReport(entry);
    return report ? { role: 'assistant', kind: report.kind, text: report.text, at: report.at } : undefined;
  }
  return undefined;
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
  /**
   * The main conversation's latest public entries, oldest first, at most
   * `TRANSCRIPT_LIMIT`. `transcriptDroppedAt` is the newest entry that fell
   * off the front, so a reader can tell whether anything it has not seen was
   * lost. The other fields survive the buffer: the first request, and the
   * latest request and final reply however much commentary followed them.
   * The latest request leaves out a message that looks put there by a tool
   * (`looksAutomatic`).
   */
  transcript: TranscriptEntry[];
  transcriptDroppedAt?: Date;
  firstUserMessage?: TranscriptEntry;
  lastUserMessageAt?: Date;
  lastReplyAt?: Date;
  /** The session's recorded events, oldest first, at most `SESSION_EVENT_LIMIT`. */
  events: SessionEvent[];
  /** Quota readings, oldest first, at most `QUOTA_SAMPLE_LIMIT`. */
  quotaSamples: QuotaSample[];
}

/** Optional facade-only scanner state; legacy callers retain their existing read path. */
export interface RolloutReadOptions {
  budget: ReaderBudget;
  state: ReaderParserState;
  onRecord?: (entry: RolloutLine) => void;
  onReset?: () => RecoveryIndexOverlay | void;
  /** Reader-local slice transaction; never exported. */
  recoveryIndex?: RecoveryIndexOverlay;
  onParsed?: () => void;
  /** Internal live storage; never part of an exported checkpoint. */
  transient?: RolloutTransient;
  previousStat?: { size: number; mtimeMs: number; ctimeMs: number };
  /** Optional shared allowance for native file bytes and complete records. */
  grant?: RecoveryReadGrant;
  /** Maximum native records in this transactional step, independent of index I/O. */
  maxNativeRecords?: number;
  clearCoordinator?: RecoveryClearCoordinator;
}

export interface RolloutReadStats {
  state: ReaderParserState;
  bytesRead: number;
  recordsRead: number;
  remainingBytes: number;
  elapsedMs: number;
  fileStat: { size: number; mtimeMs: number; ctimeMs: number };
  continuation?: import('../core/interfaces/harness-adapter.js').ReaderResult['continuation'];
  resetReason?: 'truncated' | 'file_changed';
}

export type RolloutParserCheckpoint = RolloutRecovery;

/** An opaque reader-local key: incomplete source bytes are only in this WeakMap. */
export class RolloutTransient {}
const rolloutTails = new WeakMap<
  RolloutTransient,
  {
    fileIdentity: string;
    mtimeMs: number;
    ctimeMs: number;
    committedOffset: number;
    position: number;
    pending: Buffer;
    buffered?: Buffer;
  }
>();

export interface RolloutParseOutput {
  result: RolloutParseResult;
  newOffset: number;
  runningCalls: Map<string, ToolCall>;
  wasTruncated: boolean;
  readStats?: RolloutReadStats;
  fileIdentity?: string;
}

export function computeNextOffset(startOffset: number, bytesRead: number, latestSize: number): number {
  return Math.min(latestSize, startOffset + bytesRead);
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
          if (parsed && typeof parsed === 'object') {
            visit(parsed, depth + 1);
            return;
          }
        } catch {
          /* Plain tool output. */
        }
      }
      for (const match of data.matchAll(/(?:Process exited with code|Exit code:)\s*(-?\d+)/gi))
        recordExit(Number(match[1]));
      text = (text ? `${text}\n${data}` : data).slice(-8000);
    } else if (Array.isArray(data)) {
      for (const item of data) visit(item, depth + 1);
    } else if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (record.success === false || record.isError === true) success = false;
      else if (record.success === true && success === undefined) success = true;
      recordExit(record.exit_code ?? record.exitCode);
      if (record.type === 'text' || record.type === 'input_text' || record.type === 'output_text')
        visit(record.text, depth + 1);
      else {
        for (const [key, value] of Object.entries(record)) {
          if (
            ['output', 'content', 'content_items'].includes(key) ||
            (!record.type && value && typeof value === 'object')
          )
            visit(value, depth + 1);
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
  initialPendingApproval: PendingApproval | null = null,
  /** The last quota reading before this batch, so a crossing at its start is seen. */
  initialQuota: Partial<Record<'primary' | 'secondary', number>> = {},
  options?: RolloutReadOptions
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
  let transcript: TranscriptEntry[] = [];
  let transcriptDroppedAt: Date | undefined;
  let firstUserMessage: TranscriptEntry | undefined;
  let lastUserMessageAt: Date | undefined;
  let lastReplyAt: Date | undefined;
  let events: SessionEvent[] = [];
  let quotaSamples: QuotaSample[] = [];
  let lastQuota = { ...initialQuota };
  const event = (value: SessionEvent) => {
    events = appendBounded(events, [value], SESSION_EVENT_LIMIT);
  };
  /** Note a quota reading; a crossing needs a reading below the threshold first. */
  const noteQuota = (limits: RateLimitSnapshot | null | undefined, timestamp: Date) => {
    for (const name of ['primary', 'secondary'] as const) {
      const window = limits?.[name];
      const percent = window?.used_percent;
      if (!window || typeof percent !== 'number' || !Number.isFinite(percent)) continue;
      const before = lastQuota[name];
      for (const threshold of QUOTA_THRESHOLDS) {
        if (before !== undefined && before < threshold && percent >= threshold) {
          event({
            kind: 'quota',
            at: timestamp,
            threshold,
            text: name,
            ...(typeof window.window_minutes === 'number' ? { windowMinutes: window.window_minutes } : {}),
          });
        }
      }
      lastQuota = { ...lastQuota, [name]: percent };
      quotaSamples = appendBounded(
        quotaSamples,
        [
          {
            window: name,
            at: timestamp,
            percent,
            ...(typeof window.window_minutes === 'number' ? { windowMinutes: window.window_minutes } : {}),
            ...(() => {
              const resetsAt = resetTime(window, timestamp.getTime());
              return resetsAt ? { resetsAt } : {};
            })(),
          },
        ],
        QUOTA_SAMPLE_LIMIT
      );
    }
  };
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
  const clearApprovalFor = (callId: string | undefined, at?: Date): void => {
    if (!pendingApproval) return;
    if (!pendingApproval.callId || pendingApproval.callId === callId) {
      if (at) event({ kind: 'approval-answered', at, text: pendingApproval.summary });
      pendingApproval = null;
    }
  };

  const readStarted = performance.now();
  // Open once: rename/unlink after open cannot invalidate an end-of-read stat.
  // Read a bounded snapshot; bytes appended meanwhile belong to the next poll.
  const handle = await fs.promises.open(rolloutPath, 'r');
  try {
    const stats = await handle.stat();
    const fileIdentity = `${stats.dev}:${stats.ino}`;
    const fileSize = stats.size;
    const previousStat = options?.previousStat;
    const rewritten =
      !!previousStat &&
      fileSize === previousStat.size &&
      (stats.mtimeMs !== previousStat.mtimeMs || stats.ctimeMs !== previousStat.ctimeMs);
    const wasTruncated =
      fromOffset > fileSize ||
      (previousStat !== undefined && fileSize < previousStat.size) ||
      rewritten ||
      (previousIdentity !== undefined && previousIdentity !== fileIdentity);
    const startOffset = wasTruncated ? 0 : fromOffset;
    if (wasTruncated) {
      options?.onReset?.();
      rateTracker.reset();
      runningCalls.clear();
      session = null;
      pendingApproval = null;
    }
    const processLine = (line: string): boolean => {
      if (!line.trim()) return true;
      let entry: RolloutLine;
      try {
        entry = JSON.parse(line) as RolloutLine;
      } catch {
        return false;
      }
      if (
        !entry ||
        typeof entry !== 'object' ||
        !entry.payload ||
        typeof entry.payload !== 'object' ||
        Array.isArray(entry.payload)
      )
        return false;
      const timestamp = new Date(entry.timestamp);
      // Callback/index failures are operational failures, never malformed source data.
      options?.onRecord?.(entry);
      try {
        // Shared with the agent tail reader, including overlapping tool waits.
        observeTokenRateRecord(rateTracker, entry);
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
            payload.effort ?? payload.reasoning_effort ?? payload.collaboration_mode?.settings?.reasoning_effort;
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
              arguments:
                payload.type === 'custom_tool_call' && typeof payload.input === 'string'
                  ? { code: payload.input }
                  : parseToolArguments(payload.arguments),
            };

            runningCalls.set(toolCall.id, toolCall);
            toolActivity.totalCalls++;
            toolActivity.callsByType[payload.name] = (toolActivity.callsByType[payload.name] ?? 0) + 1;

            // Add to recent calls (will update status when completed)
            toolActivity.recentCalls.push(toolCall);
            if (toolActivity.recentCalls.length > maxRecentCalls) {
              toolActivity.recentCalls.shift();
            }
          } else if (
            (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
            payload.call_id
          ) {
            // Tool call completed
            lastToolActivityTime = timestamp;
            // A result for the call is proof the approval was answered.
            clearApprovalFor(payload.call_id, timestamp);
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
              const idx = toolActivity.recentCalls.findIndex((c) => c.id === payload.call_id);
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
          const spoken =
            payload.type === 'message' ? transcriptEntry(entry, timestamp, options !== undefined) : undefined;
          if (spoken) {
            ({ entries: transcript, droppedAt: transcriptDroppedAt } = appendTranscript(
              transcript,
              [spoken],
              transcriptDroppedAt
            ));
            // A message a tool put in the user's place is not a new request.
            if (spoken.role === 'user') {
              firstUserMessage ??= spoken;
              if (!looksAutomatic(spoken.text)) lastUserMessageAt = spoken.at;
            } else if (spoken.kind === 'reply') lastReplyAt = spoken.at;
          }
        } else if (entry.type === 'event_msg') {
          const payload = entry.payload as EventMsgPayload;
          if (payload.type === 'task_started' || payload.type === 'turn_started') {
            activity = { state: 'working', updatedAt: timestamp, turnStartedAt: timestamp };
          } else if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
            activity = { ...activity, state: 'idle', updatedAt: timestamp };
            // What the turn told the person, at its head: the timeline's line for it.
            const said =
              typeof payload.last_agent_message === 'string'
                ? payload.last_agent_message.replace(/\s+/g, ' ').trim()
                : '';
            event({
              kind: 'turn-finished',
              at: timestamp,
              ...(said ? { text: Array.from(said).slice(0, TURN_TEXT_CHARS).join('') } : {}),
            });
          } else if (payload.type === 'turn_aborted' || payload.type === 'task_failed') {
            activity = {
              ...activity,
              state: payload.type === 'turn_aborted' ? 'interrupted' : 'error',
              updatedAt: timestamp,
            };
            event({ kind: payload.type === 'turn_aborted' ? 'turn-interrupted' : 'turn-failed', at: timestamp });
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
          if (
            payload.type === 'task_complete' ||
            payload.type === 'turn_complete' ||
            payload.type === 'turn_aborted' ||
            payload.type === 'task_failed'
          ) {
            pendingApproval = null;
          } else if (payload.type === 'exec_command_begin' || payload.type === 'exec_command_end') {
            clearApprovalFor(payload.call_id, timestamp);
          } else if (
            payload.type === 'exec_approval_request' ||
            payload.type === 'apply_patch_approval_request' ||
            payload.type === 'request_user_input'
          ) {
            pendingApproval = approvalFromEvent(payload, timestamp);
            event({ kind: 'approval-requested', at: timestamp, text: pendingApproval.summary });
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
              noteQuota(payload.rate_limits, timestamp);
            }
          } else if (payload.type === 'rate_limit' && payload.rate_limits) {
            rateLimits = mergeRateLimits(rateLimits, payload.rate_limits);
            noteQuota(payload.rate_limits, timestamp);
          } else if (payload.type === 'item_completed' && payload.item?.type === 'CollabAgentToolCall') {
            applyCollabAgentItem(subagents, payload.item, timestamp);
          } else if (payload.type === 'context_compacted') {
            // /compact command was executed - track it
            compactCount++;
            lastCompactTime = timestamp;
            event({ kind: 'compacted', at: timestamp });
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
        return true;
      } catch (error) {
        if (isRecoveryIndexFailure(error) || !(error instanceof TypeError)) throw error;
        // Invalid known payload shapes retain the existing malformed-record behavior.
        return false;
      }
    };

    let committedOffset = startOffset;
    let readStats: RolloutReadStats | undefined;
    if (options) {
      const { maxBytes, budgetMs } = options.budget;
      const maxRecords = Math.min(options.budget.maxRecords, options.maxNativeRecords ?? options.budget.maxRecords);
      if ([maxBytes, maxRecords, budgetMs].some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error('invalid_reader_budget');
      }
      const previousState = wasTruncated ? initialParserState() : options.state;
      if (previousState.pendingBytes.length !== 0) throw new Error('unsupported_rollout_checkpoint');
      const state: ReaderParserState = {
        ...previousState,
        pendingBytes: [],
        gaps: [...previousState.gaps],
        skipped: { ...previousState.skipped },
      };
      const token = options.transient ?? new RolloutTransient();
      const oldTail = wasTruncated ? undefined : rolloutTails.get(token);
      const matches =
        oldTail?.fileIdentity === fileIdentity &&
        oldTail.committedOffset === startOffset &&
        oldTail.mtimeMs === stats.mtimeMs &&
        oldTail.ctimeMs === stats.ctimeMs &&
        oldTail.position <= fileSize &&
        !state.discardingOversize;
      let pending = matches ? oldTail.pending : Buffer.alloc(0);
      let buffered = options.grant && matches ? (oldTail.buffered ?? Buffer.alloc(0)) : Buffer.alloc(0);
      let position = state.discardingOversize
        ? (state.discardOffset ?? startOffset)
        : matches
          ? oldTail.position
          : startOffset;
      if (!Number.isSafeInteger(position) || position < startOffset || position > fileSize)
        throw new Error('invalid_rollout_checkpoint');
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, maxBytes)));
      let recordsRead = 0,
        fetchedBytes = 0,
        consumptionSteps = 0;
      const grant = options.grant;
      const hasGrantRecords = () => !grant || grant.remaining().maxRecords > 0;
      const grantBytes = () => (grant ? grant.remaining().maxBytes : maxBytes - fetchedBytes);
      const charge = (bytesRead: number, recordsRead: number) =>
        grant?.charge({ bytesRead, recordsRead, elapsedMs: 0 });
      let timeExhausted = false;
      const hasTime = () => performance.now() - readStarted < budgetMs && (!grant || grant.remaining().budgetMs > 0);
      const canConsume = () =>
        budgetMs > 0 && (!grant || grant.remaining().budgetMs > 0) && (consumptionSteps === 0 || hasTime());
      const skip = (reason: string) => {
        state.skipped[reason] = (state.skipped[reason] ?? 0) + 1;
        if (!state.gaps.includes(reason)) state.gaps.push(reason);
      };
      const line = (bytes: Buffer) => {
        let text: string;
        let entry: unknown;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (!text.trim()) return;
          entry = JSON.parse(text);
        } catch {
          skip('invalid_json');
          return;
        }
        const value = entry as { type?: string; timestamp?: string; payload?: { type?: string } } | null;
        if (
          !value ||
          typeof value !== 'object' ||
          !['session_meta', 'turn_context', 'response_item', 'event_msg'].includes(value.type ?? '')
        ) {
          skip('unknown_type');
        } else if (
          value.type === 'response_item' &&
          ['api-request-blob', 'reasoning', 'thinking', 'image'].includes(value.payload?.type ?? '')
        ) {
          const kind = value.payload!.type!;
          state.skipped[kind] = (state.skipped[kind] ?? 0) + 1;
        } else if (
          !value.payload ||
          typeof value.payload !== 'object' ||
          Array.isArray(value.payload) ||
          !Number.isFinite(Date.parse(value.timestamp ?? '')) ||
          !processLine(text)
        ) {
          skip('malformed_record');
        }
      };
      while (
        position < fileSize &&
        (buffered.length > 0 || fetchedBytes < maxBytes) &&
        recordsRead < maxRecords &&
        hasGrantRecords() &&
        (buffered.length > 0 || grantBytes() > 0) &&
        canConsume()
      ) {
        // Charge all fetched bytes, including unprocessed prefetch. Time is a soft limit:
        // one bounded step must consume fetched data even if open/stat/read exhausted it.
        let bytesRead: number;
        if (buffered.length) {
          bytesRead = Math.min(buffer.length, buffered.length);
          buffered.copy(buffer, 0, 0, bytesRead);
          buffered = buffered.subarray(bytesRead);
        } else {
          ({ bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, fileSize - position, maxBytes - fetchedBytes, grantBytes()),
            position
          ));
          fetchedBytes += bytesRead;
          charge(bytesRead, 0);
        }
        if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead && recordsRead < maxRecords && hasGrantRecords() && canConsume()) {
          const newline = buffer.subarray(0, bytesRead).indexOf(10, start);
          const end = newline < 0 ? bytesRead : newline;
          const piece = buffer.subarray(start, end);
          if (!state.discardingOversize) {
            if (pending.length + piece.length > 1024 * 1024) {
              pending = Buffer.alloc(0);
              state.discardingOversize = true;
              skip('oversize_unknown');
            } else pending = Buffer.concat([pending, piece]);
          }
          const consumed = end - start + (newline < 0 ? 0 : 1);
          position += consumed;
          start += consumed;
          consumptionSteps++;
          if (state.discardingOversize) state.discardOffset = position;
          if (newline >= 0) {
            charge(0, 1);
            if (!state.discardingOversize) line(pending);
            state.discardingOversize = false;
            state.discardOffset = null;
            pending = Buffer.alloc(0);
            committedOffset = position;
            recordsRead++;
          }
        }
        if (grant && start < bytesRead) buffered = Buffer.concat([buffer.subarray(start, bytesRead), buffered]);
      }
      timeExhausted = budgetMs > 0 && !hasTime();
      // A complete newline-free final record is one nonpreemptible record step.
      if (
        position === fileSize &&
        maxBytes > 0 &&
        budgetMs > 0 &&
        pending.length &&
        recordsRead < maxRecords &&
        hasGrantRecords() &&
        (recordsRead === 0 || !timeExhausted)
      ) {
        let complete = false;
        try {
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending));
          complete = true;
        } catch {
          /* An incomplete tail is reread from the committed boundary after restart. */
        }
        if (complete) {
          charge(0, 1);
          line(pending);
          pending = Buffer.alloc(0);
          committedOffset = position;
          recordsRead++;
        }
      }
      state.tailBytesSeen = pending.length;
      state.tailAtEof = position === fileSize && (pending.length > 0 || state.discardingOversize);
      rolloutTails.set(token, {
        fileIdentity,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        committedOffset,
        position,
        pending,
        buffered,
      });
      const needsLarger =
        pending.length > 0 &&
        position < fileSize &&
        fetchedBytes === maxBytes &&
        maxBytes > 0 &&
        maxRecords > 0 &&
        budgetMs > 0 &&
        !timeExhausted;
      readStats = {
        state,
        bytesRead: fetchedBytes,
        recordsRead,
        remainingBytes: fileSize - position,
        fileStat: { size: fileSize, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs },
        elapsedMs: performance.now() - readStarted,
        ...(needsLarger
          ? {
              continuation: {
                kind: 'record_needs_larger_slice' as const,
                minimumBytes: 1024 * 1024 + 1,
              },
            }
          : {}),
        ...(wasTruncated
          ? {
              resetReason:
                (previousIdentity !== undefined && previousIdentity !== fileIdentity) || rewritten
                  ? ('file_changed' as const)
                  : ('truncated' as const),
            }
          : {}),
      };
    } else {
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
        let complete = false;
        try {
          JSON.parse(pending.toString('utf8'));
          complete = true;
        } catch {
          /* Retry this tail from the last complete record next time. */
        }
        if (complete) {
          processLine(pending.toString('utf8'));
          committedOffset += pending.length;
        }
      }
    }
    return {
      result: {
        session,
        activity,
        tokenUsageAt,
        toolActivity,
        planProgress,
        tokenUsage,
        outputRate: rateTracker.snapshot,
        rateLimits,
        pendingApproval,
        subagents: [...subagents.values()],
        compactCount,
        lastCompactTime,
        lastToolActivityTime,
        lastAssistantMessageTime,
        lastEventTime,
        workDirs,
        transcript,
        transcriptDroppedAt,
        firstUserMessage,
        lastUserMessageAt,
        lastReplyAt,
        events,
        quotaSamples,
      },
      newOffset: committedOffset,
      runningCalls,
      wasTruncated,
      fileIdentity,
      readStats,
    };
  } finally {
    await handle.close();
  }
}

/** Each window's latest reading, to carry into the next batch. */
function lastQuotaReadings(samples: readonly QuotaSample[]): Partial<Record<'primary' | 'secondary', number>> {
  const last: Partial<Record<'primary' | 'secondary', number>> = {};
  for (const sample of samples) last[sample.window] = sample.percent;
  return last;
}

/**
 * Rollout parser with state tracking for incremental updates
 */
interface NativeRateState extends Omit<RateRecovery, 'latest'> {
  latest?: TokenRateSnapshot;
  tools: Set<string>;
}
function rateToRecovery(t: NativeRateState): RateRecovery {
  return metadataToWire({
    baseline: t.baseline,
    lastTotal: t.lastTotal,
    lastAtMs: t.lastAtMs,
    latest: t.latest,
    toolsStartedAtMs: t.toolsStartedAtMs,
    toolsLastAtMs: t.toolsLastAtMs,
    excludedMs: t.excludedMs,
  });
}
function cloneRateTracker(tracker: TokenRateTracker, index?: RecoveryIndexOverlay): TokenRateTracker {
  const native = tracker as unknown as NativeRateState;
  if (!(native.tools instanceof RecoverySet)) return tracker.clone();
  return Object.assign(new TokenRateTracker(), metadataFromWire<NativeRateState>(rateToRecovery(native) as never), {
    tools: native.tools.fork(index),
  });
}

export class RolloutParser {
  private rolloutPath: string | null = null;
  private lastOffset: number = 0;
  private cachedResult: RolloutParseResult | null = null;
  private runningCalls: Map<string, ToolCall> = new Map();
  private rateTracker = new TokenRateTracker();
  private generation = 0;
  private fileIdentity?: string;
  private needsReplay = false;
  private readStats?: RolloutReadStats;
  #transient = new RolloutTransient();
  private recoveryIndex?: RecoveryIndexOverlay;
  private recoverySubagents?: RecoveryMap<SubagentInfo>;
  private recoveryTypes?: RecoveryMap<number>;
  private recoveryMaterialMissing?: PlanMaterialMissing;

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
    this.readStats = undefined;
    this.recoveryMaterialMissing = undefined;
    this.recoveryIndex = undefined;
    this.recoveryTypes = undefined;
    this.recoverySubagents = undefined;
    this.#transient = new RolloutTransient();
    this.cachedResult = null;
    this.runningCalls = new Map();
    this.rateTracker = new TokenRateTracker();
  }

  /**
   * Parse the rollout file, reading only new content since last parse
   */
  savepoint() {
    return {
      generation: this.generation,
      rolloutPath: this.rolloutPath,
      cachedResult: this.cachedResult,
      runningCalls: this.runningCalls,
      rateTracker: this.rateTracker,
      lastOffset: this.lastOffset,
      fileIdentity: this.fileIdentity,
      needsReplay: this.needsReplay,
      readStats: this.readStats,
      recoveryIndex: this.recoveryIndex,
      recoveryTypes: this.recoveryTypes,
      recoverySubagents: this.recoverySubagents,
      recoveryMaterialMissing: this.recoveryMaterialMissing,
    };
  }

  restore(savepoint: ReturnType<RolloutParser['savepoint']>): void {
    Object.assign(this, savepoint);
    // A tail obtained in an unsuccessful step must not outlive that step.
    this.#transient = new RolloutTransient();
  }

  async parse(options?: RolloutReadOptions): Promise<RolloutParseResult | null> {
    const generation = this.generation;
    const prior = this.savepoint();
    try {
      return await timeAsync('rollout.parse', () => this.parseNow(options));
    } catch (error) {
      if (generation === this.generation) {
        this.restore(prior);
        // Legacy reads have no durable file-stat witness, so a failed read must recheck the whole file.
        if (!this.recoveryIndex) this.needsReplay = true;
        // A completed read may have refreshed the live-only tail before metadata assembly failed.
      }
      throw error;
    }
  }

  private async parseNow(options?: RolloutReadOptions): Promise<RolloutParseResult | null> {
    if (!this.rolloutPath) {
      return null;
    }

    const generation = this.generation;
    const replay = this.needsReplay;
    if (replay && options) {
      this.#transient = new RolloutTransient();
      options = { ...options, state: initialParserState() };
    }
    // A failed or superseded read may not mutate the published snapshot.
    const tracker = cloneRateTracker(this.rateTracker, options?.recoveryIndex);
    const stagedTools = (tracker as unknown as NativeRateState).tools;
    if (stagedTools instanceof RecoverySet) stagedTools.coordinate(options?.clearCoordinator);
    const calls =
      this.runningCalls instanceof RecoveryMap
        ? this.runningCalls.fork(options?.recoveryIndex)
        : replay
          ? new Map<string, ToolCall>()
          : new Map([...this.runningCalls].map(([id, call]) => [id, { ...call }]));
    // Exact historical collections also stage in the slice overlay; prior snapshots remain usable on error.
    this.recoveryTypes = this.recoveryTypes?.fork(options?.recoveryIndex);
    this.recoverySubagents = this.recoverySubagents?.fork(options?.recoveryIndex);
    const reset = () => {
      const nextIndex = options?.onReset?.();
      if (nextIndex) {
        this.recoveryIndex = nextIndex;
        if (calls instanceof RecoveryMap) calls.resetIndex(nextIndex);
        const tools = (tracker as unknown as NativeRateState).tools;
        if (tools instanceof RecoverySet) tools.map.resetIndex(nextIndex);
        this.recoveryTypes?.resetIndex(nextIndex);
        this.recoverySubagents?.resetIndex(nextIndex);
      }
    };
    if (replay) {
      reset();
      tracker.reset();
      calls.clear();
    }
    const { result, newOffset, runningCalls, wasTruncated, fileIdentity, readStats } = await parseRolloutFile(
      this.rolloutPath,
      replay ? 0 : this.lastOffset,
      this.maxRecentCalls,
      calls,
      replay ? null : (this.cachedResult?.session ?? null),
      tracker,
      this.fileIdentity,
      replay ? null : (this.cachedResult?.pendingApproval ?? null),
      replay ? {} : lastQuotaReadings(this.cachedResult?.quotaSamples ?? []),
      options
        ? {
            ...options,
            onReset: reset,
            transient: this.#transient,
            previousStat: replay ? undefined : this.readStats?.fileStat,
          }
        : undefined
    );

    if (generation !== this.generation) return this.cachedResult;
    this.needsReplay = false;
    this.readStats = readStats;
    this.rateTracker = tracker;
    this.fileIdentity = fileIdentity;
    this.lastOffset = newOffset;
    this.runningCalls = runningCalls instanceof RecoveryMap ? runningCalls.commit() : runningCalls;
    const tools = (tracker as unknown as NativeRateState).tools;
    if (tools instanceof RecoverySet) (tracker as unknown as NativeRateState).tools = tools.commit();

    if (wasTruncated || replay) {
      this.recoveryMaterialMissing = undefined;
      this.cachedResult = null;
    }

    if (result.planProgress) this.recoveryMaterialMissing = undefined;
    // Merge with cached result for session info and accumulated stats
    if (this.cachedResult) {
      // No completed record means no new event clock, including zero-byte and tail-only slices.
      if (options && result.lastEventTime === null)
        result.toolActivity.lastUpdateTime = this.cachedResult.toolActivity.lastUpdateTime;
      // Merge tool activity
      result.toolActivity.totalCalls += this.cachedResult.toolActivity.totalCalls;
      if (!this.recoveryTypes)
        for (const [type, count] of Object.entries(this.cachedResult.toolActivity.callsByType)) {
          result.toolActivity.callsByType[type] = (result.toolActivity.callsByType[type] ?? 0) + count;
        }

      // Prepend cached recent calls, then trim
      const allCalls = [...this.cachedResult.toolActivity.recentCalls, ...result.toolActivity.recentCalls];
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
      if (!this.recoverySubagents) result.subagents = mergeSubagents(this.cachedResult.subagents, result.subagents);
      result.activity ??= this.cachedResult.activity;
      if (result.activity && !result.activity.turnStartedAt && this.cachedResult.activity?.turnStartedAt) {
        result.activity = { ...result.activity, turnStartedAt: this.cachedResult.activity.turnStartedAt };
      }
      result.tokenUsageAt ??= this.cachedResult.tokenUsageAt;
      result.lastEventTime ??= this.cachedResult.lastEventTime;
      result.lastToolActivityTime ??= this.cachedResult.lastToolActivityTime;
      result.lastAssistantMessageTime ??= this.cachedResult.lastAssistantMessageTime;
      result.workDirs = mergeWorkDirs(this.cachedResult.workDirs, result.workDirs);
      // Carried like the counts above; a truncation or replay cleared the
      // cache, so the buffer starts over with the file.
      const cachedDrop = this.cachedResult.transcriptDroppedAt;
      const batchDrop = result.transcriptDroppedAt;
      const merged = appendTranscript(
        this.cachedResult.transcript,
        result.transcript,
        cachedDrop && (!batchDrop || cachedDrop > batchDrop) ? cachedDrop : batchDrop
      );
      result.transcript = merged.entries;
      result.transcriptDroppedAt = merged.droppedAt;
      result.firstUserMessage = this.cachedResult.firstUserMessage ?? result.firstUserMessage;
      result.lastUserMessageAt ??= this.cachedResult.lastUserMessageAt;
      result.lastReplyAt ??= this.cachedResult.lastReplyAt;
      result.events = appendBounded(this.cachedResult.events, result.events, SESSION_EVENT_LIMIT);
      result.quotaSamples = appendBounded(this.cachedResult.quotaSamples, result.quotaSamples, QUOTA_SAMPLE_LIMIT);
    }

    if (this.recoveryTypes && this.recoverySubagents) {
      if (wasTruncated || replay) {
        this.recoveryTypes.clear();
        this.recoverySubagents.clear();
      }
      for (const [name, count] of Object.entries(result.toolActivity.callsByType))
        this.recoveryTypes.set(name, (this.recoveryTypes.get(name) ?? 0) + count);
      for (const agent of result.subagents) {
        const previous = this.recoverySubagents.get(agent.id);
        this.recoverySubagents.set(agent.id, mergeSubagents(previous ? [previous] : [], [agent])[0]);
      }
      this.recoveryTypes = this.recoveryTypes.commit();
      this.recoverySubagents = this.recoverySubagents.commit();
      result.toolActivity.callsByType = recoveryCounts(this.recoveryTypes);
      result.subagents = recoveryArray(this.recoverySubagents);
    }
    options?.onParsed?.();
    this.cachedResult = result;
    return result;
  }

  /** Facade recovery uses keyed exact state; legacy collectors keep their live Map/Set. */
  configureRecoveryIndex(
    index: RecoveryIndexOverlay,
    runningCount = 0,
    rateToolsCount = 0,
    runningTail: string | null = null,
    subagentCount = 0,
    typeCount = 0
  ): void {
    this.recoveryIndex = index;
    this.recoverySubagents = new RecoveryMap(
      index,
      'codex.subagents',
      subagentCount,
      (agent) => JSON.stringify(metadataToWire(agent)),
      (raw) => metadataFromWire<SubagentInfo>(JSON.parse(raw))
    );
    this.recoveryTypes = new RecoveryMap(
      index,
      'codex.tool-types',
      typeCount,
      JSON.stringify,
      (raw) => JSON.parse(raw) as number
    );
    this.runningCalls = new RecoveryCalls(
      index,
      runningCount,
      encodeRecoveryToolCall,
      decodeRecoveryToolCall,
      runningTail,
      undefined,
      undefined,
      (call) => ({ ...call })
    );
    (this.rateTracker as unknown as NativeRateState).tools = new RecoverySet(
      new RecoveryMap(index, 'codex.rate-tools', rateToolsCount, JSON.stringify, (raw) => {
        if (JSON.parse(raw) !== true) throw new Error('invalid_rollout_checkpoint');
        return true;
      })
    );
  }

  commitRecoveryIndex(index: RecoveryIndexOverlay): void {
    this.recoveryIndex = index;
    if (this.runningCalls instanceof RecoveryMap) this.runningCalls.useIndex(index);
    const tools = (this.rateTracker as unknown as NativeRateState).tools;
    if (tools instanceof RecoverySet) tools.map.useIndex(index);
    this.recoveryTypes?.useIndex(index);
    this.recoverySubagents?.useIndex(index);
  }

  /** Produce recovery metadata directly: full arguments/output never enter this graph. */
  exportCheckpoint(): RolloutParserCheckpoint {
    const r = this.cachedResult;
    const t = this.rateTracker as unknown as NativeRateState;
    const plan = compactPlan(r?.planProgress ?? null);
    const cached = r
      ? {
          activity: r.activity,
          tokenUsageAt: r.tokenUsageAt,
          outputRate: r.outputRate,
          session: r.session,
          toolActivity: {
            recentCalls: r.toolActivity.recentCalls.map(compactToolCall),
            totalCalls: r.toolActivity.totalCalls,
            callsByType: this.recoveryTypes ? {} : r.toolActivity.callsByType,
            lastUpdateTime: r.toolActivity.lastUpdateTime,
          },
          planProgress: plan.plan,
          tokenUsage: r.tokenUsage,
          rateLimits: r.rateLimits,
          pendingApproval: r.pendingApproval,
          subagents: this.recoverySubagents ? [] : r.subagents,
          compactCount: r.compactCount,
          lastCompactTime: r.lastCompactTime,
          lastToolActivityTime: r.lastToolActivityTime,
          lastAssistantMessageTime: r.lastAssistantMessageTime,
          lastEventTime: r.lastEventTime,
          workDirs: r.workDirs,
          transcript: r.transcript,
          transcriptDroppedAt: r.transcriptDroppedAt,
          firstUserMessage: r.firstUserMessage,
          lastUserMessageAt: r.lastUserMessageAt,
          lastReplyAt: r.lastReplyAt,
          events: r.events,
          quotaSamples: r.quotaSamples,
        }
      : null;
    return {
      version: 3,
      offset: this.lastOffset,
      fileIdentity: this.fileIdentity,
      state: {
        cachedResult: metadataToWire(cached),
        rateTracker: rateToRecovery(t),
        runningCount: this.runningCalls.size,
        rateToolsCount: t.tools.size,
        subagentCount: this.recoverySubagents?.size ?? 0,
        typeCount: this.recoveryTypes?.size ?? 0,
        runningTail:
          this.runningCalls instanceof RecoveryCalls
            ? this.runningCalls.tail
            : ([...this.runningCalls.keys()].at(-1) ?? null),
        ...(this.readStats
          ? {
              readStats: {
                ...this.readStats,
                bytesRead: 0,
                recordsRead: 0,
                elapsedMs: 0,
                state: {
                  ...this.readStats.state,
                  pendingBytes: [],
                  openToolWaits: [],
                  usageMessageIds: [],
                },
              },
            }
          : {}),
        needsReplay: this.needsReplay,
        ...(plan.missing || this.recoveryMaterialMissing
          ? { materialMissing: plan.missing ?? this.recoveryMaterialMissing }
          : {}),
      },
    };
  }

  restoreCheckpoint(checkpoint: RolloutParserCheckpoint): void {
    if (checkpoint.version !== 3) throw new Error('unsupported_rollout_checkpoint');
    validateRolloutRecovery(checkpoint);
    if (
      !this.recoveryIndex &&
      (checkpoint.state.runningCount ||
        checkpoint.state.rateToolsCount ||
        checkpoint.state.typeCount ||
        checkpoint.state.subagentCount)
    )
      throw new Error('missing_codex_recovery_index');
    if (this.recoveryIndex)
      this.configureRecoveryIndex(
        this.recoveryIndex,
        checkpoint.state.runningCount,
        checkpoint.state.rateToolsCount,
        checkpoint.state.runningTail,
        checkpoint.state.subagentCount,
        checkpoint.state.typeCount
      );
    const saved = checkpoint.state;
    this.recoveryMaterialMissing = saved.materialMissing ? { ...saved.materialMissing } : undefined;
    this.#transient = new RolloutTransient();
    this.cachedResult = metadataFromWire<RolloutParseResult | null>(saved.cachedResult);
    if (this.cachedResult && this.recoverySubagents && this.recoveryTypes) {
      this.cachedResult.subagents = recoveryArray(this.recoverySubagents);
      this.cachedResult.toolActivity.callsByType = recoveryCounts(this.recoveryTypes);
    }
    const tools = (this.rateTracker as unknown as NativeRateState).tools;
    this.rateTracker = Object.assign(
      new TokenRateTracker(),
      metadataFromWire<NativeRateState>(saved.rateTracker as never),
      { tools }
    );
    this.readStats = saved.readStats ? structuredClone(saved.readStats) : undefined;
    this.needsReplay = saved.needsReplay;
    this.lastOffset = checkpoint.offset;
    this.fileIdentity = checkpoint.fileIdentity;
  }

  getLatestOpenCall(): ToolCall | undefined {
    const call =
      this.runningCalls instanceof RecoveryCalls ? this.runningCalls.latest() : [...this.runningCalls.values()].at(-1);
    return call ? { ...call } : undefined;
  }

  getOpenCalls(): ToolCall[] {
    return [...this.runningCalls.values()].map((call) => ({ ...call }));
  }

  getReadStats(): RolloutReadStats | undefined {
    return this.readStats;
  }

  getRateBaseline(): ReaderParserState['rateBaseline'] {
    return this.rateTracker.checkpointBaseline();
  }

  getOpenToolWaits(): ReaderParserState['openToolWaits'] {
    return [...this.runningCalls].map(([id, call]) => ({
      id,
      startedAt: call.timestamp.getTime(),
      lastActivityAt: call.timestamp.getTime(),
    }));
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

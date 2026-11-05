import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReaderBudget, ReaderResult, SessionReader } from '../../core/interfaces/harness-adapter.js';
import type {
  SessionEvidence,
  ToolResultLinkEvidence,
  LaunchMessageLinkEvidence,
  NativeReport,
} from '../../core/interfaces/session-evidence.js';
import type { SessionRef } from '../../core/types/identity.js';
import type { RecoveryIndexEntry } from '../../core/types/checkpoint.js';
import type {
  Metric,
  ObservationEvidence,
  ReaderCheckpoint,
  ReaderParserState,
  TokenUsage,
  Coverage,
} from '../../core/types/observation.js';
import { initialParserState } from '../../core/observation.js';
import { RecoveryIndexOverlay, attachRecoveryIndex } from '../../core/checkpoint.js';
import { sameSessionRef, validateSessionRef } from '../../core/identity.js';
import { LAUNCH_MESSAGE_PREFIX, parseLaunchMessage } from '../../core/launch/message.js';
import {
  ClaudeBackgroundProjection,
  claudeBackgroundEvents,
  type ClaudeBackgroundEvent,
  type ClaudeBackgroundView,
} from './background.js';
import {
  claudeTodoMetric,
  projectClaudeTodos,
  validClaudeTodoProgress,
  validConfirmedClaudeTodoProgress,
  type ClaudeTodoProgress,
  type ConfirmedClaudeTodoProgress,
} from './todos.js';

export const CLAUDE_READER_VERSION = 'claude-reader-5';
export const CLAUDE_RECOVERY_VERSION = 'claude-recovery-1';
const USAGE_IDS = 'claude.usageMessageIds';
const FACT_CLOCKS = 'claude.factClocks';
const OPEN_WAITS = 'claude.openToolWaits';
const PENDING_CALLS = 'claude.pendingHudCalls';
const PENDING_TODOS = 'claude.pendingTodoUpdates';
const TODO_PROGRESS = 'claude.todoProgress';
const TODO_RESULTS = 'claude.todoResultIds';
export const DEFAULT_READER_BUDGET: Readonly<ReaderBudget> = {
  maxBytes: 4 * 1024 * 1024,
  maxRecords: 2000,
  budgetMs: 20,
};
export const MAX_RECORD_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 100;
const CHUNK_BYTES = 32 * 1024;
const REPORT_RECOVERY_BYTES = 1024;

export interface ClaudeStatusline {
  session_id: string;
  transcript_path: string;
  agent_id?: string;
  model?: { id?: string };
  context_window?: {
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    } | null;
  };
  cost?: { total_cost_usd?: number };
}
/** Absolute monotonic deadline supplied by the shared tick scheduler; all readers share its clock. */
export interface ClaudeReaderBudget extends ReaderBudget {
  deadlineMs?: number;
}
type CachedLinkEvidence = Omit<ToolResultLinkEvidence, 'ref'> | Omit<LaunchMessageLinkEvidence, 'ref'>;
interface RawFact {
  id: string;
  eventAt: number;
  observedTime: boolean;
  value: { kind: string; [key: string]: unknown };
}
interface Snapshot {
  recoveryVersion: typeof CLAUDE_RECOVERY_VERSION;
  targetSize: number;
  tailBytesSeen: number;
  boundarySignature: { offset: number; length: number; sha256: string } | null;
  firstRecordSignature: { offset: number; length: number; sha256: string } | null;
  lastRecordHeadSignature: { offset: number; length: number; sha256: string } | null;
  lastSuccessfulReadAt: number | null;
  fileStat: { size: number; mtimeMs: number; ctimeMs: number } | null;
  tailAtEof: boolean;
  discardOffset: number | null;
  factClocks: Record<string, number>;
  factClockPages: Readonly<Record<string, number>>[];
  statuslineKey: string | null;
  statuslineAt: number | null;
  cwd: string | null;
  cwdAt: number | null;
  startedAt: number | null;
  version: string | null;
  model: string | null;
  modelAt: number | null;
  modelObservedTime: boolean;
  contextUsed: number | null;
  contextAt: number | null;
  contextObservedTime: boolean;
  usage: TokenUsage | null;
  usageAt: number | null;
  usageObservedTime: boolean;
  lastEvidenceAt: number | null;
  pendingHudCalls: Record<string, string>;
  links: CachedLinkEvidence[];
  reports: NativeReport[];
  reportsTruncated?: true;
  facts: RawFact[];
}
export interface ClaudeCheckpoint extends ReaderCheckpoint {
  claude: Snapshot;
}
export interface ClaudeSessionEvidence extends SessionEvidence {
  background?: ClaudeBackgroundView;
  inputs: ObservationEvidence[];
}
export interface ClaudeReaderResult extends ReaderResult {
  evidence: ClaudeSessionEvidence;
  checkpoint: ClaudeCheckpoint;
  inputs: ObservationEvidence[];
  /** This successful slice only; never recovered from a checkpoint or capped display history. */
  nativeSlice?: {
    identityVerified: boolean;
    agentCalls: {
      callId: string;
      ref: SessionRef;
      sourceGeneration: number;
      fileId: ReaderCheckpoint['fileId'];
      offset: number;
    }[];
  };
}
export interface ClaudeSessionReader extends SessionReader {
  read(budget?: ClaudeReaderBudget): Promise<ClaudeReaderResult>;
}
export interface ClaudeReaderOptions {
  ref: SessionRef;
  resolveFile: (deadlineMs?: number) => string | null;
  serverNames: readonly string[];
  statusline?: ClaudeStatusline;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** Exact metadata only; both uncommitted JSON handoffs and trusted preparation use this guard. */
export function validateClaudeRecoveryIndexEntry(entry: RecoveryIndexEntry): void {
  const invalid = (): never => {
    throw new Error('invalid_claude_recovery_index_entry');
  };
  if (
    !entry ||
    ![USAGE_IDS, FACT_CLOCKS, OPEN_WAITS, PENDING_CALLS, PENDING_TODOS, TODO_PROGRESS, TODO_RESULTS].includes(
      entry.namespace
    ) ||
    typeof entry.key !== 'string' ||
    entry.key.length === 0 ||
    entry.key.length > (entry.namespace === FACT_CLOCKS ? 1024 : 256) ||
    (entry.namespace === TODO_PROGRESS && entry.key !== 'current')
  )
    invalid();
  if (entry.value === null) return;
  if (typeof entry.value !== 'string') invalid();
  let value: unknown;
  try {
    value = JSON.parse(entry.value);
  } catch {
    invalid();
  }
  switch (entry.namespace) {
    case USAGE_IDS:
    case TODO_RESULTS:
      if (value !== true) invalid();
      break;
    case FACT_CLOCKS:
      if (!count(value)) invalid();
      break;
    case PENDING_CALLS:
      if (!identifier(value)) invalid();
      break;
    case OPEN_WAITS:
      if (!object(value) || Object.keys(value).length !== 2 || !count(value.startedAt) || !count(value.lastActivityAt))
        invalid();
      break;
    case PENDING_TODOS:
      if (!validClaudeTodoProgress(value)) invalid();
      break;
    case TODO_PROGRESS:
      if (entry.key !== 'current' || !validConfirmedClaudeTodoProgress(value)) invalid();
      break;
  }
}

const emptySnapshot = (): Snapshot => ({
  recoveryVersion: CLAUDE_RECOVERY_VERSION,
  targetSize: 0,
  tailBytesSeen: 0,
  boundarySignature: null,
  firstRecordSignature: null,
  lastRecordHeadSignature: null,
  lastSuccessfulReadAt: null,
  fileStat: null,
  tailAtEof: false,
  discardOffset: null,
  factClocks: {},
  factClockPages: [],
  statuslineKey: null,
  statuslineAt: null,
  cwd: null,
  cwdAt: null,
  startedAt: null,
  version: null,
  model: null,
  modelAt: null,
  modelObservedTime: false,
  contextUsed: null,
  contextAt: null,
  contextObservedTime: false,
  usage: null,
  usageAt: null,
  usageObservedTime: false,
  lastEvidenceAt: null,
  pendingHudCalls: {},
  links: [],
  reports: [],
  facts: [],
});
/** Keep saved display material byte bounded, including JSON escaping and UTF-8 expansion. */
function reportExcerpt(text: string): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= REPORT_RECOVERY_BYTES) return text;
  const limit = REPORT_RECOVERY_BYTES - Buffer.byteLength(JSON.stringify('…'));
  let bytes = 0;
  let excerpt = '';
  for (const character of text) {
    const encoded = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + encoded > limit) break;
    excerpt += character;
    bytes += encoded;
  }
  return excerpt + '…';
}

function skip(state: ReaderParserState, reason: string, gap = false): void {
  state.skipped[reason] = (state.skipped[reason] ?? 0) + 1;
  if (gap && !state.gaps.includes(reason)) state.gaps.push(reason);
}
function resultObject(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof value === 'string') {
    try {
      return resultObject(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value) && value.length === 1 && object(value[0]) && value[0].type === 'text')
    return resultObject(value[0].text, depth + 1);
  if (!object(value) || value.isError === true || value.is_error === true) return null;
  if (identifier(value.linkId) && identifier(value.runId)) return value;
  if (value.structuredContent) return resultObject(value.structuredContent, depth + 1);
  if (value.content) return resultObject(value.content, depth + 1);
  return null;
}
/** Explicit fallback only; normal config/env transport has no prompt claim. */
export function parseFallbackLaunchMessage(
  text: string,
  nativeMessageId: string,
  eventAt: number
): Omit<LaunchMessageLinkEvidence, 'ref'>[] {
  if (!Number.isFinite(eventAt)) return [];
  const anchors: Omit<LaunchMessageLinkEvidence, 'ref'>[] = [];
  for (const line of text.split('\n')) {
    const anchor = parseLaunchMessage(line);
    if (anchor) anchors.push({ kind: 'launch_message', nativeMessageId, ...anchor, eventAt });
  }
  return anchors.slice(-HISTORY_LIMIT);
}

function observe(
  row: unknown,
  state: ReaderParserState,
  snapshot: Snapshot,
  index: RecoveryIndexOverlay,
  options: ClaudeReaderOptions,
  end: number,
  boundary: Pick<ReaderCheckpoint, 'sourceGeneration' | 'fileId'>,
  nativeSlice: NonNullable<ClaudeReaderResult['nativeSlice']>
): boolean {
  if (!object(row) || typeof row.type !== 'string') {
    skip(state, 'malformed_record', true);
    return false;
  }
  const type = row.type;
  if (['api-request-blob', 'thinking', 'reasoning'].includes(type)) {
    skip(state, type);
    return false;
  }
  if (!['user', 'assistant', 'system', 'attachment', 'ai-title', 'last-prompt'].includes(type)) {
    skip(state, 'unknown_type', true);
    return false;
  }
  if (
    (row.sessionId !== undefined && row.sessionId !== options.ref.sessionId) ||
    (row.agentId !== undefined && row.agentId !== (options.ref.threadId ?? null)) ||
    (options.ref.threadId === null && row.isSidechain === true)
  ) {
    skip(state, 'identity_mismatch', true);
    return false;
  }
  const eventTime = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  const observedTime = !Number.isFinite(eventTime);
  const messageKey = `${identifier(row.uuid) ? row.uuid : `byte:${end}`}:${type === 'user' ? 'user_message' : 'assistant_message'}`;
  const storedAt = index.get(FACT_CLOCKS, messageKey);
  const firstAt = storedAt === undefined ? undefined : Number(storedAt);
  const at = observedTime ? (firstAt ?? Date.now()) : eventTime;
  const nativeId = identifier(row.uuid) ? row.uuid : `byte:${end}`;
  const fact = (kind: string, extra: Record<string, unknown> = {}) => {
    const key = `${nativeId}:${kind}${typeof extra.callId === 'string' ? `:${extra.callId}` : ''}`;
    if (index.has(FACT_CLOCKS, key)) return;
    index.set(FACT_CLOCKS, key, JSON.stringify(at));
    snapshot.facts.push({ id: key, eventAt: at, observedTime, value: { kind, ...extra } });
    if (snapshot.facts.length > HISTORY_LIMIT) snapshot.facts.shift();
    snapshot.lastEvidenceAt = at;
  };
  if (type === 'system') {
    if (row.subtype !== 'compact_boundary') {
      skip(state, 'system_private');
      return false;
    }
    if (state.compactBoundary === nativeId) return false;
    state.compactBoundary = nativeId;
    // Only live metadata is enumerated; historical dedup IDs and clocks remain lazy.
    for (const namespace of [OPEN_WAITS, PENDING_CALLS])
      for (const [key] of index.entries(namespace)) index.delete(namespace, key);
    state.openToolWaits = [];
    state.rateBaseline = null;
    snapshot.contextUsed = null;
    snapshot.contextAt = null;
    snapshot.pendingHudCalls = {};
    snapshot.facts = [];
    fact('compact_boundary');
    return true;
  }
  if (type === 'ai-title' || type === 'last-prompt') {
    skip(state, type);
    return false;
  }
  if (type === 'attachment') {
    // Only an explicit public tool result envelope is eligible; never traverse other attachment payloads.
    const a = object(row.attachment) ? row.attachment : null;
    if (!a || a.type !== 'toolUseResult' || !identifier(a.toolUseId)) {
      skip(state, 'attachment_private');
      return false;
    }
    finish(
      a.toolUseId,
      a.result ?? a.content ?? a.toolUseResult,
      a.is_error === true,
      a.is_error === undefined || typeof a.is_error === 'boolean'
    );
    return false;
  }
  if (!object(row.message) || !['string', 'object'].includes(typeof row.message.content)) {
    skip(state, 'malformed_record', true);
    return false;
  }
  const message = row.message;
  const exactNativeIdentity =
    row.sessionId === options.ref.sessionId &&
    (options.ref.threadId === null
      ? row.agentId == null && row.isSidechain !== true
      : row.agentId === options.ref.threadId);
  if (exactNativeIdentity) nativeSlice.identityVerified = true;
  if (typeof row.cwd === 'string' && path.isAbsolute(row.cwd)) {
    snapshot.cwd = row.cwd;
    snapshot.cwdAt = at;
  }
  if (snapshot.startedAt === null) snapshot.startedAt = at;
  if (identifier(row.version)) snapshot.version = row.version;
  if (type === 'assistant') {
    if (identifier(message.model) && message.model !== snapshot.model) {
      snapshot.model = message.model;
      snapshot.modelAt = at;
      snapshot.modelObservedTime = observedTime;
    }
    if (object(message.usage)) {
      const u = message.usage;
      if (!identifier(message.id) || !count(u.input_tokens) || !count(u.output_tokens))
        skip(state, 'malformed_usage', true);
      else if (!index.has(USAGE_IDS, message.id)) {
        index.set(USAGE_IDS, message.id, 'true');
        const usage = {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: count(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0,
          cacheWrite: count(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0,
        };
        snapshot.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const increased = usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
        snapshot.usage.input += usage.input;
        snapshot.usage.output += usage.output;
        snapshot.usage.cacheRead = (snapshot.usage.cacheRead ?? 0) + usage.cacheRead;
        snapshot.usage.cacheWrite = (snapshot.usage.cacheWrite ?? 0) + usage.cacheWrite;
        if (snapshot.usageAt === null || increased) {
          snapshot.usageAt = at;
          snapshot.usageObservedTime = observedTime;
        }
        snapshot.contextUsed = usage.input + usage.cacheRead + usage.cacheWrite;
        snapshot.contextAt = at;
        snapshot.contextObservedTime = observedTime;
      }
    }
  }
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  if (!Array.isArray(content)) {
    skip(state, 'malformed_record', true);
    return false;
  }
  let publicMessage = false;
  for (const block of content) {
    if (!object(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const publicText = block.text;
      publicMessage = true;
      if (type === 'user' && identifier(row.uuid)) {
        if (observedTime && block.text.split('\n').some((line) => line.startsWith(LAUNCH_MESSAGE_PREFIX)))
          skip(state, 'link_event_time_missing', true);
        else
          for (const item of parseFallbackLaunchMessage(block.text, row.uuid, eventTime)) {
            if (
              !snapshot.links.some(
                (a) =>
                  a.kind === 'launch_message' &&
                  a.nativeMessageId === item.nativeMessageId &&
                  a.linkId === item.linkId &&
                  a.claimFingerprint === item.claimFingerprint
              )
            )
              snapshot.links.push(item);
            snapshot.links = snapshot.links.slice(-HISTORY_LIMIT);
          }
      }
      // No prompt/claim content enters reports or checkpoints; title/label material belongs to B17.
      if (type === 'assistant' && !snapshot.reports.some((r) => r.text === publicText.slice(0, 4096) && r.at === at))
        snapshot.reports = [
          ...snapshot.reports,
          { kind: 'message' as const, text: block.text.slice(0, 4096), at },
        ].slice(-20);
    } else if (block.type === 'tool_use' && type === 'assistant' && identifier(block.id) && identifier(block.name)) {
      publicMessage = true;
      if (block.name === 'Agent' && exactNativeIdentity)
        nativeSlice.agentCalls.push({
          callId: block.id,
          ref: { ...options.ref },
          sourceGeneration: boundary.sourceGeneration,
          fileId: { ...boundary.fileId },
          offset: end,
        });
      // Confirmation may arrive in a later slice, or after compaction. Keep only its bounded display summary.
      if (!index.has(TODO_RESULTS, block.id)) {
        const pending = index.get(PENDING_TODOS, block.id);
        const projected = block.name === 'TodoWrite' ? projectClaudeTodos(block.input) : null;
        if (projected && (pending === undefined || pending === JSON.stringify(projected)))
          index.set(PENDING_TODOS, block.id, JSON.stringify(projected));
        else if (block.name === 'TodoWrite' || pending !== undefined) {
          index.delete(PENDING_TODOS, block.id);
          index.set(TODO_RESULTS, block.id, 'true');
          skip(state, pending === undefined ? 'malformed_todos' : 'todo_call_conflict', true);
        }
      }
      const allowed = options.serverNames.some((server) =>
        ['delegate_spawn', 'delegate_resume', 'delegate_whoami'].some(
          (tool) => block.name === `mcp__${server}__${tool}`
        )
      );
      if (allowed) index.set(PENDING_CALLS, block.id, JSON.stringify(block.name));
      index.set(OPEN_WAITS, block.id, JSON.stringify({ startedAt: at, lastActivityAt: at }));
      fact('tool_started', { callId: block.id, tool: block.name });
    } else if (block.type === 'tool_result' && identifier(block.tool_use_id)) {
      publicMessage = true;
      finish(
        block.tool_use_id,
        block.content,
        block.is_error === true,
        block.is_error === undefined || typeof block.is_error === 'boolean'
      );
    } else if (block.type === 'thinking' || block.type === 'reasoning') skip(state, String(block.type));
    else skip(state, 'nonpublic_content');
  }
  if (publicMessage)
    fact(type === 'user' ? 'user_message' : 'assistant_message', {
      ...(identifier(message.stop_reason) ? { stopReason: message.stop_reason } : {}),
    });
  return false;

  function finish(id: string, content: unknown, error: boolean, validTodoResult = true): void {
    // Assistant-authored output is not an acknowledgement of a native tool execution.
    if (type === 'user' || type === 'attachment') {
      const pending = index.get(PENDING_TODOS, id);
      if (pending !== undefined && !validTodoResult) skip(state, 'malformed_todo_result', true);
      if (pending !== undefined && validTodoResult) {
        index.delete(PENDING_TODOS, id);
        index.set(TODO_RESULTS, id, 'true');
        if (!error) {
          const confirmed: ConfirmedClaudeTodoProgress = {
            value: JSON.parse(pending) as ClaudeTodoProgress,
            at,
            observedTime,
          };
          index.set(TODO_PROGRESS, 'current', JSON.stringify(confirmed));
        }
      }
    }
    index.delete(OPEN_WAITS, id);
    const storedTool = index.get(PENDING_CALLS, id);
    const tool: string | null = storedTool === undefined ? null : JSON.parse(storedTool);
    index.delete(PENDING_CALLS, id);
    fact('tool_finished', { callId: id, isError: error });
    const result = !error && tool ? resultObject(content) : null;
    if (!result || !tool) return;
    if (observedTime) {
      skip(state, 'link_event_time_missing', true);
      return;
    }
    const item: Omit<ToolResultLinkEvidence, 'ref'> = {
      kind: 'tool_result',
      tool,
      callId: id,
      nativeMessageId: identifier(row && (row as Record<string, unknown>).uuid)
        ? ((row as Record<string, unknown>).uuid as string)
        : null,
      linkId: result.linkId as string,
      runId: result.runId as string,
      eventAt: at,
      ...(identifier(result.launchCallId) ? { launchCallId: result.launchCallId } : {}),
      ...(identifier(result.launchCorrelationId) ? { launchCorrelationId: result.launchCorrelationId } : {}),
    };
    snapshot.links = [...snapshot.links.filter((e) => e.kind !== 'tool_result' || e.callId !== id), item].slice(
      -HISTORY_LIMIT
    );
  }
}

function evidence(
  ref: SessionRef,
  checkpoint: ClaudeCheckpoint,
  index: RecoveryIndexOverlay,
  statusline: ClaudeStatusline | undefined,
  now: number
): ClaudeSessionEvidence {
  const s = checkpoint.claude;
  const todoProgress = index.get(TODO_PROGRESS, 'current');
  const p = checkpoint.parserState;
  const coverage: Coverage = {
    state:
      checkpoint.fileId.inode === 0
        ? 'catching_up'
        : !s.tailAtEof && (s.discardOffset ?? checkpoint.offset) < s.targetSize
          ? 'catching_up'
          : p.gaps.length || s.tailAtEof || p.discardingOversize
            ? 'partial'
            : 'complete',
    skipped: { ...p.skipped },
    gaps: [...p.gaps],
    remainingBytes: Math.max(0, s.targetSize - (s.discardOffset ?? checkpoint.offset)),
    loaded: checkpoint.fileId.inode !== 0,
    ...(s.tailAtEof
      ? { reason: 'incomplete_tail' }
      : p.discardingOversize
        ? { reason: 'oversize_unknown' }
        : { reason: 'append_only_assumed_bounded_signatures' }),
  };
  const metric = <T>(value: T | null, source: string, at: number | null, observedTime = false): Metric<T> =>
    value === null
      ? { value: null, quality: 'unknown', source, asOf: now }
      : { value, quality: 'reported', source: source + (observedTime ? '.observed-time' : ''), asOf: at ?? now };
  const matching =
    statusline?.session_id === ref.sessionId && (statusline.agent_id ?? null) === ref.threadId ? statusline : undefined;
  const stdinAt = s.statuslineAt ?? now;
  const window = matching?.context_window?.context_window_size;
  const stdinUsage = matching?.context_window?.current_usage;
  const stdinUsed =
    stdinUsage && count(stdinUsage.input_tokens)
      ? stdinUsage.input_tokens +
        (stdinUsage.cache_read_input_tokens ?? 0) +
        (stdinUsage.cache_creation_input_tokens ?? 0)
      : null;
  const used = stdinUsed ?? s.contextUsed;
  const context =
    used !== null && count(window) && window > 0 ? { used, window, afterCompaction: p.compactBoundary !== null } : null;
  const modelId = matching?.model?.id ?? s.model;
  const model = metric(
    modelId ? { id: modelId } : null,
    matching?.model?.id ? 'claude.statusline.observed-time' : 'claude.assistant.model',
    matching?.model?.id ? stdinAt : s.modelAt,
    s.modelObservedTime && !matching?.model?.id
  );
  const contextMetric = metric(
    context,
    stdinUsed !== null ? 'claude.statusline.context.observed-time' : 'claude.assistant.usage+statusline.window',
    stdinUsed !== null ? stdinAt : s.contextAt,
    s.contextObservedTime
  );
  const inputs: ObservationEvidence[] = s.facts.map((f) => ({
    origin: 'transcript',
    ref,
    sourceGeneration: checkpoint.sourceGeneration,
    validity: 'current',
    evidenceId: `${CLAUDE_READER_VERSION}:${checkpoint.fileId.dev}:${checkpoint.fileId.inode}:${f.id}`,
    eventAt: f.observedTime ? null : f.eventAt,
    observedAt: now,
    lastSuccessfulReadAt: s.lastSuccessfulReadAt,
    ...(f.observedTime ? { reason: 'observed-time' } : {}),
    value: { ...f.value, firstObservedAt: f.eventAt },
  }));
  const observation: ClaudeReaderResult['observation'] = {
    nodeIdentity: { kind: 'session', ref },
    // Prepared native facts only. B16 owns combined semantics, state continuity and notices.
    statusProjection: {
      activity: 'unknown',
      pendingReason: 'none',
      lastTurnOutcome: 'none',
      liveness: 'unknown',
      freshness: {
        state: 'unknown',
        sources: [
          {
            id: 'claude-transcript',
            validity: 'current',
            lastEvidenceAt: s.lastEvidenceAt,
            observedAt: now,
            lastSuccessfulReadAt: s.lastSuccessfulReadAt,
            deadlineAt: null,
          },
        ],
        requiredSourceIds: ['claude-transcript'],
        staleSince: null,
        reason: 'awaiting_b16_projection',
        clockAnomaly: false,
      },
      stateKey: 'unknown',
      stateSince: null,
      stateSinceBasis: 'unknown',
      isRunTerminal: null,
      asOfSeq: null,
      observationStamp: null,
      asOf: s.lastEvidenceAt,
      observedAt: now,
      lastEvidenceAt: s.lastEvidenceAt,
    },
    conflict: null,
    spent: {
      tokens: metric(
        s.usage ? { ...s.usage } : null,
        'claude.message.id.unique_usage.v1',
        s.usageAt,
        s.usageObservedTime
      ),
      costUsd: metric(
        matching && count(matching.cost?.total_cost_usd) ? matching.cost.total_cost_usd : null,
        matching && count(matching.cost?.total_cost_usd)
          ? 'claude.statusline.cost.observed-time'
          : 'claude.cost_unavailable',
        stdinAt
      ),
    },
    workspace: null,
    coverage,
    loaded: checkpoint.fileId.inode !== 0,
    depth: 0,
    evidenceStamp: JSON.stringify([ref, checkpoint.fileId, checkpoint.sourceGeneration, checkpoint.offset]),
    model: metric(modelId ?? null, model.source, model.asOf),
    context: metric(
      context ? { used: context.used, window: context.window, percent: (context.used / context.window) * 100 } : null,
      contextMetric.source,
      contextMetric.asOf
    ),
  };
  return {
    ref,
    observation,
    cwd: s.cwd,
    cwdSource: s.cwd === null ? 'unknown' : 'transcript',
    cwdAsOf: s.cwdAt,
    startedAt: s.startedAt,
    version: s.version,
    model,
    context: contextMetric,
    reports: s.reports.map((r) => ({ ...r })),
    ...(todoProgress === undefined
      ? {}
      : { progress: claudeTodoMetric(JSON.parse(todoProgress) as ConfirmedClaudeTodoProgress) }),
    native: [],
    linkEvidence: s.links.map((l) => ({ ...l, ref })),
    caps: {},
    inputs,
  };
}

function validCheckpoint(cp: ClaudeCheckpoint, ref: SessionRef): boolean {
  if (
    !cp ||
    cp.schemaVersion !== 1 ||
    cp.readerVersion !== CLAUDE_READER_VERSION ||
    !sameSessionRef(cp.ref, ref) ||
    !object(cp.fileId) ||
    !Number.isSafeInteger(cp.fileId.dev) ||
    !Number.isSafeInteger(cp.fileId.inode) ||
    !Number.isSafeInteger(cp.offset) ||
    cp.offset < 0 ||
    !Number.isSafeInteger(cp.sourceGeneration) ||
    cp.sourceGeneration < 1 ||
    !object(cp.parserState) ||
    !object(cp.claude)
  )
    return false;
  const p = cp.parserState;
  const s = cp.claude;
  return (
    Array.isArray(p.pendingBytes) &&
    p.pendingBytes.length === 0 &&
    p.pendingBytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) &&
    typeof p.discardingOversize === 'boolean' &&
    (!p.discardingOversize || p.pendingBytes.length === 0) &&
    Array.isArray(p.usageMessageIds) &&
    p.usageMessageIds.length === 0 &&
    Array.isArray(p.openToolWaits) &&
    p.openToolWaits.length === 0 &&
    p.openToolWaits.every((w) => object(w) && identifier(w.id) && count(w.startedAt) && count(w.lastActivityAt)) &&
    (p.compactBoundary === null || identifier(p.compactBoundary)) &&
    Array.isArray(p.gaps) &&
    p.gaps.every(identifier) &&
    object(p.skipped) &&
    Object.values(p.skipped).every(count) &&
    s.recoveryVersion === CLAUDE_RECOVERY_VERSION &&
    typeof s.tailAtEof === 'boolean' &&
    Array.isArray(s.factClockPages) &&
    s.factClockPages.length === 0 &&
    s.factClockPages.every(
      (page) => object(page) && Object.keys(page).length <= 128 && Object.values(page).every(count)
    ) &&
    object(s.factClocks) &&
    Object.keys(s.factClocks).length === 0 &&
    Object.values(s.factClocks).every(count) &&
    (s.fileStat === null ||
      (object(s.fileStat) &&
        Number.isSafeInteger(s.fileStat.size) &&
        count(s.fileStat.mtimeMs) &&
        count(s.fileStat.ctimeMs))) &&
    (s.discardOffset === null ||
      (Number.isSafeInteger(s.discardOffset) && s.discardOffset >= cp.offset && s.discardOffset <= s.targetSize)) &&
    p.discardingOversize === (s.discardOffset !== null) &&
    Number.isSafeInteger(s.targetSize) &&
    s.targetSize >= cp.offset &&
    (s.cwd === null || (typeof s.cwd === 'string' && path.isAbsolute(s.cwd))) &&
    (s.usage === null || (object(s.usage) && count(s.usage.input) && count(s.usage.output))) &&
    object(s.pendingHudCalls) &&
    Object.entries(s.pendingHudCalls).length === 0 &&
    Object.entries(s.pendingHudCalls).every(([k, v]) => identifier(k) && identifier(v)) &&
    Array.isArray(s.links) &&
    s.links.length <= HISTORY_LIMIT &&
    s.links.every((l) => {
      if (
        !object(l) ||
        !identifier(l.linkId) ||
        !count(l.eventAt) ||
        (l.launchCallId !== undefined && !identifier(l.launchCallId)) ||
        (l.launchCorrelationId !== undefined && !identifier(l.launchCorrelationId))
      )
        return false;
      if (l.kind === 'tool_result') return identifier(l.tool) && identifier(l.callId) && identifier(l.runId);
      return (
        l.kind === 'launch_message' &&
        Object.keys(l).every((k) =>
          [
            'kind',
            'nativeMessageId',
            'linkId',
            'claimFingerprint',
            'eventAt',
            'launchCallId',
            'launchCorrelationId',
          ].includes(k)
        ) &&
        identifier(l.nativeMessageId) &&
        typeof l.claimFingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(l.claimFingerprint)
      );
    }) &&
    Array.isArray(s.reports) &&
    s.reports.length <= 20 &&
    (s.reportsTruncated === undefined || s.reportsTruncated === true) &&
    s.reports.every(
      (r) =>
        object(r) &&
        typeof r.text === 'string' &&
        Buffer.byteLength(JSON.stringify(r.text)) <= REPORT_RECOVERY_BYTES &&
        count(r.at)
    ) &&
    Array.isArray(s.facts) &&
    s.facts.length <= HISTORY_LIMIT &&
    s.facts.every(
      (f) =>
        object(f) &&
        typeof f.id === 'string' &&
        count(f.eventAt) &&
        typeof f.observedTime === 'boolean' &&
        object(f.value) &&
        typeof f.value.kind === 'string'
    )
  );
}

/**
 * An explicit leased-store rebuild boundary, not a conversion of the old index.
 * The caller must publish with rebuildFromReaderVersion before resuming this checkpoint.
 */
export function createClaudeReaderRebuild(
  previous: Pick<ReaderCheckpoint, 'ref' | 'readerVersion' | 'sourceGeneration' | 'fileId'>,
  now = Date.now()
): ClaudeReaderResult {
  const started = performance.now();
  validateSessionRef(previous.ref);
  if (
    previous.ref.harness !== 'claude' ||
    previous.readerVersion !== 'claude-reader-4' ||
    !Number.isSafeInteger(previous.sourceGeneration) ||
    previous.sourceGeneration < 1 ||
    !Number.isSafeInteger(previous.sourceGeneration + 1) ||
    !Number.isSafeInteger(previous.fileId.dev) ||
    previous.fileId.dev < 0 ||
    !Number.isSafeInteger(previous.fileId.inode) ||
    previous.fileId.inode < 0 ||
    !count(now)
  )
    throw new Error('unsupported_claude_rebuild');
  const ref = { ...previous.ref };
  const checkpoint: ClaudeCheckpoint = {
    schemaVersion: 1,
    readerVersion: CLAUDE_READER_VERSION,
    ref,
    fileId: { ...previous.fileId },
    offset: 0,
    sourceGeneration: previous.sourceGeneration + 1,
    parserState: { ...initialParserState(), gaps: ['reader_version_rebuild'] },
    claude: emptySnapshot(),
  };
  const index = new RecoveryIndexOverlay(CLAUDE_RECOVERY_VERSION);
  attachRecoveryIndex(checkpoint, index);
  const prepared = evidence(ref, checkpoint, index, undefined, now);
  prepared.observation.coverage = {
    state: 'catching_up',
    skipped: {},
    gaps: ['reader_version_rebuild'],
    loaded: false,
    reason: 'reader_version_rebuild',
  };
  prepared.observation.loaded = false;
  return {
    observation: prepared.observation,
    evidence: prepared,
    inputs: prepared.inputs,
    checkpoint,
    recoveryIndex: checkpoint.recoveryIndex,
    stats: { bytesRead: 0, recordsRead: 0, elapsedMs: performance.now() - started },
  };
}

/** No I/O until read; each reader serializes its cursor and returns a detached, JSON-safe checkpoint. */
export function createClaudeReader(options: ClaudeReaderOptions, checkpoint?: ReaderCheckpoint): ClaudeSessionReader {
  const ref = structuredClone(options.ref);
  validateSessionRef(ref);
  if (ref.harness !== 'claude') throw new Error('invalid_claude_ref');
  const statuslineKey = options.statusline
    ? JSON.stringify([
        options.statusline.model ?? null,
        options.statusline.context_window ?? null,
        options.statusline.cost ?? null,
      ])
    : null;
  // Runtime lookups are intentionally nonenumerable and must survive the JSON-state clone.
  const handoff = checkpoint?.recoveryIndex;
  for (const entry of handoff?.delta.entries ?? []) validateClaudeRecoveryIndexEntry(entry);
  let index = new RecoveryIndexOverlay(CLAUDE_RECOVERY_VERSION, handoff);
  const inline = checkpoint ? (({ recoveryIndex: _index, ...value }) => value)(checkpoint) : undefined;
  let current = inline ? (structuredClone(inline) as ClaudeCheckpoint) : undefined;
  if (current) {
    let valid = false;
    try {
      valid = validCheckpoint(current, ref);
    } catch {
      /* Corrupt persisted checkpoint. */
    }
    if (!valid || !handoff) throw new Error('unsupported_claude_checkpoint');
  }
  let pendingReset: { reason: NonNullable<ReaderCheckpoint['resetReason']>; generation: number } | undefined =
    current?.resetReason &&
    (!handoff?.delta.base || handoff.delta.base.boundary.sourceGeneration !== current.sourceGeneration)
      ? { reason: current.resetReason, generation: current.sourceGeneration }
      : undefined;
  function markCompaction(cp: ClaudeCheckpoint): void {
    cp.sourceGeneration++;
    // A physical reset authorizes the fresh index lineage until publication.
    // Later compaction has its own parser boundary and must not erase that provenance.
    const reason = pendingReset?.reason ?? 'compaction';
    cp.resetReason = reason;
    pendingReset = { reason, generation: cp.sourceGeneration };
  }
  const reportExcerpts = new WeakMap<NativeReport, string>();
  let transient: { offset: number; position: number; pending: Buffer } | undefined;
  let restoredTail = !!checkpoint && (current?.claude.tailBytesSeen ?? 0) > 0;
  let queue: Promise<unknown> = Promise.resolve();
  let background = new ClaudeBackgroundProjection(!checkpoint || checkpoint.offset === 0);
  function readSlice(
    requested: ClaudeReaderBudget,
    started: number
  ): ClaudeReaderResult & { backgroundEvents: ClaudeBackgroundEvent[]; physicalReset: boolean } {
    if (current) {
      if (pendingReset?.generation === current.sourceGeneration) current.resetReason = pendingReset.reason;
      else delete current.resetReason;
    }
    const { maxBytes, maxRecords, budgetMs, deadlineMs } = requested;
    if (
      ![maxBytes, maxRecords].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isFinite(budgetMs) ||
      budgetMs < 0 ||
      (deadlineMs !== undefined && !Number.isFinite(deadlineMs))
    )
      throw new Error('invalid_reader_budget');
    const byteLimit = Math.min(maxBytes, DEFAULT_READER_BUDGET.maxBytes);
    const recordLimit = Math.min(maxRecords, DEFAULT_READER_BUDGET.maxRecords);
    const deadline = Math.min(started + Math.min(budgetMs, DEFAULT_READER_BUDGET.budgetMs), deadlineMs ?? Infinity);
    const positiveSlice = byteLimit > 0 && recordLimit > 0 && budgetMs > 0 && (deadlineMs ?? Infinity) > started;
    // Leave a small assembly allowance; JSON.parse remains nonpreemptible and overruns are measured.
    const hasTime = () => performance.now() < deadline - 1;
    let consumptionSteps = 0;
    // Open/stat/read may exhaust a soft slice. Still consume one bounded part of the available input.
    const canConsume = () => hasTime() || (positiveSlice && consumptionSteps === 0);
    const placeholder = () => ({
      schemaVersion: 1 as const,
      readerVersion: CLAUDE_READER_VERSION,
      ref,
      fileId: { dev: 0, inode: 0 },
      offset: 0,
      sourceGeneration: 1,
      parserState: initialParserState(),
      claude: emptySnapshot(),
    });
    // An exhausted shared slice must not enter cold discovery, open, stat, or transcript reads.
    const file = positiveSlice ? options.resolveFile(deadline) : null;
    const fd = file !== null ? fs.openSync(file, 'r') : null;
    let bytesRead = 0;
    let recordsRead = 0;
    let measuredStats: ClaudeReaderResult['stats'];
    const nativeSlice: NonNullable<ClaudeReaderResult['nativeSlice']> = { identityVerified: false, agentCalls: [] };
    let needsLarger = 0;
    let physicalReset = false;
    const backgroundEvents: ClaudeBackgroundEvent[] = [];
    try {
      if (fd !== null) {
        const stat = fs.fstatSync(fd);
        const previous = current?.claude.fileStat;
        let rewritten =
          previous &&
          stat.size <= previous.size &&
          (stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs);
        // Append-only is an explicit input assumption between observed resets.
        // Bounded first/last record head+tail hashes detect common growing replacements;
        // they do not certify historical immutability. No full-prefix rehash on the hot path.
        const signatures = [
          current?.claude.firstRecordSignature,
          current?.claude.lastRecordHeadSignature,
          current?.claude.boundarySignature,
        ].filter((sig): sig is NonNullable<typeof sig> => !!sig);
        const distinctSignatures = [...new Map(signatures.map((sig) => [`${sig.offset}:${sig.length}`, sig])).values()];
        const needsSignatureCheck =
          !rewritten &&
          previous &&
          distinctSignatures.length > 0 &&
          (stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs);
        const signatureBytes = needsSignatureCheck ? distinctSignatures.reduce((sum, sig) => sum + sig.length, 0) : 0;
        const knownReset =
          rewritten ||
          (current &&
            (current.fileId.dev !== stat.dev ||
              current.fileId.inode !== stat.ino ||
              stat.size < current.claude.targetSize ||
              stat.size < current.offset));
        const recoveringTail =
          !knownReset &&
          current &&
          current.claude.tailBytesSeen > 0 &&
          (restoredTail || !transient || previous?.mtimeMs !== stat.mtimeMs || previous?.ctimeMs !== stat.ctimeMs);
        if (recoveringTail && current) {
          const target = current.claude.tailAtEof ? stat.size : current.claude.targetSize;
          // LF costs one byte beyond the maximum legal record (including any CR).
          const recordBytes = Math.min(MAX_RECORD_BYTES + 1, Math.max(0, target - current.offset));
          if (byteLimit < signatureBytes + recordBytes) needsLarger = signatureBytes + recordBytes;
        }
        if (!needsLarger && needsSignatureCheck) {
          if (byteLimit < signatureBytes) needsLarger = signatureBytes;
          else
            for (const sig of distinctSignatures) {
              // At most three bounded signatures; time exhaustion is not a byte-budget continuation.
              const sample = Buffer.allocUnsafe(sig.length);
              const fetched = fs.readSync(fd, sample, 0, sig.length, sig.offset);
              bytesRead += fetched;
              if (
                fetched !== sig.length ||
                createHash('sha256').update(sample.subarray(0, fetched)).digest('hex') !== sig.sha256
              ) {
                rewritten = true;
                break;
              }
            }
        }
        const resetReason =
          current?.fileId.inode === 0 && current.parserState.gaps.includes('reader_version_rebuild')
            ? ('file_changed' as const)
            : current &&
                current.fileId.inode !== 0 &&
                (current.fileId.dev !== stat.dev || current.fileId.inode !== stat.ino)
              ? ('file_changed' as const)
              : current && (stat.size < current.claude.targetSize || stat.size < current.offset)
                ? ('truncated' as const)
                : rewritten
                  ? ('file_changed' as const)
                  : undefined;
        if (!current || current.fileId.inode === 0 || resetReason) {
          physicalReset = !!resetReason;
          const generation =
            (current && (current.fileId.inode !== 0 || current.parserState.gaps.includes('reader_version_rebuild'))
              ? current.sourceGeneration
              : 0) + 1;
          current = {
            ...placeholder(),
            fileId: { dev: stat.dev, inode: stat.ino },
            sourceGeneration: generation,
            ...(resetReason ? { resetReason } : {}),
          };
          pendingReset = resetReason ? { reason: resetReason, generation } : undefined;
          index = new RecoveryIndexOverlay(CLAUDE_RECOVERY_VERSION);
          transient = undefined;
          restoredTail = false;
        }
        const cp = current;
        const p = cp.parserState;
        const s = cp.claude;
        const observeRecord = (row: unknown, end: number) => {
          // Publish native authority only after this whole record was accepted. A failed
          // lazy-index read or malformed record cannot leak a partially observed call.
          const record: NonNullable<ClaudeReaderResult['nativeSlice']> = { identityVerified: false, agentCalls: [] };
          const compact = observe(row, p, s, index, options, end, cp, record);
          nativeSlice.identityVerified ||= record.identityVerified;
          nativeSlice.agentCalls.push(...record.agentCalls);
          backgroundEvents.push(...claudeBackgroundEvents(row, ref, Date.now()));
          return compact;
        };
        // The rebuild starts at byte zero and must re-observe native facts. Once source identity
        // is checked, normal offset/target coverage expresses the remaining bounded reread.
        if (cp.offset === 0 && s.fileStat === null) p.gaps = p.gaps.filter((gap) => gap !== 'reader_version_rebuild');
        if (!needsLarger) s.fileStat = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        if (s.statuslineKey !== statuslineKey) {
          s.statuslineKey = statuslineKey;
          s.statuslineAt = Date.now();
        }
        if (!needsLarger) {
          if ((s.discardOffset ?? cp.offset) >= s.targetSize || s.tailAtEof) s.targetSize = stat.size;
          s.tailAtEof = false;
          const liveTail =
            transient?.offset === cp.offset && previous?.mtimeMs === stat.mtimeMs && previous?.ctimeMs === stat.ctimeMs
              ? transient
              : undefined;
          let readPosition = s.discardOffset ?? liveTail?.position ?? cp.offset;
          let pending = liveTail?.pending ?? Buffer.alloc(0);
          const commitBoundary = (position: number, tail: Buffer, head?: Buffer) => {
            if (head?.length) {
              const bytes = head.subarray(0, 512);
              const signature = {
                offset: cp.offset,
                length: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              };
              s.firstRecordSignature ??= signature;
              s.lastRecordHeadSignature = signature;
            }
            cp.offset = position;
            const bytes = tail.subarray(Math.max(0, tail.length - 256));
            s.boundarySignature = {
              offset: position - bytes.length,
              length: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            };
          };
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, byteLimit));
          while (
            !needsLarger &&
            readPosition < s.targetSize &&
            bytesRead < byteLimit &&
            recordsRead < recordLimit &&
            canConsume()
          ) {
            const size = fs.readSync(
              fd,
              buffer,
              0,
              Math.min(buffer.length, byteLimit - bytesRead, s.targetSize - readPosition),
              readPosition
            );
            if (!size) break;
            bytesRead += size;
            let position = 0;
            while (position < size && recordsRead < recordLimit && canConsume()) {
              const newline = buffer.subarray(0, size).indexOf(10, position);
              const end = newline < 0 ? size : newline + 1;
              const part = buffer.subarray(position, newline < 0 ? size : newline);
              readPosition += end - position;
              consumptionSteps++;
              if (p.discardingOversize) {
                s.discardOffset = readPosition;
                if (newline >= 0) {
                  p.discardingOversize = false;
                  s.discardOffset = null;
                  commitBoundary(readPosition, Buffer.concat([part, Buffer.from([10])]));
                  recordsRead++;
                }
              } else if (pending.length + part.length > MAX_RECORD_BYTES) {
                pending = Buffer.alloc(0);
                skip(p, 'oversize_unknown', true);
                p.discardingOversize = newline < 0;
                s.discardOffset = newline < 0 ? readPosition : null;
                if (newline >= 0) {
                  commitBoundary(readPosition, Buffer.concat([part, Buffer.from([10])]));
                  recordsRead++;
                }
              } else {
                pending = pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
                if (newline >= 0) {
                  const line = pending.toString('utf8');
                  const signatureHead = Buffer.from(pending.subarray(0, 512));
                  const signatureBytes = Buffer.concat([
                    pending.subarray(Math.max(0, pending.length - 255)),
                    Buffer.from([10]),
                  ]);
                  pending = Buffer.alloc(0);
                  recordsRead++;
                  if (line.trim()) {
                    try {
                      if (observeRecord(JSON.parse(line), readPosition)) {
                        markCompaction(cp);
                      }
                    } catch (error) {
                      if (error instanceof SyntaxError) skip(p, 'malformed_record', true);
                      else throw error;
                    }
                  }
                  commitBoundary(readPosition, signatureBytes, signatureHead);
                }
              }
              position = end;
            }
            if (position < size) break;
          }
          if (!needsLarger && pending.length && readPosition === s.targetSize) {
            s.tailAtEof = true;
            if (recordsRead < recordLimit && (canConsume() || (positiveSlice && recordsRead === 0))) {
              try {
                const row: unknown = JSON.parse(pending.toString('utf8'));
                if (observeRecord(row, readPosition)) {
                  markCompaction(cp);
                }
                commitBoundary(readPosition, pending, pending);
                pending = Buffer.alloc(0);
                recordsRead++;
                s.tailAtEof = false;
              } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
              }
            }
          }
          s.tailBytesSeen = pending.length;
          transient = pending.length ? { offset: cp.offset, position: readPosition, pending } : undefined;
          restoredTail = false;
        }
        // Persist only complete-record offsets / oversized discard cursors, never private or claim tail bytes.
        // An incomplete line is reread from cp.offset on the next slice; its I/O is charged again.
        p.pendingBytes = [];
        s.lastSuccessfulReadAt = Date.now();
      }
      current ??= placeholder();
      const cp = current;
      const p = cp.parserState;
      const s = cp.claude;
      const prepared = evidence({ ...ref }, cp, index, options.statusline, Date.now());
      if (fd === null || needsLarger) {
        prepared.observation.coverage.state = needsLarger ? 'partial' : 'catching_up';
        prepared.observation.coverage.reason = needsLarger ? 'record_needs_larger_slice' : 'budget_exhausted';
      }
      // Display excerpts are independent of exact parser metadata and the live public reports.
      const savedReports = s.reports.map((report) => {
        let text = reportExcerpts.get(report);
        if (text === undefined) {
          text = reportExcerpt(report.text);
          reportExcerpts.set(report, text);
        }
        return { ...report, text };
      });
      const reportsTruncated =
        s.reportsTruncated === true || savedReports.some((report, i) => report.text !== s.reports[i].text);
      // Clone only the JSON state, not entire file buffers; returned checkpoints cannot mutate this reader.
      const saved: ClaudeCheckpoint = {
        ...cp,
        ref: { ...ref },
        fileId: { ...cp.fileId },
        parserState: {
          ...p,
          pendingBytes: [...p.pendingBytes],
          usageMessageIds: [...p.usageMessageIds],
          openToolWaits: p.openToolWaits.map((w) => ({ ...w })),
          gaps: [...p.gaps],
          skipped: { ...p.skipped },
          rateBaseline: p.rateBaseline ? { ...p.rateBaseline } : null,
        },
        claude: {
          ...s,
          // Successful read time belongs to the live projection, not durable parser identity.
          lastSuccessfulReadAt: null,
          fileStat: s.fileStat ? { ...s.fileStat } : null,
          boundarySignature: s.boundarySignature ? { ...s.boundarySignature } : null,
          firstRecordSignature: s.firstRecordSignature ? { ...s.firstRecordSignature } : null,
          lastRecordHeadSignature: s.lastRecordHeadSignature ? { ...s.lastRecordHeadSignature } : null,
          factClocks: { ...s.factClocks },
          factClockPages: [...s.factClockPages],
          usage: s.usage ? { ...s.usage } : null,
          pendingHudCalls: { ...s.pendingHudCalls },
          links: s.links.map((l) => ({ ...l })),
          reports: savedReports,
          ...(reportsTruncated ? { reportsTruncated: true as const } : {}),
          facts: s.facts.map((f) => ({ ...f, value: { ...f.value } })),
        },
      };
      return {
        observation: prepared.observation,
        evidence: prepared,
        inputs: prepared.inputs,
        nativeSlice,
        backgroundEvents,
        physicalReset,
        checkpoint: saved,
        ...(needsLarger
          ? { continuation: { kind: 'record_needs_larger_slice' as const, minimumBytes: needsLarger } }
          : {}),
        stats: (measuredStats = { bytesRead, recordsRead, elapsedMs: performance.now() - started }),
      };
    } finally {
      if (fd !== null) fs.closeSync(fd);
      if (measuredStats) measuredStats.elapsedMs = performance.now() - started;
    }
  }
  function read(requested: ClaudeReaderBudget = DEFAULT_READER_BUDGET): ClaudeReaderResult {
    const started = performance.now();
    const previous = { current, index, transient, restoredTail, pendingReset };
    // Lazy index reads can fail after earlier records changed usage or compaction state.
    // Stage the small inline state and touched keys together until I/O and assembly finish.
    current = current ? structuredClone(current) : undefined;
    index = index.fork();
    try {
      const { backgroundEvents, physicalReset, ...result } = readSlice(requested, started);
      index = index.commit();
      const { sourceGeneration, resetReason } = result.checkpoint;
      attachRecoveryIndex(result.checkpoint, index, (lookup) => {
        if (
          resetReason &&
          pendingReset?.generation === sourceGeneration &&
          pendingReset.reason === resetReason &&
          lookup.reference.boundary.sourceGeneration === sourceGeneration
        )
          pendingReset = undefined;
      });
      result.recoveryIndex = result.checkpoint.recoveryIndex;
      // No background state enters the durable reader DTO. Stage only on changed slices,
      // after successful native parsing/index handoff, so failed reads cannot leak actions.
      const nextBackground = backgroundEvents.length || physicalReset ? background.fork() : background;
      nextBackground.apply(result.checkpoint, backgroundEvents, physicalReset);
      const projection = nextBackground.view(result.observation.coverage);
      result.evidence.background = projection.background;
      if (projection.action) result.evidence.action = projection.action;
      background = nextBackground;
      if (result.stats) result.stats.elapsedMs = performance.now() - started;
      return result;
    } catch (error) {
      ({ current, index, transient, restoredTail, pendingReset } = previous);
      throw error;
    }
  }
  return {
    read: (budget) => {
      const next = queue.then(() => read(budget));
      queue = next.catch(() => {});
      return next;
    },
  };
}

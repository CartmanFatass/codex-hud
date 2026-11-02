import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReaderBudget, ReaderResult, SessionReader } from '../../core/interfaces/harness-adapter.js';
import type { SessionEvidence, LinkEvidence, NativeReport } from '../../core/interfaces/session-evidence.js';
import type { SessionRef } from '../../core/types/identity.js';
import type {
  Metric,
  ObservationEvidence,
  ReaderCheckpoint,
  ReaderParserState,
  TokenUsage,
  Coverage,
} from '../../core/types/observation.js';
import { initialParserState } from '../../core/observation.js';
import { sameSessionRef, validateSessionRef } from '../../core/identity.js';

export const CLAUDE_READER_VERSION = 'claude-reader-2';
export const DEFAULT_READER_BUDGET: Readonly<ReaderBudget> = {
  maxBytes: 4 * 1024 * 1024,
  maxRecords: 2000,
  budgetMs: 20,
};
export const MAX_RECORD_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 100;
const CHUNK_BYTES = 32 * 1024;

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
export interface LaunchMessageAnchor {
  nativeMessageId: string;
  linkId: string;
  claimFingerprint: string;
}
interface RawFact {
  id: string;
  eventAt: number;
  observedTime: boolean;
  value: { kind: string; [key: string]: unknown };
}
interface Snapshot {
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
  links: Omit<LinkEvidence, 'ref'>[];
  launchMessages: LaunchMessageAnchor[];
  reports: NativeReport[];
  facts: RawFact[];
}
export interface ClaudeCheckpoint extends ReaderCheckpoint {
  claude: Snapshot;
}
export interface ClaudeSessionEvidence extends SessionEvidence {
  // 待 ARCH 裁决: shared LinkEvidence lacks the native launch-message anchor kind (01:119).
  claude: { launchMessages: LaunchMessageAnchor[]; cwdSource: string | null };
  inputs: ObservationEvidence[];
}
export interface ClaudeReaderResult extends ReaderResult {
  evidence: ClaudeSessionEvidence;
  checkpoint: ClaudeCheckpoint;
  inputs: ObservationEvidence[];
  continuation?: { kind: 'record_needs_larger_slice'; minimumBytes: number };
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
const emptySnapshot = (): Snapshot => ({
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
  launchMessages: [],
  reports: [],
  facts: [],
});
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
/** Provisional fallback only: B4 owns the launch-message format; normal config/env transport has no prompt claim. */
export function parseFallbackLaunchMessage(text: string, nativeMessageId: string): LaunchMessageAnchor[] {
  const anchors: LaunchMessageAnchor[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('[hud-launch] ')) continue;
    try {
      const value: unknown = JSON.parse(line.slice(13));
      if (
        object(value) &&
        identifier(value.linkId) &&
        typeof value.claim === 'string' &&
        value.claim.length > 0 &&
        value.claim.length <= 4096
      ) {
        anchors.push({
          nativeMessageId,
          linkId: value.linkId,
          claimFingerprint: createHash('sha256').update(value.claim).digest('hex'),
        });
      }
    } catch {
      /* Invalid fallback envelopes cannot supply anchors. */
    }
  }
  return anchors.slice(-HISTORY_LIMIT);
}

function observe(
  row: unknown,
  state: ReaderParserState,
  snapshot: Snapshot,
  ids: Set<string>,
  clocks: Map<string, number>,
  options: ClaudeReaderOptions,
  end: number
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
  const firstAt = clocks.get(messageKey);
  const at = observedTime ? (firstAt ?? Date.now()) : eventTime;
  const nativeId = identifier(row.uuid) ? row.uuid : `byte:${end}`;
  const fact = (kind: string, extra: Record<string, unknown> = {}) => {
    const key = `${nativeId}:${kind}${typeof extra.callId === 'string' ? `:${extra.callId}` : ''}`;
    if (clocks.has(key)) return;
    clocks.set(key, at);
    Object.defineProperty(snapshot.factClocks, key, {
      value: at,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (Object.keys(snapshot.factClocks).length >= 128) {
      snapshot.factClockPages.push(Object.freeze(snapshot.factClocks));
      snapshot.factClocks = {};
    }
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
    finish(a.toolUseId, a.result ?? a.content ?? a.toolUseResult, a.is_error === true);
    return false;
  }
  if (!object(row.message) || !['string', 'object'].includes(typeof row.message.content)) {
    skip(state, 'malformed_record', true);
    return false;
  }
  const message = row.message;
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
      else if (!ids.has(message.id)) {
        ids.add(message.id);
        state.usageMessageIds.push(message.id);
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
        for (const item of parseFallbackLaunchMessage(block.text, row.uuid)) {
          if (
            !snapshot.launchMessages.some(
              (a) => a.nativeMessageId === item.nativeMessageId && a.claimFingerprint === item.claimFingerprint
            )
          )
            snapshot.launchMessages.push(item);
          snapshot.launchMessages = snapshot.launchMessages.slice(-HISTORY_LIMIT);
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
      const allowed = options.serverNames.some((server) =>
        ['delegate_spawn', 'delegate_resume', 'delegate_whoami'].some(
          (tool) => block.name === `mcp__${server}__${tool}`
        )
      );
      if (allowed) {
        Object.defineProperty(snapshot.pendingHudCalls, block.id, {
          value: block.name,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        snapshot.pendingHudCalls = Object.fromEntries(Object.entries(snapshot.pendingHudCalls).slice(-HISTORY_LIMIT));
      }
      state.openToolWaits = [
        ...state.openToolWaits.filter((w) => w.id !== block.id),
        { id: block.id, startedAt: at, lastActivityAt: at },
      ].slice(-HISTORY_LIMIT);
      fact('tool_started', { callId: block.id, tool: block.name });
    } else if (block.type === 'tool_result' && identifier(block.tool_use_id)) {
      publicMessage = true;
      finish(block.tool_use_id, block.content, block.is_error === true);
    } else if (block.type === 'thinking' || block.type === 'reasoning') skip(state, String(block.type));
    else skip(state, 'nonpublic_content');
  }
  if (publicMessage)
    fact(type === 'user' ? 'user_message' : 'assistant_message', {
      ...(identifier(message.stop_reason) ? { stopReason: message.stop_reason } : {}),
    });
  return false;

  function finish(id: string, content: unknown, error: boolean): void {
    state.openToolWaits = state.openToolWaits.filter((w) => w.id !== id);
    const tool = Object.hasOwn(snapshot.pendingHudCalls, id) ? snapshot.pendingHudCalls[id] : null;
    delete snapshot.pendingHudCalls[id];
    fact('tool_finished', { callId: id, isError: error });
    const result = !error && tool ? resultObject(content) : null;
    if (!result || !tool) return;
    if (observedTime) {
      skip(state, 'link_event_time_missing', true);
      return;
    }
    const item: Omit<LinkEvidence, 'ref'> = {
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
    snapshot.links = [...snapshot.links.filter((e) => e.callId !== id), item].slice(-HISTORY_LIMIT);
  }
}

function evidence(
  ref: SessionRef,
  checkpoint: ClaudeCheckpoint,
  statusline: ClaudeStatusline | undefined,
  now: number
): ClaudeSessionEvidence {
  const s = checkpoint.claude;
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
    // 待 ARCH 裁决: shared cwdSource lacks transcript provenance; never mislabel as session_meta.
    cwdSource: 'unknown',
    cwdAsOf: s.cwdAt,
    startedAt: s.startedAt,
    version: s.version,
    model,
    context: contextMetric,
    reports: s.reports.map((r) => ({ ...r })),
    native: [],
    linkEvidence: s.links.map((l) => ({ ...l, ref })),
    caps: {},
    claude: {
      launchMessages: s.launchMessages.map((a) => ({ ...a })),
      cwdSource: s.cwd === null ? null : 'claude.transcript.cwd',
    },
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
    p.usageMessageIds.every(identifier) &&
    Array.isArray(p.openToolWaits) &&
    p.openToolWaits.length <= HISTORY_LIMIT &&
    p.openToolWaits.every((w) => object(w) && identifier(w.id) && count(w.startedAt) && count(w.lastActivityAt)) &&
    (p.compactBoundary === null || identifier(p.compactBoundary)) &&
    Array.isArray(p.gaps) &&
    p.gaps.every(identifier) &&
    object(p.skipped) &&
    Object.values(p.skipped).every(count) &&
    typeof s.tailAtEof === 'boolean' &&
    Array.isArray(s.factClockPages) &&
    s.factClockPages.every(
      (page) => object(page) && Object.keys(page).length <= 128 && Object.values(page).every(count)
    ) &&
    object(s.factClocks) &&
    Object.keys(s.factClocks).length < 128 &&
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
    Object.entries(s.pendingHudCalls).length <= HISTORY_LIMIT &&
    Object.entries(s.pendingHudCalls).every(([k, v]) => identifier(k) && identifier(v)) &&
    Array.isArray(s.links) &&
    s.links.length <= HISTORY_LIMIT &&
    s.links.every(
      (l) =>
        object(l) &&
        l.kind === 'tool_result' &&
        identifier(l.tool) &&
        identifier(l.callId) &&
        identifier(l.linkId) &&
        identifier(l.runId) &&
        count(l.eventAt)
    ) &&
    Array.isArray(s.launchMessages) &&
    s.launchMessages.length <= HISTORY_LIMIT &&
    s.launchMessages.every(
      (a) =>
        object(a) &&
        Object.keys(a).every((k) => ['nativeMessageId', 'linkId', 'claimFingerprint'].includes(k)) &&
        identifier(a.nativeMessageId) &&
        identifier(a.linkId) &&
        typeof a.claimFingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(a.claimFingerprint)
    ) &&
    Array.isArray(s.reports) &&
    s.reports.length <= 20 &&
    s.reports.every((r) => object(r) && typeof r.text === 'string' && r.text.length <= 4096 && count(r.at)) &&
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
  let current = checkpoint ? (structuredClone(checkpoint) as ClaudeCheckpoint) : undefined;
  if (current) {
    let valid = false;
    try {
      valid = validCheckpoint(current, ref);
    } catch {
      /* Corrupt persisted checkpoint. */
    }
    if (!valid) throw new Error('unsupported_claude_checkpoint');
  }
  let ids = new Set(current?.parserState.usageMessageIds ?? []);
  const clocks = new Map<string, number>();
  for (const page of current?.claude.factClockPages ?? []) {
    Object.freeze(page);
    for (const [key, at] of Object.entries(page)) clocks.set(key, at);
  }
  for (const [key, at] of Object.entries(current?.claude.factClocks ?? {})) clocks.set(key, at);
  let transient: { offset: number; position: number; pending: Buffer } | undefined;
  let restoredTail = !!checkpoint && (current?.claude.tailBytesSeen ?? 0) > 0;
  let queue: Promise<unknown> = Promise.resolve();
  function read(requested: ClaudeReaderBudget = DEFAULT_READER_BUDGET): ClaudeReaderResult {
    const started = performance.now();
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
    // Leave a small assembly allowance; JSON.parse remains nonpreemptible and overruns are measured.
    const hasTime = () => performance.now() < deadline - 1;
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
    const file = byteLimit > 0 && recordLimit > 0 && hasTime() ? options.resolveFile(deadline - 1) : null;
    const fd = file !== null && hasTime() ? fs.openSync(file, 'r') : null;
    let bytesRead = 0;
    let recordsRead = 0;
    let measuredStats: ClaudeReaderResult['stats'];
    let needsLarger = 0;
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
        if (
          !rewritten &&
          previous &&
          distinctSignatures.length &&
          (stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs)
        ) {
          const requiredBytes = distinctSignatures.reduce((sum, sig) => sum + sig.length, 0);
          if (byteLimit < requiredBytes) needsLarger = requiredBytes;
          else
            for (const sig of distinctSignatures) {
              if (!hasTime()) {
                needsLarger = requiredBytes;
                break;
              }
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
          current &&
          current.fileId.inode !== 0 &&
          (current.fileId.dev !== stat.dev || current.fileId.inode !== stat.ino)
            ? ('file_changed' as const)
            : current && (stat.size < current.claude.targetSize || stat.size < current.offset)
              ? ('truncated' as const)
              : rewritten
                ? ('file_changed' as const)
                : undefined;
        if (!current || current.fileId.inode === 0 || resetReason) {
          const generation = (current?.fileId.inode ? current.sourceGeneration : 0) + 1;
          current = {
            ...placeholder(),
            fileId: { dev: stat.dev, inode: stat.ino },
            sourceGeneration: generation,
            ...(resetReason ? { resetReason } : {}),
          };
          ids = new Set();
          clocks.clear();
          transient = undefined;
          restoredTail = false;
        } else delete current.resetReason;
        const cp = current;
        const p = cp.parserState;
        const s = cp.claude;
        if (!needsLarger) s.fileStat = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        if (s.statuslineKey !== statuslineKey) {
          s.statuslineKey = statuslineKey;
          s.statuslineAt = Date.now();
        }
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
          hasTime()
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
          while (position < size && recordsRead < recordLimit && hasTime()) {
            const newline = buffer.subarray(0, size).indexOf(10, position);
            const end = newline < 0 ? size : newline + 1;
            const part = buffer.subarray(position, newline < 0 ? size : newline);
            readPosition += end - position;
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
                    if (observe(JSON.parse(line), p, s, ids, clocks, options, readPosition)) {
                      cp.sourceGeneration++;
                      cp.resetReason = 'compaction';
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
          if (recordsRead < recordLimit && hasTime()) {
            try {
              const row: unknown = JSON.parse(pending.toString('utf8'));
              if (observe(row, p, s, ids, clocks, options, readPosition)) {
                cp.sourceGeneration++;
                cp.resetReason = 'compaction';
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
        if (restoredTail && pending.length && readPosition < s.targetSize && bytesRead >= byteLimit)
          needsLarger = MAX_RECORD_BYTES + 1;
        restoredTail = false;
        // 待 ARCH 裁决: Claude deliberately diverges from A4's raw pendingBytes helper.
        // Persist only complete-record offsets / oversized discard cursors, never private or claim tail bytes.
        // An incomplete line is reread from cp.offset on the next slice; its I/O is charged again.
        p.pendingBytes = [];
        s.lastSuccessfulReadAt = Date.now();
      }
      current ??= placeholder();
      const cp = current;
      const p = cp.parserState;
      const s = cp.claude;
      const prepared = evidence({ ...ref }, cp, options.statusline, Date.now());
      if (fd === null || needsLarger) {
        prepared.observation.coverage.state = needsLarger ? 'partial' : 'catching_up';
        prepared.observation.coverage.reason = needsLarger ? 'record_needs_larger_slice' : 'budget_exhausted';
      }
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
          fileStat: s.fileStat ? { ...s.fileStat } : null,
          boundarySignature: s.boundarySignature ? { ...s.boundarySignature } : null,
          firstRecordSignature: s.firstRecordSignature ? { ...s.firstRecordSignature } : null,
          lastRecordHeadSignature: s.lastRecordHeadSignature ? { ...s.lastRecordHeadSignature } : null,
          factClocks: { ...s.factClocks },
          factClockPages: [...s.factClockPages],
          usage: s.usage ? { ...s.usage } : null,
          pendingHudCalls: { ...s.pendingHudCalls },
          links: s.links.map((l) => ({ ...l })),
          launchMessages: s.launchMessages.map((a) => ({ ...a })),
          reports: s.reports.map((r) => ({ ...r })),
          facts: s.facts.map((f) => ({ ...f, value: { ...f.value } })),
        },
      };
      return {
        observation: prepared.observation,
        evidence: prepared,
        inputs: prepared.inputs,
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
  return {
    read: (budget) => {
      const next = queue.then(() => read(budget));
      queue = next.catch(() => {});
      return next;
    },
  };
}

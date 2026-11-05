import type { RecoveryIndexOverlay } from '../../core/checkpoint.js';
import type { SessionRef } from '../../core/types/identity.js';
import type { ReaderParserState, TokenUsage } from '../../core/types/observation.js';

export const PI_RECOVERY_VERSION = 'pi-recovery-1';
export const PI_STATE = 'pi.state';
export const PI_USAGE = 'pi.usage';
export const PI_RECORD = 'pi.record';
export interface Timed<T> {
  value: T;
  at: number;
  observedTime: boolean;
}
export interface PiFact {
  id: string;
  at: number;
  observedTime: boolean;
  kind: 'user_message' | 'assistant_message' | 'ask_orchestrator' | 'compact_boundary';
  stopReason?: string;
}
/** Bounded public metadata only. No prompts, tool arguments, images, thinking or custom data. */
export interface PiSnapshot {
  version: 1;
  ref: SessionRef;
  headerSeen: boolean;
  cwd: Timed<string> | null;
  startedAt: number | null;
  sessionVersion: string | null;
  model: Timed<{ id: string; provider?: string }> | null;
  effort: Timed<string> | null;
  context: Timed<number> | null;
  usage: Timed<TokenUsage> | null;
  cost: Timed<number> | null;
  missingCost: boolean;
  cacheWarm: Timed<TokenUsage> | null;
  facts: PiFact[];
  targetSize: number;
  fileStat: { size: number; mtimeMs: number; ctimeMs: number } | null;
  firstSignature: Signature | null;
  boundarySignature: Signature | null;
}
export interface Signature {
  offset: number;
  length: number;
  sha256: string;
}
export function emptyPiSnapshot(ref: SessionRef): PiSnapshot {
  return {
    version: 1,
    ref: { ...ref },
    headerSeen: false,
    cwd: null,
    startedAt: null,
    sessionVersion: null,
    model: null,
    effort: null,
    context: null,
    usage: null,
    cost: null,
    missingCost: false,
    cacheWarm: null,
    facts: [],
    targetSize: 0,
    fileStat: null,
    firstSignature: null,
    boundarySignature: null,
  };
}
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
export const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export function skip(state: ReaderParserState, reason: string, gap = false): void {
  state.skipped[reason] = (state.skipped[reason] ?? 0) + 1;
  if (gap && !state.gaps.includes(reason)) state.gaps.push(reason);
}
function usage(value: unknown): TokenUsage | null {
  if (!object(value) || !count(value.input) || !count(value.output)) return null;
  if (
    (value.cacheRead !== undefined && !count(value.cacheRead)) ||
    (value.cacheWrite !== undefined && !count(value.cacheWrite))
  )
    return null;
  const result = {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead ?? 0,
    cacheWrite: value.cacheWrite ?? 0,
  } as TokenUsage;
  return Object.values(result).every(count) &&
    Number.isFinite(result.input + result.output + (result.cacheRead ?? 0) + (result.cacheWrite ?? 0))
    ? result
    : null;
}
function add(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  return {
    input: (a?.input ?? 0) + b.input,
    output: (a?.output ?? 0) + b.output,
    cacheRead: (a?.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  };
}
/** Returns true only for a new compaction boundary. Branch navigation remains unverified. */
export function observePi(
  row: unknown,
  snapshot: PiSnapshot,
  state: ReaderParserState,
  index: RecoveryIndexOverlay,
  end: number,
  now: number
): boolean {
  if (!object(row) || typeof row.type !== 'string') {
    skip(state, 'malformed_record', true);
    return false;
  }
  const timestamp =
    typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : count(row.timestamp) ? row.timestamp : NaN;
  const observedTime = !Number.isFinite(timestamp);
  const at = observedTime ? now : timestamp;
  const timed = <T>(value: T): Timed<T> => ({ value, at, observedTime });
  const nativeId = identifier(row.id) ? row.id : `byte:${end}`;
  const fact = (kind: PiFact['kind'], stopReason?: string) => {
    snapshot.facts.push({ id: nativeId + ':' + kind, at, observedTime, kind, ...(stopReason ? { stopReason } : {}) });
    snapshot.facts = snapshot.facts.slice(-64);
  };
  if (row.type === 'session') {
    if (row.id !== snapshot.ref.sessionId || snapshot.headerSeen) throw new Error('pi_session_mismatch');
    snapshot.headerSeen = true;
    if (typeof row.cwd === 'string' && row.cwd.startsWith('/') && row.cwd.length <= 4096) snapshot.cwd = timed(row.cwd);
    snapshot.startedAt = at;
    if (typeof row.version === 'number' || identifier(row.version)) snapshot.sessionVersion = String(row.version);
    return false;
  }
  if (!snapshot.headerSeen) throw new Error('pi_session_header_required');
  if (identifier(row.id)) {
    if (index.has(PI_RECORD, row.id)) return false;
    index.set(PI_RECORD, row.id, 'true');
  }
  if (row.type === 'model_change') {
    if (identifier(row.modelId))
      snapshot.model = timed({ id: row.modelId, ...(identifier(row.provider) ? { provider: row.provider } : {}) });
    else skip(state, 'malformed_model', true);
  } else if (row.type === 'thinking_level_change') {
    if (identifier(row.thinkingLevel)) snapshot.effort = timed(row.thinkingLevel);
  } else if (row.type === 'compaction') {
    if (state.compactBoundary === nativeId) return false;
    state.compactBoundary = nativeId;
    snapshot.context = null;
    snapshot.facts = [];
    fact('compact_boundary');
    // Compaction's own usage is deliberately not interaction spend.
    return true;
  } else if (row.type === 'usage') {
    // Cache warming is separately reported and never contaminates interaction/context totals.
    if (row.kind === 'cache_warm') {
      const u = usage(row.usage);
      if (u) snapshot.cacheWarm = timed(u);
      else skip(state, 'malformed_cache_warm', true);
    } else skip(state, 'noninteractive_usage');
  } else if (row.type === 'custom') {
    if (row.customType === 'ask_orchestrator') fact('ask_orchestrator');
    else skip(state, 'custom_private');
  } else if (row.type === 'message' && object(row.message)) {
    const m = row.message;
    if (m.role !== 'assistant' && m.role !== 'user' && m.role !== 'toolResult') {
      skip(state, 'nonpublic_message');
      return false;
    }
    if (m.role === 'assistant' && object(m.usage)) {
      const u = usage(m.usage);
      // pi identifies native entries with row.id. Message.id, when supplied, is the request identity.
      const key = identifier(m.id) ? m.id : identifier(row.id) ? row.id : null;
      if (!u || !key) skip(state, 'malformed_usage', true);
      else if (!index.has(PI_USAGE, key)) {
        const total = add(snapshot.usage?.value, u);
        const cost = object(m.usage.cost) && count(m.usage.cost.total) ? m.usage.cost.total : null;
        if (
          !Object.values(total).every(count) ||
          (cost !== null && !Number.isFinite((snapshot.cost?.value ?? 0) + cost))
        ) {
          skip(state, 'usage_overflow', true);
          return false;
        }
        index.set(PI_USAGE, key, 'true');
        const increased = Object.values(u).some((v) => v > 0);
        if (!snapshot.usage || increased) snapshot.usage = timed(total);
        snapshot.context = timed(u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
        if (cost === null) snapshot.missingCost = true;
        else if (!snapshot.cost || cost > 0) snapshot.cost = timed((snapshot.cost?.value ?? 0) + cost);
      }
      if (
        identifier(m.model) &&
        (snapshot.model?.value.id !== m.model || snapshot.model?.value.provider !== m.provider)
      )
        snapshot.model = timed({ id: m.model, ...(identifier(m.provider) ? { provider: m.provider } : {}) });
    }
    // Only semantic markers are retained. Even public message text is outside this first reader slice.
    if (Array.isArray(m.content))
      for (const block of m.content) {
        if (object(block) && ['thinking', 'reasoning', 'image'].includes(String(block.type)))
          skip(state, String(block.type));
      }
    if (m.role === 'user') fact('user_message');
    if (m.role === 'assistant')
      fact(
        'assistant_message',
        ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(m.stopReason))
          ? String(m.stopReason)
          : undefined
      );
  } else if (['thinking', 'reasoning', 'image'].includes(row.type)) skip(state, row.type);
  else if (row.type === 'branch_summary' || row.type === 'leaf') skip(state, 'branch_navigation_unverified', true);
  else skip(state, 'unknown_type', true);
  return false;
}

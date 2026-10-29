import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

export type Counts = [number | null, number | null, number | null, number | null, number | null];
export interface UsageObservation {
  at: number;
  model: string | null;
  effort: string | null;
  total: Counts | null;
  last: Counts | null;
  /** Inherited/uncertain counters can establish a baseline, never a charge. */
  attributable: boolean;
}
interface ParserState {
  owner: string | null;
  parent: string | null;
  rootHint: string | null;
  role: string | null;
  ownerAt: number | null;
  model: string | null;
  effort: string | null;
  foreign: boolean;
  ownerTurn: string | null;
}
interface ParserCursor extends ParserState {
  offset: number;
  observations: number;
  malformed: number;
  ambiguous: number;
}
export interface UsageFile {
  owner: string | null;
  parent: string | null;
  rootHint: string | null;
  role: string | null;
  observations: UsageObservation[];
  malformed: number;
  ambiguous: number;
  bytes: number;
  digest: string;
  /** Last complete JSONL line; an incomplete tail is reread, never persisted. */
  cursor: ParserCursor;
}

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const textValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function counts(value: unknown): Counts | null {
  const v = object(value);
  const result: Counts = [count(v.input_tokens), count(v.cached_input_tokens), count(v.output_tokens),
    count(v.reasoning_output_tokens), count(v.total_tokens)];
  // Both cached and reasoning counts are subsets, not additional consumption.
  if (result[0] !== null && result[1] !== null && result[1] > result[0]) result[1] = null;
  if (result[2] !== null && result[3] !== null && result[3] > result[2]) result[3] = null;
  if (result[4] === null && result[0] !== null && result[2] !== null) {
    const total = result[0] + result[2];
    if (Number.isSafeInteger(total)) result[4] = total;
  }
  return result.some(n => n !== null) ? result : null;
}

/** Only allowlisted numeric evidence is retained; prompts/tool output never enter the index. */
export async function parseUsageFile(file: string, closed: () => boolean,
  resume?: { parsed: UsageFile; digest: string }): Promise<UsageFile> {
  const initial: ParserState = { owner: null, parent: null, rootHint: null, role: null,
    ownerAt: null, model: null, effort: null, foreign: false, ownerTurn: null };
  const checkpoint = resume?.parsed.cursor;
  const state: ParserState = checkpoint ? { ...checkpoint } : initial;
  const result: UsageFile = { owner: null, parent: null, rootHint: null, role: null,
    observations: resume ? resume.parsed.observations.slice(0, checkpoint!.observations) : [],
    malformed: checkpoint?.malformed ?? 0, ambiguous: checkpoint?.ambiguous ?? 0,
    bytes: 0, digest: '', cursor: { ...initial, offset: 0, observations: 0, malformed: 0, ambiguous: 0 } };
  let lines = 0;
  const consume = (line: string): void => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { result.malformed++; return; }
    const record = object(value);
    const payload = object(record.payload);
    const parsedAt = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
    const at = Number.isFinite(parsedAt) ? parsedAt : null;
    if (record.type === 'session_meta') {
      const id = textValue(payload.id) ?? textValue(payload.session_id);
      if (!state.owner && id) {
        state.owner = id;
        const spawn = object(object(object(payload.source).subagent).thread_spawn);
        state.parent = textValue(payload.parent_thread_id) ?? textValue(spawn.parent_thread_id);
        // session_id is a root hint only for a positively identified subagent.
        const subagent = Object.keys(object(object(payload.source).subagent)).length > 0
          || payload.thread_source === 'subagent' || state.parent !== null;
        state.rootHint = subagent ? textValue(payload.session_id) : null;
        if (state.rootHint === id) state.rootHint = null;
        state.role = textValue(payload.agent_role) ?? textValue(spawn.agent_role);
        const started = Date.parse(typeof payload.timestamp === 'string' ? payload.timestamp : '');
        state.ownerAt = Number.isFinite(started) ? started : at;
        state.model = textValue(payload.model) ?? textValue(spawn.model);
        state.effort = textValue(payload.effort) ?? textValue(spawn.effort);
      } else if (id && id !== state.owner) {
        state.foreign = true;
        state.model = null;
        state.effort = null;
      } else if (id === state.owner) state.foreign = false;
      return;
    }
    const explicitThread = textValue(payload.thread_id);
    if (record.type === 'event_msg' && payload.type === 'task_started' && !state.foreign
      && (!explicitThread || explicitThread === state.owner)) {
      state.ownerTurn = textValue(payload.turn_id);
    }
    if (record.type === 'turn_context') {
      // A copied parent's context can select neither the child's model nor effort.
      // An owner-tagged context, or the owner's already observed turn ID, is a
      // boundary. A merely later timestamp is not proof of ownership.
      if (explicitThread && explicitThread !== state.owner) {
        state.foreign = true;
        state.model = null;
        state.effort = null;
      } else if (state.foreign && (explicitThread === state.owner ||
          (state.ownerTurn !== null && textValue(payload.turn_id) === state.ownerTurn))) state.foreign = false;
      if (!state.foreign) {
        state.model = textValue(payload.model);
        state.effort = textValue(payload.effort) ?? textValue(object(payload.reasoning).effort);
      }
      return;
    }
    if (record.type !== 'event_msg' || payload.type !== 'token_count') return;
    const info = object(payload.info);
    const total = counts(info.total_token_usage);
    const last = counts(info.last_token_usage);
    // Quota-only events are not token consumption.
    if (!total && !last) {
      if (payload.info !== null && payload.info !== undefined) result.ambiguous++;
      return;
    }
    if (at === null || !state.owner) { result.ambiguous++; return; }
    if (explicitThread === state.owner) state.foreign = false;
    const inherited = (state.ownerAt !== null && at < state.ownerAt)
      || (explicitThread !== null && explicitThread !== state.owner);
    const ambiguous = !inherited && state.foreign && explicitThread !== state.owner;
    if (ambiguous) result.ambiguous++;
    // Keep cumulative baselines across inherited history so the first owned
    // cumulative delta does not charge earlier work to the child.
    const attributable = !inherited && !ambiguous;
    if (!attributable && !total) return;
    result.observations.push({ at, model: attributable ? state.model : null,
      effort: attributable ? state.effort : null, total, last: attributable ? last : null, attributable });
  };
  // Bound a single line as well as each stream chunk. Oversize prompt lines do
  // not allocate an unbounded JSON string or delay input for a whole file.
  const offset = checkpoint?.offset ?? 0;
  const stream = createReadStream(file, { highWaterMark: 64 * 1024, start: offset });
  const digest = createHash('sha256');
  let bytesRead = offset;
  let completeOffset = offset;
  let pending = Buffer.alloc(0);
  let skipping = false;
  try {
    for await (const chunk of stream) {
      if (closed()) throw new Error('closed');
      const bytes = chunk as Buffer;
      if (!resume) digest.update(bytes);
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        const part = bytes.subarray(start, i);
        if (!skipping && pending.length + part.length <= 2 * 1024 * 1024) {
          consume(Buffer.concat([pending, part]).toString('utf8'));
        } else result.malformed++;
        pending = Buffer.alloc(0);
        skipping = false;
        start = i + 1;
        completeOffset = bytesRead + i + 1;
        if (++lines % 128 === 0) await yieldImmediate();
      }
      const tail = bytes.subarray(start);
      if (!skipping && pending.length + tail.length > 2 * 1024 * 1024) {
        pending = Buffer.alloc(0);
        skipping = true;
      } else if (!skipping && tail.length) pending = Buffer.concat([pending, tail]);
      bytesRead += bytes.length;
      await yieldImmediate();
    }
    result.cursor = { ...state, offset: completeOffset, observations: result.observations.length,
      malformed: result.malformed, ambiguous: result.ambiguous };
    if (skipping) result.malformed++;
    else if (pending.length) consume(pending.toString('utf8'));
  } finally { stream.destroy(); }
  result.owner = state.owner;
  result.parent = state.parent;
  result.rootHint = state.rootHint;
  result.role = state.role;
  result.bytes = bytesRead;
  result.digest = resume?.digest ?? digest.digest('hex');
  if (!state.owner) result.ambiguous++;
  return result;
}

/** Private caches are still untrusted inputs after a crash or user edit. */
export function validUsageFile(value: unknown): value is UsageFile {
  const v = object(value);
  const only = (record: Record<string, unknown>, keys: string[]): boolean =>
    Object.keys(record).every(key => keys.includes(key));
  const nullableText = (n: unknown): boolean => n === null || (typeof n === 'string' && n.length > 0);
  const validCounts = (n: unknown): boolean => n === null || (Array.isArray(n) && n.length === 5
    && n.every(c => c === null || count(c) !== null));
  const c = object(v.cursor);
  return only(v, ['owner', 'parent', 'rootHint', 'role', 'observations', 'malformed', 'ambiguous', 'bytes', 'digest', 'cursor'])
    && only(c, ['owner', 'parent', 'rootHint', 'role', 'ownerAt', 'model', 'effort', 'foreign', 'ownerTurn',
      'offset', 'observations', 'malformed', 'ambiguous'])
    && nullableText(v.owner) && nullableText(v.parent) && nullableText(v.rootHint) && nullableText(v.role)
    && count(v.malformed) !== null && count(v.ambiguous) !== null && Array.isArray(v.observations)
    && count(v.bytes) !== null && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest)
    && count(c.offset) !== null && (c.offset as number) <= (v.bytes as number)
    && count(c.observations) !== null && (c.observations as number) <= v.observations.length
    && count(c.malformed) !== null && count(c.ambiguous) !== null
    && nullableText(c.owner) && nullableText(c.parent) && nullableText(c.rootHint) && nullableText(c.role)
    && nullableText(c.model) && nullableText(c.effort) && nullableText(c.ownerTurn)
    && typeof c.foreign === 'boolean' && (c.ownerAt === null || (typeof c.ownerAt === 'number' && Number.isFinite(c.ownerAt)))
    && v.observations.every((entry: unknown) => {
      const e = object(entry);
      return only(e, ['at', 'model', 'effort', 'total', 'last', 'attributable'])
        && typeof e.at === 'number' && Number.isFinite(e.at) && nullableText(e.model) && nullableText(e.effort)
        && typeof e.attributable === 'boolean' && validCounts(e.total) && validCounts(e.last) && (e.total !== null || e.last !== null);
    });
}

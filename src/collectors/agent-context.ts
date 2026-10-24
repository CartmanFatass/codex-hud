/**
 * How full a subagent's own context window is.
 *
 * The number lives in the agent's rollout, in the `token_count` events Codex
 * writes after each model call. Only the newest one matters, and a rollout is
 * append-only, so this reads the tail rather than the file: an agent that has
 * been running for an hour can have a rollout of tens of megabytes, and
 * parsing all of it once a second to learn one percentage is not a trade worth
 * making for a number in the corner of a panel.
 *
 * The window read is bounded and grows at most once. A rollout whose last
 * token report is further back than that reports nothing, which renders as an
 * absent field — the same answer as an agent that has not reported yet.
 *
 * The same reports give the agent's output rate, as the main session's is
 * taken: a turn-level wallclock proxy that includes TTFT/stalls and excludes
 * identifiable tool waits, with no rolling window. After the first read only
 * what was appended is read, so every live agent can be followed for the panel's total.
 */

import * as fs from 'node:fs';
import { buildContextUsage } from './context-usage.js';
import { fileSignature } from '../utils/file-signature.js';
import { TokenRateTracker, observeTokenRateRecord, type TokenRateSnapshot } from './token-rate.js';
import type { ContextUsage, EventMsgPayload, RolloutLine, TokenUsage, TokenUsageInfo } from '../types.js';

/** First tail window. Comfortably more than a turn's worth of events. */
export const TAIL_BYTES = 256 * 1024;
/** The one retry, for a rollout that went quiet after a long tool run. */
export const TAIL_BYTES_GROWN = 4 * TAIL_BYTES;

/** What an agent's rollout says of its tokens: its context fill and its output rate, each absent when it has not said. */
export interface AgentTokens {
  usage?: ContextUsage;
  rate?: TokenRateSnapshot;
}

interface CacheEntry {
  signature: string;
  ino: number;
  /** Bytes read so far, and the unfinished line at their end. */
  offset: number;
  rest: string;
  lastUsage?: TokenUsage;
  window?: number;
  tracker: TokenRateTracker;
  reading: AgentTokens;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: the cache is keyed by path, and tests reuse temp paths. */
export function resetAgentContextCache(): void {
  cache.clear();
}

async function readRange(handle: fs.promises.FileHandle, start: number, end: number): Promise<string> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

function readTail(handle: fs.promises.FileHandle, size: number, bytes: number): Promise<string> {
  const start = Math.max(0, size - bytes);
  // A window that did not start at byte 0 almost certainly cut a record in
  // half; drop the fragment rather than trying to parse it.
  return readRange(handle, start, size).then((text) => (start > 0 ? text.slice(text.indexOf('\n') + 1) : text));
}

/**
 * Take in the whole lines of `text`, keeping an unfinished last one for the
 * next read. The usage and the window are tracked separately: Codex repeats
 * the window on every report, but a partial report can carry one without the
 * other, and the last one of each is what the display needs.
 */
function scan(entry: CacheEntry, text: string): void {
  const lines = (entry.rest + text).split('\n');
  entry.rest = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.includes('"token_count"') && !line.includes('"task_started"') && !line.includes('"turn_started"') &&
        !line.includes('"function_call') && !line.includes('"custom_tool_call')) {
      continue;
    }
    let row: RolloutLine;
    try {
      row = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    observeTokenRateRecord(entry.tracker, row);
    if (row.type !== 'event_msg') {
      continue;
    }
    const payload = row.payload as EventMsgPayload;
    if (payload.type !== 'token_count' || !payload.info) {
      continue;
    }
    const info: TokenUsageInfo = payload.info;
    if (info.last_token_usage) {
      entry.lastUsage = info.last_token_usage;
    }
    if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
      entry.window = info.model_context_window;
    }
  }
}

const fresh = (signature: string, ino: number): CacheEntry => ({ signature, ino, offset: 0, rest: '', tracker: new TokenRateTracker(), reading: {} });

/**
 * One agent's context fill and output rate, from its rollout. Cached by the
 * file's stat signature, so a still rollout costs one stat rather than one
 * read; a grown one costs what was appended.
 */
export async function readAgentTokens(rolloutPath: string): Promise<AgentTokens> {
  const signature = fileSignature(rolloutPath);
  const cached = cache.get(rolloutPath);
  if (signature !== null && cached && cached.signature === signature) {
    return cached.reading;
  }

  let entry: CacheEntry | undefined;
  try {
    const handle = await fs.promises.open(rolloutPath, 'r');
    try {
      const { size, ino } = await handle.stat();
      const stamp = signature ?? '';
      if (cached && cached.ino === ino && size >= cached.offset) {
        // Append-only: what is new since the last read.
        entry = { ...cached, tracker: cached.tracker.clone(), signature: stamp };
        scan(entry, await readRange(handle, cached.offset, size));
      } else {
        entry = fresh(stamp, ino);
        scan(entry, await readTail(handle, size, TAIL_BYTES));
        if (!entry.lastUsage && size > TAIL_BYTES) {
          entry = fresh(stamp, ino);
          scan(entry, await readTail(handle, size, TAIL_BYTES_GROWN));
        }
      }
      entry.offset = size;
    } finally {
      await handle.close();
    }
  } catch {
    // An unreadable rollout has no usage to report, not a usage of zero.
    cache.delete(rolloutPath);
    return {};
  }

  // No compaction count: counting them needs the whole file, which is what
  // this reader exists to avoid. Nothing displays an agent's compactions, so
  // nothing reads the zero that stands in for it.
  const usage = entry.lastUsage && entry.window
    ? buildContextUsage({ last_token_usage: entry.lastUsage, model_context_window: entry.window }, undefined, undefined)
    : undefined;
  const rate = entry.tracker.snapshot;
  entry.reading = { ...(usage ? { usage } : {}), ...(rate ? { rate } : {}) };
  if (signature !== null) {
    cache.set(rolloutPath, entry);
  } else {
    cache.delete(rolloutPath);
  }
  return entry.reading;
}

/** Context usage for one agent's rollout, or undefined when it holds no usable report. */
export async function readAgentContextUsage(rolloutPath: string): Promise<ContextUsage | undefined> {
  return (await readAgentTokens(rolloutPath)).usage;
}

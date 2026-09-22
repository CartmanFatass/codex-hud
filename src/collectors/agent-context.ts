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
 */

import * as fs from 'node:fs';
import { buildContextUsage } from './context-usage.js';
import { fileSignature } from '../utils/file-signature.js';
import type { ContextUsage, EventMsgPayload, RolloutLine, TokenUsage, TokenUsageInfo } from '../types.js';

/** First tail window. Comfortably more than a turn's worth of events. */
export const TAIL_BYTES = 256 * 1024;
/** The one retry, for a rollout that went quiet after a long tool run. */
export const TAIL_BYTES_GROWN = 4 * TAIL_BYTES;

interface CacheEntry {
  signature: string;
  usage: ContextUsage | undefined;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: the cache is keyed by path, and tests reuse temp paths. */
export function resetAgentContextCache(): void {
  cache.clear();
}

function readTail(handle: fs.promises.FileHandle, size: number, bytes: number): Promise<string> {
  const start = Math.max(0, size - bytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  return handle.read(buffer, 0, length, start).then(({ bytesRead }) => {
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // A window that did not start at byte 0 almost certainly cut a record in
    // half; drop the fragment rather than trying to parse it.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  });
}

interface Latest {
  lastUsage?: TokenUsage;
  window?: number;
}

/**
 * The newest `token_count` report in this text.
 *
 * The usage and the window are tracked separately: Codex repeats the window on
 * every report, but a partial report can carry one without the other, and the
 * last one of each is what the display needs.
 */
function scanTokenCounts(text: string): Latest {
  const latest: Latest = {};
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) {
      continue;
    }
    let entry: RolloutLine;
    try {
      entry = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    if (entry.type !== 'event_msg') {
      continue;
    }
    const payload = entry.payload as EventMsgPayload;
    if (payload.type !== 'token_count' || !payload.info) {
      continue;
    }
    const info: TokenUsageInfo = payload.info;
    if (info.last_token_usage) {
      latest.lastUsage = info.last_token_usage;
    }
    if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
      latest.window = info.model_context_window;
    }
  }
  return latest;
}

/**
 * Context usage for one agent's rollout, or undefined when the tail holds no
 * usable report. Cached by the file's stat signature, so a still rollout costs
 * one stat rather than one read.
 */
export async function readAgentContextUsage(rolloutPath: string): Promise<ContextUsage | undefined> {
  const signature = fileSignature(rolloutPath);
  if (signature !== null) {
    const cached = cache.get(rolloutPath);
    if (cached && cached.signature === signature) {
      return cached.usage;
    }
  }

  let usage: ContextUsage | undefined;
  try {
    const handle = await fs.promises.open(rolloutPath, 'r');
    try {
      const { size } = await handle.stat();
      let latest = scanTokenCounts(await readTail(handle, size, TAIL_BYTES));
      if (!latest.lastUsage && size > TAIL_BYTES) {
        latest = scanTokenCounts(await readTail(handle, size, TAIL_BYTES_GROWN));
      }
      if (latest.lastUsage && latest.window) {
        // No compaction count: counting them needs the whole file, which is
        // what this reader exists to avoid. Nothing displays an agent's
        // compactions, so nothing reads the zero that stands in for it.
        usage = buildContextUsage(
          { last_token_usage: latest.lastUsage, model_context_window: latest.window },
          undefined,
          undefined
        );
      }
    } finally {
      await handle.close();
    }
  } catch {
    // An unreadable rollout has no usage to report, not a usage of zero.
    usage = undefined;
  }

  if (signature !== null) {
    cache.set(rolloutPath, { signature, usage });
  }
  return usage;
}

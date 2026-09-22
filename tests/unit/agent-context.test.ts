/**
 * Reading one agent's context fill without reading its whole rollout.
 *
 * The rule being defended: the newest report wins, the read is bounded, and a
 * rollout that has nothing to say reports nothing rather than zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readAgentContextUsage,
  resetAgentContextCache,
  TAIL_BYTES,
  TAIL_BYTES_GROWN,
} from '../../src/collectors/agent-context.js';
import { BASELINE_TOKENS } from '../../src/types.js';

const WINDOW = 272_000;

function tokenCount(total: number, at = '2026-03-01T11:30:00.000Z'): string {
  return `${JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: WINDOW,
        last_token_usage: {
          input_tokens: total - 900,
          cached_input_tokens: Math.round(total * 0.5),
          output_tokens: 900,
          total_tokens: total,
        },
        total_token_usage: { total_tokens: total * 3 },
      },
    },
  })}\n`;
}

/** Filler the reader must skip over: real rollouts are mostly not token counts. */
function padding(bytes: number): string {
  const line = `${JSON.stringify({
    timestamp: '2026-03-01T11:30:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(400) }] },
  })}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

async function withRollout(body: string, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hud-agent-ctx-'));
  const file = path.join(dir, 'rollout.jsonl');
  resetAgentContextCache();
  try {
    await fs.writeFile(file, body);
    await run(file);
  } finally {
    resetAgentContextCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('the last token report wins, even when the file starts with an older one', async () => {
  await withRollout(tokenCount(4_900) + padding(2048) + tokenCount(126_240), async (file) => {
    const usage = await readAgentContextUsage(file);
    assert.ok(usage, 'expected a reading');
    assert.equal(usage.total, WINDOW - BASELINE_TOKENS);
    assert.equal(usage.used, 126_240 - BASELINE_TOKENS);
    assert.equal(usage.percent, 44);
  });
});

test('a report past the first 256 KB is still found, because the tail is what is read', async () => {
  // A head-first reader would only ever see the stale 4,900-token report.
  const body = tokenCount(4_900) + padding(TAIL_BYTES) + tokenCount(126_240);
  await withRollout(body, async (file) => {
    assert.ok((await fs.stat(file)).size > TAIL_BYTES, 'the fixture must exceed one window');
    const usage = await readAgentContextUsage(file);
    assert.equal(usage?.used, 126_240 - BASELINE_TOKENS);
  });
});

test('a quiet tail grows the window once, and only once', async () => {
  // The report sits between the two window sizes: found on the second read.
  const reachable = tokenCount(126_240) + padding(TAIL_BYTES * 2);
  await withRollout(reachable, async (file) => {
    assert.ok((await fs.stat(file)).size < TAIL_BYTES_GROWN);
    assert.equal((await readAgentContextUsage(file))?.used, 126_240 - BASELINE_TOKENS);
  });

  // Past the grown window it stays unread: an absent number, not a wrong one.
  const unreachable = tokenCount(126_240) + padding(TAIL_BYTES_GROWN);
  await withRollout(unreachable, async (file) => {
    assert.ok((await fs.stat(file)).size > TAIL_BYTES_GROWN);
    assert.equal(await readAgentContextUsage(file), undefined);
  });
});

test('a rollout with no usable report reads as absent rather than empty', async () => {
  await withRollout(padding(4096), async (file) => {
    assert.equal(await readAgentContextUsage(file), undefined);
  });
  resetAgentContextCache();
  assert.equal(await readAgentContextUsage(path.join(os.tmpdir(), 'codex-hud-no-such-rollout.jsonl')), undefined);
});

test('a still rollout is answered from the cache, and an appended one is re-read', async () => {
  await withRollout(tokenCount(4_900), async (file) => {
    const first = await readAgentContextUsage(file);
    assert.equal(await readAgentContextUsage(file), first, 'the same object, not a second read');

    // A new mtime and size is what a rollout that moved looks like.
    await fs.appendFile(file, tokenCount(126_240, '2026-03-01T11:31:00.000Z'));
    const later = new Date(Date.now() + 5000);
    await fs.utimes(file, later, later);
    assert.equal((await readAgentContextUsage(file))?.used, 126_240 - BASELINE_TOKENS);
  });
});

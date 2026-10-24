import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TokenRateTracker, observeTokenRateRecord } from '../../src/collectors/token-rate.js';
import { RolloutParser } from '../../src/collectors/rollout.js';
import { readAgentTokens, resetAgentContextCache } from '../../src/collectors/agent-context.js';

const at = (seconds: number) => new Date(Date.parse('2026-10-04T10:00:00Z') + seconds * 1000);

test('wall proxy includes initial latency and stalls, excluding the union of parallel tool waits', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(1000, at(0));
  tracker.startTurn(at(10));
  tracker.observe(1100, at(20)); // 100 tokens / 10s, including initial latency.
  tracker.startTool('a', at(20));
  tracker.startTool('b', at(25));
  tracker.endTool('a', at(40));
  tracker.endTool('b', at(120)); // Union is 100s, not 115s.
  tracker.observe(1400, at(130));
  assert.deepEqual(tracker.snapshot, { tokensPerSecond: 20, sampleMs: 20_000, sampledAt: at(130) });
  tracker.startTurn(at(1000));
  tracker.observe(1450, at(1005));
  assert.equal(tracker.snapshot?.tokensPerSecond, 10, 'new turn discards both idle time and old tool waits');
});

test('unclosed waits conservatively remain in wall time; duplicate starts and unmatched results do not corrupt timing', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(0, at(0));
  tracker.startTool('a', at(10));
  tracker.startTool('a', at(15));
  tracker.endTool('missing', at(20));
  tracker.observe(100, at(30));
  assert.equal(tracker.snapshot?.sampleMs, 30_000, 'do not invent a tool end at the report timestamp');
  assert.equal(tracker.snapshot?.tokensPerSecond, 100 / 30);
  tracker.endTool('a', at(40));
  tracker.observe(200, at(50));
  assert.equal(tracker.snapshot?.sampleMs, 20_000);
  assert.equal(tracker.snapshot?.tokensPerSecond, 10);
});

test('a missing tool result never freezes the denominator or inflates later output', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(0, at(0));
  tracker.startTool('missing', at(1));
  tracker.startTool('overlapping', at(2));
  tracker.endTool('overlapping', at(5));
  tracker.observe(100, at(10));
  tracker.observe(1000, at(100));
  assert.equal(tracker.snapshot?.sampleMs, 100_000);
  assert.equal(tracker.snapshot?.tokensPerSecond, 10, 'unclosed union stays conservatively included');
});

test('a tail without a prior counter waits for an actual delta instead of counting previous-turn output', () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(at(100));
  observeTokenRateRecord(tracker, { timestamp: at(101).toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: {
      total_token_usage: { output_tokens: 1000 },
      last_token_usage: { output_tokens: 100 }, // Repeats the previous turn.
    },
  } });
  assert.equal(tracker.snapshot ?? null, null, 'no guessed historical baseline');
  tracker.observe(1100, at(110));
  assert.equal(tracker.snapshot?.sampleMs, 9000);
  assert.equal(tracker.snapshot?.tokensPerSecond, 100 / 9, 'only the known 100-token increment');
});

test('counter-only fallback discards tool waits before its first baseline', () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(at(0));
  tracker.startTool('a', at(1));
  tracker.endTool('a', at(5));
  tracker.startTool('b', at(6));
  tracker.observe(1000, at(10));
  tracker.endTool('b', at(20));
  tracker.observe(1100, at(30));
  assert.equal(tracker.snapshot?.sampleMs, 10_000);
  assert.equal(tracker.snapshot?.tokensPerSecond, 10);
});

test('clones isolate in-flight tools, turn state and counters during transactional parser reads', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(0, at(0));
  tracker.startTool('a', at(10));
  const copy = tracker.clone();
  copy.endTool('a', at(20));
  copy.observe(200, at(30));
  tracker.observe(100, at(30));
  assert.equal(copy.snapshot?.sampleMs, 20_000);
  assert.equal(tracker.snapshot?.sampleMs, 30_000);
  copy.reset();
  assert.equal(tracker.snapshot?.tokensPerSecond, 100 / 30);
});

test('invalid/backwards tool times and a zero model-time denominator cannot produce infinite rates', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(0, at(0));
  tracker.startTool('a', at(0));
  tracker.endTool('a', at(-1));
  tracker.endTool('a', new Date(NaN));
  tracker.startTool('b', new Date(NaN));
  tracker.endTool('a', at(10));
  tracker.observe(100, at(10));
  assert.equal(tracker.snapshot ?? null, null, 'all of the observed interval is a closed tool wait');
  tracker.observe(200, at(30));
  assert.equal(tracker.snapshot?.tokensPerSecond, 10);
});

test('main and agent readers use the same wall proxy across incremental reads, tool formats, replay and rotation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hud-wall-rate-'));
  const file = path.join(dir, 'rollout.jsonl');
  const row = (seconds: number, type: string, payload: object) => JSON.stringify({ timestamp: at(seconds).toISOString(), type, payload }) + '\n';
  const usage = (seconds: number, total: number, last: number) => row(seconds, 'event_msg', {
    type: 'token_count', info: { total_token_usage: { output_tokens: total }, last_token_usage: { output_tokens: last } },
  });
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  resetAgentContextCache();
  const compare = async (expected: number, sampleMs: number) => {
    const main = (await parser.parse())?.outputRate;
    const agent = (await readAgentTokens(file)).rate;
    assert.equal(main?.tokensPerSecond, expected);
    assert.equal(main?.sampleMs, sampleMs);
    assert.deepEqual(agent, main);
    return main;
  };
  try {
    await fs.writeFile(file, usage(-1, 50_000, 100) + row(0, 'event_msg', { type: 'task_started' }) + usage(10, 50_100, 100) +
      row(10, 'response_item', { type: 'function_call', call_id: 'a', name: 'exec_command' }) +
      row(15, 'response_item', { type: 'custom_tool_call', call_id: 'b', name: 'exec' }));
    const initial = await compare(10, 10_000);
    await fs.appendFile(file, row(40, 'response_item', { type: 'function_call_output', call_id: 'a' }) +
      row(110, 'response_item', { type: 'custom_tool_call_output', call_id: 'b' }) + usage(120, 50_400, 300));
    const measured = await compare(20, 20_000);
    assert.deepEqual(initial, { tokensPerSecond: 10, sampleMs: 10_000, sampledAt: at(10) }, 'published snapshot is immutable');
    await fs.appendFile(file, usage(150, 50_400, 300));
    assert.deepEqual(await compare(20, 20_000), measured, 'duplicate report retains freshness');
    assert.deepEqual((await parser.fullParse())?.outputRate, measured);
    await fs.appendFile(file, row(200, 'event_msg', { type: 'turn_started' }) + usage(205, 50_500, 100));
    await compare(20, 5000);
    await fs.writeFile(file, usage(-1, 0, 0) + row(0, 'event_msg', { type: 'task_started' }) + usage(2, 80, 80));
    await compare(40, 2000);
  } finally {
    resetAgentContextCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

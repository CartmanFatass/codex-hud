/**
 * Replay of recorded rollout shapes.
 *
 * These lock the parser's answers for the cases that used to be guessed at:
 * a missing quota snapshot, a half-written last line, a model switch mid
 * session, and a subagent that failed rather than finished.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRolloutFile } from '../../src/collectors/rollout.js';
import { buildContextUsage } from '../../src/collectors/context-usage.js';
import { rolloutFixture } from '../fixtures/paths.js';

test('basic session: model, tools, plan and quota all parse', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('basic-session.jsonl'));

  assert.equal(result.session?.id, 'root-session-id-0123456789');
  assert.equal(result.session?.model, 'gpt-5.6-astra');
  assert.equal(result.session?.reasoningEffort, 'xhigh');

  assert.equal(result.toolActivity.totalCalls, 2);
  const statuses = result.toolActivity.recentCalls.map((call) => call.status).sort();
  assert.deepEqual(statuses, ['completed', 'error']);

  assert.equal(result.planProgress?.totalSteps, 3);
  assert.equal(result.planProgress?.completedSteps, 1);

  assert.equal(result.rateLimits?.primary?.window_minutes, 300);
  assert.equal(Math.round(result.rateLimits?.primary?.used_percent ?? 0), 61);
  assert.equal(result.tokenUsage?.model_context_window, 272000);
});

test('missing quota stays missing rather than reading as zero', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('no-rate-limits.jsonl'));

  assert.equal(result.rateLimits, null);
  assert.notEqual(result.tokenUsage, null);
});

test('a half-written final line does not lose the lines before it', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('truncated-line.jsonl'));

  assert.equal(result.session?.id, 'truncated-session');
  assert.equal(result.tokenUsage?.model_context_window, 272000);
});

test('a mid-session model switch reports the latest model', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('model-switch.jsonl'));

  assert.equal(result.session?.model, 'gpt-5.6-astra');
  assert.equal(result.session?.reasoningEffort, 'xhigh');
});

test('a failed subagent is not counted as finished work', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('subagent-lifecycle.jsonl'));

  const byId = new Map(result.subagents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get('agent-aaa1')?.status, 'completed');
  assert.equal(byId.get('agent-bbb2')?.status, 'error');
  assert.equal(byId.get('agent-aaa1')?.model, 'gpt-5.6-sol');
  assert.equal(byId.get('agent-bbb2')?.effort, 'low');
});

test('compaction events are counted and timestamped', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('compaction.jsonl'));

  assert.equal(result.compactCount, 2);
  assert.equal(result.lastCompactTime?.toISOString(), '2026-03-01T11:45:00.000Z');

  const usage = buildContextUsage(result.tokenUsage ?? undefined, result.compactCount, result.lastCompactTime);
  assert.equal(usage?.compactCount, 2);
});

test('a context window smaller than the baseline does not read as full', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('small-context.jsonl'));

  const usage = buildContextUsage(result.tokenUsage ?? undefined, 0, null);
  assert.ok(usage, 'expected usage for an 8K window');
  assert.ok(usage.percent < 100, `expected under 100%, got ${usage.percent}%`);
  assert.ok(usage.percent > 0, `expected over 0%, got ${usage.percent}%`);
});

test('incremental parsing from an offset does not replay earlier lines', async () => {
  const first = await parseRolloutFile(rolloutFixture('basic-session.jsonl'));
  const second = await parseRolloutFile(
    rolloutFixture('basic-session.jsonl'),
    first.newOffset,
    10,
    first.runningCalls,
    first.result.session
  );

  assert.equal(second.result.toolActivity.totalCalls, 0);
  assert.equal(second.result.session?.id, 'root-session-id-0123456789');
});

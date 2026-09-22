/**
 * Replay of recorded rollout shapes.
 *
 * These lock the parser's answers for the cases that used to be guessed at:
 * a missing quota snapshot, a half-written last line, a model switch mid
 * session, and a subagent that failed rather than finished.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseRolloutFile, RolloutParser } from '../../src/collectors/rollout.js';
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

test('an approval request left unanswered at the end of the file stays pending', async () => {
  const { result } = await parseRolloutFile(rolloutFixture('approval.jsonl'));

  assert.equal(result.pendingApproval?.kind, 'exec');
  assert.equal(result.pendingApproval?.callId, 'call_exec_2');
  assert.equal(result.pendingApproval?.summary, 'git push --force');
  assert.equal(result.pendingApproval?.since.toISOString(), '2026-03-01T11:32:03.000Z');
});

test('approval requests are cleared by whatever answered them, across batches', async () => {
  const text = await fs.readFile(rolloutFixture('approval.jsonl'), 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hud-approval-'));
  const file = path.join(dir, 'rollout.jsonl');
  const parser = new RolloutParser(10);

  // Each step appends one recorded line, so every assertion is about what an
  // incremental parse concluded from a batch, not from a full re-read.
  const upTo = async (count: number) => {
    await fs.writeFile(file, `${lines.slice(0, count).join('\n')}\n`);
    return parser.parse();
  };

  try {
    await fs.writeFile(file, '');
    parser.setRolloutPath(file);

    const requested = (await upTo(3))?.pendingApproval;
    assert.equal(requested?.kind, 'exec', 'the request is observed');
    assert.equal(requested?.callId, 'call_exec_1');
    assert.equal(requested?.summary, 'bash -lc rm -rf build && npm run build');

    assert.equal((await upTo(4))?.pendingApproval, null, 'the command starting answers it');
    assert.equal((await upTo(6))?.pendingApproval, null);

    const patch = (await upTo(8))?.pendingApproval;
    assert.equal(patch?.kind, 'patch');
    assert.equal(patch?.summary, '3 files', 'patches count files');
    assert.equal((await upTo(9))?.pendingApproval, null, 'an aborted turn waits on nobody');

    assert.equal((await upTo(12))?.pendingApproval?.callId, 'call_exec_2');
    assert.equal((await upTo(13))?.pendingApproval?.callId, 'call_exec_2', 'still pending at EOF');

    // A recorded result for the same call answers it just as well.
    await fs.appendFile(
      file,
      `${JSON.stringify({
        timestamp: '2026-03-01T11:32:08.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_exec_2', output: { success: true } },
      })}\n`
    );
    assert.equal((await parser.parse())?.pendingApproval, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a request for a different call does not clear the one still waiting', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hud-approval-other-'));
  const file = path.join(dir, 'rollout.jsonl');
  const line = (payload: unknown, type = 'event_msg') =>
    `${JSON.stringify({ timestamp: '2026-03-01T11:40:00.000Z', type, payload })}\n`;

  try {
    await fs.writeFile(
      file,
      line({ type: 'exec_approval_request', call_id: 'call_a', command: ['ls'] }) +
        line({ type: 'exec_command_begin', call_id: 'call_b', command: ['pwd'] })
    );
    const { result } = await parseRolloutFile(file);
    assert.equal(result.pendingApproval?.callId, 'call_a');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

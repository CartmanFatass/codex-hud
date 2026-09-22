import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolloutParser } from '../../src/collectors/rollout.js';
import { createParseQueue } from '../../src/utils/parse-queue.js';

const row = (type: string, payload: object, seconds = 0) => JSON.stringify({
  timestamp: new Date(1_700_000_000_000 + seconds * 1000).toISOString(), type, payload,
}) + '\n';
const meta = (id: string) => row('session_meta', { id, timestamp: '2023-11-14T22:13:20Z', cwd: '/repo' });
const call = (id: string) => row('response_item', { type: 'function_call', call_id: id, name: 'exec_command', arguments: '{"cmd":"中文"}' });
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-live-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'rollout.jsonl');
  const parser = new RolloutParser(); parser.setRolloutPath(file);
  return { dir, file, parser };
}

test('split UTF-8/CRLF records are retried and counted exactly once', async t => {
  const { file, parser } = fixture(t);
  writeFileSync(file, meta('A'));
  const bytes = Buffer.from(call('c').replace(/\n$/, '\r\n'));
  const cut = bytes.indexOf(Buffer.from('中')) + 1;
  appendFileSync(file, bytes.subarray(0, cut));
  assert.equal((await parser.parse())?.toolActivity.totalCalls, 0);
  appendFileSync(file, bytes.subarray(cut));
  let result = await parser.parse();
  assert.equal(result?.toolActivity.totalCalls, 1);
  assert.equal(result?.toolActivity.recentCalls[0].arguments?.cmd, '中文');
  appendFileSync(file, row('response_item', { type: 'function_call_output', call_id: 'c', output: 'ok' }).trimEnd());
  result = await parser.parse();
  assert.equal(result?.toolActivity.recentCalls[0].status, 'completed');
  assert.equal((await parser.parse())?.toolActivity.totalCalls, 1);
});

test('session switch during read cannot commit the old snapshot', async t => {
  const { dir, file, parser } = fixture(t);
  writeFileSync(file, meta('A') + call('old'));
  const other = join(dir, 'other'); writeFileSync(other, meta('B') + call('new'));
  const oldRead = parser.parse();
  parser.setRolloutPath(other);
  await oldRead;
  const current = await parser.parse();
  assert.equal(current?.session?.id, 'B');
  assert.deepEqual(current?.toolActivity.recentCalls.map(c => c.id), ['new']);
});

test('same-size rename replacement resets counts and file identity', async t => {
  const { dir, file, parser } = fixture(t);
  writeFileSync(file, meta('A') + call('old')); await parser.parse();
  const other = join(dir, 'other'); writeFileSync(other, meta('B') + call('new'));
  renameSync(other, file);
  const result = await parser.parse();
  assert.equal(result?.session?.id, 'B');
  assert.equal(result?.toolActivity.totalCalls, 1);
  assert.deepEqual(result?.toolActivity.recentCalls.map(c => c.id), ['new']);
});

test('a failed read rejects normally and the parse queue recovers', async t => {
  const { file, parser } = fixture(t);
  const run = createParseQueue(() => parser.parse());
  await assert.rejects(run(), { code: 'ENOENT' });
  writeFileSync(file, meta('A') + call('one'));
  assert.equal((await run())?.toolActivity.totalCalls, 1);
  unlinkSync(file);
  await assert.rejects(run(), { code: 'ENOENT' });
  writeFileSync(file, meta('B') + call('two'));
  assert.equal((await run())?.session?.id, 'B');
});

test('working state persists through quiet polls and ends only on lifecycle events', async t => {
  const { file, parser } = fixture(t);
  writeFileSync(file, meta('A') + row('event_msg', { type: 'task_started' }, 1));
  const first = await parser.parse();
  assert.equal(first?.activity?.state, 'working');
  assert.deepEqual((await parser.parse())?.activity, first?.activity);
  appendFileSync(file, row('response_item', { type: 'message', role: 'assistant', content: [] }, 300));
  assert.equal((await parser.parse())?.activity?.state, 'working', 'commentary is not task completion');
  appendFileSync(file, row('event_msg', { type: 'task_complete' }, 301));
  assert.equal((await parser.parse())?.activity?.state, 'idle');
  appendFileSync(file, row('event_msg', { type: 'task_started' }, 400) + row('event_msg', { type: 'turn_aborted' }, 401));
  assert.equal((await parser.parse())?.activity?.state, 'interrupted');
});

test('usage observation time does not advance on quota-only or empty polls', async t => {
  const { file, parser } = fixture(t);
  writeFileSync(file, row('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 50000 } } }, 5));
  const first = await parser.parse();
  appendFileSync(file, row('event_msg', { type: 'token_count', info: null }, 10));
  assert.deepEqual((await parser.parse())?.tokenUsageAt, first?.tokenUsageAt);
  assert.deepEqual((await parser.parse())?.tokenUsageAt, first?.tokenUsageAt);
});

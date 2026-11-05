import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createClaudeReader,
  validateClaudeRecoveryIndexEntry,
  type ClaudeCheckpoint,
  type ClaudeReaderResult,
} from '../../src/harness/claude/reader.js';
import { MAX_TODO_ITEMS, MAX_TODO_CURRENT_BYTES } from '../../src/harness/claude/todos.js';
import { checkpointBoundary, checkpointFormat, prepareCheckpoint } from '../../src/core/checkpoint.js';
import { row, compact, TIME, SESSION, PRIVATE } from '../fixtures/claude/transcripts.js';

const list = [
  { content: 'Synthetic finished task', status: 'completed', activeForm: 'Finishing synthetic task' },
  { content: 'Synthetic current task', status: 'in_progress', activeForm: 'Checking synthetic parser' },
  { content: 'Synthetic queued task', status: 'pending', activeForm: 'Queueing synthetic task' },
];
function call(id: string, todos: unknown = list, offset = 1000, name = 'TodoWrite') {
  return row('assistant', { message: { content: [{ type: 'tool_use', id, name, input: { todos } }] } }, offset);
}
function result(id: string, offset = 2000, error = false, type = 'user') {
  return row(
    type,
    { message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: 'Synthetic result' }] } },
    offset
  );
}
function fixture(t: test.TestContext, lines: string[] = []) {
  t.mock.method(performance, 'now', () => 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-claude-todos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.jsonl');
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
  const options = {
    ref: { harness: 'claude' as const, sourceId: 'e'.repeat(64), sessionId: SESSION, threadId: null },
    resolveFile: () => file,
    serverNames: ['hud'],
  };
  return {
    file,
    options,
    reader: createClaudeReader(options),
    append: (...next: string[]) => fs.appendFileSync(file, next.join('\n') + '\n'),
  };
}
const saved = (r: ClaudeReaderResult): ClaudeCheckpoint => JSON.parse(JSON.stringify(r.checkpoint));

test('D1 progress appears only after the exact successful TodoWrite result and keeps its confirmation time', async (t) => {
  const f = fixture(t, [call('synthetic-todo')]);
  assert.equal((await f.reader.read()).evidence.progress, undefined);
  f.append(result('other-call'));
  assert.equal((await f.reader.read()).evidence.progress, undefined);
  f.append(result('synthetic-todo', 3000));
  const confirmed = await f.reader.read();
  assert.deepEqual(confirmed.evidence.progress, {
    value: { done: 1, total: 3, current: 'Checking synthetic parser' },
    source: 'claude.TodoWrite.last_confirmed',
    quality: 'reported',
    asOf: TIME + 3000,
  });
  const idle = await f.reader.read();
  assert.equal(idle.stats!.bytesRead, 0);
  assert.deepEqual(idle.evidence.progress, confirmed.evidence.progress);
});

test('D1 failed, unpaired and assistant-authored tool results cannot replace confirmed progress', async (t) => {
  const f = fixture(t, [call('first'), result('first'), call('failed', []), result('failed', 3000, true)]);
  const before = (await f.reader.read()).evidence.progress;
  f.append(call('pending', []), result('pending', 4000, false, 'assistant'), result('unknown', 5000));
  assert.deepEqual((await f.reader.read()).evidence.progress, before);
  f.append(result('pending', 6000));
  assert.deepEqual((await f.reader.read()).evidence.progress?.value, { done: 0, total: 0 });
});

test('D1 a complete list and an explicit empty list remain distinct, without invented current text', async (t) => {
  const f = fixture(t, [
    call(
      'done',
      list.map((todo) => ({ ...todo, status: 'completed' }))
    ),
    result('done'),
  ]);
  assert.deepEqual((await f.reader.read()).evidence.progress?.value, { done: 3, total: 3 });
  f.append(call('empty', [], 3000), result('empty', 4000));
  assert.deepEqual((await f.reader.read()).evidence.progress?.value, { done: 0, total: 0 });
});

test('D1 malformed error flags cannot confirm either tool-result envelope', async (t) => {
  const malformed = JSON.parse(result('malformed'));
  malformed.message.content[0].is_error = 'true';
  const attachment = row('attachment', {
    attachment: { type: 'toolUseResult', toolUseId: 'malformed', result: 'Synthetic result', is_error: 'false' },
  });
  const f = fixture(t, [call('first'), result('first'), call('malformed', []), JSON.stringify(malformed), attachment]);
  const checked = await f.reader.read();
  assert.deepEqual(checked.evidence.progress?.value, { done: 1, total: 3, current: 'Checking synthetic parser' });
  assert.ok(checked.observation.coverage.gaps.includes('malformed_todo_result'));
  f.append(result('malformed', 5000));
  assert.deepEqual((await f.reader.read()).evidence.progress?.value, { done: 0, total: 0 });
});

test('D1 pending summaries survive serialization and compaction before confirmation', async (t) => {
  const f = fixture(t, [call('first'), result('first'), call('pending', [], 3000), compact(4000)]);
  const first = await f.reader.read();
  f.append(result('pending', 5000));
  const restored = await createClaudeReader(f.options, saved(first)).read();
  assert.deepEqual(restored.evidence.progress?.value, { done: 0, total: 0 });
  assert.equal(restored.evidence.progress?.asOf, TIME + 5000);
  prepareCheckpoint({
    checkpoint: restored.checkpoint,
    boundary: checkpointBoundary(restored.checkpoint),
    format: checkpointFormat(restored.checkpoint),
    recoveryReferences: [],
  });
});

test('D1 confirmed summaries survive checkpoint recovery and compaction without fresh timestamps', async (t) => {
  const f = fixture(t, [call('first'), result('first')]);
  const first = await f.reader.read();
  f.append(compact(3000));
  const restored = await createClaudeReader(f.options, saved(first)).read();
  assert.deepEqual(restored.evidence.progress, first.evidence.progress);
  restored.evidence.progress!.value!.current = 'Synthetic caller mutation';
  assert.equal((await f.reader.read()).evidence.progress?.value?.current, 'Checking synthetic parser');
});

test('D1 replacement clears confirmed and pending summaries, with no stale post-reset confirmation', async (t) => {
  const f = fixture(t, [call('first'), result('first'), call('pending')]);
  const first = await f.reader.read();
  fs.writeFileSync(f.file, result('pending', 9000) + '\n');
  const reset = await f.reader.read();
  assert.ok(reset.checkpoint.sourceGeneration > first.checkpoint.sourceGeneration);
  assert.equal(reset.evidence.progress, undefined);
});

test('D1 rejects a whole malformed or oversized list rather than publishing a partial count', async (t) => {
  const f = fixture(t, [call('first'), result('first')]);
  const before = (await f.reader.read()).evidence.progress;
  for (const [i, invalid] of [
    null,
    [{ content: 'Synthetic task', status: 'unknown' }],
    [{ content: 'Synthetic task', status: ['completed'] }],
    [{ content: 'Synthetic task', status: ['in_progress'] }],
    [...list, { status: 'completed' }],
    [{ content: ' ', status: 'completed' }],
    Array.from({ length: MAX_TODO_ITEMS + 1 }, () => list[0]),
  ].entries()) {
    const id = `malformed-${i}`;
    f.append(call(id, invalid, 3000 + i * 2), result(id, 3001 + i * 2));
    const checked = await f.reader.read();
    assert.deepEqual(checked.evidence.progress, before);
    assert.ok(checked.observation.coverage.gaps.includes('malformed_todos'));
  }
});

test('D1 does not retain completed or queued task text and bounds the current UTF-8/escaped excerpt', async (t) => {
  const f = fixture(t, [
    call('bounded', [
      { content: PRIVATE, status: 'completed' },
      { content: 'Synthetic current', activeForm: '漢字\\"'.repeat(2000), status: 'in_progress' },
      { content: PRIVATE, status: 'pending' },
    ]),
    result('bounded'),
  ]);
  const checked = await f.reader.read();
  assert.equal(checked.evidence.progress?.value?.done, 1);
  assert.equal(checked.evidence.progress?.value?.total, 3);
  assert.ok(checked.evidence.progress?.value?.current?.endsWith('…'));
  assert.ok(Buffer.byteLength(JSON.stringify(checked.evidence.progress?.value?.current)) <= MAX_TODO_CURRENT_BYTES);
  assert.ok(!JSON.stringify(checked).includes(PRIVATE));
});

test('D1 rejects cross-session/sidechain TodoWrite records and does not accept tool-name lookalikes', async (t) => {
  const alien = JSON.parse(call('alien'));
  alien.sessionId = 'synthetic-other-session';
  const sidechain = JSON.parse(call('child'));
  sidechain.isSidechain = true;
  const f = fixture(t, [
    JSON.stringify(alien),
    result('alien'),
    JSON.stringify(sidechain),
    result('child'),
    call('lookalike', list, 3000, 'mcp__fake__TodoWrite'),
    result('lookalike', 4000),
  ]);
  assert.equal((await f.reader.read()).evidence.progress, undefined);
});

test('D1 repeated tool records cannot replay an old list over a newer confirmation', async (t) => {
  const f = fixture(t, [call('first'), result('first'), call('second', []), result('second', 3000)]);
  const before = (await f.reader.read()).evidence.progress;
  f.append(call('first', list, 4000), result('first', 5000));
  assert.deepEqual((await f.reader.read()).evidence.progress, before);
});

test('D1 conflicting pending calls fail closed instead of confirming a guessed list', async (t) => {
  const f = fixture(t, [call('conflict'), call('conflict', [], 2000), result('conflict', 3000)]);
  const checked = await f.reader.read();
  assert.equal(checked.evidence.progress, undefined);
  assert.ok(checked.observation.coverage.gaps.includes('todo_call_conflict'));
});

test('D1 public toolUseResult attachments confirm a pending list and missing event time is explicit', async (t) => {
  const confirmation = JSON.parse(
    row(
      'attachment',
      { attachment: { type: 'toolUseResult', toolUseId: 'attached', result: 'Synthetic result' } },
      2000
    )
  );
  delete confirmation.timestamp;
  const f = fixture(t, [call('attached'), JSON.stringify(confirmation)]);
  t.mock.method(Date, 'now', () => TIME + 9000);
  const checked = await f.reader.read();
  assert.equal(checked.evidence.progress?.source, 'claude.TodoWrite.last_confirmed.observed-time');
  assert.equal(checked.evidence.progress?.asOf, TIME + 9000);
});

test('D1 zero record budget does not publish attempted progress and bounded slices match a full read', async (t) => {
  const f = fixture(t, [call('first'), result('first')]);
  const zero = await f.reader.read({ maxBytes: 4096, maxRecords: 0, budgetMs: 20 });
  assert.equal(zero.evidence.progress, undefined);
  const one = await f.reader.read({ maxBytes: 4096, maxRecords: 1, budgetMs: 20 });
  assert.equal(one.evidence.progress, undefined);
  const two = await createClaudeReader(f.options, saved(one)).read({ maxBytes: 4096, maxRecords: 1, budgetMs: 20 });
  assert.deepEqual(two.evidence.progress, (await createClaudeReader(f.options).read()).evidence.progress);
});

test('D1 recovery index rejects raw payloads, impossible counts and oversized current text', () => {
  for (const value of [
    { done: 2, total: 1 },
    { done: 0, total: 1, raw: PRIVATE },
    { done: 0, total: 1, current: 'x'.repeat(MAX_TODO_CURRENT_BYTES) },
    { done: 1, total: 1, current: 'Synthetic stale current' },
  ])
    assert.throws(
      () =>
        validateClaudeRecoveryIndexEntry({
          namespace: 'claude.pendingTodoUpdates',
          key: 'synthetic',
          value: JSON.stringify(value),
        }),
      /invalid_claude_recovery_index_entry/
    );
  assert.throws(
    () =>
      validateClaudeRecoveryIndexEntry({
        namespace: 'claude.todoProgress',
        key: 'other',
        value: JSON.stringify({ value: { done: 0, total: 0 }, at: TIME, observedTime: false }),
      }),
    /invalid_claude_recovery_index_entry/
  );
});

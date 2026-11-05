import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClaudeReader, CLAUDE_READER_VERSION } from '../../src/harness/claude/reader.js';
import {
  ClaudeBackgroundProjection,
  MAX_BACKGROUND_IDENTITIES,
  type ClaudeBackgroundEvent,
} from '../../src/harness/claude/background.js';
import { RecoveryIndexOverlay } from '../../src/core/checkpoint.js';
import { row, compact, TIME, SESSION } from '../fixtures/claude/transcripts.js';

const SECRET = 'SYNTHETIC_PRIVATE_COMMAND_OUTPUT_OR_PATH';
const call = (
  id: string,
  name = 'Bash',
  input: unknown = { command: SECRET, description: SECRET, run_in_background: true },
  at = 0
) => row('assistant', { uuid: `message-${id}`, message: { content: [{ type: 'tool_use', id, name, input }] } }, at);
const result = (id: string, taskId = 'task-a', extra: Record<string, unknown> = {}, at = 1000) =>
  row(
    typeof extra.type === 'string' ? extra.type : 'user',
    {
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: SECRET }] },
      toolUseResult: { backgroundTaskId: taskId, interrupted: false, stdout: SECRET, outputFile: SECRET },
      ...extra,
    },
    at
  );
const xml = (taskId = 'task-a', status = 'completed', callId?: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n${callId ? `<tool-use-id>${callId}</tool-use-id>\n` : ''}<status>${status}</status>\n<summary>${SECRET}</summary>\n</task-notification>`;
const notice = (taskId = 'task-a', extra: Record<string, unknown> = {}, at = 2000) =>
  row('user', { origin: { kind: 'task-notification' }, message: { content: xml(taskId) }, ...extra }, at);
function fixture(t: test.TestContext, rows: string[] = []) {
  t.mock.method(performance, 'now', () => 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-claude-background-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.jsonl');
  fs.writeFileSync(file, rows.length ? rows.join('\n') + '\n' : '');
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

test('D1 background Bash action starts only after its exact successful native acknowledgement', async (t) => {
  const f = fixture(t, [call('bash-a')]);
  assert.equal((await f.reader.read()).evidence.action, undefined);
  f.append(result('unmatched'));
  assert.equal((await f.reader.read()).evidence.action, undefined);
  f.append(result('bash-a'));
  const started = await f.reader.read();
  assert.deepEqual(started.evidence.action, {
    id: 'bash-a',
    name: 'Bash (background)',
    target: 'task task-a',
    startedAt: TIME,
  });
  assert.equal(started.evidence.background?.coverage, 'complete');
  const idle = await f.reader.read();
  assert.deepEqual(idle.evidence.background, started.evidence.background);
  assert.equal(idle.stats?.bytesRead, 0);
  assert.ok(!JSON.stringify(started.evidence.background).includes(SECRET));
  assert.ok(!JSON.stringify(started.checkpoint).includes(SECRET));
  assert.equal(started.checkpoint.readerVersion, CLAUDE_READER_VERSION);
  assert.ok(!JSON.stringify(started.checkpoint).includes('backgroundTaskId'));
});

test('D1 malformed or failed results and ambiguous line-level sidecars cannot start background tasks', async (t) => {
  const malformed = JSON.parse(result('malformed'));
  malformed.message.content[0].is_error = 'false';
  const failed = JSON.parse(result('failed'));
  failed.message.content[0].is_error = true;
  const ambiguous = JSON.parse(result('multi'));
  ambiguous.message.content.push({ type: 'tool_result', tool_use_id: 'other', content: 'Synthetic' });
  const f = fixture(t, [
    call('malformed'),
    JSON.stringify(malformed),
    call('failed'),
    JSON.stringify(failed),
    call('multi'),
    JSON.stringify(ambiguous),
    call('interrupted'),
    result('interrupted', 'task-interrupted', {
      toolUseResult: { backgroundTaskId: 'task-interrupted', interrupted: true },
    }),
    call('text'),
    result('text', 'ignored', { toolUseResult: `Command running in background: ${SECRET}` }),
  ]);
  assert.equal((await f.reader.read()).evidence.action, undefined);
  f.append(result('malformed'));
  assert.equal((await f.reader.read()).evidence.action?.id, 'malformed');
});

test('D1 background acknowledgement requires exact parent/child identity and native Bash tool', async (t) => {
  const f = fixture(t, [
    call('other', 'Read'),
    result('other'),
    call('sidechain'),
    result('sidechain', 'task-side', { agentId: 'child', isSidechain: true }),
    call('missing'),
    result('missing', 'task-missing', { sessionId: undefined }),
    call('assistant'),
    result('assistant', 'task-asst', { type: 'assistant' }),
  ]);
  assert.deepEqual((await f.reader.read()).evidence.background?.tasks, []);
});

test('D1 ordinary copied XML, bare queue records and human prompts cannot settle background work', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  f.append(
    notice('task-a', { origin: { kind: 'human' } }),
    notice('task-a', { origin: undefined, isMeta: true }),
    row('queue-operation', { operation: 'enqueue', content: xml() }),
    row('attachment', {
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        origin: { kind: 'human' },
        prompt: xml(),
      },
    })
  );
  assert.equal((await f.reader.read()).evidence.background?.tasks.length, 1);
  f.append(notice());
  const closed = await f.reader.read();
  assert.deepEqual(closed.evidence.background?.tasks, []);
  assert.equal(closed.evidence.action, undefined);
});

test('D1 queued native notifications settle exact tasks, while missing or nonterminal status does not', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  f.append(
    notice('task-a', { message: { content: xml('task-a', 'running') } }),
    notice('other'),
    notice('task-a', { message: { content: xml().replace('<status>completed</status>', '') } })
  );
  assert.equal((await f.reader.read()).evidence.background?.tasks.length, 1);
  f.append(
    row('attachment', {
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt: xml('task-a', 'killed', 'bash-a'),
      },
    })
  );
  assert.deepEqual((await f.reader.read()).evidence.background?.tasks, []);
});

test('D1 a native terminal notification before launch acknowledgement prevents stale resurrection', async (t) => {
  const f = fixture(t, [call('bash-a'), notice(), result('bash-a')]);
  assert.deepEqual((await f.reader.read()).evidence.background?.tasks, []);
  f.append(call('bash-a'), result('bash-a'));
  assert.deepEqual((await f.reader.read()).evidence.background?.tasks, []);
});

test('D1 parallel background tasks keep detached stable evidence and select the newest confirmation', async (t) => {
  const f = fixture(t, [
    call('bash-a'),
    result('bash-a'),
    call('bash-b', 'Bash', {}, 2000),
    result('bash-b', 'task-b', {}, 3000),
  ]);
  const both = await f.reader.read();
  assert.equal(both.evidence.background?.tasks.length, 2);
  assert.equal(both.evidence.action?.id, 'bash-b');
  both.evidence.background!.tasks[0].id = 'mutated';
  f.append(notice('task-b', {}, 4000));
  const one = await f.reader.read();
  assert.equal(one.evidence.action?.id, 'bash-a');
  assert.equal(one.evidence.background?.tasks[0].id, 'task-a');
});

test('D1 reused task handles or conflicting notification call IDs become unknown', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a'), call('bash-b'), result('bash-b')]);
  const ambiguous = await f.reader.read();
  assert.deepEqual(ambiguous.evidence.background?.tasks, []);
  assert.ok(ambiguous.evidence.background?.gaps.includes('background_task_conflict'));
  assert.equal(ambiguous.evidence.action, undefined);
});

test('D1 TaskOutput must match its requested task and report a successful native terminal snapshot', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  const output = (query: string, task = 'task-a', retrieval = 'success', type = 'local_bash') =>
    result(query, 'unused', {
      toolUseResult: {
        retrieval_status: retrieval,
        task: { task_id: task, task_type: type, status: 'completed', output: SECRET },
      },
    });
  f.append(
    call('timeout', 'TaskOutput', { task_id: 'task-a' }),
    output('timeout', 'task-a', 'timeout'),
    call('wrong', 'TaskOutput', { task_id: 'task-a' }),
    output('wrong', 'other'),
    call('agent', 'TaskOutput', { task_id: 'task-a' }),
    output('agent', 'task-a', 'success', 'local_agent')
  );
  assert.equal((await f.reader.read()).evidence.background?.tasks.length, 1);
  f.append(call('finish', 'TaskOutput', { task_id: 'task-a' }), output('finish'));
  assert.deepEqual((await f.reader.read()).evidence.background?.tasks, []);
});

test('D1 background state survives live compaction but is explicitly unknown after checkpoint restart', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  const first = await f.reader.read();
  f.append(compact(2000));
  assert.equal((await f.reader.read()).evidence.action?.id, 'bash-a');
  const restored = await createClaudeReader(f.options, first.checkpoint).read();
  assert.equal(restored.evidence.action, undefined);
  assert.deepEqual(restored.evidence.background?.tasks, []);
  assert.ok(restored.evidence.background?.gaps.includes('background_history_unconfirmed'));
  assert.equal(restored.evidence.background?.coverage, 'partial');
});

test('D1 physical transcript replacement clears background authority before reused IDs', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  fs.writeFileSync(f.file, call('replacement') + '\n');
  fs.utimesSync(f.file, new Date(), new Date(Date.now() + 1000));
  const reset = await f.reader.read();
  assert.deepEqual(reset.evidence.background?.tasks, []);
  assert.equal(reset.evidence.action, undefined);
  f.append(result('replacement'));
  assert.equal((await f.reader.read()).evidence.action?.id, 'replacement');
});

test('D1 failed native reads cannot leak background launches before retry', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a'), call('late')]);
  const original = RecoveryIndexOverlay.prototype.get;
  const mock = t.mock.method(
    RecoveryIndexOverlay.prototype,
    'get',
    function (this: RecoveryIndexOverlay, namespace: string, key: string) {
      if (key.startsWith('message-late:')) throw new Error('synthetic background read failure');
      return original.call(this, namespace, key);
    }
  );
  await assert.rejects(f.reader.read(), /synthetic background read failure/);
  mock.mock.restore();
  const retried = await f.reader.read();
  assert.equal(retried.evidence.background?.tasks.length, 1);
  assert.equal(retried.evidence.action?.id, 'bash-a');
});

test('D1 background identity overflow is explicit and suppresses current-action claims', async (t) => {
  const f = fixture(t, [call('seed')]);
  const checkpoint = (await f.reader.read()).checkpoint;
  const projection = new ClaudeBackgroundProjection(true);
  const events: ClaudeBackgroundEvent[] = Array.from({ length: MAX_BACKGROUND_IDENTITIES + 1 }, (_, i) => ({
    kind: 'call',
    tool: 'Bash',
    callId: `synthetic-${i}`,
    at: TIME,
    observedTime: false,
  }));
  projection.apply(checkpoint, events, false);
  const result = projection.view({ state: 'complete', gaps: [], skipped: {}, loaded: true });
  assert.equal(result.action, undefined);
  assert.equal(result.background.coverage, 'partial');
  assert.ok(result.background.gaps.includes('background_identity_limit'));
});

test('D1 malformed duplicate notification tags cannot manufacture completion', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  f.append(
    notice('task-a', {
      message: {
        content: xml().replace('<status>completed</status>', '<status>running</status><status>completed</status>'),
      },
    })
  );
  assert.equal((await f.reader.read()).evidence.background?.tasks.length, 1);
});

test('D1 a failed record cannot leak a Bash call into a later acknowledgement', async (t) => {
  const f = fixture(t, [call('bash-a')]);
  const original = RecoveryIndexOverlay.prototype.get;
  const mock = t.mock.method(
    RecoveryIndexOverlay.prototype,
    'get',
    function (this: RecoveryIndexOverlay, namespace: string, key: string) {
      if (namespace === 'claude.pendingTodoUpdates') throw new SyntaxError('synthetic rejected background record');
      return original.call(this, namespace, key);
    }
  );
  await f.reader.read();
  mock.mock.restore();
  f.append(result('bash-a'));
  assert.deepEqual((await f.reader.read()).evidence.background?.tasks, []);
});

test('D1 future native timestamps do not produce negative elapsed-time actions', async (t) => {
  const f = fixture(t, [
    call('bash-a', 'Bash', {}, Date.now() - TIME + 60000),
    result('bash-a', 'task-a', {}, Date.now() - TIME + 61000),
  ]);
  const resultValue = await f.reader.read();
  assert.equal(resultValue.evidence.action, undefined);
  assert.equal(resultValue.evidence.background?.tasks.length, 1);
});

test('D1 unreadable native notifications mark background coverage partial rather than guessing', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  f.append(notice('task-a', { message: { content: xml('task-a', 'running') } }));
  assert.equal((await f.reader.read()).evidence.action?.id, 'bash-a');
  f.append(notice('task-a', { message: { content: xml().replace(SECRET, 'x'.repeat(9000)) } }));
  const unreadable = await f.reader.read();
  assert.equal(unreadable.evidence.action, undefined);
  assert.equal(unreadable.evidence.background?.coverage, 'partial');
  assert.ok(unreadable.evidence.background?.gaps.includes('background_notification_unreadable'));
  assert.equal(unreadable.evidence.background?.tasks.length, 1);
});

test('D1 native call-ID reuse by another tool cannot create or retain background action', async (t) => {
  const f = fixture(t, [
    call('first'),
    call('first', 'Read'),
    result('first'),
    call('second', 'Read'),
    call('second'),
    result('second'),
  ]);
  const rejected = await f.reader.read();
  assert.deepEqual(rejected.evidence.background?.tasks, []);
  assert.ok(rejected.evidence.background?.gaps.includes('background_call_conflict'));
  const g = fixture(t, [call('live'), result('live')]);
  assert.equal((await g.reader.read()).evidence.action?.id, 'live');
  g.append(call('live', 'Read'));
  const changed = await g.reader.read();
  assert.deepEqual(changed.evidence.background?.tasks, []);
  assert.equal(changed.evidence.action, undefined);
});

test('D1 recognized native notification without a payload cannot leave complete action claims', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  f.append(row('attachment', { attachment: { type: 'queued_command', commandMode: 'task-notification' } }));
  const missing = await f.reader.read();
  assert.equal(missing.evidence.action, undefined);
  assert.ok(missing.evidence.background?.gaps.includes('background_notification_unreadable'));
  assert.equal(missing.evidence.background?.coverage, 'partial');
});

test('D1 terminal tombstones retain the known launch owner and detect reused handles', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a'), notice(), call('bash-b'), result('bash-b')]);
  const reused = await f.reader.read();
  assert.equal(reused.evidence.action, undefined);
  assert.ok(reused.evidence.background?.gaps.includes('background_task_conflict'));
  const g = fixture(t, [notice(), call('first'), result('first'), call('second'), result('second')]);
  const early = await g.reader.read();
  assert.ok(early.evidence.background?.gaps.includes('background_task_conflict'));
  assert.deepEqual(early.evidence.background?.tasks, []);
});

test('D1 top-level queued notification provenance is accepted but unsupported task-status envelopes stay unknown', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  await f.reader.read();
  f.append(
    row('attachment', { origin: { kind: 'task-notification' }, attachment: { type: 'queued_command', prompt: xml() } })
  );
  assert.deepEqual((await f.reader.read()).evidence.background?.tasks, []);
  const g = fixture(t, [call('bash-a'), result('bash-a')]);
  await g.reader.read();
  g.append(row('attachment', { attachment: { type: 'task_status', taskId: 'task-a', status: 'completed' } }));
  const unsupported = await g.reader.read();
  assert.equal(unsupported.evidence.action, undefined);
  assert.ok(unsupported.evidence.background?.gaps.includes('background_status_unverified'));
  assert.equal(unsupported.evidence.background?.tasks.length, 1);
});

test('D1 repeated TaskOutput IDs retain the exact accepted target and flag later target substitution', async (t) => {
  const f = fixture(t, [
    call('bash-a'),
    result('bash-a'),
    call('bash-b'),
    result('bash-b', 'task-b'),
    call('query', 'TaskOutput', { task_id: 'task-a' }),
    result('query', 'unused', {
      toolUseResult: {
        retrieval_status: 'success',
        task: { task_id: 'task-a', task_type: 'local_bash', status: 'completed' },
      },
    }),
  ]);
  assert.equal((await f.reader.read()).evidence.action?.id, 'bash-b');
  f.append(call('query', 'TaskOutput', { task_id: 'task-b' }));
  const conflict = await f.reader.read();
  assert.equal(conflict.evidence.action, undefined);
  assert.ok(conflict.evidence.background?.gaps.includes('background_call_conflict'));
});

test('D1 exact background ACK replay is stable but a different task handle for the same call is ambiguous', async (t) => {
  const f = fixture(t, [call('bash-a'), result('bash-a')]);
  const first = await f.reader.read();
  f.append(result('bash-a', 'task-a', {}, 4000));
  assert.deepEqual((await f.reader.read()).evidence.background, first.evidence.background);
  f.append(result('bash-a', 'task-b', {}, 5000));
  const conflict = await f.reader.read();
  assert.deepEqual(conflict.evidence.background?.tasks, []);
  assert.equal(conflict.evidence.action, undefined);
  assert.ok(conflict.evidence.background?.gaps.includes('background_call_conflict'));
});

test('D1 unbound or malformed native lifecycle envelopes cannot keep a complete current-action claim', async (t) => {
  for (const extra of [
    { sessionId: undefined },
    { isSidechain: 'false' },
    { message: { role: 'assistant', content: xml() } },
    { timestamp: '1969-12-31T23:59:59Z' },
  ]) {
    const f = fixture(t, [call('bash-a'), result('bash-a')]);
    await f.reader.read();
    f.append(notice('task-a', extra));
    const unverified = await f.reader.read();
    assert.equal(unverified.evidence.action, undefined);
    assert.equal(unverified.evidence.background?.coverage, 'partial');
    assert.ok(unverified.evidence.background?.gaps.includes('background_envelope_unverified'));
    assert.equal(unverified.evidence.background?.tasks.length, 1);
  }
});

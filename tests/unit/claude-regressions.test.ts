import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeReader } from '../../src/harness/claude/reader.js';
import { assistant, row, user, launch, CLAIM, PRIVATE, SESSION } from '../fixtures/claude/transcripts.js';
function setup(t: test.TestContext, lines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const options = {
    ref: { harness: 'claude' as const, sourceId: 'e'.repeat(64), sessionId: SESSION, threadId: null },
    resolveFile: () => file,
    serverNames: ['hud'],
  };
  return { file, options, reader: createClaudeReader(options) };
}
test('Claude resets same-inode same-size rewrites before reusing evidence', async (t) => {
  const f = setup(t, [assistant('synthetic-a')]);
  const first = await f.reader.read();
  const replacement =
    assistant('synthetic-b', {
      input_tokens: 200,
      output_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    }) + '\n';
  assert.equal(Buffer.byteLength(replacement), fs.statSync(f.file).size);
  fs.writeFileSync(f.file, replacement);
  fs.utimesSync(f.file, new Date(), new Date(Date.now() + 1000));
  const changed = await f.reader.read();
  assert.equal(changed.checkpoint.resetReason, 'file_changed');
  assert.equal(changed.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  assert.equal(changed.observation.spent.tokens.value?.input, 200);
});
test('Claude keeps parallel tool facts distinct across checkpoint recovery', async (t) => {
  const f = setup(t, [
    assistant('synthetic-parallel', undefined, 0, [
      { type: 'tool_use', id: 'call-a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'call-b', name: 'Read', input: {} },
    ]),
  ]);
  const first = await f.reader.read();
  assert.deepEqual(
    first.inputs
      .filter((e) => (e.value as { kind: string }).kind === 'tool_started')
      .map((e) => (e.value as { callId: string }).callId),
    ['call-a', 'call-b']
  );
  fs.appendFileSync(
    f.file,
    row(
      'user',
      {
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-a', content: 'synthetic' },
            { type: 'tool_result', tool_use_id: 'call-b', content: 'synthetic' },
          ],
        },
      },
      2000
    ) + '\n'
  );
  const restored = await createClaudeReader(f.options, JSON.parse(JSON.stringify(first.checkpoint))).read();
  assert.deepEqual(
    restored.inputs
      .filter((e) => (e.value as { kind: string }).kind === 'tool_finished')
      .map((e) => (e.value as { callId: string }).callId),
    ['call-a', 'call-b']
  );
  assert.equal(restored.checkpoint.parserState.openToolWaits.length, 0);
});
test('Claude never refreshes an evicted duplicate native fact after restart', async (t) => {
  const original = JSON.parse(user('Synthetic original', 0));
  delete original.timestamp;
  const f = setup(t, [JSON.stringify(original)]);
  const first = await f.reader.read();
  const originalFact = first.inputs[0];
  fs.appendFileSync(
    f.file,
    Array.from({ length: 110 }, (_, n) => user('Synthetic intervening', 1000 + n)).join('\n') + '\n'
  );
  const evicted = await f.reader.read();
  assert.ok(!evicted.inputs.some((e) => e.evidenceId === originalFact.evidenceId));
  fs.appendFileSync(f.file, JSON.stringify(original) + '\n');
  const restored = await createClaudeReader(f.options, JSON.parse(JSON.stringify(evicted.checkpoint))).read();
  assert.ok(!restored.inputs.some((e) => e.evidenceId === originalFact.evidenceId));
  assert.equal(
    Object.assign({}, ...restored.checkpoint.claude.factClockPages, restored.checkpoint.claude.factClocks)[
      'synthetic-record-0:user_message'
    ],
    first.checkpoint.claude.factClocks['synthetic-record-0:user_message']
  );
  assert.equal(
    restored.observation.statusProjection.lastEvidenceAt,
    evicted.observation.statusProjection.lastEvidenceAt
  );
});
test('Claude partial private and fallback launch lines persist no raw bytes and charge rereads', async (t) => {
  for (const line of [row('api-request-blob', { secret: PRIVATE }), launch()]) {
    const f = setup(t, [line]);
    const cut = line.indexOf(line.includes(CLAIM) ? CLAIM : PRIVATE) + 4;
    fs.writeFileSync(f.file, line.slice(0, cut));
    const partial = await f.reader.read();
    assert.equal(partial.checkpoint.offset, 0);
    assert.deepEqual(partial.checkpoint.parserState.pendingBytes, []);
    assert.equal(partial.observation.coverage.reason, 'incomplete_tail');
    assert.ok(!JSON.stringify(partial).includes(CLAIM));
    assert.ok(!JSON.stringify(partial).includes(PRIVATE));
    fs.appendFileSync(f.file, line.slice(cut) + '\n');
    const recovered = await createClaudeReader(f.options, JSON.parse(JSON.stringify(partial.checkpoint))).read();
    assert.equal(recovered.stats?.bytesRead, Buffer.byteLength(line) + 1);
    assert.equal(recovered.observation.coverage.state, 'complete');
  }
});

test('Claude live small slices progress while checkpoint recovery explicitly requests a larger slice', async (t) => {
  const f = setup(t, [assistant('synthetic-large', undefined, 0, [{ type: 'text', text: 'x'.repeat(8192) }])]);
  const budget = { maxBytes: 1024, maxRecords: 2000, budgetMs: 20 };
  const first = await f.reader.read(budget);
  const restored = createClaudeReader(f.options, JSON.parse(JSON.stringify(first.checkpoint)));
  const constrained = await restored.read(budget);
  assert.equal(constrained.continuation?.kind, 'record_needs_larger_slice');
  assert.equal(constrained.observation.coverage.state, 'partial');
  assert.equal(constrained.observation.coverage.reason, 'record_needs_larger_slice');
  let live = first;
  for (let n = 0; n < 20 && live.checkpoint.offset === 0; n++) live = await f.reader.read(budget);
  assert.equal(live.observation.spent.tokens.value?.input, 100);
  assert.equal(live.checkpoint.offset, fs.statSync(f.file).size);
  const recovered = await restored.read();
  assert.equal(recovered.observation.spent.tokens.value?.input, 100);
});
test('Claude consumed-boundary signatures reject growing rewrites on the same inode', async (t) => {
  const f = setup(t, [assistant('synthetic-a')]);
  const first = await f.reader.read();
  fs.writeFileSync(
    f.file,
    assistant(
      'synthetic-b',
      { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
      0,
      [{ type: 'text', text: 'x'.repeat(4096) }]
    ) + '\n'
  );
  const rewritten = await f.reader.read();
  assert.ok(rewritten.stats!.bytesRead >= first.checkpoint.claude.boundarySignature!.length);
  assert.equal(rewritten.checkpoint.resetReason, 'file_changed');
  assert.equal(rewritten.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  assert.equal(rewritten.observation.spent.tokens.value?.input, 200);
});

test('Claude detects changed record heads with unchanged padded tails and detaches usage values', async (t) => {
  const padding = [{ type: 'text', text: 'x'.repeat(4096) }];
  const f = setup(t, [assistant('synthetic-a', undefined, 0, padding)]);
  const first = await f.reader.read();
  const usage = first.observation.spent.tokens.value;
  fs.writeFileSync(
    f.file,
    assistant(
      'synthetic-b',
      { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
      0,
      padding
    ) +
      '\n' +
      assistant(
        'synthetic-c',
        { input_tokens: 300, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
        1000
      ) +
      '\n'
  );
  const changed = await f.reader.read();
  assert.equal(changed.observation.spent.tokens.value?.input, 500);
  assert.equal(changed.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  assert.equal(usage?.input, 100);
  changed.observation.spent.tokens.value!.input = 99999;
  const idle = await f.reader.read();
  assert.equal(idle.observation.spent.tokens.value?.input, 500);
  assert.equal(idle.observation.coverage.reason, 'append_only_assumed_bounded_signatures');
});

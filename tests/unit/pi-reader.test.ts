import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPiReader, MAX_RECORD_BYTES, type PiReaderResult } from '../../src/harness/pi/reader.js';
import type { SessionRef } from '../../src/core/types/identity.js';
const TIME = 1_800_000_000_000;
const ref: SessionRef = { harness: 'pi', sourceId: 'a'.repeat(64), sessionId: 'synthetic-session', threadId: null };
const header = {
  type: 'session',
  id: ref.sessionId,
  version: 3,
  timestamp: new Date(TIME).toISOString(),
  cwd: '/synthetic/project',
};
const assistant = (id = 'msg1', cost: number | undefined = 0.12) => ({
  type: 'message',
  id,
  timestamp: new Date(TIME + 1000).toISOString(),
  message: {
    role: 'assistant',
    model: 'synthetic-model',
    provider: 'synthetic',
    content: [
      { type: 'text', text: 'public' },
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      { type: 'image', data: 'PRIVATE_IMAGE' },
    ],
    stopReason: 'stop',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 190,
      ...(cost === undefined ? {} : { cost: { total: cost } }),
    },
  },
});
function fixture(t: test.TestContext, rows: unknown[] = [header, assistant()]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reader-'));
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { ref, resolveFile: () => file, contextWindow: 1000 };
  return { file, options, reader: createPiReader(options) };
}
async function drain(reader: ReturnType<typeof createPiReader>): Promise<PiReaderResult> {
  for (let i = 0; i < 100; i++) {
    const r = await reader.read();
    if (r.observation.coverage.state !== 'catching_up') return r;
  }
  throw new Error('reader failed to drain');
}
function append(file: string, rows: unknown[]) {
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
test('pi assistant usage excludes output from context, deduplicates spend, and never retains private content', async (t) => {
  const f = fixture(t, [header, assistant(), assistant()]);
  const r = await drain(f.reader);
  assert.deepEqual(r.observation.spent.tokens.value, { input: 100, output: 20, cacheRead: 30, cacheWrite: 40 });
  assert.equal(r.evidence.context.value?.used, 170);
  assert.equal(r.observation.spent.costUsd.value, 0.12);
  assert.equal(r.observation.coverage.state, 'complete');
  assert.equal(r.evidence.branchView, 'last_observed');
  assert.equal(r.evidence.cwd, '/synthetic/project');
  assert.equal(r.evidence.observation, r.observation);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
  const idle = await f.reader.read();
  assert.equal(idle.stats?.bytesRead, 0);
  assert.equal(idle.observation.spent.tokens.asOf, r.observation.spent.tokens.asOf);
});
test('pi compaction resets context, retains spend and exact usage IDs through JSON checkpoint restore', async (t) => {
  const f = fixture(t);
  const first = await drain(f.reader);
  append(f.file, [
    {
      type: 'compaction',
      id: 'compact1',
      timestamp: new Date(TIME + 2000).toISOString(),
      usage: { input: 9999, output: 9999, cost: { total: 999 } },
      summary: 'PRIVATE_SUMMARY',
    },
  ]);
  const compact = await drain(f.reader);
  assert.equal(compact.evidence.context.value, null);
  assert.equal(compact.observation.spent.costUsd.value, 0.12);
  assert.equal(compact.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  const restored = createPiReader(f.options, JSON.parse(JSON.stringify(compact.checkpoint)));
  append(f.file, [assistant(), assistant('msg2')]);
  const last = await drain(restored);
  assert.equal(last.observation.spent.tokens.value?.input, 200);
  assert.equal(last.observation.spent.costUsd.value, 0.24);
  assert.equal(last.evidence.context.value?.used, 170);
  assert.ok(!JSON.stringify(last).includes('PRIVATE_SUMMARY'));
});
test('pi cache warm is separate, custom question retains metadata only, and model/effort come from native events', async (t) => {
  const f = fixture(t, [
    header,
    { type: 'model_change', modelId: 'model2', provider: 'provider2' },
    { type: 'thinking_level_change', thinkingLevel: 'high' },
    { type: 'usage', kind: 'cache_warm', usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 4 } },
    { type: 'custom', customType: 'ask_orchestrator', id: 'question1', data: { question: 'PRIVATE_QUESTION' } },
  ]);
  const r = await drain(f.reader);
  assert.equal(r.observation.spent.tokens.value, null);
  assert.equal(r.evidence.cacheWarm.value?.input, 10);
  assert.equal(r.evidence.model.value?.id, 'model2');
  assert.equal(r.observation.effort?.value, 'high');
  assert.equal((r.inputs.at(-1)?.value as { pendingReason: string }).pendingReason, 'question');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_QUESTION'));
});
test('pi missing cost is unknown independently of tokens; explicit zero is reported', async (t) => {
  const f = fixture(t, [header, assistant('zero', 0)]);
  let r = await drain(f.reader);
  assert.equal(r.observation.spent.costUsd.value, 0);
  assert.equal(r.observation.spent.costUsd.quality, 'reported');
  const missing = assistant('unknown');
  delete (missing.message.usage as { cost?: unknown }).cost;
  append(f.file, [missing]);
  r = await drain(f.reader);
  assert.equal(r.observation.spent.tokens.value?.input, 200);
  assert.equal(r.observation.spent.costUsd.value, null);
  assert.equal(r.observation.spent.costUsd.quality, 'unknown');
});
test('pi byte/record budgets and zero-budget discovery are enforced; concurrent reads serialize', async (t) => {
  const f = fixture(t, [header, assistant('a'), assistant('b')]);
  let resolutions = 0;
  const reader = createPiReader({
    ...f.options,
    resolveFile: () => {
      resolutions++;
      return f.file;
    },
  });
  const zero = await reader.read({ maxBytes: 0, maxRecords: 1, budgetMs: 20 });
  assert.equal(resolutions, 0);
  assert.equal(zero.stats?.bytesRead, 0);
  const [a, b] = await Promise.all([
    reader.read({ maxBytes: 1000, maxRecords: 1, budgetMs: 20 }),
    reader.read({ maxBytes: 1000, maxRecords: 1, budgetMs: 20 }),
  ]);
  assert.equal(a.stats?.recordsRead, 1);
  assert.equal(b.stats?.recordsRead, 1);
  assert.ok(a.stats!.bytesRead <= 1000 && b.stats!.bytesRead <= 1000);
  assert.ok(b.checkpoint.offset > a.checkpoint.offset);
  const end = await drain(reader);
  assert.equal(end.observation.spent.tokens.value?.input, 200);
});
test('pi incomplete UTF-8 tail is transient, survives restore by replay, and completes without LF', async (t) => {
  const f = fixture(t, [header]);
  await drain(f.reader);
  const row = JSON.stringify({ ...assistant('tail'), extra: 'PRIVATE_TAIL_秘密' });
  const bytes = Buffer.from(row);
  fs.appendFileSync(f.file, bytes.subarray(0, bytes.length - 3));
  const partial = await f.reader.read();
  assert.equal(partial.observation.coverage.reason, 'incomplete_tail');
  assert.deepEqual(partial.checkpoint.parserState.pendingBytes, []);
  assert.ok(!JSON.stringify(partial).includes('PRIVATE_TAIL'));
  const restored = createPiReader(f.options, JSON.parse(JSON.stringify(partial.checkpoint)));
  const small = await restored.read({ maxBytes: 20, maxRecords: 10, budgetMs: 20 });
  assert.equal(small.continuation?.kind, 'record_needs_larger_slice');
  fs.appendFileSync(f.file, bytes.subarray(bytes.length - 3));
  const complete = await drain(restored);
  assert.equal(complete.observation.spent.tokens.value?.input, 100);
  assert.equal(complete.observation.coverage.state, 'complete');
});
test('pi oversized record is discarded with a durable cursor and no material leakage', async (t) => {
  const f = fixture(t, [header]);
  await drain(f.reader);
  fs.appendFileSync(f.file, JSON.stringify({ type: 'message', private: 'x'.repeat(MAX_RECORD_BYTES + 1000) }) + '\n');
  append(f.file, [assistant('after')]);
  const r = await drain(f.reader);
  assert.equal(r.observation.coverage.skipped.oversize_unknown, 1);
  assert.equal(r.observation.coverage.state, 'partial');
  assert.equal(r.observation.spent.tokens.value?.input, 100);
  assert.ok(JSON.stringify(r.checkpoint).length < 20_000);
});
test('pi file replacement and truncation reset source generation and cannot splice a fork ID', async (t) => {
  const f = fixture(t);
  const first = await drain(f.reader);
  const replacement = f.file + '.new';
  fs.writeFileSync(replacement, [header, assistant('new')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(replacement, f.file);
  const next = await drain(f.reader);
  assert.equal(next.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  assert.equal(next.observation.spent.tokens.value?.input, 100);
  fs.writeFileSync(f.file, JSON.stringify({ ...header, id: 'fork' }) + '\n');
  await assert.rejects(f.reader.read(), /pi_session_mismatch/);
  // The failed read rolls back the complete prior observation boundary.
  fs.writeFileSync(f.file, JSON.stringify(header) + '\n');
  const reset = await drain(f.reader);
  assert.equal(reset.observation.spent.tokens.value, null);
});
test('pi malformed negative usage, unknown branch and corrupt checkpoint fail closed', async (t) => {
  const bad = assistant();
  bad.message.usage.input = -1;
  const f = fixture(t, [header, bad, { type: 'branch_summary', id: 'branch1', summary: 'PRIVATE_BRANCH' }]);
  const r = await drain(f.reader);
  assert.equal(r.observation.spent.tokens.value, null);
  assert.ok(r.observation.coverage.gaps.includes('malformed_usage'));
  assert.ok(r.observation.coverage.gaps.includes('branch_navigation_unverified'));
  assert.ok(!JSON.stringify(r).includes('PRIVATE_BRANCH'));
  const cp = JSON.parse(JSON.stringify(r.checkpoint));
  cp.parserState.pendingBytes = [1];
  assert.throws(() => createPiReader(f.options, cp), /unsupported_pi_checkpoint/);
});
test('pi repeated untimed entry IDs do not refresh fact clocks after restore', async (t) => {
  const a = assistant('untimed');
  delete (a as { timestamp?: string }).timestamp;
  const f = fixture(t, [header, a]);
  const first = await drain(f.reader);
  const restored = createPiReader(f.options, JSON.parse(JSON.stringify(first.checkpoint)));
  append(f.file, [a]);
  const second = await drain(restored);
  assert.deepEqual(
    second.inputs.map((f) => f.value),
    first.inputs.map((f) => f.value)
  );
  assert.equal(second.evidence.model.asOf, first.evidence.model.asOf);
  assert.equal(second.observation.spent.tokens.asOf, first.observation.spent.tokens.asOf);
});
test('pi checkpoint uses the existing structured preparation API without shared schema changes', async (t) => {
  const { prepareCheckpoint, checkpointBoundary, checkpointFormat, preparedCheckpointData } =
    await import('../../src/core/checkpoint.js');
  const f = fixture(t);
  const r = await drain(f.reader);
  const token = prepareCheckpoint({
    checkpoint: r.checkpoint,
    boundary: checkpointBoundary(r.checkpoint),
    format: checkpointFormat(r.checkpoint),
    recoveryReferences: [],
  });
  assert.ok(Buffer.byteLength(preparedCheckpointData(token).body) < 256 * 1024);
  assert.equal(token.identity.ref.harness, 'pi');
  assert.equal(token.identity.recoveryReferences[0].recoveryVersion, 'pi-recovery-1');
});
test('pi lazy recovery defers I/O until positive read and charges a bounded slice', async (t) => {
  const { prepareCheckpoint, checkpointBoundary, checkpointFormat } = await import('../../src/core/checkpoint.js');
  const f = fixture(t);
  const result = await drain(f.reader);
  const token = prepareCheckpoint({
    checkpoint: result.checkpoint,
    boundary: checkpointBoundary(result.checkpoint),
    format: checkpointFormat(result.checkpoint),
    recoveryReferences: [],
  });
  const values = new Map(
    result.checkpoint.recoveryIndex!.delta.entries.map((e) => [JSON.stringify([e.namespace, e.key]), e.value!])
  );
  let reads = 0;
  const lookup: import('../../src/core/types/checkpoint.js').RecoveryIndexLookup = {
    reference: token.identity.recoveryReferences[0],
    get() {
      throw new Error('unmetered lookup must never run');
    },
    page() {
      throw new Error('pages must never run');
    },
    getMetered(grant, namespace, key) {
      reads++;
      const value = values.get(JSON.stringify([namespace, key]));
      const stats = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 };
      const bytes = value === undefined ? 0 : Buffer.byteLength(value);
      if (bytes > grant.remaining().maxBytes) return { kind: 'refused', reason: 'bytes', minimumBytes: bytes, stats };
      if (value !== undefined && grant.remaining().maxRecords < 1) return { kind: 'refused', reason: 'records', stats };
      stats.bytesRead = bytes;
      stats.recordsRead = value === undefined ? 0 : 1;
      grant.charge(stats);
      return { kind: 'value', value, stats };
    },
  };
  const checkpoint = {
    ...result.checkpoint,
    recoveryIndex: { delta: { recoveryVersion: 'pi-recovery-1', base: lookup.reference, entries: [] }, lookup },
  };
  const reader = createPiReader(f.options, checkpoint);
  assert.equal(reads, 0);
  const zero = await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(reads, 0);
  assert.equal(zero.stats?.bytesRead, 0);
  const small = await reader.read({ maxBytes: 1, maxRecords: 1, budgetMs: 20 });
  assert.equal(small.stats?.bytesRead, 0);
  assert.equal(small.continuation?.kind, 'record_needs_larger_slice');
  const recovered = await reader.read({ maxBytes: 4 * 1024 * 1024, maxRecords: 1, budgetMs: 20 });
  assert.equal(recovered.stats?.recordsRead, 1);
  assert.equal(recovered.checkpoint.offset, result.checkpoint.offset);
  assert.equal(recovered.observation.spent.tokens.value?.input, 100);
  const after = reads;
  await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(reads, after);
  append(f.file, [assistant('lazy-next')]);
  fs.appendFileSync(f.file, JSON.stringify(assistant()));
  const next = await reader.read({ maxBytes: 4 * 1024 * 1024, maxRecords: 2, budgetMs: 20 });
  assert.equal(next.stats!.recordsRead, 2);
  assert.ok(next.checkpoint.offset > result.checkpoint.offset);
  const final = await reader.read({ maxBytes: 4 * 1024 * 1024, maxRecords: 2, budgetMs: 20 });
  assert.equal(final.stats!.recordsRead, 2);
  assert.equal(final.observation.spent.tokens.value?.input, 200);
});

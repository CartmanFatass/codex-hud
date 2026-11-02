import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClaudeReader, type ClaudeCheckpoint, type ClaudeReaderResult } from '../../src/harness/claude/reader.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { ReaderBudget } from '../../src/core/interfaces/harness-adapter.js';
import {
  SESSION,
  PRIVATE,
  CLAIM,
  TIME,
  CWD,
  MiB,
  row,
  user,
  assistant,
  compact,
  launch,
  toolUse,
  toolResult,
  initial,
  appendSyntheticTranscript,
} from '../fixtures/claude/transcripts.js';

function fixture(t: test.TestContext, lines: string[] = initial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reader-'));
  const previousHome = process.env.HUD_HOME;
  process.env.HUD_HOME = path.join(root, 'hud');
  fs.mkdirSync(process.env.HUD_HOME);
  t.after(() => {
    if (previousHome === undefined) delete process.env.HUD_HOME;
    else process.env.HUD_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, SESSION + '.jsonl');
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
  const ref: SessionRef = {
    harness: 'claude',
    sourceId: 'e'.repeat(64),
    sessionId: SESSION,
    threadId: null,
  };
  const options = {
    ref,
    resolveFile: () => file,
    serverNames: ['hud'],
    statusline: {
      session_id: SESSION,
      transcript_path: file,
      model: { id: 'claude-statusline-synthetic' },
      context_window: { context_window_size: 1000 },
    },
  };
  return { root, file, ref, options, reader: createClaudeReader(options) };
}

async function drain(
  reader: ReturnType<typeof createClaudeReader>,
  budget: ReaderBudget = { maxBytes: 4 * MiB, maxRecords: 2000, budgetMs: 20 }
): Promise<ClaudeReaderResult> {
  for (let n = 0; n < 2000; n++) {
    const result = await reader.read(budget);
    if (result.observation.coverage.state !== 'catching_up') return result;
  }
  throw new Error('synthetic Claude reader did not catch up');
}

function roundtrip(result: ClaudeReaderResult): ClaudeCheckpoint {
  return JSON.parse(JSON.stringify(result.checkpoint)) as ClaudeCheckpoint;
}

test('Claude usage is deduplicated by message.id and public evidence excludes private content', async (t) => {
  const f = fixture(t);
  const result = await drain(f.reader);
  assert.deepEqual(result.observation.spent.tokens.value, { input: 100, output: 10, cacheRead: 20, cacheWrite: 30 });
  assert.equal(result.evidence.context.value?.used, 150);
  assert.equal(result.evidence.context.value?.window, 1000);
  assert.equal(result.evidence.model.value?.id, 'claude-statusline-synthetic');
  assert.equal(result.observation.spent.costUsd.value, null);
  assert.equal(result.observation.spent.costUsd.quality, 'unknown');
  assert.strictEqual(result.evidence.observation, result.observation);
  assert.strictEqual(result.inputs, result.evidence.inputs);
  assert.equal(result.evidence.cwd, CWD);
  assert.equal(result.evidence.cwdSource, 'transcript');
  assert.equal(result.evidence.cwdAsOf, TIME + 1100);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
  assert.ok(result.observation.coverage.skipped['api-request-blob'] >= 1);
  assert.equal(result.observation.coverage.state, 'complete');
  const idle = await f.reader.read();
  assert.equal(idle.stats?.bytesRead, 0);
  assert.equal(idle.stats?.recordsRead, 0);
  assert.equal(idle.observation.spent.tokens.asOf, result.observation.spent.tokens.asOf);
});

test('Claude compact invalidates context but preserves cumulative usage IDs across checkpoint recovery', async (t) => {
  const f = fixture(t, [assistant(), compact()]);
  const first = await drain(f.reader);
  assert.equal(first.evidence.context.value, null);
  assert.equal(first.observation.spent.tokens.value?.input, 100);
  fs.appendFileSync(
    f.file,
    [
      assistant(),
      assistant(
        'synthetic-message-2',
        { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 6, cache_creation_input_tokens: 4 },
        5000
      ),
    ].join('\n') + '\n'
  );
  const recovered = await drain(createClaudeReader(f.options, roundtrip(first)));
  assert.equal(recovered.observation.spent.tokens.value?.input, 140);
  assert.equal(recovered.observation.spent.tokens.value?.output, 15);
  assert.equal(recovered.evidence.context.value?.used, 50);
});

test('Claude byte and record budgets continue with the complete merge state after JSON serialization', async (t) => {
  const f = fixture(t, [user(), assistant(), toolUse(), toolResult(), assistant('synthetic-last')]);
  const first = await f.reader.read({ maxBytes: 71, maxRecords: 1, budgetMs: 20 });
  assert.ok(first.checkpoint.offset <= 71);
  assert.deepEqual(first.checkpoint.parserState.pendingBytes, []);
  assert.equal(first.checkpoint.offset, 0);
  assert.equal(first.observation.coverage.state, 'catching_up');
  assert.ok((first.observation.coverage.remainingBytes ?? 0) > 0);
  let reader = createClaudeReader(f.options, roundtrip(first));
  let result = first;
  while (result.observation.coverage.state === 'catching_up') {
    result = await reader.read({ maxBytes: 4096, maxRecords: 1, budgetMs: 20 });
    assert.ok((result.stats?.recordsRead ?? 0) <= 1);
    reader = createClaudeReader(f.options, roundtrip(result));
  }
  const expected = await drain(createClaudeReader(f.options));
  assert.deepEqual(result.observation.spent.tokens.value, expected.observation.spent.tokens.value);
  assert.deepEqual(result.evidence.linkEvidence, expected.evidence.linkEvidence);
  assert.equal(result.checkpoint.offset, fs.statSync(f.file).size);
});

test('Claude zero budgets and expired shared deadlines do not advance the cursor', async (t) => {
  const f = fixture(t);
  for (const budget of [
    { maxBytes: 0, maxRecords: 2000, budgetMs: 20 },
    { maxBytes: MiB, maxRecords: 0, budgetMs: 20 },
    { maxBytes: MiB, maxRecords: 2000, budgetMs: 0 },
    { maxBytes: MiB, maxRecords: 2000, budgetMs: 20, deadlineMs: performance.now() - 1 },
  ]) {
    const result = await f.reader.read(budget);
    assert.equal(result.checkpoint.offset, 0);
    assert.equal(result.stats?.bytesRead, 0);
    assert.equal(result.observation.coverage.state, 'catching_up');
  }
  assert.equal((await drain(f.reader)).observation.coverage.state, 'complete');
});

test('Claude preserves UTF-8 bytes and CRLF partial tails, including a final record without newline', async (t) => {
  const f = fixture(t, []);
  const text = assistant();
  const bytes = Buffer.from(text);
  const splitAt = bytes.indexOf(Buffer.from('中')) + 1;
  fs.writeFileSync(f.file, bytes.subarray(0, splitAt));
  const partial = await f.reader.read();
  assert.deepEqual(partial.checkpoint.parserState.pendingBytes, []);
  assert.equal(partial.checkpoint.offset, 0);
  assert.equal(partial.observation.spent.tokens.value, null);
  fs.appendFileSync(f.file, Buffer.concat([bytes.subarray(splitAt), Buffer.from('\r')]));
  const recovered = createClaudeReader(f.options, roundtrip(partial));
  const complete = await drain(recovered);
  assert.equal(complete.observation.spent.tokens.value?.input, 100);
  fs.appendFileSync(f.file, '\n' + assistant('synthetic-final', undefined, 6000));
  const final = await drain(recovered);
  assert.equal(final.observation.spent.tokens.value?.input, 200);
  assert.equal(final.checkpoint.offset, fs.statSync(f.file).size);
  assert.ok(final.evidence.reports.some((report) => report.text.includes('中文')));
});

test('Claude whitelist marks unknown types and oversized lines without retaining their payload', async (t) => {
  const f = fixture(t, [
    row('unrecognized-synthetic-type', { secret: PRIVATE }),
    row('unrecognized-synthetic-large', { data: PRIVATE + 'x'.repeat(MiB + 100) }),
    row('api-request-blob', { data: PRIVATE + 'x'.repeat(MiB + 100) }),
    assistant(),
  ]);
  const first = await f.reader.read({ maxBytes: MiB / 2, maxRecords: 2000, budgetMs: 20 });
  assert.ok(first.checkpoint.parserState.pendingBytes.length <= MiB);
  const result = await drain(createClaudeReader(f.options, roundtrip(first)));
  assert.equal(result.observation.spent.tokens.value?.input, 100);
  assert.ok(result.observation.coverage.gaps.length > 0);
  assert.ok(Object.values(result.observation.coverage.skipped).reduce((sum, n) => sum + n, 0) >= 3);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
  assert.ok(result.checkpoint.parserState.pendingBytes.length <= MiB);
});

test('Claude source truncation and inode replacement reset totals and increment source generation', async (t) => {
  const f = fixture(t, [assistant(), assistant('synthetic-longer')]);
  const first = await drain(f.reader);
  fs.writeFileSync(f.file, assistant('synthetic-short') + '\n');
  const truncated = await drain(f.reader);
  assert.equal(truncated.checkpoint.resetReason, 'truncated');
  assert.equal(truncated.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  assert.equal(truncated.observation.spent.tokens.value?.input, 100);
  const replacement = path.join(f.root, 'replacement.jsonl');
  fs.writeFileSync(replacement, assistant('synthetic-replacement') + '\n');
  fs.renameSync(replacement, f.file);
  const replaced = await drain(f.reader);
  assert.equal(replaced.checkpoint.resetReason, 'file_changed');
  assert.equal(replaced.checkpoint.sourceGeneration, truncated.checkpoint.sourceGeneration + 1);
  assert.equal(replaced.observation.spent.tokens.value?.input, 100);
});

test('Claude only pairs exact configured HUD tool calls with corresponding tool results', async (t) => {
  const f = fixture(t, [
    toolResult('unmatched'),
    toolUse('lookalike', 'mcp__other_hud__delegate_spawn'),
    toolResult('lookalike', 'run-lookalike'),
    toolUse('valid'),
    toolResult('valid'),
    toolUse('suffix', 'mcp__hud__delegate_spawn_extra'),
    toolResult('suffix', 'run-suffix'),
  ]);
  const result = await drain(f.reader);
  assert.equal(result.evidence.linkEvidence.length, 1);
  const anchor = result.evidence.linkEvidence[0];
  assert.equal(anchor.kind, 'tool_result');
  assert.ok(anchor.kind === 'tool_result');
  assert.equal(anchor.callId, 'valid');
  assert.equal(anchor.runId, 'run-synthetic');
  assert.equal(anchor.tool, 'mcp__hud__delegate_spawn');
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test('Claude accepts public attachment toolUseResult envelopes while skipping other attachment payloads', async (t) => {
  const f = fixture(t, [
    toolUse('attached'),
    row('attachment', { attachment: { type: 'private-synthetic', data: PRIVATE } }, 1500),
    row(
      'attachment',
      {
        attachment: {
          type: 'toolUseResult',
          toolUseId: 'attached',
          toolUseResult: { linkId: 'link-attached', runId: 'run-attached' },
        },
      },
      2000
    ),
  ]);
  const result = await drain(f.reader);
  assert.equal(result.evidence.linkEvidence.length, 1);
  const anchor = result.evidence.linkEvidence[0];
  assert.ok(anchor.kind === 'tool_result');
  assert.equal(anchor.callId, 'attached');
  assert.equal(result.evidence.linkEvidence[0].linkId, 'link-attached');
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test('Claude launch markers use shared event-time anchors and retain each resume message', async (t) => {
  const f = fixture(t, [user('A normal first user prompt.'), launch()]);
  const first = await drain(f.reader);
  assert.deepEqual(first.evidence.linkEvidence, [
    {
      kind: 'launch_message',
      ref: f.ref,
      nativeMessageId: 'synthetic-record-0',
      linkId: 'link-synthetic',
      claimFingerprint: createHash('sha256').update(CLAIM).digest('hex'),
      eventAt: TIME,
    },
  ]);
  assert.ok(!('claude' in first.evidence));
  fs.appendFileSync(f.file, launch('link-synthetic', 'synthetic-resume-secret', 8000) + '\n');
  const resumed = await drain(createClaudeReader(f.options, roundtrip(first)));
  assert.equal(resumed.evidence.linkEvidence.length, 2);
  assert.equal(resumed.evidence.linkEvidence[1].nativeMessageId, 'synthetic-record-8000');
  assert.equal(resumed.evidence.linkEvidence[1].eventAt, TIME + 8000);
  assert.ok(!JSON.stringify(resumed).includes(CLAIM));
  assert.ok(!JSON.stringify(resumed).includes('synthetic-resume-secret'));
});

test('Claude launch anchors require a native event time and preserve copied-message candidates', async (t) => {
  const missing = JSON.parse(launch('link-missing-time', 'synthetic-missing-time-claim', 4000));
  delete missing.timestamp;
  const original = user(
    '[hud-launch] ' +
      JSON.stringify({
        linkId: 'link-synthetic',
        claim: CLAIM,
        launchCallId: 'call-synthetic',
        launchCorrelationId: 'correlation-synthetic',
      }),
    5000
  );
  const copy = JSON.parse(original);
  copy.uuid = 'synthetic-copy';
  const f = fixture(t, [JSON.stringify(missing), original, JSON.stringify(copy)]);
  const result = await drain(f.reader);
  assert.equal(result.evidence.linkEvidence.length, 2);
  assert.equal(result.observation.coverage.skipped.link_event_time_missing, 1);
  assert.deepEqual(
    result.evidence.linkEvidence.map((anchor) => anchor.nativeMessageId),
    ['synthetic-record-5000', 'synthetic-copy']
  );
  for (const anchor of result.evidence.linkEvidence) {
    assert.equal(anchor.kind, 'launch_message');
    assert.equal(anchor.eventAt, TIME + 5000);
    assert.equal(anchor.launchCallId, 'call-synthetic');
    assert.equal(anchor.launchCorrelationId, 'correlation-synthetic');
    assert.ok(!('runId' in anchor));
    assert.ok(!('tool' in anchor));
    assert.ok(!('callId' in anchor));
  }
  assert.ok(!JSON.stringify(result).includes(CLAIM));
  const old = roundtrip(result);
  old.readerVersion = 'claude-reader-2';
  assert.throws(() => createClaudeReader(f.options, old), /unsupported_claude_checkpoint/);
  const malformed = roundtrip(result);
  delete (malformed.claude.links[0] as Partial<{ eventAt: number }>).eventAt;
  assert.throws(() => createClaudeReader(f.options, malformed), /unsupported_claude_checkpoint/);
});

test('Claude fixture generation appends exact byte counts and incremental stats exclude the cold prefix', async (t) => {
  const f = fixture(t, []);
  const coldCount = appendSyntheticTranscript(f.file, MiB);
  assert.equal(fs.statSync(f.file).size, MiB);
  const before = await drain(f.reader);
  assert.equal(before.checkpoint.offset, MiB);
  assert.ok(coldCount > 1);
  const appendedCount = appendSyntheticTranscript(f.file, MiB, 10000);
  let bytes = 0;
  let records = 0;
  let result: ClaudeReaderResult;
  do {
    result = await f.reader.read({ maxBytes: 32768, maxRecords: 2000, budgetMs: 20 });
    bytes += result.stats?.bytesRead ?? 0;
    records += result.stats?.recordsRead ?? 0;
  } while (result.observation.coverage.state === 'catching_up');
  // Incomplete uncommitted tails are deliberately reread, and every fetched byte is charged.
  assert.ok(bytes >= MiB && bytes < 2 * MiB);
  assert.equal(records, appendedCount);
  assert.equal(result.checkpoint.offset, 2 * MiB);
});

test('Claude catching-up continuation finishes its fixed snapshot before reading later appends', async (t) => {
  const f = fixture(t, [user(), assistant()]);
  const originalSize = fs.statSync(f.file).size;
  const first = await f.reader.read({ maxBytes: 71, maxRecords: 1, budgetMs: 20 });
  fs.appendFileSync(f.file, assistant('synthetic-later-append', undefined, 9000) + '\n');
  const snapshot = await drain(createClaudeReader(f.options, roundtrip(first)));
  assert.equal(snapshot.checkpoint.offset, originalSize);
  assert.equal(snapshot.observation.spent.tokens.value?.input, 100);
  const next = await drain(createClaudeReader(f.options, roundtrip(snapshot)));
  assert.equal(next.checkpoint.offset, fs.statSync(f.file).size);
  assert.equal(next.observation.spent.tokens.value?.input, 200);
});

test('Claude oversized unterminated records retain discard state across EOF and checkpoint recovery', async (t) => {
  const f = fixture(t, []);
  fs.writeFileSync(f.file, row('unknown-oversized', { data: 'x'.repeat(MiB + 512) }));
  const discarded = await drain(f.reader);
  assert.equal(discarded.checkpoint.parserState.discardingOversize, true);
  assert.deepEqual(discarded.checkpoint.parserState.pendingBytes, []);
  assert.notEqual(discarded.observation.coverage.state, 'complete');
  fs.appendFileSync(f.file, '\n' + assistant() + '\n');
  const recovered = await drain(createClaudeReader(f.options, roundtrip(discarded)));
  assert.equal(recovered.checkpoint.parserState.discardingOversize, false);
  assert.equal(recovered.observation.spent.tokens.value?.input, 100);
  assert.equal(recovered.checkpoint.offset, fs.statSync(f.file).size);
});

test('Claude observed-time facts preserve their first clock and usage clock when duplicate records recur', async (t) => {
  let now = 1900000000000;
  t.mock.method(Date, 'now', () => now);
  const record = JSON.parse(assistant()) as Record<string, unknown>;
  delete record.timestamp;
  const line = JSON.stringify(record);
  const f = fixture(t, [line]);
  const before = await drain(f.reader);
  const original = before.inputs.find((input) => (input.value as { kind?: string }).kind === 'assistant_message');
  assert.ok(original);
  assert.equal(original.eventAt, null);
  const firstObservedAt = (original.value as { firstObservedAt: number }).firstObservedAt;
  now += 5000;
  const idle = await f.reader.read();
  assert.equal(idle.observation.spent.tokens.asOf, before.observation.spent.tokens.asOf);
  fs.appendFileSync(f.file, line + '\n');
  const duplicate = await drain(createClaudeReader(f.options, roundtrip(idle)));
  assert.equal(duplicate.observation.spent.tokens.value?.input, 100);
  assert.equal(duplicate.observation.spent.tokens.asOf, before.observation.spent.tokens.asOf);
  const facts = duplicate.inputs.filter((input) => input.evidenceId === original.evidenceId);
  assert.equal(facts.length, 1);
  assert.equal((facts[0].value as { firstObservedAt: number }).firstObservedAt, firstObservedAt);
});

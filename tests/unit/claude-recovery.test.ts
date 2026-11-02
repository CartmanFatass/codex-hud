import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import {
  createClaudeReader,
  MAX_RECORD_BYTES,
  type ClaudeCheckpoint,
  type ClaudeReaderResult,
} from '../../src/harness/claude/reader.js';
import { ClaudeTranscriptFiles } from '../../src/harness/claude/binding.js';
import { ClaudeAdapter } from '../../src/harness/claude/index.js';
import { assistant, compact, launch, row, CLAIM, PRIVATE, SESSION } from '../fixtures/claude/transcripts.js';

function fixture(t: test.TestContext, bytes: string | Buffer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.jsonl');
  fs.writeFileSync(file, bytes);
  const options = {
    ref: { harness: 'claude' as const, sourceId: 'e'.repeat(64), sessionId: SESSION, threadId: null },
    resolveFile: () => file,
    serverNames: ['hud'],
  };
  return { root, file, options, reader: createClaudeReader(options) };
}

const roundtrip = (result: ClaudeReaderResult): ClaudeCheckpoint => JSON.parse(JSON.stringify(result.checkpoint));
const budget = (maxBytes: number) => ({ maxBytes, maxRecords: 2000, budgetMs: 20 });

function privateCheckpoint(result: ClaudeReaderResult): void {
  assert.deepEqual(result.checkpoint.parserState.pendingBytes, []);
  const artifacts = JSON.stringify({
    checkpoint: result.checkpoint,
    summary: result.observation,
    evidence: result.evidence,
  });
  assert.ok(!artifacts.includes(PRIVATE));
  assert.ok(!artifacts.includes(CLAIM));
}

test('Claude crash cuts in UTF-8, CRLF, private blobs and fallback claims recover the complete-record summary', async (t) => {
  t.mock.method(performance, 'now', () => 0);
  let now = 1900000000000;
  t.mock.method(Date, 'now', () => now);
  const utf8 = Buffer.from(assistant('synthetic-cut', undefined, 2000) + '\r\n');
  const privateLine = Buffer.from(row('api-request-blob', { data: PRIVATE + 'x'.repeat(128) }, 2000) + '\n');
  const fallback = Buffer.from(launch('link-synthetic', CLAIM, 2000) + '\n');
  for (const [bytes, cut] of [
    [utf8, utf8.indexOf(Buffer.from('中')) + 1],
    [utf8, utf8.length - 1],
    [privateLine, privateLine.length - 3],
    [fallback, fallback.indexOf(Buffer.from(CLAIM)) + Buffer.byteLength(CLAIM)],
  ] as const) {
    const prefix = Buffer.from(assistant('synthetic-prefix', undefined, 1000) + '\n');
    const f = fixture(t, Buffer.concat([prefix, bytes.subarray(0, cut)]));
    const partial = await f.reader.read();
    privateCheckpoint(partial);
    assert.ok(partial.checkpoint.offset === prefix.length || partial.checkpoint.offset === prefix.length + cut);
    const expectedFile = Buffer.concat([prefix, bytes]);
    fs.appendFileSync(f.file, bytes.subarray(cut));
    now += 5000;
    const recovered = await createClaudeReader(f.options, roundtrip(partial)).read();
    const full = await createClaudeReader(f.options).read();
    privateCheckpoint(recovered);
    assert.equal(recovered.checkpoint.offset, expectedFile.length);
    assert.deepEqual(recovered.observation.spent.tokens, full.observation.spent.tokens);
    assert.deepEqual(recovered.evidence.linkEvidence, full.evidence.linkEvidence);
    assert.equal(
      recovered.observation.statusProjection.lastEvidenceAt,
      full.observation.statusProjection.lastEvidenceAt
    );
    const idle = await createClaudeReader(f.options, roundtrip(recovered)).read();
    assert.equal(idle.observation.spent.tokens.asOf, recovered.observation.spent.tokens.asOf);
    assert.equal(
      idle.observation.statusProjection.lastEvidenceAt,
      recovered.observation.statusProjection.lastEvidenceAt
    );
  }
});

test('Claude maximum legal CRLF recovery includes the delimiter and required signature I/O in its slice', async (t) => {
  t.mock.method(performance, 'now', () => 0);
  const prefix = assistant('synthetic-prefix', undefined, 1000) + '\n';
  const empty = JSON.parse(assistant('synthetic-maximum', undefined, 2000, [{ type: 'text', text: '' }]));
  const baseBytes = Buffer.byteLength(JSON.stringify(empty));
  empty.message.content[0].text = 'x'.repeat(MAX_RECORD_BYTES - baseBytes - 1);
  const record = Buffer.from(JSON.stringify(empty) + '\r\n');
  assert.equal(record.length, MAX_RECORD_BYTES + 1);
  const f = fixture(t, Buffer.concat([Buffer.from(prefix), record.subarray(0, 1024)]));
  const partial = await f.reader.read();
  assert.equal(partial.checkpoint.offset, Buffer.byteLength(prefix));
  privateCheckpoint(partial);
  fs.appendFileSync(f.file, record.subarray(1024));
  const signatures = [
    partial.checkpoint.claude.firstRecordSignature,
    partial.checkpoint.claude.lastRecordHeadSignature,
    partial.checkpoint.claude.boundarySignature,
  ].filter((signature): signature is NonNullable<typeof signature> => signature !== null);
  const signatureBytes = [
    ...new Map(signatures.map((signature) => [`${signature.offset}:${signature.length}`, signature])).values(),
  ].reduce((sum, signature) => sum + signature.length, 0);
  const required = record.length + signatureBytes;
  const restored = createClaudeReader(f.options, roundtrip(partial));
  const constrained = await restored.read(budget(record.length));
  assert.equal(constrained.continuation?.minimumBytes, required);
  assert.equal(constrained.observation.coverage.state, 'partial');
  assert.equal(constrained.checkpoint.offset, partial.checkpoint.offset);
  assert.ok(constrained.stats!.bytesRead <= record.length);
  privateCheckpoint(constrained);
  const recovered = await restored.read(budget(required));
  assert.equal(recovered.continuation, undefined);
  assert.equal(recovered.stats?.bytesRead, required);
  assert.equal(recovered.stats?.recordsRead, 1);
  assert.equal(recovered.observation.spent.tokens.value?.input, 200);
  assert.equal(recovered.checkpoint.offset, fs.statSync(f.file).size);
  assert.equal(recovered.observation.coverage.state, 'complete');
});

test('Claude accepts a maximum legal fixed-EOF record without charging a nonexistent LF', async (t) => {
  t.mock.method(performance, 'now', () => 0);
  const empty = row('api-request-blob', { data: '' });
  const line = row('api-request-blob', { data: 'x'.repeat(MAX_RECORD_BYTES - Buffer.byteLength(empty)) });
  assert.equal(Buffer.byteLength(line), MAX_RECORD_BYTES);
  const f = fixture(t, line);
  const result = await f.reader.read(budget(MAX_RECORD_BYTES));
  assert.equal(result.checkpoint.offset, MAX_RECORD_BYTES);
  assert.equal(result.stats?.bytesRead, MAX_RECORD_BYTES);
  assert.equal(result.stats?.recordsRead, 1);
  assert.equal(result.observation.coverage.skipped['api-request-blob'], 1);
  assert.equal(result.observation.coverage.state, 'complete');
});

test('Claude oversized unterminated records advance a durable discard cursor across restarts and count one gap', async (t) => {
  t.mock.method(performance, 'now', () => 0);
  const f = fixture(t, row('api-request-blob', { data: PRIVATE + 'x'.repeat(2 * MAX_RECORD_BYTES + 256) }));
  let result = await f.reader.read(budget(MAX_RECORD_BYTES + 1));
  assert.equal(result.checkpoint.parserState.discardingOversize, true);
  assert.equal(result.checkpoint.claude.discardOffset, MAX_RECORD_BYTES + 1);
  let position = result.checkpoint.claude.discardOffset!;
  for (let n = 0; position < fs.statSync(f.file).size && n < 100; n++) {
    result = await createClaudeReader(f.options, roundtrip(result)).read(budget(64 * 1024));
    privateCheckpoint(result);
    assert.equal(result.checkpoint.offset, 0);
    assert.ok(result.checkpoint.claude.discardOffset! > position);
    assert.ok(result.stats!.bytesRead <= 64 * 1024);
    assert.equal(result.observation.coverage.skipped.oversize_unknown, 1);
    position = result.checkpoint.claude.discardOffset!;
  }
  assert.equal(position, fs.statSync(f.file).size);
  assert.equal(result.observation.coverage.state, 'partial');
  fs.appendFileSync(f.file, '\n' + assistant() + '\n');
  result = await createClaudeReader(f.options, roundtrip(result)).read();
  assert.equal(result.checkpoint.offset, fs.statSync(f.file).size);
  assert.equal(result.checkpoint.parserState.discardingOversize, false);
  assert.equal(result.observation.coverage.skipped.oversize_unknown, 1);
  assert.deepEqual(result.observation.coverage.gaps, ['oversize_unknown']);
  assert.equal(result.observation.spent.tokens.value?.input, 100);
  privateCheckpoint(result);
});

test('Claude drops an old live tail on source reset and on a compacted replacement tail', async (t) => {
  t.mock.method(performance, 'now', () => 0);
  for (const replacement of ['reset', 'compaction']) {
    const prefix = assistant('synthetic-prefix', undefined, 1000) + '\n';
    const tail = launch('link-old', CLAIM, 2000);
    const f = fixture(t, prefix + tail.slice(0, tail.length - 3));
    const partial = await f.reader.read();
    assert.ok(partial.checkpoint.claude.tailBytesSeen > 0);
    const next = assistant('synthetic-new', undefined, 4000) + '\n';
    fs.writeFileSync(f.file, replacement === 'reset' ? next : prefix + compact() + '\n' + next);
    const changed = await f.reader.read();
    privateCheckpoint(changed);
    assert.equal(changed.evidence.linkEvidence.length, 0);
    assert.ok(changed.checkpoint.sourceGeneration > partial.checkpoint.sourceGeneration);
    assert.equal(changed.observation.spent.tokens.value?.input, replacement === 'reset' ? 100 : 200);
    assert.equal(changed.checkpoint.resetReason, replacement === 'reset' ? 'truncated' : 'compaction');
    assert.equal(changed.checkpoint.offset, fs.statSync(f.file).size);
  }
});

test('Claude consumes a bounded part after slow discovery, stat or read and never labels elapsed time as missing bytes', async (t) => {
  for (const delayed of ['discovery', 'stat', 'read']) {
    const firstLine = assistant('synthetic-first', undefined, 1000) + '\n';
    const f = fixture(t, firstLine + assistant('synthetic-second', undefined, 2000) + '\n');
    let clock = 0;
    const now = t.mock.method(performance, 'now', () => clock);
    const original = delayed === 'stat' ? fs.fstatSync : fs.readSync;
    let ioMock: ReturnType<typeof t.mock.method> | undefined;
    const options = {
      ...f.options,
      resolveFile: () => {
        if (delayed === 'discovery') clock += 50;
        return f.file;
      },
    };
    if (delayed !== 'discovery') {
      const name = delayed === 'stat' ? 'fstatSync' : 'readSync';
      ioMock = t.mock.method(fs, name, (...args: unknown[]) => {
        const value = Reflect.apply(original, fs, args);
        clock += 50;
        return value;
      });
      syncBuiltinESMExports();
    }
    try {
      const reader = createClaudeReader(options);
      const first = await reader.read();
      assert.equal(first.checkpoint.offset, Buffer.byteLength(firstLine));
      assert.equal(first.stats?.recordsRead, 1);
      assert.ok(first.stats!.elapsedMs >= 50);
      assert.equal(first.continuation, undefined);
      clock = 0;
      const next = await reader.read({ maxBytes: 4 * MAX_RECORD_BYTES, maxRecords: 1, budgetMs: 0.1 });
      assert.equal(next.checkpoint.offset, fs.statSync(f.file).size);
      assert.equal(next.stats?.recordsRead, 1);
      assert.equal(next.continuation, undefined);
    } finally {
      ioMock?.mock.restore();
      now.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test('Claude cached path validation completes one bounded metadata step after the soft deadline', (t) => {
  const f = fixture(t, assistant() + '\n');
  const project = path.join(f.root, 'projects', 'synthetic');
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, SESSION + '.jsonl');
  fs.renameSync(f.file, transcript);
  const files = new ClaudeTranscriptFiles(f.root, f.options.ref.sourceId);
  assert.equal(files.resolve(f.options.ref), transcript);
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const original = fs.realpathSync;
  const delayed = t.mock.method(fs, 'realpathSync', (...args: Parameters<typeof original>) => {
    const result = Reflect.apply(original, fs, args);
    clock += 50;
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(files.resolve(f.options.ref, 20), transcript);
    assert.equal(clock, 100);
    assert.equal(files.resolve(f.options.ref, 20), null);
    assert.equal(clock, 100);
  } finally {
    delayed.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Claude default adapter cold discovery advances when every realpath consumes 30 ms', async (t) => {
  const f = fixture(t, assistant() + '\n');
  const project = path.join(f.root, 'projects', 'synthetic');
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, SESSION + '.jsonl');
  fs.renameSync(f.file, transcript);
  const adapter = new ClaudeAdapter();
  const sourceId = await adapter.resolveSource(
    {
      name: 'synthetic',
      harness: 'claude',
      source: { root: f.root, label: 'synthetic' },
      launch: { argv: ['claude'] },
      headless: null,
      resume: null,
      resumeHeadless: null,
      host: { kind: 'none', layout: 'none' },
      env: {},
      mcpServerName: 'hud',
      claimTransport: 'config_env',
      clientToolTimeoutMs: null,
      responseMarginMs: 1000,
      orphan_policy: 'continue',
      managedShellVerified: false,
    },
    {}
  );
  const ref = { ...f.options.ref, sourceId };
  const reader = adapter.open(ref);
  let clock = 0,
    realpaths = 0,
    listings = 0;
  t.mock.method(performance, 'now', () => clock);
  const realpath = fs.realpathSync;
  const list = fs.readdirSync;
  const pathMock = t.mock.method(fs, 'realpathSync', (...args: Parameters<typeof realpath>) => {
    const value = Reflect.apply(realpath, fs, args);
    clock += 30;
    realpaths++;
    return value;
  });
  const listMock = t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof list>) => {
    listings++;
    return Reflect.apply(list, fs, args);
  });
  syncBuiltinESMExports();
  try {
    const zero = await reader.read({ maxBytes: MAX_RECORD_BYTES, maxRecords: 1, budgetMs: 0 });
    assert.equal(zero.checkpoint.offset, 0);
    assert.equal(realpaths, 0);
    assert.equal(listings, 0);
    assert.equal(new ClaudeTranscriptFiles(f.root, sourceId).resolve(ref, clock), null);
    assert.equal(realpaths, 0, 'an entry-expired deadline does no metadata I/O');
    let result = zero;
    for (let n = 0; n < 4 && result.checkpoint.offset === 0; n++) result = await reader.read();
    assert.equal(result.checkpoint.offset, fs.statSync(transcript).size);
    assert.equal(result.observation.coverage.state, 'complete');
    assert.equal(result.observation.spent.tokens.value?.input, 100);
    assert.equal(listings, 1, 'the cold listing is saved across exhausted slices');
    assert.ok(realpaths > 1);
    assert.ok(result.stats!.elapsedMs >= 30, 'metadata latency remains in the measured soft budget');
  } finally {
    pathMock.mock.restore();
    listMock.mock.restore();
    syncBuiltinESMExports();
  }
});

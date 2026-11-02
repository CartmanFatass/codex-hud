/** Executable A9 specifications; physical clauses and exclusions are recorded in tmp/tasks/A4a/report.md. */
import test from 'node:test';
import { identityExecutionCases } from '../fixtures/contracts/identity-execution.js';
import { observationExportCases } from '../fixtures/contracts/observation-export.js';
import { supervisionCases, integrationCases } from '../fixtures/contracts/supervision.js';

test('T-01-1', () => identityExecutionCases['T-01-1']());
test('T-01-2', () => identityExecutionCases['T-01-2']());
test('T-01-6', () => identityExecutionCases['T-01-6']());
test('T-01-7', () => identityExecutionCases['T-01-7']());
test('T-01-8', () => identityExecutionCases['T-01-8']());
test('T-01-9', () => identityExecutionCases['T-01-9']());
test('T-01-10', () => identityExecutionCases['T-01-10']());
test('T-01-11', () => identityExecutionCases['T-01-11']());
test('T-01-12', () => identityExecutionCases['T-01-12']());
test('T-01-13', () => identityExecutionCases['T-01-13']());
test('T-01-14', () => identityExecutionCases['T-01-14']());
test('T-01-15', () => identityExecutionCases['T-01-15']());
test('T-01-16', () => identityExecutionCases['T-01-16']());
test('T-01-17', () => identityExecutionCases['T-01-17']());
test('T-01-19', () => identityExecutionCases['T-01-19']());
test('T-01-20', () => identityExecutionCases['T-01-20']());
test('T-01-21', () => identityExecutionCases['T-01-21']());
test('T-01-22', () => identityExecutionCases['T-01-22']());
test('T-01-24', () => identityExecutionCases['T-01-24']());
test('T-01-25', () => identityExecutionCases['T-01-25']());
test('T-01-26', () => identityExecutionCases['T-01-26']());
test('T-01-28', () => identityExecutionCases['T-01-28']());
test('T-01-29', () => identityExecutionCases['T-01-29']());
test('T-01-30', () => identityExecutionCases['T-01-30']());
test('T-01-31', () => identityExecutionCases['T-01-31']());
test('T-01-32', () => identityExecutionCases['T-01-32']());
test('T-01-35', () => identityExecutionCases['T-01-35']());
test('T-01-36', () => identityExecutionCases['T-01-36']());
test('T-01-37', () => identityExecutionCases['T-01-37']());
test('T-01-38', () => identityExecutionCases['T-01-38']());
test('T-01-39', () => identityExecutionCases['T-01-39']());
test('T-02-2', () => identityExecutionCases['T-02-2']());
test('T-02-9', () => identityExecutionCases['T-02-9']());
test('T-02-10', () => identityExecutionCases['T-02-10']());
test('T-02-11', () => identityExecutionCases['T-02-11']());
test('T-02-13', () => identityExecutionCases['T-02-13']());
test('T-02-17', () => identityExecutionCases['T-02-17']());
test('T-02-18', () => identityExecutionCases['T-02-18']());
test('T-02-19', () => identityExecutionCases['T-02-19']());
test('T-02-20', () => identityExecutionCases['T-02-20']());
test('T-02-23', () => identityExecutionCases['T-02-23']());
test('T-02-27', () => identityExecutionCases['T-02-27']());
test('T-02-28', () => identityExecutionCases['T-02-28']());
test('T-02-30', () => identityExecutionCases['T-02-30']());
test('T-02-31', () => identityExecutionCases['T-02-31']());
test('T-02-32', () => identityExecutionCases['T-02-32']());
test('T-02-33', () => identityExecutionCases['T-02-33']());
test('T-02-34', () => identityExecutionCases['T-02-34']());
test('T-03-1', () => identityExecutionCases['T-03-1']());
test('T-03-2', () => identityExecutionCases['T-03-2']());
test('T-03-3', () => identityExecutionCases['T-03-3']());
test('T-03-4', () => identityExecutionCases['T-03-4']());
test('T-03-5', () => identityExecutionCases['T-03-5']());
test('T-03-6', () => identityExecutionCases['T-03-6']());
test('T-03-7', () => identityExecutionCases['T-03-7']());
test('T-03-8', () => identityExecutionCases['T-03-8']());
test('T-03-9', () => identityExecutionCases['T-03-9']());
test('T-03-10', () => identityExecutionCases['T-03-10']());
test('T-03-11', () => identityExecutionCases['T-03-11']());
test('T-03-12', () => identityExecutionCases['T-03-12']());
test('T-03-14', () => identityExecutionCases['T-03-14']());
test('T-03-15', () => identityExecutionCases['T-03-15']());
test('T-03-16', () => identityExecutionCases['T-03-16']());
test('T-03-17', () => identityExecutionCases['T-03-17']());
test('T-03-19', () => identityExecutionCases['T-03-19']());
test('T-03-20', () => identityExecutionCases['T-03-20']());
test('T-03-26', () => identityExecutionCases['T-03-26']());
test('T-03-34', () => integrationCases['T-03-34']());
test('T-03-35', () => integrationCases['T-03-35']());
test('T-03-36', () => integrationCases['T-03-36']());
test('T-03-37', () => integrationCases['T-03-37']());
test('T-04-2', () => supervisionCases['T-04-2']());
test('T-04-4', () => supervisionCases['T-04-4']());
test('T-04-6', () => supervisionCases['T-04-6']());
test('T-04-7', () => supervisionCases['T-04-7']());
test('T-04-8', () => supervisionCases['T-04-8']());
test('T-04-9', () => supervisionCases['T-04-9']());
test('T-04-12', () => supervisionCases['T-04-12']());
test('T-04-13', () => supervisionCases['T-04-13']());
test('T-04-14', () => supervisionCases['T-04-14']());
test('T-04-15', () => supervisionCases['T-04-15']());
test('T-04-16', () => supervisionCases['T-04-16']());
test('T-04-20', () => supervisionCases['T-04-20']());
test('T-04-31', () => supervisionCases['T-04-31']());
test('T-04-32', () => supervisionCases['T-04-32']());
test('T-04-33', () => supervisionCases['T-04-33']());
test('T-04-35', () => supervisionCases['T-04-35']());
test('T-04-40', () => supervisionCases['T-04-40']());
test('T-04-41', () => supervisionCases['T-04-41']());
test('T-04-43', () => supervisionCases['T-04-43']());
test('T-05-1', () => observationExportCases['T-05-1']());
test('T-05-3', () => observationExportCases['T-05-3']());
test('T-05-4', () => observationExportCases['T-05-4']());
test('T-05-8', () => observationExportCases['T-05-8']());
test('T-05-10', () => observationExportCases['T-05-10']());
test('T-05-11', () => observationExportCases['T-05-11']());
test('T-05-13', () => observationExportCases['T-05-13']());
test('T-05-17', () => observationExportCases['T-05-17']());
test('T-05-18', () => observationExportCases['T-05-18']());
test('T-06-1', () => observationExportCases['T-06-1']());
test('T-06-4', () => observationExportCases['T-06-4']());
test('T-06-5', () => observationExportCases['T-06-5']());
test('T-06-6', () => observationExportCases['T-06-6']());
test('T-06-10', () => observationExportCases['T-06-10']());
test('T-06-17', () => observationExportCases['T-06-17']());
test('T-06-22', () => observationExportCases['T-06-22']());
test('T-06-23', () => observationExportCases['T-06-23']());
test('T-06-24', () => observationExportCases['T-06-24']());
test('T-06-25', () => observationExportCases['T-06-25']());
test('T-06-26', () => observationExportCases['T-06-26']());
test('T-06-27', () => observationExportCases['T-06-27']());
test('T-06-28', () => observationExportCases['T-06-28']());
test('T-06-29', () => observationExportCases['T-06-29']());
test('T-07-1', () => observationExportCases['T-07-1']());
test('T-07-3', () => observationExportCases['T-07-3']());
test('T-07-10', () => observationExportCases['T-07-10']());
test('T-07-20', () => observationExportCases['T-07-20']());
test('T-07-22', () => observationExportCases['T-07-22']());
test('T-07-23', () => observationExportCases['T-07-23']());
test('T-07-24', () => observationExportCases['T-07-24']());
test('T-07-25', () => observationExportCases['T-07-25']());
test('T-07-26', () => observationExportCases['T-07-26']());
test('T-07-27', () => observationExportCases['T-07-27']());

// Consult 4 F09/F10: durable state is metadata only; source bytes belong to a live reader.
import assert from 'node:assert/strict';
import {
  initialParserState,
  JSONL_READER_VERSION,
  readJsonlBytes,
  resetReaderCheckpoint,
} from '../../src/core/observation.js';
import type { ReaderCheckpoint } from '../../src/core/types/observation.js';
const jsonlCheckpoint = (): ReaderCheckpoint => ({
  schemaVersion: 1,
  readerVersion: JSONL_READER_VERSION,
  ref: { harness: 'codex', sourceId: 'e'.repeat(64), sessionId: 'synthetic-recovery', threadId: null },
  fileId: { dev: 1, inode: 2 },
  offset: 0,
  sourceGeneration: 1,
  parserState: initialParserState(),
});

test('F09/F10 A4 crash cuts keep UTF-8/CRLF, private blobs and claims out of every serialized artifact', () => {
  const prefix = Buffer.from('{"type":"user"}\n');
  for (const [type, content] of [
    ['assistant', '合成\r\nCRASH_SENTINEL'],
    ['api-request-blob', 'CRASH_SENTINEL_PRIVATE'],
    ['user', '[hud-launch] CRASH_SENTINEL_CLAIM'],
  ]) {
    const record = Buffer.from(JSON.stringify({ type, content }) + '\r\n');
    const bytes = Buffer.concat([prefix, record]);
    const cuts = [prefix.length + record.indexOf(Buffer.from(type)) + 2, bytes.length - 6, bytes.length - 1];
    const unicode = record.indexOf(Buffer.from('合'));
    if (unicode >= 0) cuts.push(prefix.length + unicode + 1);
    for (const cut of cuts) {
      const first = readJsonlBytes({
        checkpoint: jsonlCheckpoint(),
        bytes: bytes.subarray(0, cut),
        knownEndOffset: bytes.length,
      });
      assert.equal(first.checkpoint.offset, prefix.length);
      assert.deepEqual(first.checkpoint.parserState.pendingBytes, []);
      assert.ok(!JSON.stringify(first).includes('CRASH_SENTINEL'));
      assert.ok(!JSON.stringify(first).includes(Buffer.from('CRASH_SENTINEL').toString('base64')));
      const checkpoint = JSON.parse(JSON.stringify(first.checkpoint));
      const restored = readJsonlBytes({
        checkpoint,
        bytes: bytes.subarray(checkpoint.offset),
        knownEndOffset: bytes.length,
      });
      const full = readJsonlBytes({ checkpoint: jsonlCheckpoint(), bytes, knownEndOffset: bytes.length });
      assert.deepEqual(restored.records, full.records.slice(1));
      assert.equal(restored.checkpoint.offset, bytes.length);
      assert.deepEqual(restored.coverage, full.coverage);
    }
  }
});

test('F10 A4 transient continuation, maximum record, oversize restarts and source resets', () => {
  const MiB = 1024 * 1024;
  const base = Buffer.from('{"type":"assistant","text":""}');
  const maximum = Buffer.from('{"type":"assistant","text":"' + 'x'.repeat(MiB - base.length - 1) + '"}\r\n');
  assert.equal(maximum.length, MiB + 1, 'CR counts toward maxRecordBytes; LF is additional');
  const first = readJsonlBytes({
    checkpoint: jsonlCheckpoint(),
    bytes: maximum,
    knownEndOffset: maximum.length,
    budget: { maxBytes: 128 },
  });
  assert.equal(first.checkpoint.offset, 0);
  assert.equal(first.coverage.state, 'partial');
  assert.equal(first.coverage.reason, 'record_needs_larger_slice');
  assert.deepEqual(first.continuation, { kind: 'record_needs_larger_slice', minimumBytes: MiB + 1 });
  const live = readJsonlBytes({
    checkpoint: first.checkpoint,
    transient: first.transient,
    byteOffset: first.nextReadOffset,
    bytes: maximum.subarray(first.nextReadOffset),
    knownEndOffset: maximum.length,
  });
  assert.equal(live.checkpoint.offset, maximum.length);
  const restarted = readJsonlBytes({
    checkpoint: JSON.parse(JSON.stringify(first.checkpoint)),
    bytes: maximum,
    knownEndOffset: maximum.length,
    budget: { maxBytes: first.continuation!.minimumBytes },
  });
  assert.equal(restarted.checkpoint.offset, maximum.length);
  assert.equal(restarted.coverage.state, 'complete');
  const huge = Buffer.from('x'.repeat(MiB + 500000));
  let result = readJsonlBytes({
    checkpoint: jsonlCheckpoint(),
    bytes: huge,
    knownEndOffset: huge.length,
    budget: { maxBytes: MiB + 2 },
  });
  while (result.nextReadOffset < huge.length) {
    const cp = JSON.parse(JSON.stringify(result.checkpoint));
    result = readJsonlBytes({
      checkpoint: cp,
      bytes: huge.subarray(cp.parserState.discardOffset!),
      knownEndOffset: huge.length,
      budget: { maxBytes: 100000 },
    });
  }
  assert.equal(result.coverage.skipped.oversize_unknown, 1);
  assert.equal(result.coverage.state, 'partial');
  assert.equal(result.checkpoint.parserState.discardOffset, huge.length);
  assert.deepEqual(result.checkpoint.parserState.pendingBytes, []);
  const next = Buffer.from('{"type":"user"}\n');
  for (const reason of ['file_changed', 'truncated', 'compaction', 'branch_changed'] as const) {
    const reset = resetReaderCheckpoint(first.checkpoint, { dev: 1, inode: 3 }, 2, reason);
    const fresh = readJsonlBytes({
      checkpoint: reset,
      transient: first.transient,
      bytes: next,
      knownEndOffset: next.length,
    });
    assert.deepEqual(fresh.records, [{ type: 'user', byteEnd: next.length }]);
  }
  assert.throws(
    () =>
      readJsonlBytes({
        checkpoint: { ...jsonlCheckpoint(), readerVersion: 'jsonl-bytes-1' },
        bytes: next,
        knownEndOffset: next.length,
      }),
    /unsupported_reader_version/
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';
import { makeWorkerFatal, resultWireUpperBound, validWorkerFatal } from '../../src/core/link/worker-control.js';
import { WORKER_PAYLOAD_LIMIT } from '../../src/core/link/worker-protocol.js';
const incarnation = '11111111-1111-4111-8111-111111111111';
test('B10D total envelope bound conservatively includes ArrayBuffer framing at its exact limit', () => {
  const header = { payload: null as ArrayBuffer | null, scope: 'synthetic', revision: 1 };
  const n = WORKER_PAYLOAD_LIMIT - resultWireUpperBound(header);
  header.payload = new ArrayBuffer(n);
  assert.equal(resultWireUpperBound(header), WORKER_PAYLOAD_LIMIT);
  assert.ok(serialize(header).byteLength <= WORKER_PAYLOAD_LIMIT);
  header.payload = new ArrayBuffer(n + 1);
  assert.equal(resultWireUpperBound(header), WORKER_PAYLOAD_LIMIT + 1);
  const failure = { payload: null, scope: 'x'.repeat(WORKER_PAYLOAD_LIMIT) };
  assert.ok(resultWireUpperBound(failure) > WORKER_PAYLOAD_LIMIT);
  const fatal = makeWorkerFatal(
    incarnation,
    1,
    'worker_metadata_limit',
    [{ refKey: 'a'.repeat(64), commitSeq: 2 }],
    []
  );
  assert.ok(validWorkerFatal(fatal));
  assert.ok(serialize(fatal).byteLength < 1024);
  assert.equal('scope' in fatal, false);
  assert.equal(fatal.commits[0].commitSeq, 2);
});
test('B10D invalid outcome counts are explicitly incomplete and arbitrary control text cannot escape', () => {
  const oversized = Array.from({ length: 217 }, () => ({
    refKey: 'a'.repeat(64),
    reason: 'collector_closed_unaccepted',
  }));
  const fatal = makeWorkerFatal(
    incarnation,
    2,
    'worker_protocol_failure',
    [{ refKey: 'b'.repeat(64), commitSeq: 3 }],
    oversized
  );
  assert.equal(fatal.accountingComplete, false);
  assert.equal(fatal.lifecycleCount, 217);
  assert.equal(fatal.lifecycles.length, 0);
  assert.equal(fatal.commits.length, 1);
  assert.equal(validWorkerFatal({ ...fatal, error: 'x'.repeat(WORKER_PAYLOAD_LIMIT) }), false);
  assert.equal(validWorkerFatal({ ...fatal, commits: [{ refKey: {}, commitSeq: 3 }] }), false);
});

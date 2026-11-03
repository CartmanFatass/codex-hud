import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeView, decodeView } from '../../src/core/link/worker-codec.js';
import { WORKER_PAYLOAD_LIMIT } from '../../src/core/link/worker-protocol.js';
import { buildVm } from '../fixtures/b10b-delegation.js';

const view = () => {
  const vm = buildVm([]).vm;
  vm.tree.ledger.state = 'available';
  vm.limits = { source: 'default', reason: null, limits: { maxActiveRuns: 6, maxActiveRunsPerOwner: 4 } };
  return vm;
};
test('B10D exact bounded transport preserves shared plain data without leaking authority', () => {
  const input = view();
  const shared: never[] = [];
  input.tree.coverage.gaps = shared;
  input.tree.candidates = shared;
  const encoded = encodeView(input);
  assert.ok(encoded instanceof ArrayBuffer && encoded.byteLength < WORKER_PAYLOAD_LIMIT);
  const output = decodeView(encoded)!;
  assert.deepEqual(output, input);
  assert.strictEqual(output.tree.coverage.gaps, output.tree.candidates);
  assert.equal(decodeView(encodeView(null)), null);
});
test('B10D DTO rejects accessors without invoking them, native handles, checkpoint state and cycles', () => {
  let called = false;
  const getter = view();
  Object.defineProperty(getter.tree, 'coverage', {
    enumerable: true,
    get() {
      called = true;
      return {};
    },
  });
  assert.throws(() => encodeView(getter), /worker_dto_accessor/);
  assert.equal(called, false);
  for (const value of [
    new Date(),
    new Map(),
    new Uint8Array(1),
    () => {},
    { parserState: {} },
    { recoveryIndex: {} },
  ]) {
    const input = view();
    Object.assign(input.tree, { coverage: value });
    assert.throws(() => encodeView(input), /worker_dto_/);
  }
  const cycle = view();
  Object.assign(cycle.tree, { coverage: cycle });
  assert.throws(() => encodeView(cycle), /worker_dto_cycle/);
});
test('B10D oversize transport fails explicitly instead of trimming display history', () => {
  const input = view();
  input.tree.ledger.reason = 'x'.repeat(WORKER_PAYLOAD_LIMIT);
  assert.throws(() => encodeView(input), /worker_payload_limit/);
  assert.throws(() => decodeView(new ArrayBuffer(WORKER_PAYLOAD_LIMIT + 1)), /worker_payload_limit/);
});

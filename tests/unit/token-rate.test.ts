import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenRateTracker, formatTokenRate } from '../../src/collectors/token-rate.js';

const at = (seconds: number): Date => new Date(1_700_000_000_000 + seconds * 1000);

test('rate uses output counter deltas and observation timestamps', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(10_000, at(0));
  assert.equal(tracker.snapshot ?? null, null);
  tracker.observe(10_421, at(10));
  assert.deepEqual(tracker.snapshot, {
    tokensPerSecond: 42.1, sampleMs: 10_000, sampledAt: at(10),
  });
  tracker.observe(10_600, at(20));
  assert.equal(tracker.snapshot?.tokensPerSecond, 30);
  assert.equal(tracker.snapshot?.sampleMs, 20_000);
});

test('polling reads and repeated observations do not refresh a rate', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(100, at(0));
  tracker.observe(300, at(10));
  const measured = tracker.snapshot;
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(tracker.snapshot, measured);
    tracker.observe(300, at(10));
  }
  assert.deepEqual(tracker.snapshot, measured);
  assert.equal(formatTokenRate(tracker.snapshot, at(19).getTime()), '~20.0 tok/s');
  assert.equal(formatTokenRate(tracker.snapshot, at(20).getTime()), 'last ~20.0 tok/s');
});

test('turn starts exclude idle time and preserve the previous estimate until measurable', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(100, at(0));
  tracker.observe(300, at(10));
  const measured = tracker.snapshot;
  tracker.startTurn(at(100));
  assert.deepEqual(tracker.snapshot, measured);
  tracker.observe(325, at(100.5));
  assert.deepEqual(tracker.snapshot, measured);
  tracker.observe(400, at(102));
  assert.deepEqual(tracker.snapshot, {
    tokensPerSecond: 50, sampleMs: 2000, sampledAt: at(102),
  });
});

test('a turn without a known counter waits for two observations', () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(at(0));
  tracker.observe(5000, at(10));
  assert.equal(tracker.snapshot ?? null, null);
  tracker.observe(5200, at(15));
  assert.equal(tracker.snapshot?.tokensPerSecond, 40);
});

test('the first counter can establish a baseline at the turn-start timestamp', () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(at(10));
  tracker.observe(100, at(9));
  tracker.observe(500, at(10));
  assert.equal(tracker.snapshot ?? null, null);
  tracker.observe(600, at(15));
  assert.equal(tracker.snapshot?.tokensPerSecond, 20);
});

test('counter rollback discards the old estimate and establishes a new baseline', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(100, at(0));
  tracker.observe(300, at(10));
  tracker.observe(10, at(20));
  assert.equal(tracker.snapshot ?? null, null);
  tracker.observe(60, at(25));
  assert.deepEqual(tracker.snapshot, {
    tokensPerSecond: 10, sampleMs: 5000, sampledAt: at(25),
  });
});

test('reset removes both the displayed estimate and the previous counter', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(100, at(0));
  tracker.observe(300, at(10));
  tracker.reset();
  assert.equal(tracker.snapshot ?? null, null);
  tracker.startTurn(at(20));
  tracker.observe(1000, at(30));
  assert.equal(tracker.snapshot ?? null, null);
  tracker.observe(1100, at(40));
  assert.equal(tracker.snapshot?.tokensPerSecond, 10);
});

test('duplicate or older timestamps cannot change the counter or turn baseline', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(100, at(0));
  tracker.observe(300, at(10));
  tracker.observe(9999, at(10));
  tracker.observe(1, at(9));
  tracker.startTurn(at(9));
  tracker.startTurn(at(10));
  tracker.observe(500, at(20));
  assert.deepEqual(tracker.snapshot, {
    tokensPerSecond: 20, sampleMs: 20_000, sampledAt: at(20),
  });
});

test('explicit zero-output observations report zero while absent observations retain the rate', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(0, at(0));
  tracker.observe(0, at(10));
  assert.equal(tracker.snapshot?.tokensPerSecond, 0);
  tracker.startTurn(at(20));
  tracker.observe(100, at(25));
  const measured = tracker.snapshot;
  assert.equal(measured?.tokensPerSecond, 20);
  assert.deepEqual(tracker.snapshot, measured);
  tracker.observe(100, at(30));
  assert.equal(tracker.snapshot?.tokensPerSecond, 10);
  tracker.observe(100, at(100));
  assert.equal(tracker.snapshot?.tokensPerSecond, 0);
});

test('invalid counters and timestamps cannot poison subsequent observations', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(100, at(0));
  for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    tracker.observe(value, at(1));
  }
  tracker.observe(1, new Date(NaN));
  tracker.startTurn(new Date(NaN));
  tracker.observe(300, at(10));
  assert.equal(tracker.snapshot?.tokensPerSecond, 20);
});

test('subsecond bursts wait for at least one second of elapsed observation time', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(0, at(0));
  tracker.observe(100, at(0.001));
  tracker.observe(200, at(0.999));
  assert.equal(tracker.snapshot ?? null, null);
  tracker.observe(300, at(1));
  assert.deepEqual(tracker.snapshot, {
    tokensPerSecond: 300, sampleMs: 1000, sampledAt: at(1),
  });
});

test('recent observations replace older throughput in the rolling window', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(0, at(0));
  tracker.observe(1000, at(10));
  tracker.observe(1100, at(20));
  tracker.observe(1200, at(30));
  tracker.observe(1300, at(40));
  assert.deepEqual(tracker.snapshot, {
    tokensPerSecond: 10, sampleMs: 30_000, sampledAt: at(40),
  });
});

test('sparse observations report their actual interval instead of inventing a 30s denominator', () => {
  const tracker = new TokenRateTracker();
  tracker.observe(100, at(0));
  tracker.observe(700, at(60));
  assert.deepEqual(tracker.snapshot, {
    tokensPerSecond: 10, sampleMs: 60_000, sampledAt: at(60),
  });
});

test('dense observations still yield an estimate after enough elapsed time', () => {
  const tracker = new TokenRateTracker();
  for (let millis = 0; millis <= 2000; millis++) {
    tracker.observe(millis, at(millis / 1000));
  }
  assert.equal(tracker.snapshot?.tokensPerSecond, 1000);
  assert.ok((tracker.snapshot?.sampleMs ?? 0) >= 1000);
});

test('formatter omits missing or invalid estimates', () => {
  assert.equal(formatTokenRate(undefined), null);
  assert.equal(formatTokenRate({ tokensPerSecond: 0, sampleMs: 1000, sampledAt: at(0) }, at(0).getTime()), '~0.0 tok/s');
  for (const tokensPerSecond of [-1, NaN, Infinity]) {
    assert.equal(formatTokenRate({ tokensPerSecond, sampleMs: 1000, sampledAt: at(0) }), null);
  }
  assert.equal(formatTokenRate({ tokensPerSecond: 10, sampleMs: 0, sampledAt: at(0) }), null);
  assert.equal(formatTokenRate({ tokensPerSecond: 10, sampleMs: 1000, sampledAt: new Date(NaN) }), null);
});

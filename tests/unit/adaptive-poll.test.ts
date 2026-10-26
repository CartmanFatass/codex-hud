import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptivePollDue, createAdaptivePollState, forceAdaptivePoll, recordAdaptivePoll, type AdaptivePollObservation } from '../../src/collectors/adaptive-poll.js';

const quiet = (nowMs: number, extra: Partial<AdaptivePollObservation> = {}): AdaptivePollObservation => ({
  scopeKey: 'root:tree', nowMs, activity: 'quiet', fingerprint: 'path:inode:size:mtime', succeeded: true, ...extra,
});

test('only repeated successful, unchanged and explicitly quiet observations back off, capped at 5s', () => {
  let state = createAdaptivePollState(200);
  assert.equal(adaptivePollDue(state, 'root:tree', 0), true);
  const intervals: number[] = [];
  for (let i = 0; i < 10; i++) {
    state = recordAdaptivePoll(state, quiet(i * 10_000));
    intervals.push(state.intervalMs);
    assert.equal(adaptivePollDue(state, 'root:tree', state.nextDueAt - 1), false);
    assert.equal(adaptivePollDue(state, 'root:tree', state.nextDueAt), true);
  }
  assert.deepEqual(intervals, [200, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000]);
});

test('activity, uncertain state, failed reads and changed or missing fingerprints restore base cadence', () => {
  let idle = createAdaptivePollState(250);
  for (let i = 0; i < 7; i++) idle = recordAdaptivePoll(idle, quiet(i * 1000));
  assert.equal(idle.intervalMs, 5000);
  for (const extra of [
    { activity: 'active' as const }, { activity: 'uncertain' as const },
    { succeeded: false }, { fingerprint: 'changed' }, { fingerprint: undefined }, { fingerprint: '' },
  ]) {
    const recovered = recordAdaptivePoll(idle, quiet(10_000, extra));
    assert.equal(recovered.intervalMs, 250);
    assert.equal(recovered.stablePolls, 0);
    assert.equal(recovered.nextDueAt, 10_250);
    assert.equal(recordAdaptivePoll(recovered, quiet(10_250)).intervalMs, 250, 'recovery establishes quiet history again');
  }
  assert.equal(idle.intervalMs, 5000, 'transitions do not mutate their input');
});

test('session/mode switches and forced input refresh bypass an idle deadline and reset history', () => {
  let state = createAdaptivePollState(100);
  for (let i = 0; i < 8; i++) state = recordAdaptivePoll(state, quiet(i * 1000));
  assert.equal(adaptivePollDue(state, 'other:tree', 7001), true);
  assert.equal(adaptivePollDue(state, 'root:brief', 7001), true);
  const switched = recordAdaptivePoll(state, quiet(7001, { scopeKey: 'other:tree' }));
  assert.equal(switched.intervalMs, 100);
  assert.equal(switched.stablePolls, 0);
  const forced = forceAdaptivePoll(state);
  assert.equal(adaptivePollDue(forced, 'root:tree', 7001), true);
  assert.equal(forced.intervalMs, 100);
  assert.equal(forced.stablePolls, 0);
  assert.equal(recordAdaptivePoll(forced, quiet(7001)).stablePolls, 0);
});

test('interval configuration stays finite, respects a lower cap, and preserves a slower configured base', () => {
  for (const invalid of [0, -1, Infinity, NaN]) assert.throws(() => createAdaptivePollState(invalid), RangeError);
  assert.throws(() => createAdaptivePollState(200, Infinity), RangeError);
  for (const [base, max, expected] of [[100, 800, 800], [100, 90_000, 5000], [7000, 5000, 7000]]) {
    let state = createAdaptivePollState(base, max);
    for (let i = 0; i < 100; i++) state = recordAdaptivePoll(state, quiet(i * 10_000));
    assert.equal(state.intervalMs, expected);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityRings } from '../../dist/collectors/activity-ring.js';

const MIN = 60_000;
test('Activity ring: a write counts in the current minute, buckets slide with the clock, a quiet ring is absent', () => {
  const rings = new ActivityRings(), at = 5_000_000 * MIN;
  const run = (activityAt, extra) => ({ id: 'a', state: 'working', settledAt: null, work: { activityAt }, ...extra });
  assert.equal(rings.observe([run(1)], at).size, 0, 'first sight has no history');
  assert.equal(rings.observe([run(1)], at + 5000).size, 0, 'no new write, no activity');
  rings.observe([run(2)], at + 6000);
  assert.deepEqual(rings.observe([run(3, { progress: [{}] })], at + 7000).get('a'), [0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(rings.observe([run(4, { progress: [{}] })], at + 2 * MIN).get('a'), [0, 0, 0, 0, 0, 0, 0, 2, 0, 1]);
  assert.deepEqual(rings.observe([run(4, { progress: [{}] })], at + 3 * MIN).get('a'), [0, 0, 0, 0, 0, 0, 2, 0, 1, 0]);
  assert.equal(rings.observe([run(4, { progress: [{}] })], at + 14 * MIN).size, 0, 'ten quiet minutes empty the ring');
  rings.observe([run(5)], at + 14 * MIN + 1);
  assert.equal(rings.observe([{ ...run(6), settledAt: 1, state: 'done' }], at + 14 * MIN + 2).size, 0, 'a settled worker has none');
  assert.equal(rings.observe([run(7)], at + 15 * MIN).size, 0, 'and starts afresh if it runs again');
});

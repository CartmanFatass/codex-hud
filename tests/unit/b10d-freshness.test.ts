import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationFreshness, projectDelegationFreshness } from '../../src/core/link/freshness.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../src/core/status/merge.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';

function fixture() {
  const ref = { harness: 'codex' as const, sourceId: '1'.repeat(64), sessionId: 'synthetic-worker', threadId: null };
  const stamp = { ref, seqDomain: 'synthetic-observation', commitSeq: 4, sourceGeneration: 1, inputLedgerSeq: 3 };
  const projection = mergeStatus(
    {
      target: { nodeIdentity: { kind: 'session', ref }, sourceGeneration: 1 },
      sources: [
        {
          id: 'synthetic-native',
          deadlineAt: 6000,
          evidence: {
            origin: 'transcript',
            ref,
            sourceGeneration: 1,
            eventAt: 1000,
            observedAt: 2000,
            lastSuccessfulReadAt: 2000,
            validity: 'current',
            value: { activity: 'working', liveness: 'alive' },
          },
        },
      ],
      asOfSeq: 3,
      observationStamp: stamp,
      history: { continuity: 'proven' },
    },
    null,
    STATUS_RULE_VERSION,
    2000
  ).projection;
  const view = {
    tree: { nodes: [{ key: 'synthetic', observation: { statusProjection: projection } }] },
    details: { synthetic: { status: projection, statusSource: 'committed' } },
  } as unknown as DelegationViewModel;
  return { view, projection };
}
test('B10D delayed worker result ages original committed clocks without receipt-time freshness or stamp changes', () => {
  const { view, projection } = fixture();
  const output = projectDelegationFreshness(view, 8000).view;
  assert.equal(output.details.synthetic.status!.freshness.state, 'stale');
  assert.equal(output.details.synthetic.status!.observedAt, 2000);
  assert.strictEqual(output.details.synthetic.status!.observationStamp, projection.observationStamp);
  assert.equal(projection.freshness.state, 'fresh');
  assert.equal(output.details.synthetic.status!.freshness.sources[0].lastSuccessfulReadAt, 2000);
});
test('B10D pure paint freshness keeps equality fresh, schedules strict crossing and memoizes unchanged repaints', () => {
  const { view } = fixture();
  const cache = new DelegationFreshness();
  assert.strictEqual(cache.current(view, 2000), view);
  assert.equal(cache.nextDeadline(), 6001);
  assert.strictEqual(cache.current(view, 6000), view);
  const expired = cache.current(view, 6001)!;
  assert.equal(expired.details.synthetic.status!.freshness.state, 'stale');
  assert.strictEqual(cache.current(view, 9000), expired);
  assert.equal(cache.current(null, 9000), null);
});

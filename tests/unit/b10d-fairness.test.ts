import test from 'node:test';
import assert from 'node:assert/strict';
import { planLinkRead } from '../../src/core/link/read-plan.js';
import type { LinkTreeProjection } from '../../src/core/link/types.js';
const ref = { harness: 'codex' as const, sourceId: '1'.repeat(64), sessionId: 'synthetic', threadId: null };
function plan(eligible: string[], cursor?: string, remainingMs = 20) {
  const tree = {
    nodes: ['F0', 'F1', 'A', 'B'].map((key) => ({ key })),
    continuation: eligible.map((key) => ({ key, identity: { kind: 'session', ref }, reason: 'unloaded' })),
    io: { remainingBytes: 4 * 1024 * 1024, exceeded: false },
  } as unknown as LinkTreeProjection;
  return planLinkRead(tree, { afterKey: cursor, remainingMs });
}
test('B10D fair traversal retains the position of a completed target across a permanent follower prefix', () => {
  const next = plan(['F0', 'F1', 'B'], 'A');
  assert.equal(next.target?.key, 'B');
  assert.equal(plan(['F0', 'F1', 'A'], 'B').target?.key, 'F0');
  assert.equal(plan(['F1', 'B'], 'removed-from-scope').target?.key, 'F1');
  assert.equal(plan(['F0', 'F1', 'A', 'B'], 'F1').target?.key, 'A');
  assert.equal(plan(['F0', 'F1', 'B'], 'A').target?.key, 'B');
  const deadline = plan(['B'], 'A', 0);
  assert.equal(deadline.target, null);
  assert.equal(deadline.nextCursor, 'A');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectLinkTree, planLinkRead } from '../../src/core/link/index.js';
import { displayNodeKey } from '../../src/core/observation.js';
import type { LinkTreeInput } from '../../src/core/link/index.js';
import type { DisplayNodeIdentity } from '../../src/core/types/observation.js';

const degraded = { state: 'degraded', snapshot: null, reason: 'ledger_unavailable' } as const;
const input = (roots: DisplayNodeIdentity[]): LinkTreeInput => ({ ledger: degraded, roots, sessions: [], nowMs: 1000 });

test('B9 degraded projection retains distinct complete session and job identities without inventing ledger seq', () => {
  const base = { harness: 'codex' as const, sourceId: '1'.repeat(64), sessionId: 'synthetic-session', threadId: null };
  const roots: DisplayNodeIdentity[] = [
    { kind: 'session', ref: base },
    { kind: 'session', ref: { ...base, sourceId: '2'.repeat(64) } },
    { kind: 'session', ref: { ...base, threadId: 'synthetic-native-child' } },
    { kind: 'job', ref: { kind: 'jev', provider: 'synthetic', account: 'a', key: 'job' } },
    { kind: 'job', ref: { kind: 'jev', provider: 'synthetic', account: 'b', key: 'job' } },
  ];
  const tree = projectLinkTree(input([...roots, roots[0], roots[3]]));
  assert.equal(tree.nodes.length, 5);
  assert.equal(tree.ledger.asOfSeq, null);
  assert.equal(tree.ledger.ledgerId, null);
  assert.equal(tree.counts.confirmedSessions, 3);
  assert.equal(tree.counts.jobs, 2);
  assert.equal(new Set(tree.nodes.map((node) => node.key)).size, 5);
  assert.ok(tree.nodes.every((node) => !node.loaded));
  assert.equal(tree.coverage.state, 'partial');
  const plan = planLinkRead(tree, { remainingMs: 10 });
  assert.ok(plan.target && roots.some((root) => root.kind === 'session' && displayNodeKey(root) === plan.target?.key));
});

test('B9 caller cannot lift node caps and zero budget emits continuation without a 201st row', () => {
  const roots: DisplayNodeIdentity[] = Array.from({ length: 205 }, (_, i) => ({
    kind: 'session',
    ref: { harness: 'codex', sourceId: '1'.repeat(64), sessionId: `synthetic-${i}`, threadId: null },
  }));
  const capped = projectLinkTree({ ...input(roots), budget: { maxNodes: 1000 } });
  assert.equal(capped.nodes.length, 200);
  assert.equal(capped.counts.omitted, 5);
  const zero = projectLinkTree({ ...input(roots), budget: { maxNodes: 0 } });
  assert.equal(zero.nodes.length, 0);
  assert.equal(zero.counts.omitted, 205);
  assert.equal(zero.continuation.length, 200);
  assert.equal(zero.truncation.continuation, 5);
  assert.throws(() => projectLinkTree({ ...input([]), budget: { maxBytes: NaN } }), /invalid_link_budget/);
  assert.equal(projectLinkTree(input([{ kind: 'delegationIntent', linkId: 'invented' }])).nodes.length, 0);
});

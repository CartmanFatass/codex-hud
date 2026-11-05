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

test('an oversized session does not starve the other 199 targets and remains eligible when a grant fits', () => {
  const roots: DisplayNodeIdentity[] = Array.from({ length: 200 }, (_, i) => ({
    kind: 'session',
    ref: { harness: 'codex', sourceId: '1'.repeat(64), sessionId: `fair-${i}`, threadId: null },
  }));
  const tree = projectLinkTree(input(roots));
  const blocked = tree.continuation[0].key;
  const minimumBytes = new Map([[blocked, 4 * 1024 * 1024 + 1]]);
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 199; i++) {
    const plan = planLinkRead(tree, { remainingMs: 13, afterKey: cursor, minimumBytes });
    assert.ok(plan.target);
    assert.notEqual(plan.target.key, blocked);
    assert.equal(plan.budget.maxBytes, 4 * 1024 * 1024);
    assert.equal(plan.budget.maxRecords, 2000);
    assert.equal(plan.budget.budgetMs, 13);
    seen.add(plan.target.key);
    cursor = plan.nextCursor;
  }
  assert.equal(seen.size, 199);
  assert.ok(tree.continuation.some((entry) => entry.key === blocked));
  minimumBytes.set(blocked, 1024);
  const restored = planLinkRead(tree, { remainingMs: 13, afterKey: cursor, minimumBytes });
  assert.equal(restored.target?.key, blocked);
});

test('all blocked sessions keep the cursor, while a topology read uses its own allowance', () => {
  const roots: DisplayNodeIdentity[] = ['one', 'two'].map((sessionId) => ({
    kind: 'session',
    ref: { harness: 'codex', sourceId: '1'.repeat(64), sessionId, threadId: null },
  }));
  const tree = projectLinkTree(input(roots));
  const [first, second] = tree.continuation;
  const minimumBytes = new Map([
    [first.key, 8 * 1024 * 1024],
    [second.key, 0],
  ]);
  const blocked = planLinkRead(tree, { remainingMs: 5, afterKey: second.key, minimumBytes });
  assert.deepEqual(blocked, { target: null, reason: 'bytes', nextCursor: second.key });
  first.reason = 'native_topology';
  const topology = planLinkRead(tree, { remainingMs: 5, afterKey: second.key, minimumBytes });
  assert.equal(topology.target?.key, first.key);
  assert.equal(topology.target?.kind, 'native_topology');
  assert.equal(tree.continuation.length, 2);
  const expired = planLinkRead(tree, { remainingMs: 0, afterKey: second.key, minimumBytes });
  assert.equal(expired.target, null);
  if (!expired.target) assert.equal(expired.reason, 'deadline');
});

test('a session blocked only by the remaining shared bytes resumes on the next sufficient grant', () => {
  const roots: DisplayNodeIdentity[] = ['large', 'small'].map((sessionId) => ({
    kind: 'session',
    ref: { harness: 'codex', sourceId: '1'.repeat(64), sessionId, threadId: null },
  }));
  const tree = projectLinkTree(input(roots));
  const [large, small] = tree.continuation;
  const minimumBytes = new Map([[large.key, 2048]]);
  tree.io.remainingBytes = 1024;
  const first = planLinkRead(tree, { remainingMs: 7, minimumBytes });
  assert.equal(first.target?.key, small.key);
  if (!first.target) throw new Error('expected target');
  assert.equal(first.budget.maxBytes, 1024);
  tree.io.remainingBytes = 4096;
  const next = planLinkRead(tree, { remainingMs: 7, afterKey: first.nextCursor, minimumBytes });
  assert.equal(next.target?.key, large.key);
  if (!next.target) throw new Error('expected target');
  assert.equal(next.budget.maxBytes, 4096);
});

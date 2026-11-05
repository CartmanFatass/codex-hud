import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSiblings, planRows } from '../../src/render/delegation/rows.js';
import { projectDelegation, type PNode } from '../../src/render/delegation/projection.js';
import { S, ago, buildVm, NOW } from '../fixtures/b10b-delegation.js';

function item(key: string, index: number, rank: 0 | 1, since: number | null, createdAt: number | null): PNode {
  return { key, index, sub: { rank, sortAt: since }, proj: { createdAt } } as unknown as PNode;
}

test('missing trouble and creation timestamps produce an antisymmetric transitive order', () => {
  const values = [item('missing', 0, 0, null, null), item('old', 1, 0, 10, 10), item('new', 2, 0, 20, 20)];
  for (const creation of [false, true]) {
    const compare = compareSiblings(creation);
    for (const a of values)
      for (const b of values)
        for (const c of values) {
          assert.equal(Math.sign(compare(a, b)) + Math.sign(compare(b, a)), 0);
          if (compare(a, b) <= 0 && compare(b, c) <= 0) assert.ok(compare(a, c) <= 0);
        }
    assert.deepEqual(
      [...values].sort(compare).map((value) => value.key),
      creation ? ['old', 'new', 'missing'] : ['new', 'old', 'missing']
    );
  }
});

test('active subtree precedes live tail while creation-only sort ignores buckets', () => {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(), label: null },
    {
      id: 'tail',
      parent: 'main',
      harness: 'codex',
      createdAt: ago(400),
      run: { state: 'cancelling', mode: 'headless' },
      status: { cls: 'interrupted', reason: 'cancelling' },
    },
    {
      id: 'close',
      parent: 'main',
      harness: 'codex',
      createdAt: ago(500),
      run: { state: 'running', mode: 'visible' },
      status: S.exited(ago(40)),
      report: { status: 'completed', at: ago(40) },
    },
    {
      id: 'parent',
      parent: 'main',
      harness: 'codex',
      createdAt: ago(300),
      run: { state: 'ended' },
      status: S.exited(ago(40)),
    },
    { id: 'child', parent: 'parent', native: true, harness: 'codex', status: S.working(), createdAt: ago(100) },
    { id: 'active', parent: 'main', harness: 'codex', status: S.working(), createdAt: ago(200) },
  ]);
  const proj = projectDelegation(built.vm);
  const nodes = (byCreation: boolean) =>
    planRows(proj, { nowMs: NOW, showHistory: true, sortByCreation: byCreation })
      .rows.filter((row) => row.kind === 'node')
      .map((row) => row.key);
  const normal = nodes(false);
  assert.ok(normal.indexOf(built.keys.parent) < normal.indexOf(built.keys.tail));
  assert.ok(normal.indexOf(built.keys.active) < normal.indexOf(built.keys.tail));
  assert.ok(normal.indexOf(built.keys.active) < normal.indexOf(built.keys.close));
  assert.ok(nodes(true).indexOf(built.keys.tail) < nodes(true).indexOf(built.keys.parent));
});

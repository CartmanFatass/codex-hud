/** Snapshot and cache-lifetime guards for the B10B-S3F performance remediation. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { delegationAgentsRows, delegationView } from '../../src/render/delegation/panel.js';
import { ProjectionCache, projectDelegation, sharedProjectionCache } from '../../src/render/delegation/projection.js';
import { planRows, renderRow, PUT_AWAY_MS } from '../../src/render/delegation/rows.js';
import { plainSay } from '../../src/render/delegation/style.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { NOW, S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { draw, press } from '../fixtures/b10b-s3.js';

const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(300)), label: null };
const worker = (label = 'original', extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id: 'worker',
  parent: 'main',
  label,
  status: S.working(ago(30)),
  ...extra,
});

function compact(vm: DelegationViewModel, cache: ProjectionCache): string[] {
  const proj = projectDelegation(vm, cache);
  const plan = planRows(proj, { nowMs: NOW });
  return plan.rows.map((row) => renderRow(row, { proj, nowMs: NOW, width: 56, say: plainSay, coarse: plan.coarse }));
}

test('perf equivalence: rebuilt-equal views, one fact changed, and return to its previous value', () => {
  const a = buildVm([root, worker()]).vm;
  const b = buildVm([root, worker('changed')]).vm;
  const cache = new ProjectionCache();
  const first = compact(a, cache);
  const original = projectDelegation(a, cache).byKey.get('codex:worker')!.proj;
  const misses = cache.misses;
  assert.deepEqual(compact(structuredClone(a), cache), first);
  assert.equal(cache.misses, misses, 'all complete facts of an equal clone hit');
  for (const vm of [b, structuredClone(a)]) {
    assert.deepEqual(compact(vm, cache), compact(vm, new ProjectionCache()));
  }
  assert.deepEqual(compact(a, cache), first);
  assert.equal(original.name, 'original', 'a later fact change does not mutate an old projection');
  assert.notDeepEqual(compact(b, cache), first);
});

test('perf equivalence: an older compact or rich frame retains its text, destinations and exact descriptor', () => {
  for (const style of ['compact', 'rich'] as const) {
    const a = buildVm([
      root,
      worker('original', {
        status: { cls: 'uncertain', since: ago(30) },
        run: { state: 'uncertain', reconciliation: 'scope_unknown' },
        reconcile: true,
      }),
    ]);
    const key = a.keys['worker'];
    const before = draw(a.vm, { style, selected: key, width: 80, height: 30 });
    const rows = before.panes.find((p) => p.id === 'agents')!.rows;
    const text = rows.map((row) => row.text);
    const dest = before.delegation!.dest.rows.map((row) => [row.key, row.parentKey]);
    const descriptor = a.vm.details[key].reconcile!;
    const b = buildVm([root, worker('newer', { status: S.failed(ago(2)) })]);
    draw(b.vm, { style, selected: key, width: 32, height: 12 });
    assert.deepEqual(
      rows.map((row) => row.text),
      text
    );
    assert.deepEqual(
      before.delegation!.dest.rows.map((row) => [row.key, row.parentKey]),
      dest
    );
    assert.equal(before.delegation!.proj.byKey.get(key)!.node, a.vm.tree.nodes[1]);
    const out = press(before, 'resume-reconcile');
    assert.equal(out.action?.type, 'delegation-copy');
    if (out.action?.type !== 'delegation-copy') assert.fail('the old frame still offers its own reconcile');
    assert.strictEqual(out.action.descriptor, descriptor);
    assert.equal(before.delegation!.vm, a.vm);
  }
});

test('perf equivalence: removed and reinserted nodes and a different root cannot contaminate a live snapshot', () => {
  const a = buildVm([root, worker()]);
  const old = projectDelegation(a.vm);
  const absent = buildVm([root]);
  projectDelegation(absent.vm);
  assert.equal(sharedProjectionCache.size, 1, 'disappeared entries are swept');
  const other = buildVm([
    { ...root, id: 'other-root' },
    { ...worker('other tree'), parent: 'other-root' },
  ]);
  const different = projectDelegation(other.vm);
  assert.equal(different.byKey.get(other.keys['worker'])!.parent!.key, other.keys['other-root']);
  const again = projectDelegation(structuredClone(a.vm));
  assert.deepEqual(again, projectDelegation(a.vm, new ProjectionCache()));
  assert.equal(old.byKey.get(a.keys['worker'])!.parent!.key, a.keys['main']);
  assert.equal(old.byKey.get(a.keys['worker'])!.proj.name, 'original');
  assert.equal(sharedProjectionCache.size, 2);
});

test('perf equivalence: old views survive conflict, topology and bucket changes plus option and clock boundaries', () => {
  const finished: NodeSpec = worker('finished', {
    run: { state: 'ended', endedAt: NOW - PUT_AWAY_MS + 1 },
    status: S.exited(NOW - PUT_AWAY_MS + 1),
    report: { status: 'completed', summary: 'synthetic result', at: NOW - PUT_AWAY_MS + 1 },
  });
  const a = buildVm([root, finished]);
  const b = buildVm([
    root,
    worker('changed', { status: S.pending('approval', ago(1)) }),
    {
      id: 'conflict',
      parent: 'main',
      relationOnly: true,
      conflict: { count: 2, since: ago(2) },
    },
  ]);
  for (const style of ['compact', 'rich'] as const) {
    const view = delegationView(a.vm, { nowMs: NOW, style });
    const keys = view.dest.rows.map((row) => row.key);
    for (const nowMs of [NOW, NOW + 1, NOW + 1000, NOW - 1]) {
      for (const showHistory of [false, true]) {
        for (const sortByCreation of [false, true]) {
          const options = { nowMs, style, width: 56, showHistory, sortByCreation, say: plainSay };
          const expected = delegationAgentsRows(structuredClone(a.vm), options).map((row) => row.text);
          delegationAgentsRows(b.vm, { ...options, collapsed: new Set([b.keys['main']]) }).map((row) => row.text);
          assert.deepEqual(
            delegationAgentsRows(a.vm, options).map((row) => row.text),
            expected
          );
        }
      }
    }
    assert.deepEqual(
      view.dest.rows.map((row) => row.key),
      keys
    );
    assert.ok(view.dest.index.has(a.keys['worker']), 'the pre-boundary view keeps its worker destination');
    assert.ok(delegationView(a.vm, { nowMs: NOW + 1, style }).plan.rows.some((row) => row.kind === 'putAway'));
  }
});

test('perf memo identity: consecutive hits, envelope-only wrappers, and all three tuple references', () => {
  const a = buildVm([root, worker()], { capacity: { active: 1, limit: 6, mine: 1, mineLimit: 4 } }).vm;
  const first = projectDelegation(a);
  assert.strictEqual(projectDelegation(a), first);
  const envelope = { ...a, pendingStatus: 17 };
  const wrapped = projectDelegation(envelope);
  assert.strictEqual(wrapped.vm, envelope);
  assert.strictEqual(first.vm, a);
  assert.equal(first.vm.pendingStatus, 0);
  assert.strictEqual(wrapped.nodes, first.nodes);
  assert.strictEqual(projectDelegation(a), first);
  for (const next of [
    { ...a, tree: structuredClone(a.tree) },
    { ...a, details: { ...a.details } },
    { ...a, capacity: structuredClone(a.capacity) },
    { ...a, capacity: null },
  ]) {
    const before = projectDelegation(a);
    const projected = projectDelegation(next);
    assert.notStrictEqual(projected, before);
    assert.strictEqual(projected.vm, next);
    assert.strictEqual(projected.vm.capacity, next.capacity);
    assert.deepEqual(projected, projectDelegation(next, new ProjectionCache()));
    assert.strictEqual(projectDelegation(next), projected);
  }
});

test('perf memo policy: one live tuple is retained, A to B to A evicts without retargeting snapshots', () => {
  const a = buildVm([root, worker()]).vm;
  const b = structuredClone(a);
  const first = projectDelegation(a);
  const second = projectDelegation(b);
  const again = projectDelegation(a);
  // This is a new bounded-eviction policy guard, not evidence of an old output bug or a speed measurement.
  assert.notStrictEqual(again, first);
  assert.deepEqual(again, projectDelegation(a, new ProjectionCache()));
  assert.strictEqual(first.vm, a);
  assert.strictEqual(second.vm, b);
  for (const [vm, proj] of [
    [a, first],
    [b, second],
  ] as const) {
    for (const node of vm.tree.nodes) assert.strictEqual(proj.byKey.get(node.key)!.node, node);
  }
});

test('perf memo isolation: a custom projection cache neither hits nor replaces the shared tuple', () => {
  const a = buildVm([root, worker()]).vm;
  const b = buildVm([root, worker('different')]).vm;
  const current = projectDelegation(a);
  const custom = new ProjectionCache();
  const independent = projectDelegation(a, custom);
  assert.notStrictEqual(independent, current);
  assert.equal(custom.misses, a.tree.nodes.length);
  projectDelegation(b, custom);
  assert.strictEqual(projectDelegation(a), current);
  assert.equal(current.byKey.get('codex:worker')!.proj.name, 'original');
});

test('perf snapshots: unread lazy rows and equal render facts with a newer descriptor keep their own views', () => {
  for (const style of ['compact', 'rich'] as const) {
    const a = buildVm([
      root,
      worker('original', {
        status: { cls: 'uncertain', since: ago(30) },
        run: { state: 'uncertain', reconciliation: 'scope_unknown' },
        reconcile: true,
      }),
    ]);
    const key = a.keys['worker'];
    const options = { style, width: 80, nowMs: NOW, selectedId: key, say: plainSay };
    const frameA = draw(a.vm, { style, width: 80, selected: key });
    const unread = delegationAgentsRows(a.vm, options);
    const expected = delegationAgentsRows(structuredClone(a.vm), options).map((row) => row.text);
    const b = structuredClone(a.vm);
    b.details[key].reconcile = { ...b.details[key].reconcile!, displayCommand: 'hud synthetic-new-descriptor' };
    const frameB = draw(b, { style, width: 80, selected: key });
    assert.deepEqual(
      unread.map((row) => row.text),
      expected
    );
    for (const [vm, frame] of [
      [a.vm, frameA],
      [b, frameB],
    ] as const) {
      const out = press(frame, 'resume-reconcile');
      if (out.action?.type !== 'delegation-copy') assert.fail('the frame offers reconcile');
      assert.strictEqual(out.action.descriptor, vm.details[key].reconcile);
      assert.strictEqual(frame.delegation!.vm, vm);
    }
    assert.deepEqual(draw(a.vm, { style, width: 80, selected: key }).lines, frameA.lines);
  }
});

test('perf cache churn: repeated keys under distinct roots sweep disappeared entries and preserve old trees', () => {
  const retained = [];
  for (let i = 0; i < 40; i++) {
    const id = `root-${i}`;
    const built = buildVm([
      { ...root, id },
      { ...worker(`worker-${i}`), parent: id },
    ]);
    const proj = projectDelegation(built.vm);
    retained.push({ vm: built.vm, proj, id, label: `worker-${i}` });
    assert.equal(sharedProjectionCache.size, 2);
    assert.equal(sharedProjectionCache.get(`claude:root-${i - 1}`), undefined);
  }
  const empty = buildVm([root]).vm;
  projectDelegation(empty);
  assert.equal(sharedProjectionCache.size, 1);
  for (const { vm, proj, id, label } of retained) {
    assert.strictEqual(proj.vm, vm);
    assert.equal(proj.byKey.get('codex:worker')!.parent!.key, `claude:${id}`);
    assert.equal(proj.byKey.get('codex:worker')!.proj.name, label);
  }
});

test('facts scratch lifetime: equal/miss/equal passes never overwrite or alias retained frozen facts', () => {
  const built = buildVm([
    root,
    { ...worker('first'), id: 'first' },
    { ...worker('middle'), id: 'middle' },
    { ...worker('last'), id: 'last' },
  ]);
  const cache = new ProjectionCache();
  const original = projectDelegation(built.vm, cache);
  const saved = built.vm.tree.nodes.map((node) => {
    const facts = cache.get(node.key)!.facts;
    Object.freeze(facts);
    return { key: node.key, facts, value: { ...facts } };
  });
  const equal = projectDelegation(structuredClone(built.vm), cache);
  assert.equal(cache.hits, 4);
  assert.equal(cache.misses, 4);
  for (const { key, facts } of saved) {
    assert.strictEqual(cache.get(key)!.facts, facts);
    assert.strictEqual(equal.byKey.get(key)!.proj, original.byKey.get(key)!.proj);
  }
  const changed = structuredClone(built.vm);
  changed.tree.relations.find((r) => r.childKey === built.keys['middle'])!.link.label = 'middle changed';
  const mixed = projectDelegation(changed, cache);
  assert.equal(cache.hits, 7, 'hits before and after the middle miss remain hits');
  assert.equal(cache.misses, 5);
  assert.deepEqual(mixed, projectDelegation(changed, new ProjectionCache()));
  for (const { key, facts, value } of saved) {
    assert.deepEqual(facts, value);
    if (key !== built.keys['middle']) assert.strictEqual(cache.get(key)!.facts, facts);
    Object.freeze(cache.get(key)!.facts);
  }
  assert.equal(new Set(changed.tree.nodes.map((node) => cache.get(node.key)!.facts)).size, 4);
  const later = structuredClone(changed);
  later.tree.relations.find((r) => r.childKey === built.keys['last'])!.link.label = 'last changed';
  assert.deepEqual(projectDelegation(later, cache), projectDelegation(later, new ProjectionCache()));
  assert.equal(cache.hits, 10);
  assert.equal(cache.misses, 6);
  assert.equal(cache.get(built.keys['middle'])!.facts.linkLabel, 'middle changed');
  assert.equal(cache.get(built.keys['last'])!.facts.linkLabel, 'last changed');
  assert.deepEqual(projectDelegation(structuredClone(built.vm), cache), original);
  assert.equal(cache.hits, 12);
  assert.equal(cache.misses, 8);
  for (const { facts, value } of saved) assert.deepEqual(facts, value);
});

test('facts scratch lifetime: all-cold and all-miss records stay distinct through removal and reinsertion', () => {
  const a = buildVm([root, worker(), { ...worker('sibling'), id: 'sibling' }]);
  const cache = new ProjectionCache();
  const first = projectDelegation(a.vm, cache);
  const old = a.vm.tree.nodes.map((node) => Object.freeze(cache.get(node.key)!.facts));
  const b = structuredClone(a.vm);
  for (const node of b.tree.nodes) node.loaded = !node.loaded;
  const second = projectDelegation(b, cache);
  assert.equal(cache.misses, 6);
  assert.equal(cache.hits, 0);
  const next = b.tree.nodes.map((node) => cache.get(node.key)!.facts);
  assert.equal(new Set(next).size, 3);
  for (const facts of next) {
    assert.ok(!old.includes(facts));
    Object.freeze(facts);
  }
  assert.deepEqual(second, projectDelegation(b, new ProjectionCache()));
  projectDelegation(buildVm([root]).vm, cache);
  assert.equal(cache.size, 1);
  assert.equal(cache.get(a.keys['worker']), undefined);
  assert.deepEqual(projectDelegation(a.vm, cache), first);
  assert.equal(cache.size, 3);
  for (const [index, node] of a.vm.tree.nodes.entries()) {
    assert.strictEqual(first.byKey.get(node.key)!.node, node);
    assert.equal(old[index].loaded, node.loaded);
    assert.equal(next[index].loaded, !node.loaded);
  }
});

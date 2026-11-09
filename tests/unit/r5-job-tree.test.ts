import assert from 'node:assert/strict';
import test from 'node:test';
import { r5Fixture, refR5, idR5, ROOT_R5 } from '../fixtures/r5-jobs.js';
import { registerExternal, externalRootHash } from '../../src/roles/external-association.js';
import { composeJobTree } from '../../src/collectors/job-tree.js';
import type { SubagentTreeNode } from '../../src/types.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { NativeCallCollector } from '../../src/collectors/native-calls.js';
import { RelationStore } from '../../src/managed/relations.js';
import { projectLinkTree } from '../../src/core/link/index.js';

const native = (id: string, ref = refR5(), children: SubagentTreeNode[] = []): SubagentTreeNode => ({
  id,
  ref,
  name: 'Synthetic native',
  status: 'running',
  rolloutPath: '/synthetic/rollout.jsonl',
  depth: 1,
  children,
});
test('R5 mixed real-file tree has one invocation per job, exact helpers, native descendants and residual native-v2 relation', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  f.receipt(f.association(1));
  const pi = f.association(2);
  f.dispatch(pi);
  f.status(pi, 'working', {}, 'sonic-1');
  f.status(pi, 'working', {}, 'review-1');
  const web = {
    id: 'synthetic-web',
    executor: 'jev' as const,
    harness: null,
    model: 'target',
    effort: null,
    env_profile: null,
    recipe: null,
  };
  f.jev(f.association(3, { role: 'oracle', phase: 'propose', backend: web }), 'completed', { status: 'answered' });
  f.jev(f.association(4, { role: 'jev', backend: web }), 'running');
  registerExternal(
    f.home,
    {
      root: ROOT_R5,
      id: 'external',
      agent: 'synthetic-agent',
      pane: 'pane-1',
      tab: 'tab-1',
      workspace: null,
      label: 'Synthetic external',
    },
    f.now()
  );
  const tree = {
    ...f.emptyTree(),
    nodes: [native('native-parent', refR5('b'), [native('native-descendant', refR5('c'))])],
  };
  const result = await f.collect(c, 40, tree);
  assert.equal(result.tree.nodes.length, 6);
  assert.equal(result.tree.totalCount, 9);
  assert.deepEqual(
    result.tree.nodes
      .find((n) => n.job?.jobId === idR5(2))!
      .children.map((n) => n.id)
      .sort(),
    [`role-job:${pi.job}:dispatch:review-1`, `role-job:${pi.job}:dispatch:sonic-1`]
  );
  assert.equal(result.tree.nodes[0]!.children[0]!.id, 'native-descendant');
  assert.equal(result.tree.nodes.filter((n) => n.job?.jobId === idR5(3)).length, 1);
  assert.equal(result.tree.nodes.filter((n) => n.job?.jobId === idR5(4)).length, 1);
  assert.ok(result.tree.nodes.some((n) => n.id === `external-herdr:${externalRootHash(ROOT_R5)}:external`));
  const owner = { ...refR5('d'), threadId: null };
  const relation = {
    owner,
    callId: 'synthetic-call',
    workspace: '/synthetic/work',
    child: { harness: 'codex' as const, threadId: 'synthetic-legacy' },
    profileId: 'synthetic-profile',
    createdAt: 1,
  };
  new RelationStore(f.home).record(relation);
  // The real legacy collector/merger remains independent; it may not invent an exact native source.
  const legacyCollector = new NativeCallCollector(f.home);
  await legacyCollector.collect(owner);
  const legacy = legacyCollector.merge(null);
  assert.ok(legacy?.tree.nodes.some((n) => n.key.startsWith('native-call:')));
  const composed = composeJobTree({ tree, snapshot: result.snapshot, root: ROOT_R5, nowMs: f.now(), legacy });
  assert.equal(composed.legacy!.tree.nodes.length, legacy!.tree.nodes.length);
  assert.equal(composed.tree.totalCount, 9);
});

test('R5 exact full-ref dedupe enriches native node and preserves id, rollout, children; incomplete refs never claim it', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const ref = refR5();
  const a = f.association(1, { native: ref });
  f.receipt(a);
  const child = native('kept-child', refR5('b'));
  const n = native('kept-native-id', ref, [child]);
  const tree = { ...f.emptyTree(), nodes: [n] };
  let result = await f.collect(c, 10, tree);
  assert.equal(result.tree.nodes.length, 1);
  assert.equal(result.tree.nodes[0]!.id, n.id);
  assert.equal(result.tree.nodes[0]!.rolloutPath, n.rolloutPath);
  assert.equal(result.tree.nodes[0]!.children[0]!.id, child.id);
  assert.equal(result.tree.nodes[0]!.job!.jobId, a.job);
  assert.equal(result.aliases[`role-job:${a.job}`], n.id);
  assert.equal(n.job, undefined, 'composition does not mutate its input');
  const incomplete = { harness: 'codex', sessionId: ref.sessionId, threadId: null };
  f.put(joinAssoc(f.home, a.job), { ...a, native: incomplete });
  result = await f.collect(c, 10, tree);
  assert.equal(result.tree.nodes.length, 2);
  assert.ok(result.tree.nodes.some((n) => n.id === `role-job:${a.job}`));
});
const joinAssoc = (home: string, job: string) => `${home}/assoc/${job}.json`;

test('R5 two invocations on one native session remain two records; no arbitrary descendant ownership; cycles refused', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const ref = refR5();
  for (const i of [1, 2]) f.receipt(f.association(i, { native: ref }));
  const tree = { ...f.emptyTree(), nodes: [native('native', ref, [native('only-child', refR5('b'))])] };
  const result = await f.collect(c, 10, tree);
  assert.equal(result.tree.nodes.length, 3);
  assert.equal(result.tree.totalCount, 4);
  assert.equal(result.tree.nodes[0]!.job, undefined);
  assert.ok(result.diagnostics.some((d) => d.startsWith('ambiguous_native_ownership:')));
  const cyclic = native('cycle');
  cyclic.children = [cyclic];
  const cycle = composeJobTree({
    tree: { ...f.emptyTree(), nodes: [cyclic] },
    snapshot: result.snapshot,
    root: ROOT_R5,
    nowMs: f.now(),
  });
  assert.ok(cycle.diagnostics.some((d) => d.startsWith('cycle_or_duplicate:')));
  assert.equal(cycle.tree.totalCount, 3);
});

test('R5 legacy exact-ref replacement migrates descendants atomically and keeps residual history; combined budget includes native nodes', async (t) => {
  const f = r5Fixture(t),
    main = refR5('d', 'parent'),
    child = refR5('a'),
    grandchild = refR5('b');
  const root = `${main.sourceId}/${main.sessionId}`,
    c = f.observer(root);
  const a = f.association(1, { root, native: child });
  f.receipt(a);
  new RelationStore(f.home).record({
    owner: main,
    callId: 'synthetic-call',
    child: { harness: 'pi', sessionId: 'thin-child', sessionFile: '/synthetic/pi.jsonl' },
    workspace: '/synthetic',
    profileId: 'pi-local',
    createdAt: f.now(),
  });
  const nativeCalls = new NativeCallCollector(f.home);
  await nativeCalls.collect(main);
  const base = nativeCalls.merge(null)!;
  const linkTree = projectLinkTree({
    ledger: { state: 'degraded', snapshot: null, reason: 'synthetic' },
    roots: [main, child, grandchild].map((ref) => ({ kind: 'session' as const, ref })),
    sessions: [],
    nowMs: f.now(),
  });
  const row = (sourceId: string) =>
    linkTree.nodes.find((n) => n.identity.kind === 'session' && n.identity.ref.sourceId === sourceId)!;
  const mainRow = row(main.sourceId),
    childRow = row(child.sourceId),
    grandRow = row(grandchild.sourceId);
  childRow.parentKey = mainRow.key;
  grandRow.parentKey = childRow.key;
  const legacy = { ...base, tree: linkTree },
    snapshot = (await f.collect(c)).snapshot;
  const result = composeJobTree({ tree: f.emptyTree(), snapshot, root, nowMs: f.now(), legacy });
  assert.equal(result.tree.nodes.length, 1);
  assert.equal(result.tree.nodes[0]!.id, childRow.key);
  assert.equal(result.tree.nodes[0]!.job!.jobId, a.job);
  assert.equal(result.tree.nodes[0]!.children[0]!.id, grandRow.key);
  assert.deepEqual(
    result.legacy!.tree.nodes.map((n) => n.key),
    [mainRow.key]
  );
  assert.strictEqual(result.legacy!.tree.relations, legacy.tree.relations);
  assert.strictEqual(result.legacy!.details, legacy.details);
  const second = f.association(2, { root });
  f.receipt(second);
  const all = (await f.collect(c)).snapshot;
  const fullNative = {
    ...f.emptyTree(),
    nodes: Array.from({ length: 199 }, (_, i) => native(`existing-${i}`, refR5('f', `native-${i}`))),
  };
  const capped = composeJobTree({ tree: fullNative, snapshot: all, root, nowMs: f.now() });
  assert.equal(capped.tree.totalCount, 200);
  assert.ok(capped.coverage.incomplete);
  assert.equal(fullNative.nodes.length, 199);
});

test('R5 same native session string under another namespace does not dedupe', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const ref = refR5();
  f.receipt(f.association(1, { native: ref }));
  const result = await f.collect(c, 10, {
    ...f.emptyTree(),
    nodes: [native('other-source', refR5('b', ref.sessionId))],
  });
  assert.equal(result.tree.nodes.length, 2);
});

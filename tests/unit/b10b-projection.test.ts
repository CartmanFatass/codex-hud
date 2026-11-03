/**
 * Design §6: the node projection cache, the single post-order pass for
 * subtree buckets and counts, and the tree's spend sum.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PROJECTED_NODES,
  ProjectionCache,
  projectDelegation,
  sharedProjectionCache,
  spendText,
} from '../../src/render/delegation/projection.js';
import { planRows, renderRow, renderRows } from '../../src/render/delegation/rows.js';
import { delegationAlerts } from '../../src/render/delegation/alerts.js';
import { attentionForms } from '../../src/render/delegation/bar.js';
import { statuslineDelegation } from '../../src/render/delegation/statusline.js';
import { plainSay } from '../../src/render/delegation/style.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationC,
  situationD,
  situationE,
  type NodeSpec,
} from '../fixtures/b10b-delegation.js';

test('counts are by marker over every node but the viewpoint root; backends and spend follow', () => {
  const proj = projectDelegation(situationC({ reviewPass: true }).vm, new ProjectionCache());
  assert.deepEqual(
    { ...proj.counts },
    { warn: 0, flag: 1, fail: 0, stop: 0, unknown: 0, working: 3, starting: 0, done: 2 }
  );
  // The statusline's ⧉ counts workers and jobs only: no root, no native children.
  assert.deepEqual(
    { ...proj.delegatedCounts },
    { warn: 0, flag: 1, fail: 0, stop: 0, unknown: 0, working: 2, starting: 0, done: 1 }
  );
  assert.deepEqual({ ...proj.backends }, { codex: 2, pi: 1, jev: 1, claude: 0 });
  assert.equal(proj.crossHarness, true);
  assert.equal(proj.toClose, 0);
  // Only pi reported a cost: a lower bound, never a total (§1).
  assert.equal(proj.spend.value, 0.12);
  assert.equal(proj.spend.knownCount, 1);
  assert.ok(proj.spend.missingCount > 0);
  assert.equal(spendText(proj.spend), '≥$0.12');
});

test('a tree of one harness is not cross-harness, and a spend nobody reported is not written', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'codex', status: S.working() },
    { id: 'a', parent: 'main', native: true, harness: 'codex', status: S.working() },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.equal(proj.crossHarness, false);
  assert.equal(spendText(proj.spend), '');
  assert.equal(proj.spend.value, null);
});

test('the slots and the close-pane count: held by marker, to close by fact', () => {
  const proj = projectDelegation(situationD().vm, new ProjectionCache());
  assert.equal(proj.counts.done, 9);
  assert.equal(proj.counts.unknown, 1);
  assert.equal(proj.counts.starting, 1);
  assert.equal(proj.toClose, 0, 'the nine finished runs hold no slot');
});

test('one post-order pass: a finished parent with a pending grandchild sorts first, and counts what is below', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'quiet', parent: 'main', status: S.working(ago(900)), createdAt: ago(900) },
    {
      id: 'parent',
      parent: 'main',
      run: { state: 'ended', endedAt: ago(400) },
      status: S.exited(ago(400)),
      report: { status: 'completed', summary: 'ok', at: ago(400) },
      createdAt: ago(800),
    },
    { id: 'kid', parent: 'parent', harness: 'pi', status: S.pending('approval', ago(25)), createdAt: ago(700) },
    { id: 'kid2', parent: 'parent', harness: 'pi', status: S.working(ago(60)), createdAt: ago(600) },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  const parent = proj.byKey.get('codex:parent')!;
  assert.equal(parent.proj.marker.glyph, 'done', 'the parent itself is a ✓');
  assert.equal(parent.sub.rank, 0, 'the subtree bucket is the best of its members (§3.2)');
  assert.equal(parent.sub.sortAt, ago(25), "and its time is the grandchild's");
  assert.deepEqual(
    { flag: parent.sub.below.flag, working: parent.sub.below.working, done: parent.sub.below.done },
    { flag: 1, working: 1, done: 0 }
  );
  assert.equal(parent.sub.total, 2);
  assert.equal(parent.sub.allFinished, false, 'a subtree with live members is never put away');

  const order = planRows(proj, { nowMs: NOW }).rows.map((row) => row.key);
  assert.deepEqual(order, ['claude:main', 'codex:parent', 'pi:kid', 'pi:kid2', 'codex:quiet']);

  const root = proj.byKey.get('claude:main')!;
  assert.equal(root.sub.total, 4);
  assert.equal(root.sub.rank, 0);
});

test('a finished subtree is put away with its youngest member, not its oldest', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    {
      id: 'p',
      parent: 'main',
      run: { state: 'ended', endedAt: ago(900) },
      status: S.exited(ago(900)),
      report: { status: 'completed', summary: 'a', at: ago(900) },
    },
    {
      id: 'c',
      parent: 'p',
      run: { state: 'ended', endedAt: ago(100) },
      status: S.exited(ago(100)),
      report: { status: 'completed', summary: 'b', at: ago(100) },
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  const p = proj.byKey.get('codex:p')!;
  assert.equal(p.sub.allFinished, true);
  assert.equal(p.sub.youngestFinish, ago(100));
  const rows = planRows(proj, { nowMs: NOW }).rows.map((row) => row.key);
  assert.deepEqual(rows, ['claude:main', 'codex:p', 'codex:c'], 'the parent waits for its youngest child');
  assert.deepEqual(
    planRows(proj, { nowMs: NOW + 90_000 }).rows.map((row) => row.kind),
    ['node', 'putAway'],
    'then both go, as one row'
  );
});

test('the node cache: an equal tree rebuilt every tick costs one stamp compare per node', () => {
  const cache = new ProjectionCache();
  const first = projectDelegation(situationC().vm, cache);
  const nodes = first.nodes.length;
  assert.equal(cache.misses, nodes);
  assert.equal(cache.hits, 0);
  // A new tick builds new objects with the same content.
  const second = projectDelegation(situationC().vm, cache);
  assert.equal(cache.misses, nodes, 'nothing was projected again');
  assert.equal(cache.hits, nodes);
  for (const pn of second.nodes) assert.equal(pn.proj, first.byKey.get(pn.key)!.proj, 'the very same node projection');
  assert.equal(cache.size, nodes);
});

test('the node cache: one changed state projects one node', () => {
  const cache = new ProjectionCache();
  const specs = (since: number): NodeSpec[] => [
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'a', parent: 'main', status: S.working(ago(300)) },
    { id: 'b', parent: 'main', status: S.pending('approval', since) },
  ];
  projectDelegation(buildVm(specs(ago(50))).vm, cache);
  const before = cache.misses;
  projectDelegation(buildVm(specs(ago(50))).vm, cache);
  assert.equal(cache.misses, before);
  const changed = projectDelegation(buildVm(specs(ago(5))).vm, cache);
  assert.equal(cache.misses, before + 1);
  assert.equal(changed.byKey.get('codex:b')!.proj.marker.sinceMs, ago(5));
});

test('the node cache: derived freshness moves the marker with every commit stamp unchanged', () => {
  const cache = new ProjectionCache();
  const specs = (freshness: 'fresh' | 'stale', reason: string | null): NodeSpec[] => [
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    {
      id: 'a',
      parent: 'main',
      status: { cls: 'working', since: ago(300), freshness, freshnessReason: reason },
    },
  ];
  const tick1 = projectDelegation(buildVm(specs('fresh', null)).vm, cache);
  const row1 = renderRow(planRows(tick1, { nowMs: NOW }).rows[1], { proj: tick1, width: 48, nowMs: NOW });
  assert.equal(tick1.byKey.get('codex:a')!.proj.marker.glyph, 'working');
  const misses = cache.misses;

  // A required source expired: the stamp, the state key and the evidence stamp are all what they were.
  const stale = buildVm(specs('stale', 'source_expired')).vm;
  const was = buildVm(specs('fresh', null)).vm;
  // Freshness is the only difference: the ledger sequence, the status sequence and the observation commit
  // sequence are those of the model the cache has seen (comparing the new model with the old one, not with itself).
  assert.equal(stale.tree.ledger.asOfSeq, was.tree.ledger.asOfSeq);
  assert.equal(stale.details['codex:a'].status!.asOfSeq, was.details['codex:a'].status!.asOfSeq);
  assert.equal(
    stale.details['codex:a'].status!.observationStamp!.commitSeq,
    was.details['codex:a'].status!.observationStamp!.commitSeq
  );
  assert.deepEqual(stale.details['codex:a'].status!.observationStamp, was.details['codex:a'].status!.observationStamp);
  assert.notEqual(stale.details['codex:a'].status!.freshness.state, was.details['codex:a'].status!.freshness.state);
  assert.equal(stale.details['codex:a'].status!.stateKey, was.details['codex:a'].status!.stateKey);
  assert.equal(stale.tree.nodes[1].observation!.evidenceStamp, was.tree.nodes[1].observation!.evidenceStamp);

  const tick2 = projectDelegation(stale, cache);
  assert.equal(cache.misses, misses + 1, 'exactly the changed node is projected again');
  const marker = tick2.byKey.get('codex:a')!.proj.marker;
  assert.equal(marker.glyph, 'unknown');
  assert.deepEqual(marker.words, ['stale']);
  const row2 = renderRow(planRows(tick2, { nowMs: NOW }).rows[1], { proj: tick2, width: 48, nowMs: NOW });
  assert.notEqual(stripAnsi(row1), stripAnsi(row2));
  assert.match(stripAnsi(row2), /\? .*a.* · stale/);

  // Only the reason moves: still a new projection.
  const tick3 = projectDelegation(buildVm(specs('stale', 'registry_unreachable')).vm, cache);
  assert.equal(cache.misses, misses + 2);
  assert.equal(tick3.byKey.get('codex:a')!.proj.marker.glyph, 'unknown');
});

test('a node the cache no longer sees is swept', () => {
  const cache = new ProjectionCache();
  projectDelegation(situationC().vm, cache);
  const small = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working() }]).vm;
  projectDelegation(small, cache);
  assert.equal(cache.size, 1);
});

test('the same tree, details and capacity objects return the same projection', () => {
  const { vm } = situationC();
  const a = projectDelegation(vm);
  const b = projectDelegation(vm);
  assert.equal(a, b);
  assert.ok(sharedProjectionCache.size > 0);
  // A tick that rebuilt only the envelope still finds the cached nodes.
  const c = projectDelegation({ ...vm, pendingStatus: 3 });
  assert.equal(c.nodes.length, a.nodes.length);
});

test('an observation the reader says is unavailable is `? unknown`, never healthy or idle', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'a', parent: 'main', status: S.working(ago(100)), observationUnavailable: 'reader_busy' },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  const marker = proj.byKey.get('codex:a')!.proj.marker;
  assert.equal(marker.glyph, 'unknown');
  assert.deepEqual(marker.words, ['unknown']);
  assert.equal(marker.clock.at, null);
  assert.equal(proj.counts.working, 0);
  assert.equal(proj.counts.unknown, 1);
});

test('conflicts: one row per claiming parent in the tree, one count per child', () => {
  const proj = projectDelegation(situationE().vm, new ProjectionCache());
  const rows = planRows(proj, { nowMs: NOW }).rows;
  const conflicts = rows.filter((row) => row.pn?.proj.marker.glyph === 'warn');
  assert.equal(conflicts.length, 1, 'the second claimant is not in the tree');
  assert.equal(conflicts[0].unconfirmed, true, 'drawn with `┊`');
  assert.equal(proj.counts.warn, 1);

  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'other', parent: 'main', harness: 'claude', status: S.working() },
    { id: 'c', parent: 'main', alsoClaimedBy: ['other'], relationOnly: true, conflict: { count: 2, since: ago(360) } },
  ]);
  const both = projectDelegation(vm, new ProjectionCache());
  const bothRows = planRows(both, { nowMs: NOW }).rows.filter((row) => row.pn?.proj.marker.glyph === 'warn');
  assert.equal(bothRows.length, 2, 'drawn under each claiming parent');
  assert.equal(both.counts.warn, 1, 'counted once');
});

test('a session ref the identity check rejects does not stop the render', () => {
  const { vm } = situationC();
  const broken = {
    ...vm,
    tree: {
      ...vm.tree,
      nodes: vm.tree.nodes.map((node, i) =>
        i === 1 && node.identity.kind === 'session'
          ? { ...node, identity: { ...node.identity, ref: { ...node.identity.ref, sourceId: 'not a digest' } } }
          : node
      ),
    },
  };
  const proj = projectDelegation(broken, new ProjectionCache());
  assert.equal(proj.spend.value, null);
  assert.equal(spendText(proj.spend), '');
});

const MAIN: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(30)), label: null };

/** The `ESC[...m` colour sequences are the renderer's own; anything else with a control code is not. */
// eslint-disable-next-line no-control-regex
const withoutColours = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, '');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

test('model and effort are escaped once, when the projection is built (§6 #7)', () => {
  const { vm } = buildVm([
    MAIN,
    {
      id: 'a',
      parent: 'main',
      status: S.working(ago(60)),
      model: 'demo\x1b[2J',
      effort: 'high\x1b[31m',
      contextPercent: 40,
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  const p = proj.byKey.get('codex:a')!.proj;
  assert.equal(p.model, 'demo\\x1b[2J');
  assert.equal(p.effort, 'high\\x1b[31m');
  for (const width of [80, 56, 48, 40]) {
    const rows = renderRows(proj, { nowMs: NOW }, { width, say: plainSay });
    for (const row of rows) {
      assert.doesNotMatch(withoutColours(row), CONTROL, `${width}: |${JSON.stringify(row)}|`);
      assert.equal(visualLength(row), width);
    }
  }
  // The root's badge is a model badge too.
  const { vm: root } = buildVm([{ ...MAIN, model: 'x\x9b2J', effort: 'y\x07' }]);
  const rootRow = renderRows(
    projectDelegation(root, new ProjectionCache()),
    { nowMs: NOW },
    { width: 60, say: plainSay }
  )[0];
  assert.doesNotMatch(withoutColours(rootRow), CONTROL);
});

/** A child claimed by two parents, written by each record under its own label. */
function conflictTree(labels: [string | null, string | null]) {
  const { vm } = buildVm([
    MAIN,
    { id: 'other', parent: 'main', harness: 'claude', status: S.working(ago(60)), createdAt: ago(900) },
    {
      id: 'c',
      parent: 'main',
      harness: 'codex',
      alsoClaimedBy: ['other'],
      relationOnly: true,
      conflict: { count: 2, since: ago(360) },
    },
  ]);
  const built = structuredClone(vm);
  const records = built.tree.relations.filter((r) => r.childKey === 'codex:c');
  records[0].link.label = labels[0];
  records[1].link.label = labels[1];
  return built;
}

const conflictRows = (vm: DelegationViewModel) =>
  projectDelegation(vm, new ProjectionCache()).nodes.filter((pn) => pn.node === null);

test('§3.4: a conflicting child has one name, the shared label only when every record agrees', () => {
  // Disagreeing labels: both rows, the alert and the statusline say the child by its session short form.
  const apart = conflictTree(['alpha', 'beta']);
  const rows = conflictRows(apart);
  assert.equal(rows.length, 2, 'one row under each claiming parent');
  assert.deepEqual(
    rows.map((r) => r.proj.name),
    ['codex:c000', 'codex:c000']
  );
  const proj = projectDelegation(apart, new ProjectionCache());
  assert.deepEqual(
    delegationAlerts(proj, NOW, plainSay)
      .nodes.filter((a) => a.cls === 'warn')
      .map((a) => a.name),
    ['codex:c000']
  );
  const line2 = stripAnsi(statuslineDelegation(apart, { width: 120, nowMs: NOW, say: plainSay }).line2 ?? '');
  assert.match(line2, /codex:c000 conflict/);
  assert.doesNotMatch(line2, /alpha|beta/);
  // Agreeing labels: the label, on every occurrence.
  const agree = conflictRows(conflictTree(['alpha', 'alpha']));
  assert.deepEqual(
    agree.map((r) => r.proj.name),
    ['alpha', 'alpha']
  );
  // One record without a label breaks the agreement.
  assert.deepEqual(
    conflictRows(conflictTree(['alpha', null])).map((r) => r.proj.name),
    ['codex:c000', 'codex:c000']
  );
  // The records name the child by its session even if one is stale about the label: the order of the records
  // does not matter.
  assert.deepEqual(
    conflictRows(conflictTree(['beta', 'alpha'])).map((r) => r.proj.name),
    ['codex:c000', 'codex:c000']
  );
  // A name with a control code is escaped.
  assert.deepEqual(
    conflictRows(conflictTree(['a\x1b[2J', 'a\x1b[2J'])).map((r) => r.proj.name),
    ['a\\x1b[2J', 'a\\x1b[2J']
  );
});

test('§3.4: a conflicting child that is also a node is named the same way on every row', () => {
  const { vm } = buildVm([
    MAIN,
    { id: 'other', parent: 'main', harness: 'claude', status: S.working(ago(60)), createdAt: ago(900) },
    { id: 'c', parent: 'main', harness: 'codex', alsoClaimedBy: ['other'], conflict: { count: 2, since: ago(360) } },
  ]);
  const built = structuredClone(vm);
  const records = built.tree.relations.filter((r) => r.childKey === 'codex:c');
  records[0].link.label = 'alpha';
  records[1].link.label = 'beta';
  const proj = projectDelegation(built, new ProjectionCache());
  const names = proj.nodes.filter((pn) => pn.proj.marker.glyph === 'warn').map((pn) => pn.proj.name);
  assert.ok(names.length >= 2, 'the node itself and its other claim');
  assert.deepEqual([...new Set(names)], ['codex:c000']);
});

test('§3.4: a conflict-only child takes part in cross-harness detection, with its harness from the link', () => {
  const { vm } = buildVm([
    MAIN,
    { id: 'other', parent: 'main', harness: 'claude', status: S.working(ago(60)), createdAt: ago(900) },
    {
      id: 'c',
      parent: 'main',
      harness: 'codex',
      alsoClaimedBy: ['other'],
      relationOnly: true,
      conflict: { count: 2, since: ago(360) },
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.equal(proj.crossHarness, true, 'a Codex child among Claude nodes is a second harness');
  const rows = renderRows(proj, { nowMs: NOW }, { width: 60, say: plainSay }).map(stripAnsi);
  assert.ok(
    rows.some((r) => /⚠ ⌬ codex:c000|⚠ ⌬ c/.test(r)),
    rows.join('\n')
  );
  // The session the link names beats the backend profile's hint.
  const built = structuredClone(vm);
  for (const r of built.tree.relations.filter((x) => x.childKey === 'codex:c')) {
    r.link.backend = 'claude';
    r.link.childRef = { harness: 'pi', sourceId: 'ab'.repeat(32), sessionId: 'c-0001', threadId: null };
  }
  const named = projectDelegation(built, new ProjectionCache());
  assert.deepEqual(
    conflictRows(built).map((r) => r.proj.harness),
    ['pi', 'pi']
  );
  assert.equal(named.crossHarness, true);
  assert.deepEqual({ ...named.backends }, { codex: 0, pi: 1, jev: 0, claude: 1 });
  // A conflict child of the same harness as everything else opens no slot column.
  const same = buildVm([
    MAIN,
    { id: 'c', parent: 'main', harness: 'claude', relationOnly: true, conflict: { count: 1, since: ago(60) } },
  ]);
  assert.equal(projectDelegation(same.vm, new ProjectionCache()).crossHarness, false);
});

function budgetTree(real: number, conflicts: number) {
  return buildVm([
    MAIN,
    ...Array.from({ length: real - 1 }, (_, i): NodeSpec => ({
      id: `w${i}`,
      parent: 'main',
      harness: i % 2 ? 'pi' : 'codex',
      status: S.working(ago(60 + i)),
      createdAt: ago(1000 - i),
    })),
    ...Array.from({ length: conflicts }, (_, i): NodeSpec => ({
      id: `x${i}`,
      parent: 'main',
      harness: 'codex',
      relationOnly: true,
      conflict: { count: 2, since: ago(300 + i) },
    })),
  ]);
}

test('§6 #3: conflict rows share the 200-node budget; the rest are counted and reported', () => {
  assert.equal(MAX_PROJECTED_NODES, 200);
  // 200 real nodes + 2 conflicts: nothing fits, both children are still counted, once each.
  const full = projectDelegation(budgetTree(200, 2).vm, new ProjectionCache());
  assert.equal(full.nodes.length, 200);
  assert.equal(full.omittedConflictRows, 2);
  assert.equal(full.counts.warn, 2);
  assert.equal(full.conflictKeys.size, 2);
  assert.equal(planRows(full, { nowMs: NOW }).rows.length, 200);
  // 199 + 2: one fits.
  const edge = projectDelegation(budgetTree(199, 2).vm, new ProjectionCache());
  assert.equal(edge.nodes.length, 200);
  assert.equal(edge.omittedConflictRows, 1);
  assert.equal(edge.counts.warn, 2);
  assert.equal(planRows(edge, { nowMs: NOW }).rows.length, 200);
  // 198 + 2: both fit.
  const fits = projectDelegation(budgetTree(198, 2).vm, new ProjectionCache());
  assert.equal(fits.nodes.length, 200);
  assert.equal(fits.omittedConflictRows, 0);
  assert.equal(fits.counts.warn, 2);
  // Many conflicts: the work never grows past the budget.
  const flood = projectDelegation(budgetTree(150, 400).vm, new ProjectionCache());
  assert.equal(flood.nodes.length, 200);
  assert.equal(flood.omittedConflictRows, 350);
  assert.equal(flood.counts.warn, 400);
  assert.equal(planRows(flood, { nowMs: NOW }).rows.length, 200);
  // A conflict claimed by two parents that are both in the tree is one child, counted once, omitted or drawn.
  const { vm } = buildVm([
    MAIN,
    ...Array.from({ length: 198 }, (_, i): NodeSpec => ({
      id: `w${i}`,
      parent: 'main',
      status: S.working(ago(60 + i)),
    })),
    {
      id: 'c',
      parent: 'main',
      alsoClaimedBy: ['w0', 'w1'],
      relationOnly: true,
      conflict: { count: 3, since: ago(60) },
    },
  ]);
  const shared = projectDelegation(vm, new ProjectionCache());
  assert.equal(shared.nodes.length, 200, 'one of the three claims fits');
  assert.equal(shared.omittedConflictRows, 2);
  assert.equal(shared.counts.warn, 1);
});

// ---------------------------------------------------------------------------
// Fix round 2, #16: the row budget bounds what is drawn, not what is known.

/** A finished native child, old enough to be history (and so to fold away when its subtree is finished). */
const oldNative = (id: string, parent: string): NodeSpec => ({
  id,
  parent,
  native: true,
  status: S.exited(ago(3600)),
  createdAt: ago(7200),
});

const fillers = (count: number, from = 0): NodeSpec[] =>
  Array.from({ length: count }, (_, i): NodeSpec => ({
    id: `w${from + i}`,
    parent: 'main',
    status: S.working(ago(60 + i)),
    createdAt: ago(1000 - i),
  }));

test('§4.1, §4.12: a conflict that fits no row still lights the bar and the statusline, and marks the root', () => {
  // 199 history rows and the root fill the budget; the one conflicting child has no row.
  const { vm } = buildVm([
    MAIN,
    ...Array.from({ length: 199 }, (_, i) => oldNative(`n${i}`, 'main')),
    { id: 'x', parent: 'main', harness: 'codex', relationOnly: true, conflict: { count: 2, since: ago(300) } },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.equal(proj.nodes.length, 200);
  assert.equal(proj.omittedConflictRows, 1);
  assert.equal(proj.omittedConflicts.length, 1, 'one summary for the child nothing draws');
  assert.equal(proj.counts.warn, 1);
  assert.equal(proj.byKey.get('claude:main')!.sub.below.warn, 1, 'the root counts it below itself');
  assert.equal(proj.byKey.get('claude:main')!.sub.rank, 0);

  // The bar: one alert, in full, naming the child.
  const alerts = delegationAlerts(proj, NOW, plainSay);
  assert.deepEqual(
    alerts.nodes.map((a) => [a.cls, a.name, a.word]),
    [['warn', 'x', 'conflict']]
  );
  const forms = attentionForms(vm, NOW, false, { flag: 0, fail: 0 });
  assert.ok(forms, 'the attention module has something to say');
  assert.match(stripAnsi(forms!.full), /⚠ x conflict/);

  // The statusline: nothing else earns line two, and this does.
  const line = statuslineDelegation(vm, { width: 120, nowMs: NOW });
  assert.match(stripAnsi(line.counts), /1⚠/);
  assert.equal(line.height, 2);
  assert.ok(line.line2);
  assert.match(stripAnsi(line.line2!), /⚠ .*x conflict/);
});

test('§3.2, §3.4: a claim that fits no row still keeps its parent unfinished, troubled and on the list', () => {
  // The child `c` is claimed by the root (this claim fits the 200th row) and by the finished parent `p`
  // (this one does not). `p` and its finished child are history; without the claim they would fold into `⊕N`.
  const { vm } = buildVm([
    MAIN,
    { ...oldNative('p', 'main') },
    oldNative('q', 'p'),
    ...fillers(196),
    {
      id: 'c',
      parent: 'main',
      harness: 'codex',
      alsoClaimedBy: ['p'],
      relationOnly: true,
      conflict: { count: 2, since: ago(120) },
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.equal(proj.nodes.length, 200, 'one claim fits');
  assert.equal(proj.omittedConflictRows, 1, 'the claim under p does not');
  assert.equal(proj.omittedConflicts.length, 0, 'the child has a row, so the summary would be a second alert');
  assert.equal(proj.counts.warn, 1, 'one child, counted once');
  assert.equal(delegationAlerts(proj, NOW, plainSay).nodes.filter((a) => a.cls === 'warn').length, 1);

  const p = proj.byKey.get('codex:p')!;
  assert.equal(p.sub.allFinished, false, 'the omitted claim is not a finished thing');
  assert.equal(p.sub.youngestFinish, null);
  assert.equal(p.sub.rank, 0, 'the subtree is in the trouble bucket');
  assert.equal(p.sub.below.warn, 1);
  assert.equal(p.sub.total, 2, 'q and the claim');

  const plan = planRows(proj, { nowMs: NOW });
  // Only the finished child `q` is put away, under `p`; `p` itself (which would go with it) stays on the list.
  assert.equal(plan.putAway, 1);
  const keys = plan.rows.map((row) => row.key);
  assert.ok(keys.includes('codex:p'), 'the parent stays on the list');
  // Trouble first: both `p` (its omitted claim) and the drawn claim row sort before the working rows.
  assert.ok(keys.indexOf('codex:p') < keys.indexOf('codex:w0'));
  // A folded `p` still tells of the conflict it holds.
  const folded = planRows(proj, { nowMs: NOW, collapsed: new Set(['codex:p']) }).rows.find((r) => r.key === 'codex:p')!;
  assert.equal(folded.fold!.below.warn, 1);
  assert.equal(folded.fold!.hidden, 2);
});

test('§4.12: every claim omitted, two finished parents: one child, one alert, one item, both parents troubled', () => {
  const { vm } = buildVm([
    MAIN,
    oldNative('p1', 'main'),
    oldNative('p2', 'main'),
    ...fillers(197),
    {
      id: 'c',
      parent: 'p1',
      harness: 'pi',
      alsoClaimedBy: ['p2'],
      relationOnly: true,
      conflict: { count: 2, since: ago(90) },
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.equal(proj.nodes.length, 200);
  assert.equal(proj.omittedConflictRows, 2);
  assert.equal(proj.omittedConflicts.length, 1, 'one summary however many parents claim the child');
  assert.equal(proj.counts.warn, 1);
  assert.equal(delegationAlerts(proj, NOW, plainSay).nodes.length, 1);
  for (const id of ['codex:p1', 'codex:p2']) {
    const parent = proj.byKey.get(id)!;
    assert.equal(parent.sub.allFinished, false, `${id} holds a claim`);
    assert.equal(parent.sub.below.warn, 1, `${id} counts the conflict below it`);
  }
  const plan = planRows(proj, { nowMs: NOW });
  assert.equal(plan.putAway, 0);
  assert.ok(plan.rows.some((r) => r.key === 'codex:p1') && plan.rows.some((r) => r.key === 'codex:p2'));
  const line = statuslineDelegation(vm, { width: 160, nowMs: NOW });
  assert.equal((stripAnsi(line.line2 ?? '').match(/conflict/g) ?? []).length, 1, 'one item for the child');
  // The same tree under the budget gives the same alert, item and parent summaries (the budget changes rows only).
  const small = buildVm([
    MAIN,
    oldNative('p1', 'main'),
    oldNative('p2', 'main'),
    {
      id: 'c',
      parent: 'p1',
      harness: 'pi',
      alsoClaimedBy: ['p2'],
      relationOnly: true,
      conflict: { count: 2, since: ago(90) },
    },
  ]);
  const whole = projectDelegation(small.vm, new ProjectionCache());
  assert.equal(whole.omittedConflictRows, 0);
  for (const id of ['codex:p1', 'codex:p2'])
    assert.deepEqual(
      { ...whole.byKey.get(id)!.sub.below },
      { ...proj.byKey.get(id)!.sub.below },
      `${id}: the omitted claim marks its parent the way the drawn one does`
    );
});

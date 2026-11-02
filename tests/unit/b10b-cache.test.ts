/**
 * Design §6 #2: the node projection cache and the row cache return what a cold
 * render would. Two tables, both exhaustive by construction:
 *
 *  - one entry per fact of `nodeFacts` (the single list a projection reads, and
 *    the cache key): an immutable rebuild of the view model with that one input
 *    changed must project again, and the warm projection must equal a cold one;
 *  - one entry per input a rendered row reads besides its projection: the warm
 *    row after the change must equal a cold row, and differ from the row before
 *    it where the change is visible.
 *
 * A fact (or row input) added without an entry here fails the coverage test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setDisplayConfig, type HudDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { factsEqual, nodeFacts } from '../../src/render/delegation/facts.js';
import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import { planRows, renderRow, type RenderContext, type RowOptions } from '../../src/render/delegation/rows.js';
import { panelSay, plainSay } from '../../src/render/delegation/style.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { NOW, S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';

const ROOT: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(30)), label: null };

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Target {
  vm: DelegationViewModel;
  node: any;
  detail: any;
  status: any;
  relations: any[];
}

interface Entry {
  fact: string;
  specs: NodeSpec[];
  /** The id of the node that changes (default `a`). */
  id?: string;
  mutate: (t: Target) => void;
  /** Part of the key without being read by the projection (the design's stamps): it must still invalidate. */
  inert?: boolean;
}

const child = (spec: Partial<NodeSpec> = {}): NodeSpec[] => [ROOT, { id: 'a', parent: 'main', ...spec }];
const run = (r: NonNullable<Extract<NodeSpec['run'], object>>, spec: Partial<NodeSpec> = {}): NodeSpec[] =>
  child({ run: r, ...spec });

const TABLE: Entry[] = [
  // Identity.
  {
    fact: 'idKind',
    specs: child(),
    mutate: (t) =>
      (t.node.identity = { kind: 'job', ref: { kind: 'ask', provider: 'x', account: null, key: 'job-1' } }),
  },
  { fact: 'idHarness', specs: child(), mutate: (t) => (t.node.identity.ref.harness = 'pi') },
  {
    fact: 'shortRef',
    specs: child({ native: true }),
    mutate: (t) => (t.node.identity.ref.sessionId = 'zzzz-0002'),
  },
  { fact: 'isRoot', specs: child(), id: 'main', mutate: (t) => (t.node.depth = 1) },
  { fact: 'edge', specs: child(), mutate: (t) => (t.node.edge = 'native') },
  { fact: 'loaded', specs: child(), mutate: (t) => (t.node.loaded = false) },
  {
    fact: 'conflictCount',
    specs: child(),
    mutate: (t) => (t.node.conflict = { count: 2, recordIds: [], since: ago(100) }),
  },
  {
    fact: 'conflictSince',
    specs: child({ conflict: { count: 2, since: ago(360) } }),
    mutate: (t) => (t.node.conflict.since = ago(60)),
  },
  {
    fact: 'conflictName',
    specs: [
      ROOT,
      { id: 'b', parent: 'main', harness: 'claude' },
      { id: 'a', parent: 'main', alsoClaimedBy: ['b'], conflict: { count: 2, since: ago(360) } },
    ],
    // The second claim now names the child differently: the shared label is gone (§3.4).
    mutate: (t) => (t.relations[1].link.label = 'beta'),
  },
  { fact: 'paneLabel', specs: child({ pane: 'pane 4' }), mutate: (t) => (t.node.host.currentState = null) },

  // The observation.
  {
    fact: 'evidenceStamp',
    specs: child(),
    inert: true,
    mutate: (t) => (t.node.observation.evidenceStamp = 'ev-other'),
  },
  {
    fact: 'model',
    specs: child({ model: 'gpt-6.1-sol' }),
    mutate: (t) => (t.node.observation.model.value = 'gpt-6.1-flash'),
  },
  {
    fact: 'effort',
    specs: child({ model: 'gpt-6.1-sol', effort: 'high' }),
    mutate: (t) => (t.node.observation.effort.value = 'xhigh'),
  },
  {
    fact: 'contextPercent',
    specs: child({ contextPercent: 40 }),
    mutate: (t) => (t.node.observation.context.value.percent = 80),
  },

  // The ledger's run.
  {
    fact: 'runId',
    specs: run({ state: 'running' }),
    inert: true,
    mutate: (t) => (t.node.currentRun.runId = 'r_other'),
  },
  {
    fact: 'runState',
    specs: run({ state: 'running', mode: 'visible' }),
    mutate: (t) => (t.node.currentRun.state = 'cancelling'),
  },
  {
    fact: 'runMode',
    specs: run({ state: 'running', mode: 'visible' }),
    mutate: (t) => (t.node.currentRun.mode = 'headless'),
  },
  {
    fact: 'runCreatedAt',
    // No relation: the run's own creation time is the row's.
    specs: [{ id: 'a', run: { state: 'running', createdAt: ago(500) }, status: S.working(ago(60)) }],
    mutate: (t) => (t.node.currentRun.createdAt = ago(100)),
  },
  {
    fact: 'runEndedAt',
    specs: run(
      { state: 'ended', endedAt: ago(500) },
      { status: S.exited(ago(500)), report: { status: 'completed', summary: 'ok', at: ago(500) } }
    ),
    mutate: (t) => (t.node.currentRun.endedAt = ago(100)),
  },
  {
    fact: 'runCancelRequestedAt',
    specs: run(
      { state: 'cancelling', mode: 'visible', cancelRequestedAt: ago(30) },
      { status: { cls: 'interrupted', reason: 'cancelling', since: null, basis: 'unknown' } }
    ),
    mutate: (t) => (t.node.currentRun.cancelRequestedAt = ago(5)),
  },
  {
    // The review's case: an uncertain run whose heartbeat is the only age on the row.
    fact: 'runHeartbeatAt',
    specs: run(
      { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown', heartbeatAt: ago(90) },
      { status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(200), evidenceAt: null } }
    ),
    mutate: (t) => (t.node.currentRun.heartbeatAt = ago(5)),
  },
  {
    fact: 'runExitSource',
    specs: run(
      { state: 'running', exit: { code: 1, signal: null, source: 'wait_status' } },
      { status: S.working(ago(60)) }
    ),
    mutate: (t) => (t.node.currentRun.exitSource = null),
  },
  {
    fact: 'runExitCode',
    specs: run(
      { state: 'running', exit: { code: 0, signal: null, source: 'wait_status' } },
      { status: S.working(ago(60)) }
    ),
    mutate: (t) => (t.node.currentRun.exitCode = 1),
  },
  {
    fact: 'runExitSignal',
    specs: run(
      { state: 'running', exit: { code: 0, signal: null, source: 'wait_status' } },
      { status: S.working(ago(60)) }
    ),
    mutate: (t) => (t.node.currentRun.exitSignal = 'SIGKILL'),
  },

  // What the execution projection says of it.
  {
    fact: 'isRunTerminal',
    specs: run({ state: 'running' }, { status: S.exited(ago(500)) }),
    // Managed runs say `ended`, a plain session `exited`.
    mutate: (t) => (t.node.execution.isRunTerminal = null),
  },
  {
    fact: 'reconciliationCause',
    specs: run(
      { state: 'uncertain', reconciliation: 'scope_unknown' },
      { status: { cls: 'uncertain', since: ago(100) } }
    ),
    mutate: (t) => (t.node.execution.reconciliation.cause = 'supervisor_dead'),
  },
  {
    fact: 'requestedCause',
    specs: run({ state: 'ended', endedAt: ago(500), requestedCause: 'runtime_limit' }, { status: S.exited(ago(500)) }),
    mutate: (t) => (t.node.execution.terminal.termination.requestedCause = 'retire_idle'),
  },
  {
    fact: 'launchFailed',
    specs: run({ state: 'running' }, { status: S.working(ago(60)) }),
    mutate: (t) => (t.node.execution.launchFailure = { stateKey: 'launch_failed', reason: 'spawn_error' }),
  },

  // The current relation.
  { fact: 'linkId', specs: child(), inert: true, mutate: (t) => (t.relations[0].link.linkId = 'l_other') },
  {
    fact: 'linkState',
    // No status yet: a pending link is `starting`, a bound one is only `unknown`.
    specs: run({ state: 'running' }, { status: null, linkState: 'bound' }),
    mutate: (t) => (t.relations[0].link.state = 'pending'),
  },
  { fact: 'linkLabel', specs: child(), mutate: (t) => (t.relations[0].link.label = 'renamed') },
  {
    fact: 'linkRole',
    specs: child({ label: null, role: 'worker' }),
    mutate: (t) => (t.relations[0].link.role = 'reviewer'),
  },
  {
    fact: 'linkBackend',
    specs: [ROOT, { id: 'a', parent: 'main', kind: 'intent', run: { state: 'starting' }, status: { cls: 'starting' } }],
    id: 'a',
    mutate: (t) => (t.relations[0].link.backend = 'pi-reviewer'),
  },
  { fact: 'linkCreatedAt', specs: child(), mutate: (t) => (t.relations[0].link.createdAt = ago(10)) },
  {
    fact: 'childHarness',
    specs: [ROOT, { id: 'a', parent: 'main', kind: 'intent', run: { state: 'starting' }, status: { cls: 'starting' } }],
    mutate: (t) =>
      (t.relations[0].link.childRef = { harness: 'claude', sourceId: 'ab'.repeat(32), sessionId: 'x', threadId: null }),
  },

  // The published status.
  {
    fact: 'observationUnavailableReason',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => (t.detail.observationUnavailableReason = 'reader_busy'),
  },
  { fact: 'hasStatus', specs: child({ status: S.working(ago(100)) }), mutate: (t) => (t.detail.status = null) },
  { fact: 'statusAsOfSeq', specs: child(), inert: true, mutate: (t) => (t.status.asOfSeq = 2) },
  { fact: 'commitSeq', specs: child(), inert: true, mutate: (t) => (t.status.observationStamp.commitSeq = 2) },
  {
    fact: 'stateKey',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => {
      t.status.stateKey = 'pending:approval';
      t.status.activity = 'unknown';
    },
  },
  { fact: 'stateSince', specs: child({ status: S.working(ago(100)) }), mutate: (t) => (t.status.stateSince = ago(7)) },
  {
    fact: 'stateSinceBasis',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => (t.status.stateSinceBasis = 'observed'),
  },
  {
    fact: 'freshnessState',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => (t.status.freshness.state = 'stale'),
  },
  {
    fact: 'freshnessReason',
    specs: child({ status: { cls: 'working', since: ago(100), freshness: 'stale' } }),
    inert: true,
    mutate: (t) => (t.status.freshness.reason = 'registry_unreachable'),
  },
  {
    fact: 'clockAnomaly',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => (t.status.freshness.clockAnomaly = true),
  },
  {
    fact: 'liveness',
    specs: child({ native: true, status: S.idle(ago(300)) }),
    // An idle native whose process is gone has exited.
    mutate: (t) => (t.status.liveness = 'gone'),
  },
  {
    fact: 'activity',
    specs: child({ native: true, status: S.idle(ago(300)) }),
    mutate: (t) => (t.status.activity = 'working'),
  },
  {
    fact: 'pendingReason',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => (t.status.pendingReason = 'approval'),
  },
  {
    fact: 'lastTurnOutcome',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => (t.status.lastTurnOutcome = 'failed'),
  },
  {
    fact: 'lastEvidenceAt',
    specs: run(
      { state: 'uncertain', reconciliation: 'scope_unknown' },
      { status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(200), evidenceAt: ago(80) } }
    ),
    mutate: (t) => (t.status.lastEvidenceAt = ago(8)),
  },

  // The report of the run.
  {
    fact: 'reportId',
    specs: child({ report: { status: 'completed', summary: 'ok', at: ago(100) } }),
    inert: true,
    mutate: (t) => (t.detail.latestReportForRun.reportId = 'rep_other'),
  },
  {
    fact: 'reportStatus',
    specs: run(
      { state: 'ended', endedAt: ago(500) },
      { status: S.exited(ago(500)), report: { status: 'completed', summary: 'ok', at: ago(500) } }
    ),
    mutate: (t) => (t.detail.latestReportForRun.status = 'failed'),
  },
  {
    fact: 'reportCreatedAt',
    specs: child({ report: { status: 'completed', summary: 'ok', at: ago(100) } }),
    mutate: (t) => (t.detail.latestReportForRun.createdAt = ago(20)),
  },
  {
    fact: 'reportSummary',
    specs: child({ report: { status: 'completed', summary: 'ok', at: ago(100) } }),
    mutate: (t) => (t.detail.latestReportForRun.summary = 'a different summary'),
  },
];

/** The key of the fact that cannot change inside one cache entry: the cache is indexed by it. */
const INDEX_KEY = 'key';

function targetOf(vm: DelegationViewModel, key: string): Target {
  const node = vm.tree.nodes.find((n) => n.key === key) as any;
  const detail = vm.details[key] as any;
  const relations = vm.tree.relations.filter((r) => r.childKey === key) as any[];
  return { vm, node, detail, status: detail?.status, relations };
}

test('the facts are the cache key: a table entry for every fact, none for a field that is not one', () => {
  const { vm } = buildVm(child({ model: 'm' }));
  const facts = nodeFacts(vm.tree.nodes[1], vm.details[vm.tree.nodes[1].key], vm.tree.relations[0], false, null);
  const names = Object.keys(facts).filter((name) => name !== INDEX_KEY);
  assert.deepEqual(
    [...new Set(TABLE.map((e) => e.fact))].sort(),
    names.sort(),
    'add an entry to the table for each fact the projection reads'
  );
});

test('factsEqual compares every fact: two facts that differ in any one field are not equal', () => {
  // The table below changes the view model, where a change can move several facts at once (a session's harness
  // moves its short form too); this test changes one fact of the facts object at a time, so no field can hide
  // behind another in the comparison.
  const { vm } = buildVm(child({ model: 'm', status: S.working(ago(60)) }));
  const node = vm.tree.nodes[1];
  const base = nodeFacts(node, vm.details[node.key], vm.tree.relations[0], false, null);
  assert.ok(factsEqual(base, { ...base }));
  for (const name of Object.keys(base) as Array<keyof typeof base>) {
    const value = base[name];
    const changed = {
      ...base,
      [name]: typeof value === 'boolean' ? !value : typeof value === 'number' ? value + 1 : 'x' + value,
    };
    assert.equal(factsEqual(base, changed as typeof base), false, `${name} takes part in the comparison`);
  }
});

for (const entry of TABLE) {
  test(`projection cache: changing ${entry.fact} alone projects again, and warm equals cold`, () => {
    const built = buildVm(entry.specs);
    const key = built.keys[entry.id ?? 'a'];
    const cache = new ProjectionCache();
    projectDelegation(built.vm, cache);

    // An immutable rebuild, as every tick does, with one input changed.
    const after = structuredClone(built.vm);
    entry.mutate(targetOf(after, key));

    const misses = cache.misses;
    const warm = projectDelegation(after, cache);
    assert.equal(cache.misses, misses + 1, `${entry.fact}: exactly the changed node is projected again`);
    const cold = projectDelegation(after, new ProjectionCache());
    assert.deepEqual(warm.byKey.get(key)!.proj, cold.byKey.get(key)!.proj, `${entry.fact}: warm equals cold`);
    assert.equal(warm.nodes.length, cold.nodes.length);
    warm.nodes.forEach((pn, i) =>
      assert.deepEqual(pn.proj, cold.nodes[i].proj, `${entry.fact}: ${pn.key} warm equals cold`)
    );

    if (!entry.inert) {
      const before = projectDelegation(built.vm, new ProjectionCache());
      assert.notDeepEqual(
        before.byKey.get(key)!.proj,
        cold.byKey.get(key)!.proj,
        `${entry.fact}: the change shows in the projection (else the entry tests nothing)`
      );
    }
  });
}

test('projection cache: an equal rebuild is all hits', () => {
  const built = buildVm([
    ROOT,
    {
      id: 'a',
      parent: 'main',
      model: 'gpt-6.1-sol',
      pane: 'pane 4',
      report: { status: 'completed', summary: 'x', at: ago(9) },
    },
  ]);
  const cache = new ProjectionCache();
  projectDelegation(built.vm, cache);
  const misses = cache.misses;
  projectDelegation(structuredClone(built.vm), cache);
  assert.equal(cache.misses, misses);
});

// ---------------------------------------------------------------------------
// The row cache.

interface RowCase {
  input: string;
  specs: NodeSpec[];
  /** The row to draw (default: the second). */
  at?: number;
  options?: Partial<RowOptions>;
  /** What the first render uses, and what the second uses (a context patch). */
  before?: Partial<RenderContext>;
  after?: Partial<RenderContext>;
  /** A switch of the display configuration between the two renders. */
  config?: { before?: Partial<HudDisplayConfig>; after: Partial<HudDisplayConfig> };
  language?: { before: 'en' | 'zh'; after: 'en' | 'zh' };
  /** The second render is of this tree, projected through the same cache: the row's node projection is reused. */
  secondSpecs?: NodeSpec[];
}

const withModel = (specs: NodeSpec[], id: string, model: string): NodeSpec[] =>
  specs.map((spec) => (spec.id === id ? { ...spec, model } : spec));

function foldTree(flags: number, fails: number): NodeSpec[] {
  return [
    ROOT,
    { id: 'p', parent: 'main', status: S.working(ago(60)), createdAt: ago(900) },
    ...Array.from({ length: 12 }, (_, i): NodeSpec => {
      const spec: NodeSpec = { id: `k${i}`, parent: 'p', createdAt: ago(800 - i) };
      return i < flags
        ? { ...spec, status: S.pending('approval', ago(30)) }
        : i < flags + fails
          ? { ...spec, status: S.failed(ago(40)) }
          : { ...spec, status: S.working(ago(60)) };
    }),
  ];
}

const ONE_HARNESS: NodeSpec[] = [
  { ...ROOT, harness: 'codex' },
  { id: 'a', parent: 'main', harness: 'codex', status: S.working(ago(60)) },
];
const NATIVE_TREE: NodeSpec[] = [
  ROOT,
  { id: 'p', parent: 'main', status: S.working(ago(60)), model: 'gpt-6.1-sol', createdAt: ago(300) },
  {
    id: 'n',
    parent: 'p',
    native: true,
    label: 'probe',
    status: S.working(ago(30)),
    model: 'gpt-6.1-sol',
    createdAt: ago(100),
  },
];

const ROW_CASES: RowCase[] = [
  {
    input: 'width',
    specs: child({ model: 'gpt-6.1-sol', status: S.working(ago(60)) }),
    before: { width: 60 },
    after: { width: 48 },
  },
  {
    input: 'selection',
    specs: child({ status: S.working(ago(60)) }),
    before: { selectedKey: null },
    after: { selectedKey: 'codex:a' },
  },
  {
    // The viewpoint root: its prefix and its clock do not change with the glyph set, so only the key can tell.
    input: 'glyph set (ascii option)',
    specs: [{ ...ROOT, status: S.pending('approval', ago(60)) }],
    at: 0,
    before: { ascii: false },
    after: { ascii: true },
  },
  {
    // The review's case: an omitted `ascii` follows the display's icon set.
    input: 'glyph set (icon set, ascii omitted)',
    specs: [{ ...ROOT, status: S.pending('approval', ago(60)) }],
    at: 0,
    config: { before: { icons: 'unicode' }, after: { icons: 'text' } },
  },
  {
    input: 'clock text',
    specs: child({ status: S.working(ago(60)) }),
    before: { nowMs: NOW },
    after: { nowMs: NOW + 5000 },
  },
  {
    input: 'coarse clocks',
    specs: child({ status: S.working(ago(400)) }),
    before: { coarse: false },
    after: { coarse: true },
  },
  {
    // The review's case: 1 flag + 11 failures becomes 11 flags + 1 failure under the same cached parent.
    input: 'fold counts',
    specs: foldTree(1, 11),
    secondSpecs: foldTree(11, 1),
    options: { collapsed: new Set(['codex:p']) },
  },
  {
    input: 'cross-harness slot',
    specs: ONE_HARNESS,
    // A second harness appears below the row (so its own tee does not change): the icon slot opens on every row.
    secondSpecs: [...ONE_HARNESS, { id: 'z', parent: 'a', harness: 'pi', status: S.working(ago(30)) }],
  },
  {
    // A later sibling arrives: the row's own tee turns from the last child's into a middle child's.
    input: 'tree prefix',
    specs: ONE_HARNESS,
    secondSpecs: [...ONE_HARNESS, { id: 'z', parent: 'main', harness: 'codex', status: S.working(ago(30)) }],
  },
  {
    // The minute of settling after a finish: the marker and the name go quiet (the clock text turns `59s` to `1m`
    // at the same instant, so this case tests the behaviour end to end rather than one component of the key).
    input: 'fade',
    specs: child({ status: S.exited(ago(59)) }),
    before: { nowMs: NOW },
    after: { nowMs: NOW + 2000 },
  },
  {
    input: 'parent model',
    specs: NATIVE_TREE,
    at: 2,
    secondSpecs: withModel(NATIVE_TREE, 'p', 'gpt-6.1-flash'),
  },
  {
    input: 'language',
    specs: child({ status: S.pending('approval', ago(60)) }),
    before: { say: panelSay },
    after: { say: panelSay },
    language: { before: 'en', after: 'zh' },
  },
  {
    // The review's case: the bar's translator first, the panel's second, in Chinese.
    input: 'translator',
    specs: child({ status: S.pending('approval', ago(60)) }),
    before: { say: plainSay },
    after: { say: panelSay },
    language: { before: 'zh', after: 'zh' },
  },
  {
    input: 'palette',
    specs: child({ status: S.working(ago(60)) }),
    config: { before: { theme: 'mocha' }, after: { theme: 'latte' } },
  },
  {
    input: 'model glyph mode',
    specs: child({ model: 'gpt-6.1-sol', effort: 'xhigh', status: S.working(ago(60)) }),
    config: { before: { glyphs: 'glyph' }, after: { glyphs: 'text' } },
  },
  {
    // The three seconds of emphasis end between two renders that print the same clock text.
    input: 'emphasis',
    specs: child({ status: S.working(NOW - 2950) }),
    before: { nowMs: NOW, coarse: true },
    after: { nowMs: NOW + 150, coarse: true },
  },
];

for (const c of ROW_CASES) {
  test(`row cache: changing ${c.input} alone, the warm row equals the cold row`, () => {
    const previousConfig = setDisplayConfig({ theme: 'mocha', ...(c.config?.before ?? {}) });
    const previousLanguage = setLanguage(c.language?.before ?? 'en');
    try {
      const at = c.at ?? 1;
      const options: RowOptions = { nowMs: NOW, ...c.options };
      const ctx = (proj: RenderContext['proj'], coarse: boolean, patch: Partial<RenderContext>): RenderContext => ({
        proj,
        width: 60,
        nowMs: NOW,
        say: plainSay,
        coarse,
        ...patch,
      });

      const cache = new ProjectionCache();
      const proj1 = projectDelegation(buildVm(c.specs).vm, cache);
      const plan1 = planRows(proj1, options);
      const first = renderRow(plan1.rows[at], ctx(proj1, plan1.coarse, c.before ?? {}));

      // The second render: the same cache, so a row whose facts did not change keeps its projection (and its rows).
      const proj2 = c.secondSpecs ? projectDelegation(buildVm(c.secondSpecs).vm, cache) : proj1;
      const plan2 = planRows(proj2, options);
      assert.equal(proj2.nodes[at].proj, proj1.nodes[at].proj, 'the row keeps its node projection');
      if (c.config) setDisplayConfig(c.config.after);
      if (c.language) setLanguage(c.language.after);
      const warm = renderRow(plan2.rows[at], ctx(proj2, c.after?.coarse ?? plan2.coarse, c.after ?? {}));

      const coldProj = projectDelegation(buildVm(c.secondSpecs ?? c.specs).vm, new ProjectionCache());
      const coldPlan = planRows(coldProj, options);
      const cold = renderRow(coldPlan.rows[at], ctx(coldProj, c.after?.coarse ?? coldPlan.coarse, c.after ?? {}));
      assert.equal(warm, cold, `${c.input}: the cached row is what a cold render gives`);
      assert.notEqual(first, warm, `${c.input}: the change shows in the row (else the case tests nothing)`);
    } finally {
      setLanguage(previousLanguage);
      setDisplayConfig(previousConfig);
    }
  });
}

test('row cache: every input of the row key has a case', () => {
  assert.deepEqual(
    ROW_CASES.map((c) => c.input).sort(),
    [
      'width',
      'selection',
      'glyph set (ascii option)',
      'glyph set (icon set, ascii omitted)',
      'clock text',
      'coarse clocks',
      'fold counts',
      'cross-harness slot',
      'tree prefix',
      'fade',
      'parent model',
      'language',
      'translator',
      'palette',
      'model glyph mode',
      'emphasis',
    ].sort(),
    'rowKey in rows.ts lists exactly these (the prefix is the tree shape, the fade and the muted name follow the clock); add a case with each new input'
  );
});

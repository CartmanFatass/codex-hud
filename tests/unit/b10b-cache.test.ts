/** Cached display updates must match a cold render, without pinning the private facts schema. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setDisplayConfig, type HudDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
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
  mutate: (t: Target) => void;
}

const child = (spec: Partial<NodeSpec> = {}): NodeSpec[] => [ROOT, { id: 'a', parent: 'main', ...spec }];

const TABLE: Entry[] = [
  { fact: 'linkLabel', specs: child(), mutate: (t) => (t.relations[0].link.label = 'renamed') },
  {
    fact: 'model',
    specs: child({ model: 'gpt-6.1-sol' }),
    mutate: (t) => (t.node.observation.model.value = 'gpt-6.1-flash'),
  },
  {
    fact: 'stateKey',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => {
      t.status.stateKey = 'pending:approval';
      t.status.activity = 'unknown';
    },
  },
  {
    fact: 'freshnessState',
    specs: child({ status: S.working(ago(100)) }),
    mutate: (t) => (t.status.freshness.state = 'stale'),
  },
  {
    fact: 'reportSummary',
    specs: child({
      run: { state: 'ended', endedAt: ago(100) },
      status: S.exited(ago(100)),
      report: { status: 'completed', summary: 'ok', at: ago(100) },
    }),
    mutate: (t) => (t.detail.latestReportForRun.summary = 'a different summary'),
  },
];

function targetOf(vm: DelegationViewModel, key: string): Target {
  const node = vm.tree.nodes.find((n) => n.key === key) as any;
  const detail = vm.details[key] as any;
  const relations = vm.tree.relations.filter((r) => r.childKey === key) as any[];
  return { vm, node, detail, status: detail?.status, relations };
}

test('cached projection updates match cold rendered rows for names, models, status, freshness and reports', () => {
  for (const entry of TABLE) {
    const built = buildVm(entry.specs);
    const key = built.keys.a;
    const cache = new ProjectionCache();
    projectDelegation(built.vm, cache);

    // An immutable rebuild, as every tick does, with one input changed.
    const after = structuredClone(built.vm);
    entry.mutate(targetOf(after, key));

    const rows = (vm: DelegationViewModel, cache: ProjectionCache) => {
      const proj = projectDelegation(vm, cache);
      return planRows(proj, { nowMs: NOW }).rows.map((row) =>
        renderRow(row, { proj, width: 80, nowMs: NOW, say: plainSay })
      );
    };
    assert.deepEqual(rows(after, cache), rows(after, new ProjectionCache()));
    assert.notDeepEqual(rows(built.vm, new ProjectionCache()), rows(after, cache), entry.fact);
  }
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

test('cached rows follow changed layout, selection, clocks, tree, language and display settings', () => {
  for (const c of ROW_CASES) {
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
  }
});

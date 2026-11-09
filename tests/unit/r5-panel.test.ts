import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PanelJobPipeline, panelActionAllowed, dispatchPanelAction, panelJobRenderState } from '../../src/tree-page.js';
import { r5Fixture, refR5, ROOT_R5, idR5 } from '../fixtures/r5-jobs.js';
import { registerExternal, externalRootHash } from '../../src/roles/external-association.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../src/render/monitor.js';
import { buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';
const vm = (specs: NodeSpec[]) => buildVm(specs).vm;
const key = (id: string) => `${id === 'legacy' ? 'claude' : 'codex'}:${id}`;
import { panelRoot } from '../../src/cli/panel.js';
import { main } from '../../src/cli/hud-main.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const listing = JSON.stringify({
  result: { agents: [{ name: 'synthetic-agent', tab_id: 'tab-1', pane_id: 'pane-1', agent_status: 'working' }] },
});
function nodes(tree: SubagentTree): SubagentTreeNode[] {
  const all: SubagentTreeNode[] = [];
  const walk = (items: SubagentTreeNode[]) => {
    for (const item of items) {
      all.push(item);
      walk(item.children);
    }
  };
  walk(tree.nodes);
  return all;
}
const native = (id: string, ref = refR5()): SubagentTreeNode => ({
  id,
  ref,
  name: 'Native original',
  status: 'running',
  depth: 1,
  children: [],
});
function frame(tree: SubagentTree, legacy: ReturnType<typeof vm> | null, selected?: string) {
  const state = initialMonitorState();
  state.style = 'compact';
  state.tree.showAll = true;
  if (selected) state.tree.selectedId = selected;
  return renderMonitor({
    tree,
    state,
    hud: { delegation: legacy } as any,
    nowMs: Date.parse('2026-11-09T12:00:00Z'),
    width: 80,
    height: 120,
  });
}

test('R5 panel refresh/compose/apply/render shows one mixed tree with helpers, external and native enrichment', async (t) => {
  const f = r5Fixture(t);
  const pipeline = new PanelJobPipeline(f.home, ROOT_R5, { now: f.now, herdr: async () => listing });
  t.after(() => pipeline.dispose());
  f.receipt(f.association(1, { native: refR5() }));
  const pi = f.association(2);
  f.dispatch(pi);
  f.status(pi, 'working', {}, 'sonic-1');
  f.jev(
    f.association(3, {
      role: 'oracle',
      phase: 'propose',
      backend: {
        id: 'web',
        executor: 'jev',
        harness: null,
        model: 'web-model',
        effort: null,
        env_profile: null,
        recipe: null,
      },
    }),
    'completed',
    { status: 'answered' }
  );
  registerExternal(
    f.home,
    {
      root: ROOT_R5,
      id: 'external',
      agent: 'synthetic-agent',
      pane: 'pane-1',
      tab: 'tab-1',
      workspace: null,
      label: 'External',
    },
    f.now()
  );
  f.receipt(f.association(4, { root: 'other/main' }));
  const tree = { ...f.emptyTree(), nodes: [native('native')] };
  for (let i = 0; i < 35; i++) await pipeline.refresh();
  const result = pipeline.compose(tree, null, f.now());
  const all = nodes(result.tree);
  assert.equal(all.length, 5);
  assert.equal(new Set(all.map((node) => node.id)).size, 5);
  assert.equal(all.find((node) => node.id === 'native')!.job!.jobId, idR5(1));
  assert.ok(all.some((node) => node.id.endsWith(':dispatch:sonic-1')));
  assert.ok(all.some((node) => node.id.startsWith('external-herdr:')));
  assert.ok(all.every((node) => node.job?.root === ROOT_R5));
  const rendered = frame(result.tree, result.legacy);
  assert.equal(rendered.panes.filter((pane) => pane.id === 'agents').length, 1);
  const rows = rendered.panes.find((pane) => pane.id === 'agents')!.rows;
  assert.equal(rows.filter((row) => row.counts).length, 1);
  assert.deepEqual(new Set(rows.flatMap((row) => (row.item ? [row.item] : []))), new Set(all.map((node) => node.id)));
});

test('R5 mixed legacy mode retains job rows and shared selection after afterPaint re-merge without duplicates', async (t) => {
  const f = r5Fixture(t);
  const legacy = vm([
    { id: 'main', root: true },
    { id: 'legacy', parent: 'main', harness: 'claude', status: { cls: 'working' } },
  ]);
  const identity = legacy.tree.nodes[0]!.identity;
  assert.equal(identity.kind, 'session');
  const root = identity.kind === 'session' ? `${identity.ref.sourceId}/${identity.ref.sessionId}` : '';
  f.receipt(f.association(1, { root }));
  const p = new PanelJobPipeline(f.home, root, { now: f.now, herdr: async () => listing });
  t.after(() => p.dispose());
  for (let i = 0; i < 8; i++) await p.refresh();
  for (const result of [p.compose(f.emptyTree(), legacy, f.now()), p.afterPaint(f.emptyTree(), legacy, f.now())]) {
    const id = `role-job:${idR5(1)}`;
    assert.equal(nodes(result.tree).filter((node) => node.id === id).length, 1);
    const rendered = frame(result.tree, result.legacy, id);
    assert.equal(rendered.state.tree.selectedId, id);
    const rows = rendered.panes.find((pane) => pane.id === 'agents')!.rows;
    assert.equal(rows.filter((row) => row.item === id).length, 1);
    assert.ok(rows.some((row) => row.item === key('legacy')));
    assert.equal(rows.filter((row) => row.counts).length, 1);
    assert.ok(rendered.delegation!.dest.index.has(id));
    const moved = handleMonitorInput(
      rendered.state,
      { type: 'key', key: 'up' },
      { tree: result.tree, frame: rendered, nowMs: f.now() }
    );
    assert.notEqual(moved.state.tree.selectedId, id);
  }
});

test('R5 generation fence drops collector reads and herdr results after root change and dispose', async (t) => {
  const f = r5Fixture(t);
  f.receipt(f.association(1));
  f.receipt(f.association(2, { root: 'other/main' }));
  let release!: (value: string) => void;
  const p = new PanelJobPipeline(f.home, ROOT_R5, {
    now: f.now,
    herdr: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  t.after(() => p.dispose());
  const original = fsp.open;
  let unblock!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let first = true;
  t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
    if (first && String(args[0]).includes('/assoc/')) {
      first = false;
      entered();
      await gate;
    }
    return original(...args);
  });
  const read = p.refresh();
  await held;
  p.setRoot('other/main');
  release(listing);
  unblock();
  assert.equal(await read, false);
  for (let i = 0; i < 10; i++) await p.refresh();
  assert.deepEqual(
    nodes(p.compose(f.emptyTree(), null, f.now()).tree).map((node) => node.job?.jobId),
    [idR5(2)]
  );
  const last = p.refresh();
  p.dispose();
  release(listing);
  assert.equal(await last, false);
  assert.equal(p.compose(f.emptyTree(), null, f.now()).tree.totalCount, 0);
});

test('R5 final panel action fence rejects every observation identity while legacy/native actions remain dispatchable', async (t) => {
  const f = r5Fixture(t);
  const a = f.association(1);
  f.dispatch(a);
  f.status(a, 'working', {}, 'sonic-1');
  registerExternal(
    f.home,
    {
      root: ROOT_R5,
      id: 'outside',
      agent: 'synthetic-agent',
      pane: 'pane-1',
      tab: 'tab-1',
      workspace: null,
      label: 'External',
    },
    f.now()
  );
  const p = new PanelJobPipeline(f.home, ROOT_R5, { now: f.now, herdr: async () => listing });
  t.after(() => p.dispose());
  for (let i = 0; i < 20; i++) await p.refresh();
  const tree = p.compose(f.emptyTree(), null, f.now()).tree;
  const dispatches: string[] = [];
  const dispatch = t.mock.fn((id: string) => dispatches.push(id));
  for (const node of nodes(tree)) {
    const rendered = frame(tree, null, node.id);
    for (const action of ['open-session', 'resume-reconcile', 'log', 'main', 'enter']) {
      const outcome = handleMonitorInput(
        rendered.state,
        { type: 'key', key: action },
        { tree, frame: rendered, nowMs: f.now() }
      );
      const id =
        outcome.action &&
        ('id' in outcome.action ? outcome.action.id : 'key' in outcome.action ? outcome.action.key : undefined);
      // Same final dispatcher seam as tree-page, even if an old frame offers an unsafe action.
      if (id) dispatchPanelAction(tree, id, () => dispatch(id));
      dispatchPanelAction(tree, node.id, () => dispatch(node.id));
      assert.equal(panelActionAllowed(tree, node.id), false, action);
    }
    for (const control of rendered.controls.filter((control) =>
      ['main', 'open-session', 'delegation-open', 'delegation-recover'].includes(control.kind)
    )) {
      const outcome = handleMonitorInput(
        rendered.state,
        { type: 'mouse', x: control.x, y: control.y, button: 'left' },
        { tree, frame: rendered, nowMs: f.now() }
      );
      const action = outcome.action;
      const id = action && ('id' in action ? action.id : 'key' in action ? action.key : undefined);
      if (id) dispatchPanelAction(tree, id, () => dispatch(id));
    }
  }
  assert.ok(!dispatches.some((id) => /^(role-job:|external-herdr:)/.test(id)));
  assert.equal(panelActionAllowed(tree, `job-root:${externalRootHash(ROOT_R5)}`), false);
  dispatchPanelAction(tree, key('legacy'), () => dispatch(key('legacy')));
  dispatchPanelAction(tree, 'original-codex-id', () => dispatch('original-codex-id'));
  assert.ok(dispatch.mock.calls.some((call) => call.arguments[0] === key('legacy')));
  assert.ok(dispatch.mock.calls.some((call) => call.arguments[0] === 'original-codex-id'));
});

test('R5 all-roots exact attachment uses native roots and metadata-only containers only for absent roots', async (t) => {
  const f = r5Fixture(t);
  const ref = refR5('a', 'first');
  const first = `${ref.sourceId}/${ref.sessionId}`;
  f.receipt(f.association(1, { root: first }));
  f.receipt(f.association(2, { root: 'other/second' }));
  const p = new PanelJobPipeline(f.home, null, { now: f.now, herdr: async () => listing });
  t.after(() => p.dispose());
  for (let i = 0; i < 15; i++) await p.refresh();
  const original = { ...f.emptyTree(), nodes: [native('root-native', ref)] };
  const result = p.compose(original, null, f.now());
  assert.equal(result.tree.nodes.filter((node) => node.id.startsWith('job-root:')).length, 1);
  assert.equal(result.tree.nodes[0]!.children[0]!.job!.root, first);
  const container = result.tree.nodes.find((node) => node.id.startsWith('job-root:'))!;
  assert.equal(container.id, `job-root:${externalRootHash('other/second')}`);
  assert.equal(container.children[0]!.job!.root, 'other/second');
  assert.equal(container.rolloutPath, undefined);
  assert.equal(container.stages, undefined);
  assert.equal(container.ref, undefined);
  assert.equal(container.job, undefined);
  assert.equal(original.nodes[0]!.children.length, 0);
});

test('R5 global deadline uncertainty and projection omissions reach live render inputs without claiming an empty tree', async (t) => {
  const f = r5Fixture(t);
  f.receipt(f.association(1));
  f.receipt(f.association(2));
  const p = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now });
  t.after(() => p.dispose());
  await p.refresh(undefined, { deadline: 0 });
  const early = p.compose(f.emptyTree(), null, f.now());
  assert.equal(early.tree.totalCount, 0);
  assert.equal(early.coverage.incomplete, true);
  const render = (result: typeof early) =>
    renderMonitor({
      tree: result.tree,
      state: { ...initialMonitorState(), style: 'compact' },
      ...panelJobRenderState(result, false),
      width: 80,
      height: 60,
      nowMs: f.now(),
    }).lines.join('\n');
  const pending = render(early);
  assert.ok(pending.includes('tree partial'));
  assert.ok(!pending.includes('No agents started in this session yet'));
  for (let n = 0; n < 10; n++) await p.refresh();
  const base = {
    ...f.emptyTree(),
    nodes: Array.from({ length: 199 }, (_, n) => ({
      id: `original-native-${n}`,
      name: `Native ${n}`,
      status: 'running' as const,
      depth: 1,
      children: [],
    })),
    totalCount: 199,
  };
  const truncated = p.afterPaint(base, null, f.now());
  assert.equal(truncated.tree.totalCount, 200);
  assert.equal(truncated.coverage.incomplete, true);
  assert.ok(truncated.coverage.omitted === null || truncated.coverage.omitted > 0);
  assert.match(render(truncated), /tree partial|not loaded/);
  assert.equal(
    panelJobRenderState({ coverage: { ...early.coverage, incomplete: false, omitted: 3 }, diagnostics: [] }, false)
      .notice,
    '3 not loaded'
  );
});

test('R5 actual hud panel --root CLI renders only the selected observation root without a native session', async (t) => {
  const f = r5Fixture(t);
  f.receipt(f.association(1, { task_label: 'SCOPED_OK' }));
  f.receipt(f.association(2, { root: 'other/main', task_label: 'WRONG_ROOT' }));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../../bin/hud', import.meta.url)), 'panel', '--root', ROOT_R5],
    {
      cwd: f.home,
      env: { HOME: f.home, HUD_HOME: f.home, CODEX_HOME: `${f.home}/no-codex`, PATH: '/nonexistent', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  let output = '',
    error = '';
  child.stdout.on('data', (part) => {
    output += part;
  });
  child.stderr.on('data', (part) => {
    error += part;
  });
  const exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
  t.after(async () => {
    child.kill('SIGTERM');
    await exit;
  });
  // Unknown/old work is initially folded by the ordinary panel's existing linger policy.
  for (let i = 0; i < 100 && !output.includes('unknown'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  child.stdin.write('a');
  for (let i = 0; i < 100 && !output.includes('SCOPED_OK'); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(output.includes('SCOPED_OK'), `${error}\n${output}`);
  assert.ok(!output.includes('WRONG_ROOT'));
});

test('R5 hud panel root parsing refuses invalid input and no-argument behaviour remains all-delegations', async () => {
  assert.equal(panelRoot([]), null);
  assert.equal(panelRoot(['--root', 'synthetic/main']), ROOT_R5);
  for (const args of [['--root'], ['--root', '../bad'], ['--root', 'one/two/three'], ['--other', ROOT_R5]])
    assert.throws(() => panelRoot(args));
  const errors: string[] = [];
  assert.equal(
    await main(['panel', '--root', '../bad'], {
      env: {},
      stdout: async () => {},
      stderr: (text) => {
        errors.push(text);
      },
    }),
    2
  );
  assert.deepEqual(errors, ['invalid_arguments\n']);
});

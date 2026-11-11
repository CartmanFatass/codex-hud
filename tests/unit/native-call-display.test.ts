import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCallCollector } from '../../src/collectors/native-calls.js';
import { RelationStore, type NativeOwner, type DirectRelation } from '../../src/managed/relations.js';
import type { NativeHostPort } from '../../src/managed/host-ipc.js';
import { projectDelegation, ProjectionCache } from '../../src/render/delegation/projection.js';
import { nativeCallLabel } from '../../src/core/link/view-model.js';

const owner: NativeOwner = { harness: 'claude', sourceId: 'a'.repeat(64), sessionId: 'parent', threadId: null };
const relation: DirectRelation = {
  owner,
  callId: 'call-1',
  child: { harness: 'pi', sessionId: 'child', sessionFile: '/synthetic/pi.jsonl' },
  workspace: '/synthetic/work',
  profileId: 'pi-local',
  createdAt: 1,
};
const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'native-display-'));
  new RelationStore(home).record(relation);
  return home;
};

test('direct calls are discovered without ledger and render raw state without task/report gates', async () => {
  const home = setup();
  try {
    assert.equal(existsSync(join(home, 'ledger.sqlite')), false);
    const methods: string[] = [];
    const raw = { isStreaming: false, isCompacting: true, pendingMessageCount: 2 };
    const port: NativeHostPort = {
      async invoke(parent, method, args) {
        assert.deepEqual(parent, owner);
        methods.push(method);
        if (method === 'list')
          return { connections: [{ connectionId: 'live', nativeRef: relation.child, state: raw }] };
        assert.deepEqual(args, { waitMs: 0, afterSeq: 0 });
        return {
          events: [
            {
              seq: 1,
              connectionId: 'live',
              nativeRef: relation.child,
              event: { type: 'native_event', kind: 'agent_end', payload: { native: 'unmodified' } },
            },
          ],
        };
      },
    };
    const collector = new NativeCallCollector(home, port);
    await collector.collect(owner);
    const view = collector.merge(null)!;
    assert.deepEqual(methods.sort(), ['list', 'wait']);
    const child = view.tree.nodes.find((n) => n.edge === 'direct-call')!;
    assert.ok(child.parentKey);
    assert.equal(child.currentRun, null);
    assert.equal(view.capacity, null);
    assert.equal(view.details[child.key].resumable, null);
    assert.equal(view.details[child.key].reconcile, null);
    assert.deepEqual((view.details[child.key].nativeCall!.snapshot as { state: unknown }).state, raw);
    const projection = projectDelegation(view, new ProjectionCache()).byKey.get(child.key)!;
    assert.match(
      projection.proj.marker.words.join(' '),
      /isStreaming=false.*isCompacting=true.*pendingMessageCount=2.*agent_end/
    );
    assert.equal(projection.proj.marker.historyEligible, false);
    assert.equal(projection.proj.marker.finishedAt, null);
    assert.equal(projection.proj.detail.managed, false);
    // Legacy publication may replace its view: direct nodes are restored, never lost afterPaint.
    assert.equal(collector.merge(null)!.tree.nodes.filter((n) => n.edge === 'direct-call').length, 1);
    chmodSync(join(home, 'native-relations'), 0o777);
    await collector.collect(owner);
    const stale = collector.merge(null)!;
    assert.deepEqual(stale.details[child.key].nativeCall!.snapshot, view.details[child.key].nativeCall!.snapshot);
    assert.match(nativeCallLabel(stale.details[child.key].nativeCall!), /unavailable/);
    assert.equal(stale.tree.nodes.find((n) => n.key === child.key)!.loaded, false);
    await collector.collect({ ...owner, sourceId: 'b'.repeat(64) });
    assert.equal(collector.merge(null), null, 'last-known data never crosses an explicit root change');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('source identity is scoped, and missing host leaves relation visible without launching/writing', async () => {
  const home = setup();
  try {
    const collector = new NativeCallCollector(home);
    await collector.collect({ ...owner, sourceId: 'b'.repeat(64) });
    assert.equal(collector.merge(null), null);
    const before = readdirSync(home);
    await collector.collect(owner);
    const view = collector.merge(null)!;
    const direct = Object.values(view.details).find((d) => d.nativeCall)!.nativeCall!;
    assert.equal(direct.snapshot, null);
    assert.match(nativeCallLabel(direct), /native source unavailable/);
    assert.deepEqual(readdirSync(home), before);
    assert.equal(existsSync(join(home, 'native-hosts')), false);
    assert.equal(existsSync(join(home, 'ledger.sqlite')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('native payload with terminal escapes is sanitized in existing render projection', async () => {
  const home = setup();
  try {
    const port: NativeHostPort = {
      async invoke(_parent, method) {
        return method === 'list'
          ? { connections: [{ nativeRef: relation.child, connected: '\x1b[31munsafe' }] }
          : { events: [] };
      },
    };
    const collector = new NativeCallCollector(home, port);
    await collector.collect(owner);
    const projected = projectDelegation(collector.merge(null)!, new ProjectionCache());
    const direct = projected.nodes.find((n) => n.node?.edge === 'direct-call')!;
    assert.equal(direct.proj.marker.words.join('').includes('\x1b'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('no relation storage is created by an idle HUD', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-display-empty-'));
  const home = join(root, 'absent');
  try {
    const collector = new NativeCallCollector(home);
    await collector.collect(owner);
    assert.equal(collector.merge(null), null);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('supplemental calls keep the existing native panel, selection and model-summary rows', async () => {
  const { makeHudData, makeNestedTree } = await import('../fixtures/hud-data.js');
  const { initialMonitorState, reconcileMonitor } = await import('../../src/render/monitor.js');
  const { agentsView } = await import('../../src/render/monitor-panes.js');
  const { buildBarModules } = await import('../../src/render/layout/bar-modules.js');
  const { stripAnsi } = await import('../../src/render/colors.js');
  const home = setup();
  try {
    const port: NativeHostPort = {
      async invoke(_owner, method) {
        return method === 'list'
          ? { connections: [{ nativeRef: relation.child, state: { isStreaming: true } }] }
          : { events: [] };
      },
    };
    const calls = new NativeCallCollector(home, port);
    await calls.collect(owner);
    const delegation = calls.merge(null)!;
    const tree = makeNestedTree();
    const state = initialMonitorState();
    state.tree.selectedId = tree.nodes[0].id;
    const hud = makeHudData();
    const input = { tree, state, width: 120, height: 60, nowMs: 10, hud };
    const before = agentsView(input, state, 120, 10, true).map((r) => stripAnsi(r.text ?? ''));
    const after = agentsView({ ...input, hud: { ...hud, delegation } }, state, 120, 10, true).map((r) =>
      stripAnsi(r.text ?? '')
    );
    assert.deepEqual(after.slice(0, before.length), before);
    assert.match(after.join('\n'), /isStreaming=true/);
    assert.equal(reconcileMonitor(state, tree, null, null, 10, delegation).tree.selectedId, tree.nodes[0].id);
    const agents = buildBarModules({ ...hud, subagentTree: tree, delegation }, { density: 'full' }).find(
      (m) => m.id === 'agents'
    )!;
    assert.match(stripAnsi(agents.variants.full!), /Agents.*Native calls 1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('same official ID resume selects the live connection and excludes prior-connection events', async () => {
  const home = setup();
  try {
    const port: NativeHostPort = {
      async invoke(_owner, method) {
        if (method === 'list')
          return {
            connections: [
              {
                connectionId: 'old',
                nativeRef: relation.child,
                transportEnd: { type: 'disconnected', reason: 'pipe_closed' },
                connected: false,
                state: { isStreaming: false },
              },
              { connectionId: 'resumed', nativeRef: relation.child, connected: true, state: { isStreaming: true } },
            ],
          };
        return {
          events: [
            {
              seq: 1,
              connectionId: 'resumed',
              nativeRef: relation.child,
              event: { type: 'native_event', kind: 'agent_start', payload: {} },
            },
            {
              seq: 2,
              connectionId: 'old',
              nativeRef: relation.child,
              event: { type: 'native_event', kind: 'agent_settled', payload: {} },
            },
          ],
        };
      },
    };
    const collector = new NativeCallCollector(home, port);
    await collector.collect(owner);
    const call = Object.values(collector.merge(null)!.details).find((d) => d.nativeCall)!.nativeCall!;
    assert.equal((call.snapshot as { connectionId: string }).connectionId, 'resumed');
    assert.equal(call.latestEvent!.connectionId, 'resumed');
    assert.match(nativeCallLabel(call), /cached get_state.isStreaming=true.*connected=true.*agent_start/);
    assert.doesNotMatch(nativeCallLabel(call), /agent_settled/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('panel keeps native observer latency outside root parser budgets and native activity navigation', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../../../src/tree-page.ts', import.meta.url), 'utf8');
  assert.ok(panel.indexOf('await nativeRead') > panel.indexOf('main = await parser.parse('));
  assert.match(panel, /if \(!delegation \|\| nativeOnly\)\s+walkNodes/);
  assert.match(panel, /const view = nativeCallsOnly\(delegation\) \? null : delegation/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevHost, readJevRelations, type JevBridge } from '../../src/managed/jev-host.js';
import { NativeCallCollector } from '../../src/collectors/native-calls.js';
import { jevCallLabel } from '../../src/core/link/view-model.js';
import { projectDelegation, ProjectionCache } from '../../src/render/delegation/projection.js';
import type { NativeOwner } from '../../src/managed/relations.js';

const owner: NativeOwner = { harness: 'claude', sourceId: 'a'.repeat(64), sessionId: 'parent', threadId: null };

test('Jev Agent.snapshot enters actual HUD job nodes without simulated ledger or task verdict', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-display-'));
  const methods: string[] = [];
  const snapshot = {
    status: 'blocked',
    url: 'https://example.test/captcha',
    artifacts: [{ path: '/synthetic/page.png' }],
    futureField: { unchanged: true },
  };
  const bridge: JevBridge = {
    async invoke(method) {
      methods.push(method);
      return method === 'create' ? { targetId: 'target-a', sessionId: 'browser-session' } : snapshot;
    },
    release() {
      throw new Error('unexpected_release');
    },
  };
  try {
    const host = createJevHost(home, owner, () => bridge);
    await host.invoke('jev_create', { callId: 'jev-call' });
    const collector = new NativeCallCollector(home, {
      async invoke(parent, method, args, signal) {
        assert.deepEqual(parent, owner);
        return host.invoke(method, args, signal);
      },
    });
    await collector.collect(owner);
    const view = collector.merge(null)!;
    const job = view.tree.nodes.find((n) => n.identity.kind === 'job')!;
    assert.ok(job);
    assert.equal(job.edge, 'direct-call');
    assert.equal(job.simulationJob, undefined);
    assert.equal(job.currentRun, null);
    assert.equal(view.capacity, null);
    assert.equal(view.tree.counts.jobs, 1);
    assert.deepEqual(view.details[job.key].jevCall!.snapshot, snapshot);
    assert.match(jevCallLabel(view.details[job.key].jevCall!), /Agent.snapshot=.*blocked.*captcha.*futureField/);
    const projected = projectDelegation(view, new ProjectionCache()).byKey.get(job.key)!;
    assert.equal(projected.proj.harness, 'jev');
    assert.equal(projected.proj.marker.historyEligible, false);
    assert.equal(projected.proj.detail.managed, false);
    assert.deepEqual(methods, ['create', 'snapshot']);
    assert.equal(existsSync(join(home, 'ledger.sqlite')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Jev relation discovery is read-only, owner scoped and visible after host loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-display-private-'));
  try {
    const absent = join(root, 'absent');
    assert.deepEqual(readJevRelations(absent, owner, 64), []);
    assert.equal(existsSync(absent), false);
    const host = createJevHost(root, owner, () => ({
      async invoke() {
        return { targetId: 'target', sessionId: 'session' };
      },
      release() {},
    }));
    await host.invoke('jev_create', { callId: 'call' });
    assert.equal(readJevRelations(root, { ...owner, sourceId: 'b'.repeat(64) }, 64).length, 0);
    assert.equal(readJevRelations(root, undefined, 64).length, 1);
    const before = readdirSync(root);
    const collector = new NativeCallCollector(root);
    await collector.collect(owner);
    const job = Object.values(collector.merge(null)!.details).find((d) => d.jevCall)!.jevCall!;
    assert.equal(job.snapshot, null);
    assert.match(jevCallLabel(job), /snapshot unavailable/);
    assert.deepEqual(readdirSync(root), before);
    assert.equal(existsSync(join(root, 'native-hosts')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Jev display uses actual last yield and original receipt time without queueing a snapshot or faking freshness', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-display-yield-'));
  const snapshot = { status: 'ready', history: ['native first step'], futureField: { retained: true } };
  const methods: string[] = [];
  const host = createJevHost(home, owner, () => ({
    async invoke(method) {
      methods.push(method);
      if (method !== 'create') throw new Error('must not queue an Agent call for a display refresh');
      return { targetId: 'target', sessionId: 'session' };
    },
    observation: () => ({ source: 'run_yield', receivedAt: 1234, value: snapshot }),
    release() {},
  }));
  try {
    await host.invoke('jev_create', { callId: 'yield-call' });
    const collector = new NativeCallCollector(home, {
      async invoke(_owner, method, args, signal) {
        return host.invoke(method, args, signal);
      },
    });
    for (let refresh = 0; refresh < 2; refresh++) {
      await collector.collect(owner);
      const call = Object.values(collector.merge(null)!.details).find((detail) => detail.jevCall)!.jevCall!;
      assert.deepEqual(call.snapshot, snapshot);
      assert.equal(call.receivedAt, 1234);
      assert.equal(call.observationSource, 'run_yield');
      assert.match(jevCallLabel(call), /Agent.run_yield \(receivedAt=1234; previously received output\)=/);
    }
    assert.deepEqual(methods, ['create']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('concurrent and abandoned Jev snapshot observers share one upstream read, never cancel/close', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-display-coalesce-'));
  let finish: (value: unknown) => void = () => {};
  let snapshots = 0,
    release = 0;
  const host = createJevHost(home, owner, () => ({
    invoke(method) {
      if (method === 'create') return Promise.resolve({ targetId: 'target', sessionId: 'session' });
      assert.equal(method, 'snapshot');
      snapshots++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    release() {
      release++;
    },
  }));
  try {
    const created = (await host.invoke('jev_create', { callId: 'call' })) as { instanceId: string };
    const controller = new AbortController();
    const first = host.invoke('jev_snapshot', created, controller.signal);
    controller.abort();
    const second = host.invoke('jev_snapshot', created);
    assert.equal(snapshots, 1);
    const raw = { state: 'CAPTCHA', pageRetained: true };
    finish(raw);
    assert.deepEqual(await first, raw);
    assert.deepEqual(await second, raw);
    const third = host.invoke('jev_snapshot', created);
    assert.equal(snapshots, 2);
    finish(raw);
    await third;
    assert.equal(release, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

import { renderHud } from '../../dist/render/header.js';
import { makeHudData } from '../../dist-test/tests/fixtures/hud-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { LinkTickCollector } from '../../dist/core/link/tick.js';
import { loadLimits } from '../../dist/core/link/limits.js';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { makeSourceId } from '../../dist/core/identity.js';
import { displayNodeKey } from '../../dist/core/observation.js';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';
import { fixture, root, child, ref, collected, encodeRef, insert, runProof } from './b9-fixture.mjs';
const opts = { skip: !ledgerRuntimeSupported() };
const roots = [{ kind: 'session', ref: root }];
async function tickCollector(f) {
  return new LinkTickCollector(await openLinkLedgerReader(f.path), f.home, loadLimits(f.home));
}

test('B10A missing ledger degrades without throwing into the tick', opts, async (t) => {
  const f = await fixture({ links: 0 });
  t.after(f.cleanup);
  const collector = new LinkTickCollector(
    await openLinkLedgerReader(join(f.home, 'missing.sqlite')),
    f.home,
    loadLimits(f.home)
  );
  t.after(() => collector.close());
  const result = await collector.tick({ roots });
  assert.equal(result.tree.ledger.state, 'degraded');
  assert.equal(result.capacity, null);
  assert.equal(
    renderHud(
      { ...makeHudData(), delegation: result },
      { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } }
    ).length,
    1
  );
});
test('B10A busy real SQLite degrades and recovers without reopening', opts, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.db.exec('PRAGMA journal_mode=DELETE');
  const collector = await tickCollector(f);
  t.after(() => collector.close());
  await collector.tick({ roots, sessions: [collected(root)] });
  f.db.exec('BEGIN EXCLUSIVE');
  const blocked = await collector.tick({ roots });
  assert.equal(blocked.tree.ledger.state, 'degraded');
  assert.equal(blocked.tree.ledger.reason, 'ledger_busy');
  assert.equal(blocked.tree.nodes.length, 2);
  assert.equal(blocked.tree.nodes[1].currentRun.runId, 'run-a');
  assert.equal(blocked.capacity, null);
  assert.ok(blocked.tree.coverage.gaps.includes('ledger_busy'));
  assert.equal(
    renderHud(
      { ...makeHudData(), delegation: blocked },
      { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } }
    ).length,
    1
  );
  f.db.exec('ROLLBACK');
  assert.equal((await collector.tick({ roots })).tree.ledger.state, 'available');
});
test('B10A schema mismatch degrades while tick data remains paintable', opts, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.db.exec('PRAGMA user_version=99');
  const collector = await tickCollector(f);
  t.after(() => collector.close());
  const data = await collector.tick({ roots });
  assert.equal(data.tree.ledger.reason, 'ledger_unsupported_schema');
  assert.equal(
    renderHud(
      { ...makeHudData(), delegation: data },
      { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } }
    ).length,
    1
  );
  assert.equal(data.tree.nodes[0].identity.kind, 'session');
});
test('B10A no-change tick is a projection memo hit with only one high-water check', opts, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const collector = await tickCollector(f);
  t.after(() => collector.close());
  const sessions = [collected(root), collected(child)];
  let previous;
  for (let i = 0; i < 3; i++) previous = await collector.tick({ roots, sessions, nowMs: 12000 + i });
  const unchanged = await collector.tick({ roots, sessions, nowMs: 40000 });
  assert.strictEqual(unchanged, previous);
  assert.equal(collector.stats().projected, false);
  assert.equal(collector.stats().ledgerReads, 0);
  assert.equal(collector.stats().highWaterChecks, 1);
  assert.equal(collector.stats().immediateMerges, 0);
});
test('B10A intent binding preserves selection mappings across later ticks', opts, async (t) => {
  const f = await fixture({ links: 0 });
  t.after(f.cleanup);
  f.addLink('a', root, null, 'pending');
  const collector = await tickCollector(f);
  t.after(() => collector.close());
  const sessions = [collected(root), collected(child)];
  const pending = await collector.tick({ roots, sessions, nowMs: 12000 });
  const intent = displayNodeKey({ kind: 'delegationIntent', linkId: 'link-a' });
  assert.ok(pending.tree.nodes.some((n) => n.key === intent));
  f.evidence('binding-proof', 'launch_receipt', runProof(child));
  f.db
    .prepare("UPDATE links SET state='bound',child_ref=?,current_owner=1,bound_at=11000 WHERE link_id='link-a'")
    .run(encodeRef(child));
  f.db.prepare("UPDATE runs SET target_session_ref=? WHERE run_id='run-a'").run(encodeRef(child));
  insert(f.db, 'events', { run_id: 'run-a', link_id: 'link-a', kind: 'link.bound', payload: '{}', at: 11000 });
  const bound = await collector.tick({ roots, sessions, nowMs: 12001 });
  assert.equal(bound.tree.selectionMap[intent], displayNodeKey({ kind: 'session', ref: child }));
  const later = await collector.tick({ roots, sessions, nowMs: 12002 });
  assert.deepEqual(later.tree.selectionMap, bound.tree.selectionMap);
});
test('B10A no HUD_HOME adds zero collection work; empty delegation ledger has no projection', opts, async (t) => {
  assert.equal(await HudDelegationCollector.open({}, '/synthetic/nonexistent'), null);
  const f = await fixture({ links: 0 });
  t.after(f.cleanup);
  const runtime = await HudDelegationCollector.open({ HUD_HOME: f.home });
  t.after(() => runtime.close());
  assert.equal(await runtime.tick(undefined), null);
  assert.equal(runtime.collector.stats().projected, false);
});
test('B10A reader is retained across ordinary ticks and reopened only after identity change', opts, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const runtime = await HudDelegationCollector.open({ HUD_HOME: f.home });
  t.after(() => runtime.close());
  const first = await runtime.tick(undefined);
  await runtime.prepare();
  const second = await runtime.tick(undefined);
  assert.equal(first.tree.ledger.ledgerId, second.tree.ledger.ledgerId);
  assert.equal(runtime.collector.stats().ledgerReads, 0);
  const next = await fixture({ links: 0 });
  t.after(next.cleanup);
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  next.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.renameSync(f.path, join(f.home, 'old.sqlite'));
  for (const suffix of ['-wal', '-shm'])
    if (fs.existsSync(f.path + suffix)) fs.renameSync(f.path + suffix, join(f.home, 'old.sqlite') + suffix);
  fs.copyFileSync(next.path, f.path);
  fs.chmodSync(f.path, 0o600);
  await runtime.prepare();
  assert.equal(await runtime.tick(undefined), null);
});

test(
  'B10A 200-node real tree and 20 MiB transcript continue fairly under the shared 8 MiB ceiling',
  opts,
  async (t) => {
    const f = await fixture({ links: 0 });
    t.after(f.cleanup);
    const sourceRoot = join(f.home, 'codex');
    const dir = join(sourceRoot, 'sessions', '2026', '11', '02');
    fs.mkdirSync(dir, { recursive: true });
    const sourceId = makeSourceId('codex', fs.realpathSync(sourceRoot));
    const parent = { ...root, sourceId };
    const row = (type, payload) => JSON.stringify({ type, timestamp: '2026-11-02T12:00:00Z', payload }) + '\n';
    const file = (id) => join(dir, `rollout-${id}.jsonl`);
    fs.writeFileSync(file(parent.sessionId), row('session_meta', { id: parent.sessionId, cwd: '/synthetic/project' }));
    const targets = [];
    for (let i = 0; i < 199; i++) {
      const target = { ...child, sourceId, sessionId: `synthetic-worker-${i}` };
      targets.push(target);
      f.addLink(`n${i}`, parent, target);
      fs.writeFileSync(
        file(target.sessionId),
        row('session_meta', { id: target.sessionId, parent_thread_id: parent.sessionId, cwd: '/synthetic/project' }) +
          row('event_msg', { type: 'task_started' })
      );
    }
    const big = targets[0];
    const legal = row('event_msg', { type: 'agent_message', message: 'x'.repeat(1024 * 1024 - 200) });
    fs.appendFileSync(file(big.sessionId), legal.repeat(21));
    fs.writeFileSync(join(f.home, 'delegate.json'), JSON.stringify({ version: 1, profiles: [] }));
    const runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot);
    t.after(() => runtime.close());
    let view,
      previousRemaining = Infinity,
      progress = 0,
      maxBytes = 0;
    for (let tick = 0; tick < 3000; tick++) {
      view = await runtime.tick(parent.sessionId);
      maxBytes = Math.max(maxBytes, runtime.collector.stats().bytesRead);
      assert.ok(runtime.collector.stats().bytesRead <= 8 * 1024 * 1024);
      const node = view?.tree.nodes.find(
        (n) => n.identity.kind === 'session' && n.identity.ref.sessionId === big.sessionId
      );
      const remaining = node?.lastObservation?.coverage.remainingBytes;
      if (typeof remaining === 'number' && remaining < previousRemaining) {
        progress++;
        previousRemaining = remaining;
      }
      if (view?.tree.nodes.length === 200 && view.tree.nodes.every((n) => n.loaded) && remaining === 0) {
        break;
      }
    }
    assert.equal(view.tree.nodes.length, 200);
    assert.ok(view.tree.nodes.every((n) => n.loaded));
    assert.equal(previousRemaining, 0);
    assert.ok(progress >= 5, `expected multi-tick forward progress, got ${progress}`);
    assert.ok(maxBytes > 1024 * 1024);
  }
);

test('B10A metered grants exclude unrelated owners and nodes beyond cross-harness depth four', opts, async (t) => {
  const f = await fixture({ links: 0 });
  t.after(f.cleanup);
  const chain = [root];
  for (let i = 1; i <= 6; i++) {
    const target = ref(`synthetic-depth-${i}`, i % 2 ? 'claude' : 'codex');
    f.addLink(`depth-${i}`, chain.at(-1), target);
    chain.push(target);
  }
  const outside = ref('synthetic-outside-parent'),
    outsider = ref('synthetic-outside-child');
  f.addLink('outside', outside, outsider);
  const sessions = chain.map((r) => collected(r));
  const seen = [];
  const port = {
    sessions: () => sessions,
    pending: (r) => {
      seen.push(r.sessionId);
      return 'session';
    },
    collect: async () => null,
  };
  const collector = new LinkTickCollector(await openLinkLedgerReader(f.path), f.home, loadLimits(f.home), port);
  t.after(() => collector.close());
  for (let i = 0; i < 3; i++) await collector.tick({ roots, sessions, nowMs: 12000 });
  assert.ok(!seen.includes(outside.sessionId) && !seen.includes(outsider.sessionId));
  assert.ok(!seen.includes(chain[5].sessionId) && !seen.includes(chain[6].sessionId));
  assert.equal(collector.current().capacity.active, 7);
});

test('B10A immediate intent merges are bounded to twenty and continue fairly', opts, async (t) => {
  const f = await fixture({ links: 0 });
  t.after(f.cleanup);
  for (let i = 0; i < 45; i++) f.addLink(`intent-${i}`, null, null, 'pending');
  const collector = await tickCollector(f);
  t.after(() => collector.close());
  let view;
  for (let i = 0; i < 10; i++) {
    view = await collector.tick({ roots: [], nowMs: 12000 + i });
    assert.ok(collector.stats().immediateMerges <= 20);
    if (view.pendingStatus === 0) break;
  }
  assert.equal(view.tree.nodes.length, 45);
  assert.equal(view.pendingStatus, 0);
  assert.ok(Object.values(view.details).every((detail) => detail.statusSource === 'ledger'));
});

test('B10A committed freshness expires on a memo hit without mutating the committed projection', opts, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.db.exec('PRAGMA journal_mode=DELETE');
  const collector = await tickCollector(f);
  t.after(() => collector.close());
  const current = collected(child);
  const status = current.evidence.observation.statusProjection;
  status.observationStamp = {
    ref: child,
    runId: 'run-a',
    bindingGeneration: 1,
    sourceGeneration: 1,
    seqDomain: 'synthetic-committed',
    commitSeq: 7,
    inputLedgerSeq: 1,
  };
  status.freshness = {
    state: 'fresh',
    sources: [
      {
        id: 'transcript',
        validity: 'current',
        lastEvidenceAt: 12000,
        observedAt: 12000,
        lastSuccessfulReadAt: 12000,
        deadlineAt: 13000,
      },
    ],
    requiredSourceIds: ['transcript'],
    staleSince: null,
    reason: null,
    clockAnomaly: false,
  };
  const sessions = [collected(root), current];
  const first = await collector.tick({ roots, sessions, nowMs: 12000 });
  const key = displayNodeKey({ kind: 'session', ref: child });
  assert.equal(first.details[key].status.freshness.state, 'fresh');
  const expired = await collector.tick({ roots, sessions, nowMs: 14000 });
  assert.equal(collector.stats().projected, false);
  assert.equal(expired.details[key].status.freshness.state, 'stale');
  assert.equal(expired.details[key].status.freshness.staleSince, 13000);
  assert.equal(expired.tree.nodes.find((n) => n.key === key).observation.statusProjection.freshness.state, 'fresh');
  assert.strictEqual(expired.details[key].status.observationStamp, status.observationStamp);
  assert.equal(expired.details[key].status.stateKey, status.stateKey);
  // Return to a fresh available base, then expire while repeated busy ticks clone it.
  assert.equal((await collector.tick({ roots, sessions, nowMs: 12000 })).details[key].status.freshness.state, 'fresh');
  f.db.exec('BEGIN EXCLUSIVE');
  try {
    for (const nowMs of [14000, 14001, 14002]) {
      const busy = await collector.tick({ roots, sessions, nowMs });
      assert.equal(busy.tree.ledger.reason, 'ledger_busy');
      assert.equal(busy.details[key].status.freshness.state, 'stale');
    }
  } finally {
    f.db.exec('ROLLBACK');
  }
});

test(
  'B10A continuous appends advance body readers and new native children survive later body reads',
  opts,
  async (t) => {
    const f = await fixture({ links: 0 });
    t.after(f.cleanup);
    const sourceRoot = join(f.home, 'codex');
    const dir = join(sourceRoot, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const sourceId = makeSourceId('codex', sourceRoot),
      parent = { ...root, sourceId },
      target = { ...child, sourceId };
    f.addLink('a', parent, target);
    const file = (id) => join(dir, id + '.jsonl');
    const row = (type, payload, at = 0) =>
      JSON.stringify({ type, timestamp: new Date(1772366400000 + at * 1000).toISOString(), payload }) + '\n';
    fs.writeFileSync(file(parent.sessionId), row('session_meta', { id: parent.sessionId }));
    fs.writeFileSync(
      file(target.sessionId),
      row('session_meta', { id: target.sessionId, parent_thread_id: parent.sessionId })
    );
    const runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot);
    t.after(() => runtime.close());
    let view;
    for (let i = 0; i < 30; i++) view = await runtime.tick(parent.sessionId);
    const key = displayNodeKey({ kind: 'session', ref: target }),
      reading = runtime.port.readings.get(key);
    const before = reading.checkpoint.offset;
    for (let i = 0; i < 30; i++) {
      fs.appendFileSync(file(target.sessionId), row('event_msg', { type: 'task_started' }, i + 1));
      fs.appendFileSync(file(parent.sessionId), row('event_msg', { type: 'task_started' }, i + 1));
      fs.writeFileSync(file('unrelated-' + i), row('session_meta', { id: 'unrelated-' + i }));
      view = await runtime.tick(parent.sessionId);
    }
    assert.ok(reading.checkpoint.offset > before + 1000);
    for (let i = 0; i < 10; i++) await runtime.tick(parent.sessionId);
    assert.equal(reading.checkpoint.offset, fs.statSync(file(target.sessionId)).size);
    const fresh = 'synthetic-new-native';
    fs.writeFileSync(file(fresh), row('session_meta', { id: fresh, parent_thread_id: parent.sessionId }));
    for (let i = 0; i < 30; i++) view = await runtime.tick(parent.sessionId);
    assert.ok(view.tree.nodes.some((n) => n.identity.kind === 'session' && n.identity.ref.sessionId === fresh));
    fs.appendFileSync(file(parent.sessionId), row('event_msg', { type: 'task_started' }, 99));
    for (let i = 0; i < 30; i++) view = await runtime.tick(parent.sessionId);
    assert.ok(view.tree.nodes.some((n) => n.identity.kind === 'session' && n.identity.ref.sessionId === fresh));
  }
);

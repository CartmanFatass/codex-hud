import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync, appendFileSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { publishFixture, cycle, settle } from './b10c-fixture.mjs';
import { runtimeRow } from './b10a-runtime-fixture.mjs';
import { insert } from './b9-fixture.mjs';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { openObservationStore } from '../../dist/core/observation-store.js';
import { makeSourceId } from '../../dist/core/identity.js';
import { renderHud } from '../../dist/render/header.js';
import { makeHudData } from '../../dist-test/tests/fixtures/hud-data.js';
const key = (ref) =>
  JSON.stringify(['session', JSON.stringify([ref.harness, ref.sourceId, ref.sessionId, ref.threadId])]);
const sourceRoot = (f) => f.file(f.parent.sessionId).split('/sessions/')[0];
async function storeFor(t, f, sourceId = f.parent.sourceId) {
  const store = await openObservationStore({ hudHome: f.home, sourceId, readOnly: true });
  t.after(() => store.close());
  return store;
}

test('B10C real SQLite busy observation publication keeps a complete old commit and retries the same candidate after paint', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const store = await storeFor(t, f),
    before = store.readProjection(f.parent);
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  const lock = new DatabaseSync(store.databasePath);
  t.after(() => lock.close());
  lock.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < 6; i++) {
      const view = await cycle(f);
      assert.equal(
        renderHud(
          { ...makeHudData(), delegation: view },
          { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } }
        ).length,
        1
      );
      assert.equal(store.readProjection(f.parent).commitSeq, before.commitSeq);
    }
    assert.equal(f.runtime.publicationStats().error, 'observation_busy');
  } finally {
    lock.exec('ROLLBACK');
  }
  for (let i = 0; i < 20 && store.readProjection(f.parent).commitSeq === before.commitSeq; i++) await cycle(f);
  assert.equal(store.readProjection(f.parent).commitSeq, before.commitSeq + 1);
  assert.equal(
    store.readProjection(f.parent).continuity.stateKey,
    store.readProjection(f.parent).summary.statusProjection.stateKey
  );
});
test('B10C unavailable real observation store degrades and leaves the bar paintable without throwing', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const source = f.runtime.port.sources.get(f.parent.sourceId);
  source.store.close();
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 5; i++) {
    const view = await cycle(f);
    assert.equal(
      renderHud(
        { ...makeHudData(), delegation: view },
        { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } }
      ).length,
      1
    );
  }
  assert.equal(f.runtime.collector.current().details[key(f.parent)].statusSource, 'unavailable');
});
test('B10C restart restores stateKey/stateSince/basis and notice cursor from the same committed recovery boundary', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f),
    before = store.readProjection(f.parent);
  f.runtime.close();
  f.runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot(f), { publish: true });
  t.after(() => f.runtime.close());
  await settle(f);
  const after = store.readProjection(f.parent);
  assert.equal(after.continuity.stateKey, before.continuity.stateKey);
  assert.equal(after.continuity.stateSince, before.continuity.stateSince);
  assert.equal(after.continuity.stateSinceBasis, before.continuity.stateSinceBasis);
  assert.equal(after.noticeState.noticeSeq, before.noticeState.noticeSeq);
  assert.deepEqual(after.notices, before.notices);
  assert.equal(after.checkpointIdentity.sourceGeneration, before.checkpointIdentity.sourceGeneration);
});
test('B10C crossing a captured deadline publishes one semantic edge; clock ages and unrelated ledger events publish nothing', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  const f = await publishFixture();
  t.after(() => {
    f.cleanup();
    Date.now = actual;
  });
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f),
    before = store.readProjection(f.parent);
  now += 6000;
  for (let i = 0; i < 10; i++) await cycle(f);
  const stale = store.readProjection(f.parent);
  assert.equal(stale.commitSeq, before.commitSeq + 1);
  assert.equal(stale.summary.statusProjection.freshness.state, 'stale');
  for (let i = 0; i < 20; i++) {
    now++;
    await cycle(f);
  }
  assert.equal(store.readProjection(f.parent).commitSeq, stale.commitSeq);
  insert(f.db, 'events', { kind: 'synthetic.unrelated', payload: '{}', at: now });
  for (let i = 0; i < 10; i++) await cycle(f);
  assert.equal(store.readProjection(f.parent).commitSeq, stale.commitSeq);
  assert.deepEqual(store.readProjection(f.parent).observationStamp, stale.observationStamp);
});
test('B10C all same-snapshot reports after the committed cursor publish together, then restart does not repeat them', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const store = await storeFor(t, f);
  const ref = f.targets[0];
  for (let i = 0; i < 2; i++) {
    const reportId = `synthetic-report-${i}`;
    insert(f.db, 'reports', {
      report_id: reportId,
      run_id: 'run-n1',
      link_id: 'link-n1',
      child_binding_id: 'binding-n1',
      caller_id: 'caller-a',
      caller_context_id: 'context-a',
      context_generation: 1,
      status: 'blocked',
      summary: 'Synthetic report',
      path: null,
      created_at: Date.now() + i,
    });
    insert(f.db, 'events', {
      run_id: 'run-n1',
      link_id: 'link-n1',
      kind: 'report.received',
      payload: JSON.stringify({ reportId }),
      at: Date.now() + i,
    });
  }
  for (let i = 0; i < 10; i++) await cycle(f);
  const published = store.readProjection(ref);
  assert.equal(published.notices.filter((n) => n.kind === 'report').length, 2);
  assert.equal(published.summary.statusProjection.pendingReason, 'needs_human');
  const seq = published.noticeState.noticeSeq;
  f.runtime.close();
  f.runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot(f), { publish: true });
  await settle(f);
  for (let i = 0; i < 10; i++) await cycle(f);
  assert.equal(store.readProjection(ref).noticeState.noticeSeq, seq);
});
test('B10C known Claude session publishes explicit end_turn facts with observed provenance; native topology remains unavailable', async (t) => {
  const f = await publishFixture();
  f.runtime.close();
  t.after(f.cleanup);
  const root = join(f.home, 'claude');
  mkdirSync(join(root, 'projects', 'synthetic-project'), { recursive: true });
  const ref = {
    harness: 'claude',
    sourceId: makeSourceId('claude', root),
    sessionId: 'synthetic-claude',
    threadId: null,
  };
  const now = Date.now();
  writeFileSync(
    join(root, 'projects', 'synthetic-project', ref.sessionId + '.jsonl'),
    JSON.stringify({
      type: 'assistant',
      uuid: 'synthetic-message',
      sessionId: ref.sessionId,
      cwd: '/synthetic/project',
      timestamp: new Date(now).toISOString(),
      message: {
        id: 'synthetic-response',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Synthetic completion' }],
      },
    }) + '\n'
  );
  writeFileSync(
    join(f.home, 'delegate.json'),
    JSON.stringify({
      version: 1,
      profiles: [{ name: 'synthetic-claude', harness: 'claude', source: { root }, env: {}, mcpServerName: 'hud' }],
    })
  );
  f.addLink('claude', f.parent, ref);
  f.runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot(f), { publish: true });
  t.after(() => f.runtime.close());
  const store = await storeFor(t, f, ref.sourceId);
  let view;
  for (let i = 0; i < 100; i++) {
    view = await cycle(f);
    if (store.readProjection(ref)) break;
  }
  const projection = store.readProjection(ref);
  assert.ok(projection);
  assert.equal(projection.summary.statusProjection.activity, 'idle');
  assert.equal(projection.summary.statusProjection.lastTurnOutcome, 'completed');
  assert.equal(projection.summary.statusProjection.isRunTerminal, false);
  assert.equal(view.tree.nodes.find((n) => n.key === key(ref)).native, null);
  const before = projection.checkpointIdentity.offset;
  appendFileSync(
    join(root, 'projects', 'synthetic-project', ref.sessionId + '.jsonl'),
    JSON.stringify({
      type: 'assistant',
      uuid: 'synthetic-message-2',
      sessionId: ref.sessionId,
      timestamp: new Date(now).toISOString(),
      message: {
        id: 'synthetic-response-2',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Synthetic update' }],
      },
    }) + '\n'
  );
  for (let i = 0; i < 60 && store.readProjection(ref).checkpointIdentity.offset === before; i++) await cycle(f);
  assert.ok(store.readProjection(ref).checkpointIdentity.offset > before, 'known Claude append must make progress');
  const completedOffset = store.readProjection(ref).checkpointIdentity.offset;
  appendFileSync(
    join(root, 'projects', 'synthetic-project', ref.sessionId + '.jsonl'),
    JSON.stringify({
      type: 'user',
      uuid: 'synthetic-user-next',
      sessionId: ref.sessionId,
      timestamp: new Date(now + 1000).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'Synthetic next request' }] },
    }) + '\n'
  );
  for (let i = 0; i < 60 && store.readProjection(ref).checkpointIdentity.offset === completedOffset; i++)
    await cycle(f);
  const next = store.readProjection(ref).summary.statusProjection;
  assert.equal(next.activity, 'unknown');
  assert.equal(next.lastTurnOutcome, 'completed');
});
test('B10C production legacy without a ledger creates no publisher/store and leaves the old render bytes unchanged', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-b10c-legacy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });
  const data = makeHudData(),
    before = renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } });
  assert.equal(await HudDelegationCollector.open({}, home, { publish: true }), null);
  assert.equal(await HudDelegationCollector.open({ HUD_HOME: home }, home, { publish: true }), null);
  assert.deepEqual(renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } }), before);
  assert.deepEqual((await import('node:fs')).readdirSync(home), []);
});

test('B10C Codex semantic entry uses the turn event clock, never a later token/usage event', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  appendFileSync(
    f.file(f.parent.sessionId),
    runtimeRow('event_msg', { type: 'task_started' }, 1) +
      runtimeRow(
        'event_msg',
        { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } },
        7
      )
  );
  await settle(f);
  const store = await storeFor(t, f),
    projection = store.readProjection(f.parent);
  assert.equal(projection.summary.statusProjection.stateSince, 1772366401000);
  assert.equal(projection.summary.statusProjection.stateSinceBasis, 'event');
  assert.equal(projection.summary.statusProjection.activity, 'working');
});

test('B10C normal startup defaults to a private existing HOME/.hud ledger and publishes without a new user flag', async (t) => {
  const taskHome = mkdtempSync(join(tmpdir(), 'hud-b10c-default-home-'));
  const originalHome = process.env.HOME;
  process.env.HOME = taskHome;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(taskHome, { recursive: true, force: true });
  });
  assert.equal(await HudDelegationCollector.open({}, undefined, { publish: true }), null);
  assert.deepEqual((await import('node:fs')).readdirSync(taskHome), []);
  const defaultHome = join(taskHome, '.hud');
  mkdirSync(defaultHome, { mode: 0o700 });
  assert.equal(await HudDelegationCollector.open({}, undefined, { publish: true }), null);
  assert.deepEqual((await import('node:fs')).readdirSync(defaultHome), []);
  const f = await publishFixture();
  f.runtime.close();
  t.after(f.cleanup);
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  (await import('node:fs')).copyFileSync(f.path, join(defaultHome, 'ledger.sqlite'));
  (await import('node:fs')).chmodSync(join(defaultHome, 'ledger.sqlite'), 0o600);
  const runtime = await HudDelegationCollector.open({}, sourceRoot(f), { publish: true });
  assert.ok(runtime);
  t.after(() => runtime.close());
  const defaultFixture = { ...f, runtime };
  await settle(defaultFixture);
  const store = await openObservationStore({ hudHome: defaultHome, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => store.close());
  assert.ok(store.readProjection(f.parent));
  assert.equal(runtime.home, defaultHome);
  runtime.close();
  (await import('node:fs')).chmodSync(defaultHome, 0o755);
  assert.equal(await HudDelegationCollector.open({}, sourceRoot(f), { publish: true }), null);
  (await import('node:fs')).chmodSync(defaultHome, 0o700);
  assert.equal(
    await HudDelegationCollector.open({ HUD_HOME: `${taskHome}/x/../.hud` }, sourceRoot(f), {
      publish: true,
    }),
    null
  );
  (await import('node:fs')).renameSync(defaultHome, join(taskHome, 'private-hud'));
  (await import('node:fs')).symlinkSync(join(taskHome, 'private-hud'), defaultHome);
  assert.equal(await HudDelegationCollector.open({}, sourceRoot(f), { publish: true }), null);
});

test('B10C stable native failure episode is not notified again by a later usage-only checkpoint', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const store = await storeFor(t, f);
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_failed' }, 4));
  for (let i = 0; i < 10; i++) await cycle(f);
  const failed = store.readProjection(f.parent);
  assert.equal(failed.notices.filter((n) => n.kind === 'failed').length, 1);
  appendFileSync(
    f.file(f.parent.sessionId),
    runtimeRow(
      'event_msg',
      { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } },
      5
    )
  );
  for (let i = 0; i < 10; i++) await cycle(f);
  const usage = store.readProjection(f.parent);
  assert.ok(usage.checkpointIdentity.offset > failed.checkpointIdentity.offset);
  assert.equal(usage.noticeState.noticeSeq, failed.noticeState.noticeSeq);
  assert.deepEqual(usage.notices, failed.notices);
});
test('B10C matched approval answer starts the resumed working interval at the native answer event', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  const file = f.file(f.parent.sessionId);
  appendFileSync(file, runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f);
  appendFileSync(
    file,
    runtimeRow('event_msg', { type: 'exec_approval_request', call_id: 'synthetic-call', command: ['true'] }, 2)
  );
  for (let i = 0; i < 10; i++) await cycle(f);
  assert.equal(store.readProjection(f.parent).summary.statusProjection.pendingReason, 'approval');
  appendFileSync(file, runtimeRow('event_msg', { type: 'exec_command_begin', call_id: 'synthetic-call' }, 3));
  for (let i = 0; i < 10; i++) await cycle(f);
  const resumed = store.readProjection(f.parent);
  assert.equal(resumed.summary.statusProjection.activity, 'working');
  assert.equal(resumed.summary.statusProjection.stateSince, 1772366403000);
  assert.equal(resumed.summary.statusProjection.stateSinceBasis, 'event');
});
test('B10C cause-only reconciliation uses its actual time/seq and keeps the uncertain-entry episode stable', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const store = await storeFor(t, f),
    ref = f.targets[0];
  f.db.prepare("UPDATE runs SET state='uncertain' WHERE run_id='run-n1'").run();
  insert(f.db, 'events', {
    run_id: 'run-n1',
    link_id: 'link-n1',
    kind: 'run.state',
    payload: JSON.stringify({ state: 'uncertain', cause: 'supervisor_dead' }),
    at: Date.now() - 10,
  });
  for (let i = 0; i < 10; i++) await cycle(f);
  const before = store.readProjection(ref),
    at = Date.now();
  insert(f.db, 'events', {
    run_id: 'run-n1',
    link_id: 'link-n1',
    kind: 'run.reconciliation',
    payload: JSON.stringify({ cause: 'scope_unknown', blockNewOperations: true, evidenceIds: [] }),
    at,
  });
  for (let i = 0; i < 10; i++) await cycle(f);
  const after = store.readProjection(ref);
  assert.equal(after.continuity.stateKey, 'uncertain:scope_unknown');
  assert.equal(after.continuity.stateSince, at);
  assert.equal(after.continuity.stateSinceBasis, 'event');
  assert.equal(after.noticeState.noticeSeq, before.noticeState.noticeSeq);
  assert.equal(after.continuity.episodeAnchor, before.continuity.episodeAnchor);
});
test('B10C fresh managed working child remains fresh through 29s then crosses the real heartbeat cutoff', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  const f = await publishFixture();
  t.after(() => {
    f.cleanup();
    Date.now = actual;
  });
  f.db
    .prepare("UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=? WHERE run_id='run-n1'")
    .run(now, now);
  appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f),
    ref = f.targets[0];
  assert.equal(store.readProjection(ref).summary.statusProjection.freshness.state, 'fresh');
  assert.equal(store.readProjection(ref).summary.statusProjection.liveness, 'alive');
  now += 29000;
  insert(f.db, 'events', { kind: 'synthetic.ledger-refresh', payload: '{}', at: now });
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 2));
  for (let i = 0; i < 40; i++) await cycle(f);
  assert.equal(store.readProjection(ref).summary.statusProjection.freshness.state, 'fresh');
  now += 2001;
  for (let i = 0; i < 10; i++) await cycle(f);
  const stale = store.readProjection(ref).summary.statusProjection;
  assert.equal(stale.freshness.state, 'stale');
  assert.equal(stale.liveness, 'unknown');
  assert.equal(stale.isRunTerminal, false);
});
test('B10C a later actual ledger snapshot can recover stale run facts without clock-only publications each tick', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  const f = await publishFixture();
  t.after(() => {
    f.cleanup();
    Date.now = actual;
  });
  f.db
    .prepare("UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=? WHERE run_id='run-n1'")
    .run(now, now);
  const ref = f.targets[0];
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f);
  now += 6000;
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 2));
  for (let i = 0; i < 20; i++) await cycle(f);
  assert.equal(store.readProjection(ref).summary.statusProjection.freshness.state, 'stale');
  insert(f.db, 'events', { kind: 'synthetic.ledger-refresh', payload: '{}', at: now });
  for (let i = 0; i < 10; i++) await cycle(f);
  const fresh = store.readProjection(ref);
  assert.equal(fresh.summary.statusProjection.freshness.state, 'fresh');
  for (let i = 0; i < 20; i++) {
    now++;
    await cycle(f);
  }
  assert.equal(store.readProjection(ref).commitSeq, fresh.commitSeq);
});
test('B10C recovery consumes its cooperative grant before another native read is allowed', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  f.runtime.close();
  f.runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot(f), { publish: true });
  t.after(() => f.runtime.close());
  const source = f.runtime.port.sources.get(f.parent.sourceId),
    readRecovery = source.store.readRecovery.bind(source.store),
    open = source.adapter.open.bind(source.adapter);
  let recoveries = 0,
    reads = 0;
  source.store.readRecovery = (target, budget) => {
    const result = readRecovery(target, budget);
    if (target.ref.sessionId === f.parent.sessionId) {
      recoveries++;
      const until = performance.now() + 25;
      while (performance.now() < until) {
        /* bounded injected recovery work */
      }
    }
    return result;
  };
  source.adapter.open = (ref, checkpoint) => {
    const reader = open(ref, checkpoint);
    return {
      read: (budget) => {
        if (ref.sessionId === f.parent.sessionId) reads++;
        return reader.read(budget);
      },
    };
  };
  for (let i = 0; i < 20 && recoveries === 0; i++) await cycle(f);
  assert.equal(recoveries, 1);
  assert.equal(reads, 0);
  source.store.readRecovery = readRecovery;
  for (let i = 0; i < 20 && reads === 0; i++) await cycle(f);
  assert.ok(reads > 0);
});

test('B10C existing empty ledger publishes the real ambient session with inputLedgerSeq zero; read-only API remains unchanged', async (t) => {
  const f = await publishFixture(1, 8);
  t.after(f.cleanup);
  const store = await storeFor(t, f);
  const readOnly = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot(f));
  t.after(() => readOnly.close());
  assert.equal(await readOnly.tick(f.parent.sessionId), null);
  for (let i = 0; i < 30 && !store.readProjection(f.parent); i++) await cycle(f);
  const projection = store.readProjection(f.parent);
  assert.ok(projection);
  assert.equal(projection.observationStamp.inputLedgerSeq, 0);
  assert.equal(projection.observationStamp.runId, undefined);
  assert.equal(projection.observationStamp.bindingGeneration, undefined);
  assert.equal(projection.ref.sessionId, f.parent.sessionId);
});

test('B10C supervisor wrapper clocks stay at the actual ledger snapshot across later native-only publication tails', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  const f = await publishFixture();
  t.after(() => {
    f.cleanup();
    Date.now = actual;
  });
  const ref = f.targets[0];
  f.db
    .prepare("UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=? WHERE run_id='run-n1'")
    .run(now, now);
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f);
  const first = store
    .readProjection(ref)
    .summary.statusProjection.freshness.sources.find((s) => s.id === 'supervisor:run-n1');
  assert.equal(first.observedAt, now);
  assert.equal(first.lastSuccessfulReadAt, now);
  now += 2000;
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 2));
  for (let i = 0; i < 10; i++) await cycle(f);
  const next = store
    .readProjection(ref)
    .summary.statusProjection.freshness.sources.find((s) => s.id === 'supervisor:run-n1');
  assert.equal(next.observedAt, first.observedAt);
  assert.equal(next.lastSuccessfulReadAt, first.lastSuccessfulReadAt);
  assert.equal(next.deadlineAt, first.deadlineAt);
});

test('B10C failed native read reserves both known recovered bytes and the remaining failed-read grant', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  f.runtime.close();
  f.runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot(f), { publish: true });
  const source = f.runtime.port.sources.get(f.parent.sourceId),
    recover = source.store.readRecovery.bind(source.store),
    open = source.adapter.open.bind(source.adapter);
  let knownBytes = 0,
    failedGrant = null;
  source.store.readRecovery = (target, budget) => {
    const result = recover(target, budget);
    if (target.ref.sessionId === f.parent.sessionId && result && 'checkpoint' in result) {
      const { recoveryIndex, ...inline } = result.checkpoint;
      knownBytes = Buffer.byteLength(JSON.stringify(inline));
    }
    return result;
  };
  source.adapter.open = (ref, checkpoint) =>
    ref.sessionId === f.parent.sessionId
      ? {
          read: async (budget) => {
            failedGrant = budget;
            throw new Error('synthetic_native_read_failure');
          },
        }
      : open(ref, checkpoint);
  for (let i = 0; i < 20 && !failedGrant; i++) await cycle(f);
  assert.ok(failedGrant);
  assert.ok(knownBytes > 0);
  assert.ok(f.runtime.collector.stats().bytesRead >= knownBytes + failedGrant.maxBytes);
});

test('B10C same-read approval/answer changes working episode and bounded event eviction plus restart preserve that accepted boundary', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  const file = f.file(f.parent.sessionId);
  appendFileSync(file, runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f);
  appendFileSync(
    file,
    runtimeRow('event_msg', { type: 'exec_approval_request', call_id: 'synthetic-same-read', command: ['true'] }, 2) +
      runtimeRow('event_msg', { type: 'exec_command_begin', call_id: 'synthetic-same-read' }, 3)
  );
  for (let i = 0; i < 10; i++) await cycle(f);
  const resumed = store.readProjection(f.parent);
  assert.equal(resumed.summary.statusProjection.activity, 'working');
  assert.equal(resumed.continuity.stateSince, 1772366403000);
  const anchor = resumed.continuity.episodeAnchor;
  for (let i = 0; i < 65; i++) {
    appendFileSync(
      file,
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 0 } } }, 4 + i * 2) +
        runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 85 } } }, 5 + i * 2)
    );
    for (let j = 0; j < 4; j++) await cycle(f);
  }
  const evicted = store.readProjection(f.parent);
  assert.equal(evicted.continuity.episodeAnchor, anchor);
  assert.equal(evicted.continuity.stateSince, 1772366403000);
  f.runtime.close();
  f.runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot(f), { publish: true });
  await settle(f);
  assert.equal(store.readProjection(f.parent).continuity.episodeAnchor, anchor);
  assert.equal(store.readProjection(f.parent).continuity.stateSince, 1772366403000);
  appendFileSync(file, runtimeRow('event_msg', { type: 'task_started' }, 200));
  for (let i = 0; i < 10; i++) await cycle(f);
  assert.equal(store.readProjection(f.parent).continuity.stateSince, 1772366600000);
});

test('B10C dormant same-process lease expiry reacquires a new generation and recovers the accepted interval', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  const f = await publishFixture();
  t.after(() => {
    f.cleanup();
    Date.now = actual;
  });
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f),
    before = store.readProjection(f.parent),
    lease = store.readLease(f.parent);
  now += 16000;
  appendFileSync(
    f.file(f.parent.sessionId),
    runtimeRow(
      'event_msg',
      { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } },
      2
    )
  );
  for (let i = 0; i < 60; i++) await cycle(f);
  const after = store.readProjection(f.parent);
  assert.ok(store.readLease(f.parent).generation > lease.generation);
  assert.ok(after.checkpointIdentity.offset > before.checkpointIdentity.offset);
  assert.equal(after.continuity.stateSince, before.continuity.stateSince);
});

test('B10C real SQLite stale-CAS rejection discards the unacknowledged writer and recovers its accepted head', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  const f = await publishFixture();
  t.after(() => {
    f.cleanup();
    Date.now = actual;
  });
  await settle(f);
  const source = f.runtime.port.sources.get(f.parent.sourceId),
    publish = source.store.publishPrepared.bind(source.store);
  const store = await storeFor(t, f),
    before = store.readProjection(f.parent);
  let conflict = false;
  source.store.publishPrepared = (...args) => {
    if (args[0]?.commit?.ref?.sessionId === f.parent.sessionId && !conflict) {
      publish(...args);
      conflict = true;
      return publish(...args); // same original expectedCommitSeq now loses the real SQLite CAS
    }
    return publish(...args);
  };
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_failed' }, 4));
  for (let i = 0; i < 20 && !conflict; i++) await cycle(f);
  assert.ok(conflict);
  assert.equal(f.runtime.publicationStats().error, 'observation_commit_conflict');
  const accepted = store.readProjection(f.parent);
  assert.equal(accepted.commitSeq, before.commitSeq + 1);
  now += 16000;
  source.store.publishPrepared = publish;
  for (let i = 0; i < 60; i++) await cycle(f);
  const recovered = store.readProjection(f.parent);
  assert.equal(recovered.noticeState.noticeSeq, accepted.noticeState.noticeSeq);
  assert.deepEqual(recovered.notices, accepted.notices);
  assert.equal(recovered.continuity.stateSince, accepted.continuity.stateSince);
});

test('B10C same-session new run retargets through a real reader capture before publishing the new run stamp', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const ref = f.targets[0],
    store = await storeFor(t, f),
    before = store.readProjection(ref);
  const old = f.db.prepare("SELECT * FROM runs WHERE run_id='run-n1'").get();
  f.evidence('synthetic-terminal-next', 'scope_reconciled', {}, 'link-n1', 'run-n1');
  f.db
    .prepare(
      "UPDATE runs SET state='ended',ended_at=12000,terminal_evidence_id='synthetic-terminal-next',submission_fenced_at=12000 WHERE run_id='run-n1'"
    )
    .run();
  insert(f.db, 'runs', {
    ...old,
    run_id: 'run-n1-next',
    run_seq: 2,
    operation: 'resume',
    expected_generation: 2,
    state: 'running',
    launch_token_hash: '7'.repeat(64),
    launch_call_id: 'synthetic-next-call',
    launch_correlation_id: 'synthetic-next-correlation',
    launch_message_id: 'synthetic-next-message',
    created_at: 13000,
    started_at: 13001,
  });
  insert(f.db, 'events', {
    run_id: 'run-n1-next',
    link_id: 'link-n1',
    kind: 'run.state',
    payload: JSON.stringify({ state: 'running' }),
    at: 13001,
  });
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 2));
  for (let i = 0; i < 60; i++) await cycle(f);
  const after = store.readProjection(ref);
  assert.equal(after.observationStamp.runId, 'run-n1-next');
  assert.equal(after.observationStamp.bindingGeneration, 2);
  assert.ok(after.checkpointIdentity.offset > before.checkpointIdentity.offset);
});

test('B10C an interruption evicted before any read falls back to an observed interval and ledger-only updates do not restart it', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  const f = await publishFixture();
  t.after(() => {
    f.cleanup();
    Date.now = actual;
  });
  const ref = f.targets[0],
    file = f.file(ref.sessionId);
  f.db
    .prepare("UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=? WHERE run_id='run-n1'")
    .run(now, now);
  appendFileSync(file, runtimeRow('event_msg', { type: 'task_started' }, 1));
  await settle(f);
  const store = await storeFor(t, f);
  let rows =
    runtimeRow('event_msg', { type: 'exec_approval_request', call_id: 'synthetic-hidden', command: ['true'] }, 2) +
    runtimeRow('event_msg', { type: 'exec_command_begin', call_id: 'synthetic-hidden' }, 3);
  for (let i = 0; i < 65; i++)
    rows +=
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 0 } } }, 4 + i * 2) +
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 85 } } }, 5 + i * 2);
  appendFileSync(file, rows);
  for (let i = 0; i < 20; i++) await cycle(f);
  const observed = store.readProjection(ref);
  assert.equal(observed.continuity.stateSinceBasis, 'observed');
  assert.equal(observed.continuity.stateSince, now);
  now += 1000;
  f.db
    .prepare("UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=? WHERE run_id='run-n1'")
    .run(now, now);
  insert(f.db, 'events', { kind: 'synthetic.ledger-refresh', payload: '{}', at: now });
  for (let i = 0; i < 20; i++) await cycle(f);
  assert.equal(store.readProjection(ref).continuity.stateSince, observed.continuity.stateSince);
});

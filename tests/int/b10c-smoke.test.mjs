import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { runtimeFixture, runtimeRow } from './b10a-runtime-fixture.mjs';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { openObservationStore } from '../../dist/core/observation-store.js';
import { displayNodeKey } from '../../dist/core/observation.js';

import { publishFixture, cycle, settle } from './b10c-fixture.mjs';
test('B10C production collector publishes only after initial paint and no-change cycles make zero commits', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  const view = await settle(f);
  const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => store.close());
  const ref = f.targets[0],
    key = displayNodeKey({ kind: 'session', ref });
  const before = store.readProjection(ref);
  assert.equal(view.details[key].statusSource, 'committed');
  for (let i = 0; i < 30; i++) await cycle(f);
  assert.equal(store.readProjection(ref).commitSeq, before.commitSeq);
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  let observed = false;
  for (let i = 0; i < 30; i++) {
    await f.runtime.tick(f.parent.sessionId);
    assert.equal(store.readProjection(ref).commitSeq, before.commitSeq);
    await f.runtime.afterPaint((next) => {
      observed = next?.details[key]?.statusSource === 'committed';
    });
    if (store.readProjection(ref).commitSeq > before.commitSeq) break;
  }
  assert.equal(observed, true);
  assert.ok(store.readProjection(ref).commitSeq > before.commitSeq);
});

test('B10C duplicate or stale tail token cannot publish a later collection; committed refresh grants no reader', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => store.close());
  await f.runtime.tick(f.parent.sessionId);
  const oldToken = f.runtime.publicationToken();
  await f.runtime.afterPaint(() => {}, undefined, oldToken);
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  const before = store.readProjection(f.parent);
  await f.runtime.tick(f.parent.sessionId);
  const currentToken = f.runtime.publicationToken();
  let reads = 0;
  const collect = f.runtime.port.collect.bind(f.runtime.port);
  f.runtime.port.collect = (...args) => {
    reads++;
    return collect(...args);
  };
  await f.runtime.afterPaint(() => assert.fail('stale callback'), undefined, oldToken);
  assert.equal(store.readProjection(f.parent).commitSeq, before.commitSeq);
  let painted = 0;
  await f.runtime.afterPaint(() => painted++, undefined, currentToken);
  assert.equal(reads, 0);
  assert.equal(painted, 1);
  assert.equal(store.readProjection(f.parent).commitSeq, before.commitSeq + 1);
  await f.runtime.afterPaint(() => assert.fail('duplicate callback'), undefined, currentToken);
  assert.equal(store.readProjection(f.parent).commitSeq, before.commitSeq + 1);
});

test('B10C an unpublished first reading never escapes as display/history summary or metrics', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  appendFileSync(
    f.file(f.parent.sessionId),
    runtimeRow('event_msg', { type: 'task_started' }, 1) +
      runtimeRow(
        'event_msg',
        { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } },
        2
      )
  );
  const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => store.close());
  let read = false;
  for (let i = 0; i < 20; i++) {
    const view = await f.runtime.tick(f.parent.sessionId);
    if (!store.readProjection(f.parent)) {
      const root = view.tree.nodes.find(
        (n) => n.identity.kind === 'session' && n.identity.ref.sessionId === f.parent.sessionId
      );
      assert.equal(root.observation, null);
      assert.equal(root.lastObservation, null);
      if (f.runtime.collector.stats().recordsRead > 0) read = true;
    }
    await f.runtime.afterPaint(() => {});
    if (store.readProjection(f.parent)) break;
  }
  assert.equal(read, true);
  assert.ok(store.readProjection(f.parent));
});

test('B10C a source WAL change checks cheap heads instead of decoding every unchanged committed projection', async (t) => {
  const f = await publishFixture();
  t.after(f.cleanup);
  await settle(f);
  const source = f.runtime.port.sources.get(f.parent.sourceId),
    store = source.store;
  let heads = 0,
    projections = 0;
  const readHead = store.readHead.bind(store),
    readProjection = store.readProjection.bind(store);
  store.readHead = (...args) => {
    heads++;
    return readHead(...args);
  };
  store.readProjection = (...args) => {
    projections++;
    return readProjection(...args);
  };
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 10; i++) {
    await cycle(f);
    if (f.runtime.publicationStats().changed) break;
  }
  heads = projections = 0;
  await cycle(f);
  assert.equal(heads, 3);
  assert.equal(projections, 0);
});

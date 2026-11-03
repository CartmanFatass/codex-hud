import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { sourceFixture, runtimeRow } from './b10d-fixture.mjs';
import { hudProcess } from './b10d-process-fixture.mjs';
import { openObservationStore } from '../../dist/core/observation-store.js';

for (const [stage, name, committed] of [
  [4, 'before real SQLite COMMIT', false],
  [5, 'after real COMMIT before reader ACK', true],
  [6, 'after reader ACK before IPC', true],
  [7, 'after IPC before worker consumes transport ACK', true],
])
  test(`B10D owned process SIGKILL ${name} preserves the exact durable head and recoverable checkpoint`, async (t) => {
    const f = await sourceFixture();
    let owner, follower;
    let store;
    t.after(async () => {
      await Promise.allSettled([owner?.close(), follower?.close()]);
      store?.close();
      f.cleanup();
    });
    owner = await hudProcess(f, 'bar', true);
    await owner.rpc('warm');
    store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
    const before = store.readProjection(f.parent);
    await owner.rpc('fault', { code: stage });
    appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_failed' }, 4));
    let pending;
    for (let i = 0; i < 30; i++) {
      let finished = false;
      pending = owner.rpc('step').then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        }
      );
      for (let j = 0; j < 100; j++) {
        if ((await owner.rpc('stage')) === stage || finished) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      if ((await owner.rpc('stage')) === stage) break;
      await pending;
    }
    assert.equal(await owner.rpc('stage'), stage);
    await owner.kill();
    await pending;
    const after = store.readProjection(f.parent);
    assert.equal(after.commitSeq, before.commitSeq + (committed ? 1 : 0));
    assert.equal(after.notices.filter((n) => n.kind === 'failed').length, committed ? 1 : 0);
    const recovery = store.readRecovery(after, { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 });
    assert.ok(recovery && !('kind' in recovery));
    assert.equal(recovery.checkpoint.offset, after.checkpointIdentity.offset);
    follower = await hudProcess(f, 'panel');
    await follower.rpc('warm');
    const shown = (await follower.rpc('view')).tree.nodes.find(
      (n) => n.identity.kind === 'session' && n.identity.ref.sessionId === f.parent.sessionId
    );
    assert.deepEqual(shown.observation.statusProjection.observationStamp, after.observationStamp);
    assert.equal(
      store.readProjection(f.parent).commitSeq,
      after.commitSeq,
      'unexpired dead-owner lease is not transferred to the follower'
    );
  });

test('B10D concurrent owners remain exclusive, graceful release transfers ownership and SIGKILL takeover waits for real lease expiry', async (t) => {
  const f = await sourceFixture();
  let a, b;
  let store;
  t.after(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
    store?.close();
    f.cleanup();
  });
  a = await hudProcess(f, 'bar');
  await a.rpc('warm');
  store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  b = await hudProcess(f, 'panel');
  await b.rpc('warm');
  const initial = store.readLease(f.parent);
  assert.ok(initial);
  await Promise.all([a.rpc('step'), b.rpc('step')]);
  assert.equal(store.readLease(f.parent).holder, initial.holder);
  await a.close();
  for (let i = 0; i < 30; i++) {
    await b.rpc('step');
    if (store.readLease(f.parent) && store.readLease(f.parent).holder !== initial.holder) break;
  }
  const next = store.readLease(f.parent);
  assert.ok(
    next && next.holder !== initial.holder && next.generation > initial.generation,
    JSON.stringify({ initial, next, diag: await b.rpc('metrics') })
  );
  await b.kill();
  a = await hudProcess(f, 'bar');
  await a.rpc('warm');
  await a.rpc('step');
  assert.equal(store.readLease(f.parent).holder, next.holder);
  const waitMs = Math.max(0, next.expires_at - Date.now() + 10);
  await new Promise((r) => setTimeout(r, waitMs));
  for (let i = 0; i < 30; i++) {
    await a.rpc('step');
    if (store.readLease(f.parent)?.holder !== next.holder) break;
  }
  const final = store.readLease(f.parent);
  assert.ok(final.holder !== next.holder && final.generation > next.generation);
});

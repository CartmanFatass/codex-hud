import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import { publishFixture, cycle, settle } from './b10c-fixture.mjs';
import { runtimeRow } from './b10a-runtime-fixture.mjs';
import { openObservationStore } from '../../dist/core/observation-store.js';

async function processFor(t, f, entry) {
  const child = fork(new URL('./b10c-process.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, HUD_HOME: f.home },
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b));
  f.owned.push(child);
  let seq = 0;
  const pending = new Map(),
    points = new Map(),
    seen = new Set();
  child.on('exit', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('owned child exited'));
    }
    pending.clear();
    for (const item of points.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('owned child exited before cut'));
    }
    points.clear();
  });
  child.on('message', (message) => {
    if (message.point) {
      seen.add(message.point);
      const point = points.get(message.point);
      if (point) {
        clearTimeout(point.timer);
        points.delete(message.point);
        point.resolve();
      }
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error));
    else item.resolve(message);
  });
  const request = (body) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => reject(new Error(`child timeout ${entry}: ${stderr}`)), 20000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, ...body });
    });
  const point = (name) =>
    seen.has(name)
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`child did not reach ${name}: ${stderr}`)), 20000);
          points.set(name, { resolve, reject, timer });
        });
  await request({
    cmd: 'init',
    home: f.home,
    sourceRoot: f.file(f.parent.sessionId).split('/sessions/')[0],
    root: f.parent.sessionId,
    clockFile: join(f.home, 'clock'),
    entry,
  });
  return { child, request, point, stderr: () => stderr };
}
async function setup(t) {
  const f = await publishFixture();
  f.runtime.close();
  const owned = [];
  let store;
  t.after(async () => {
    for (const child of owned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    store?.close();
    f.cleanup();
  });
  const epoch = Date.now();
  writeFileSync(join(f.home, 'clock'), String(epoch));
  store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  return { ...f, store, epoch, owned };
}
test('B10C real bar and panel elect one publisher per full SessionRef; follower reads the original committed stamp', async (t) => {
  const f = await setup(t),
    bar = await processFor(t, f, 'bar'),
    panel = await processFor(t, f, 'panel');
  const [a, b] = await Promise.all([bar.request({ cmd: 'cycles', n: 30 }), panel.request({ cmd: 'cycles', n: 30 })]);
  for (const ref of [f.parent, ...f.targets]) {
    const projection = f.store.readProjection(ref),
      lease = f.store.readLease(ref);
    assert.ok(projection);
    assert.equal(projection.leaseGeneration, 1);
    assert.equal(lease.generation, 1);
  }
  const later = await panel.request({ cmd: 'cycles', n: 10 });
  assert.ok(later.details.every((d) => d.source === 'committed'));
  for (const d of later.details) assert.deepEqual(d.stamp, f.store.readProjection(d.stamp.ref).observationStamp);
  assert.ok(a.paints > 0 && b.paints > 0);
});
test('B10C SIGKILL holder takes over after lease expiry with atomic recovery and persistent continuity', async (t) => {
  const f = await setup(t),
    holder = await processFor(t, f, 'bar');
  await holder.request({ cmd: 'cycles', n: 30 });
  const before = f.store.readProjection(f.parent);
  holder.child.kill('SIGKILL');
  await once(holder.child, 'exit');
  const follower = await processFor(t, f, 'panel');
  await follower.request({ cmd: 'cycles', n: 10 });
  assert.equal(f.store.readLease(f.parent).generation, 1);
  writeFileSync(join(f.home, 'clock'), String(f.epoch + 16000));
  await follower.request({ cmd: 'cycles', n: 30 });
  const after = f.store.readProjection(f.parent);
  assert.equal(after.leaseGeneration, 2);
  assert.deepEqual(after.summary.statusProjection.observationStamp, after.observationStamp);
  assert.equal(after.checkpointIdentity.sourceGeneration, after.sourceGeneration);
  assert.equal(after.continuity.stateKey, before.continuity.stateKey);
  assert.equal(after.continuity.stateSince, before.continuity.stateSince);
  assert.equal(after.continuity.stateSinceBasis, before.continuity.stateSinceBasis);
});
test('B10C paused old-generation publication is fenced after a real competing process takeover', async (t) => {
  const f = await setup(t),
    old = await processFor(t, f, 'bar');
  await old.request({ cmd: 'cycles', n: 30 });
  await old.request({ cmd: 'cut', cut: { sessionId: f.parent.sessionId, point: 'before_publish' } });
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 2));
  const pending = old.request({ cmd: 'cycles', n: 20 });
  void pending.catch(() => {});
  await old.point('before_publish');
  writeFileSync(join(f.home, 'clock'), String(f.epoch + 16000));
  const next = await processFor(t, f, 'panel');
  await next.request({ cmd: 'cycles', n: 40 });
  const accepted = f.store.readProjection(f.parent);
  assert.equal(accepted.leaseGeneration, 2);
  old.child.kill('SIGCONT');
  const late = await pending;
  assert.equal(f.store.readProjection(f.parent).leaseGeneration, 2);
  assert.deepEqual(f.store.readProjection(f.parent).observationStamp, accepted.observationStamp);
  assert.ok(late.paints > 0);
  assert.ok(late.errors.includes('lease_fenced'));
});
for (const point of ['before_commit', 'after_commit'])
  test(`B10C real process SIGKILL ${point} exposes one complete old/new commit`, async (t) => {
    const f = await setup(t),
      holder = await processFor(t, f, 'bar');
    await holder.request({ cmd: 'cycles', n: 30 });
    const before = f.store.readProjection(f.parent);
    await holder.request({ cmd: 'cut', cut: { sessionId: f.parent.sessionId, point } });
    appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 3));
    const pending = holder.request({ cmd: 'cycles', n: 20 }).catch(() => {});
    await holder.point(point);
    holder.child.kill('SIGKILL');
    await once(holder.child, 'exit');
    const after = f.store.readProjection(f.parent);
    assert.equal(after.commitSeq, before.commitSeq + (point === 'after_commit' ? 1 : 0));
    assert.deepEqual(after.summary.statusProjection.observationStamp, after.observationStamp);
    assert.equal(after.checkpointIdentity.sourceGeneration, after.sourceGeneration);
    const recovery = f.store.readRecovery(after, { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 });
    assert.equal(recovery.checkpoint.offset, after.checkpointIdentity.offset);
    assert.equal(after.continuity.stateKey, after.summary.statusProjection.stateKey);
    // Settle the owned RPC timer before leaving the test.
    await pending;
  });

test('B10C former holder following after inode reset adopts the other process newer committed generation', async (t) => {
  const f = await setup(t),
    old = await processFor(t, f, 'bar');
  await old.request({ cmd: 'cycles', n: 30 });
  const original = f.store.readProjection(f.parent),
    file = f.file(f.parent.sessionId),
    replacement = file + '.replacement';
  const header = readFileSync(file, 'utf8').split('\n')[0];
  writeFileSync(replacement, header + '\n' + runtimeRow('event_msg', { type: 'task_started' }, 7));
  renameSync(replacement, file);
  writeFileSync(join(f.home, 'clock'), String(f.epoch + 16000));
  const next = await processFor(t, f, 'panel');
  await next.request({ cmd: 'cycles', n: 60 });
  const current = f.store.readProjection(f.parent);
  assert.equal(current.sourceGeneration, original.sourceGeneration + 1);
  const following = await old.request({ cmd: 'cycles', n: 60 });
  const root = following.details.find((d) => d.stamp?.ref.sessionId === f.parent.sessionId);
  assert.equal(root.source, 'committed');
  assert.deepEqual(root.stamp, current.observationStamp);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { r5Fixture } from '../fixtures/r5-jobs.js';
import { composeJobTree } from '../../src/collectors/job-tree.js';

test('R5 helper and QA discovery share the global entry/read budget across ticks', async (t) => {
  const f = r5Fixture(t),
    c = f.observer(),
    a = f.association(1);
  f.dispatch(a);
  for (let n = 1; n <= 64; n++) f.status(a, 'working', {}, `sonic-${n}`);
  for (let n = 1; n <= 512; n++) f.put(join(f.home, 'jobs', a.job, 'qa', `q${n}.md`), 'Synthetic bounded question');
  const before = diskSnapshot(f.home);
  let completed = false,
    maximumEntries = 0;
  for (let n = 0; n < 200; n++) {
    const snapshot = await c.refresh();
    await c.live.settled();
    assert.ok(snapshot.coverage.entries <= 128);
    assert.ok(snapshot.coverage.files <= 32);
    assert.ok(snapshot.coverage.bytes <= 1024 * 1024);
    maximumEntries = Math.max(maximumEntries, snapshot.coverage.entries);
    const tree = composeJobTree({ tree: f.emptyTree(), snapshot, root: 'synthetic/main', nowMs: f.now() }).tree;
    assert.ok(tree.totalCount <= 200);
    const job = snapshot.jobs[0];
    if (job?.helpers.length === 64 && job.requests?.length === 100) {
      completed = true;
      break;
    }
  }
  assert.ok(completed, '64 real helper STATUS files and 100 of 512 QA pointers observed incrementally');
  assert.equal(diskSnapshot(f.home), before);
  // Non-question entries consume discovery budget too, even when no file read is needed.
  fs.rmSync(join(f.home, 'jobs', a.job, 'qa'), { recursive: true });
  for (let n = 1; n <= 512; n++) f.put(join(f.home, 'jobs', a.job, 'qa', `noise-${n}`), 'Synthetic non-question');
  const capped = f.observer();
  for (let n = 0; n < 50; n++) {
    const snapshot = await capped.refresh();
    assert.ok(snapshot.coverage.entries <= 128);
    maximumEntries = Math.max(maximumEntries, snapshot.coverage.entries);
  }
  assert.equal(maximumEntries, 128, 'entry cap is exercised, not merely declared');
});
import { diskSnapshot } from '../fixtures/r5-job-bounds-perf.js';
import { JOB_BOUNDS } from '../../src/collectors/job-observations.js';

test('semantic residue: small association set exercises caps and fair continuation without deletion', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const count = JOB_BOUNDS.nodes + 1;
  for (let n = 1; n <= count; n++) f.association(n);
  const before = diskSnapshot(f.home),
    seen = new Set<string>();
  let peakEntries = 0,
    peakNodes = 0;
  for (let tick = 0; tick < 100 && seen.size < count; tick++) {
    const snapshot = await c.refresh();
    const tree = composeJobTree({ tree: f.emptyTree(), snapshot, root: 'synthetic/main', nowMs: f.now() }).tree;
    assert.ok(snapshot.coverage.entries <= JOB_BOUNDS.entries);
    assert.ok(snapshot.coverage.files <= JOB_BOUNDS.files);
    assert.ok(snapshot.coverage.bytes <= JOB_BOUNDS.bytes);
    assert.ok(tree.totalCount <= JOB_BOUNDS.nodes);
    peakEntries = Math.max(peakEntries, snapshot.coverage.entries);
    peakNodes = Math.max(peakNodes, tree.totalCount);
    for (const job of snapshot.jobs) seen.add(job.jobId);
  }
  assert.ok(peakEntries > 0);
  assert.ok(peakNodes > 0);
  assert.equal(seen.size, count);
  assert.equal(diskSnapshot(f.home), before);
});

test('semantic residue: closed history keeps 50 recent records and excludes a 31-day record without disk deletion', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  for (let n = 1; n <= 52; n++) {
    const a = f.association(n, {
      closed: true,
      closed_at: new Date(f.now() - (n === 1 ? 31 : 1) * 86400000).toISOString(),
    });
    f.receipt(a, { state: 'closed' });
  }
  const before = diskSnapshot(f.home);
  let snapshot = await c.refresh();
  for (let tick = 0; tick < 60; tick++) snapshot = await c.refresh();
  const result = composeJobTree({ tree: f.emptyTree(), snapshot, root: 'synthetic/main', nowMs: f.now() });
  assert.equal(result.tree.totalCount, 50);
  assert.ok(snapshot.jobs.every((j) => j.jobId !== 'j0000000000000001'));
  assert.equal(fs.readdirSync(join(f.home, 'assoc')).length, 52);
  assert.equal(diskSnapshot(f.home), before);
});

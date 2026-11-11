import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { r5Fixture } from '../fixtures/r5-jobs.js';
import { JOB_BOUNDS } from '../../src/collectors/job-observations.js';
import { composeJobTree } from '../../src/collectors/job-tree.js';
import { diskSnapshot } from '../fixtures/r5-job-bounds-perf.js';

test('R5 5000 associations: per-refresh caps, bounded projection, fair cursor continuation, no durable deletion', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  for (let n = 1; n <= 5000; n++) f.association(n);
  const before = diskSnapshot(f.home),
    seen = new Set<string>();
  let peakEntries = 0;
  for (let tick = 0; tick < 1600 && seen.size < 5000; tick++) {
    const snapshot = await c.refresh();
    const tree = composeJobTree({ tree: f.emptyTree(), snapshot, root: 'synthetic/main', nowMs: f.now() }).tree;
    assert.ok(snapshot.coverage.entries <= JOB_BOUNDS.entries);
    assert.ok(snapshot.coverage.files <= JOB_BOUNDS.files);
    assert.ok(snapshot.coverage.bytes <= JOB_BOUNDS.bytes);
    assert.ok(tree.totalCount <= JOB_BOUNDS.nodes);
    peakEntries = Math.max(peakEntries, snapshot.coverage.entries);
    for (const job of snapshot.jobs) seen.add(job.jobId);
  }
  assert.equal(seen.size, 5000, 'every metadata-only live job must get a turn, not just the first directory page');
  assert.ok(peakEntries > 0);
  assert.equal(diskSnapshot(f.home), before);
});

test('R5 closed display history prunes to 50 / 30 days, preserving all disk records', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  for (let n = 1; n <= 260; n++) {
    const a = f.association(n, {
      closed: true,
      closed_at: new Date(f.now() - (n <= 60 ? 31 : 1) * 86400000).toISOString(),
    });
    f.receipt(a, { state: 'closed' });
  }
  const before = diskSnapshot(f.home);
  let snapshot = await c.refresh();
  for (let n = 0; n < 300; n++) snapshot = await c.refresh();
  const result = composeJobTree({ tree: f.emptyTree(), snapshot, root: 'synthetic/main', nowMs: f.now() });
  assert.equal(result.tree.totalCount, 50);
  assert.ok(snapshot.jobs.every((j) => Number.parseInt(j.jobId.slice(1), 16) > 60));
  assert.equal(diskSnapshot(f.home), before);
  assert.equal(fs.readdirSync(join(f.home, 'assoc')).length, 260);
});

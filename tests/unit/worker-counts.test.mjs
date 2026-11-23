/** home-compact/06: Home's top line counts the workers each role has started since the panel opened, in memory only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { WorkerCounts } from '../../dist/panel/worker-counts.js';

const OPEN = Date.parse('2026-11-22T12:00:00Z'), MIN = 60_000;
const worker = (id, role, o = {}) => ({ id, role, startedAt: OPEN + MIN, settledAt: null, state: 'working', ...o });

test('every worker counts under its role whatever its state; a sonic child is sonic; a worker counts once', () => {
  const counts = new WorkerCounts(OPEN);
  const workers = [
    worker('a', 'imp'), worker('b', 'imp', { state: 'done', settledAt: OPEN + 2 * MIN }), worker('c', 'imp', { state: 'failed', settledAt: OPEN + 2 * MIN }),
    worker('d', 'frontend-imp'), worker('e', 'oracle'), worker('f', 'Reviewer'), worker('g', 'custom-role'),
    worker('h', 'sonic', { parentJobId: 'a' }), worker('i', 'imp', { parentJobId: 'a' }),
  ];
  counts.observe(workers);
  counts.observe(workers.slice(0, 4));
  assert.deepEqual(Object.fromEntries(counts.counts()), { imp: 3, 'frontend-imp': 1, oracle: 1, reviewer: 1, other: 1, sonic: 2 });
});

test('a worker that started before the panel opened, a queued one and a native agent are not counted; a queued one counts once it starts', () => {
  const counts = new WorkerCounts(OPEN);
  counts.observe([worker('old', 'imp', { startedAt: OPEN - 1 }), worker('queued', 'general', { startedAt: null, state: 'queued' }), worker('native', null)]);
  assert.equal(counts.counts().size, 0);
  counts.observe([worker('queued', 'general')]);
  assert.deepEqual(Object.fromEntries(counts.counts()), { general: 1 });
});

test('a finished worker stays counted after the board drops it; a restarted panel starts from zero', () => {
  const panel = new WorkerCounts(OPEN);
  panel.observe([worker('a', 'imp'), worker('b', 'sonic', { parentJobId: 'a' })]);
  panel.observe([]);
  assert.deepEqual(Object.fromEntries(panel.counts()), { imp: 1, sonic: 1 });
  assert.equal(new WorkerCounts(OPEN + 5 * MIN).counts().size, 0, 'the next panel knows nothing of them');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { batchView } from '../../dist/mcp/batch.js';
import { saveBatch, settleItem } from '../../dist/mcp/batch-state.js';

// Captured against the fixed-manifest runner, before moving policy into the engine.
test('batch view and notice wire text retain the fixed-manifest format', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'workflow-golden-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const flow = 'b0000000000000001', pane = 'sample', dir = join(home, 'flows', flow);
  fs.mkdirSync(dir, { recursive: true });
  const batch = { flow, pane, state: 'working', epoch: 0, settled: 0, failures: 0, streak: 0, notices: {},
    scale: { count: 3, role: 'sonic', cap: 4, max_parallel: 2, presets: ['sample'], input_bytes: { max: 7, median: 6, total: 18 } } };
  const items = [1, 2, 3].map(item => ({ item, job: `j${String(item).padStart(16, '0')}`, state: 'running', preset: 'sample', pilot: item === 1 }));
  settleItem(batch, items, items[0]);
  settleItem(batch, items, items[1], 'sample failure');
  settleItem(batch, items, items[2], 'sample failure');
  saveBatch(home, batch, items);
  batch.state = 'working'; batch.epoch++; delete batch.reason;
  saveBatch(home, batch, items);
  const actual = JSON.stringify({ notices: batch.notices, view: batchView(home, flow, pane) }, null, 2).replaceAll(home, '$HUD_HOME') + '\n';
  assert.equal(actual, fs.readFileSync(new URL('../fixtures/workflow-batch.golden.json', import.meta.url), 'utf8'));
});

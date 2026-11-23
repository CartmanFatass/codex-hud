import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../helpers/thin-mcp-harness.mjs';

test('the MCP entry, dispatch and worker modules resolve and share job receipts', async (t) => {
  const f = await fixture(t);
  const prior = process.env.HUD_HOME;
  process.env.HUD_HOME = f.env.HUD_HOME;
  t.after(() => {
    if (prior === undefined) delete process.env.HUD_HOME;
    else process.env.HUD_HOME = prior;
  });

  // Load the worker first to exercise its static dispatch import independently of the facade.
  assert.equal(typeof (await import('../../dist/worker/tools.js')).startSonic, 'function');
  const { dispatchJob } = await import('../../dist/mcp/dispatch/orchestrator.js');
  const { openRuntime } = await import('../../dist/mcp/mcp/server.js');
  const entry = await import('../../dist/mcp/thin-main.js');
  assert.equal(entry.dispatchJob, dispatchJob);
  assert.equal(entry.openRuntime, openRuntime);

  const created = await f.call('hud_create', { role: 'imp', task: 'Synthetic seam check.', request_key: 'module-round-trip' });
  assert.match(created.job, /^j[0-9a-f]{16}$/);
  assert.notEqual(created.ok, false);
  const { findJob, directory } = await import('../../dist/mcp/store/job-store.js');
  const receipt = findJob(created.job);
  assert.equal(receipt.role, 'imp');
  assert.equal(receipt.request_key, 'module-round-trip');
  assert.equal(directory(receipt.job), created.task_dir);
  const read = await f.call('hud_read', { job: created.job, mode: 'full' });
  assert.equal(read.job, receipt.job);
  assert.equal(read.role, receipt.role);
  assert.equal(read.report_exists, true);
  assert.equal(read.report, 'Synthetic implementation report.');
});

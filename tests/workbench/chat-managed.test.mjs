import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
test('exact bound managed run exchanges synthetic chat and rejects stale generation', async () => {
  const child = spawn(process.execPath, ['scripts/workbench/chat-demo.mjs'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '',
    err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  const result = await new Promise((r, j) => {
    child.on('error', j);
    child.on('close', (code, signal) => r({ code, signal }));
  });
  assert.equal(result.code, 0, err);
  const value = JSON.parse(out.trim());
  assert.equal(value.simulated, true);
  assert.equal(value.ownedRuns.length, 1);
  assert.equal(value.ownedRuns[0], value.runId);
  assert.equal(value.selection.runId, value.runId);
  assert.equal(value.dispatches, 1);
  assert.equal(value.staleRejected, true);
  assert.equal(value.ledgerRead, true);
  assert.equal(value.reply, 'SIMULATED reply: hello from the owner');
});

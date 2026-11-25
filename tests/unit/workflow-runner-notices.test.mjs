import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fixture, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

// Legacy-format seeds, including a live pilot. No worker is launched for either case.
test('runner error and stalled-pilot notices match the original detached host', { timeout: 12_000 }, async t => {
  const f = await fixture(t), home = f.env.HUD_HOME, flow = 'b0000000000000001', job = 'j0000000000000002';
  const dir = join(home, 'flows', flow), childDir = join(home, 'jobs', job);
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(childDir, { recursive: true });
  const write = (path, value) => writeFixtureFile(path, JSON.stringify(value));
  const view = () => JSON.parse(fs.readFileSync(dir+'.json', 'utf8'));
  const run = () => {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/workflow-runner.mjs'), flow], { cwd: f.root, env: f.env, stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    return once(child, 'exit');
  };
  const batch = { flow, pane: f.env.HERDR_PANE_ID, cwd: f.root, state: 'working', epoch: 0, streak: 0, settled: 0, failures: 0,
    notices: {}, totals: { waiting: 0, running: 1, done: 0, failed: 0 }, scale: { count: 1, role: 'sonic', max_parallel: 1 } };
  const items = [{ item: 1, state: 'running', pilot: true, job }];
  const seed = () => { write(join(dir,'index.json'), { batch, items }); write(dir+'.json', batch); };
  seed(); assert.deepEqual(await run(), [0,null]);
  const error = view().notices['error-0'].replaceAll(home,'$HUD_HOME');
  seed(); write(join(dir,'manifest.json'), { shared: {}, items: [] });
  write(join(childDir,'job.json'), { job, cwd: f.root, role: 'sonic', batch_flow: flow, created_at: new Date().toISOString() });
  write(join(childDir,'STATUS.json'), { state: 'working', blocked: true, reason: 'synthetic input needed' });
  const exit = run(); await until(() => view().notices['pause-0'], t.signal);
  const stall = view().notices['pause-0'];
  write(join(childDir,'STATUS.json'), { state: 'closed', output_written: false }); assert.deepEqual(await exit, [0,null]);
  const actual = JSON.stringify({ error, stall }, null, 2) + '\n';
  assert.equal(actual, fs.readFileSync(new URL('../fixtures/workflow-runner-notices.golden.json', import.meta.url), 'utf8'));
});

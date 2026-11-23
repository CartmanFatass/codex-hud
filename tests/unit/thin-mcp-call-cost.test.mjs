import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JobIndexCache } from '../../dist/roles/job-index-cache.js';

// Keep queued jobs frozen and readiness pending while exercising the real MCP call path.
test('MCP shares one receipt scan and global FIFO, and only wakes the watcher when needed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-call-cost-'));
  const prev = { HUD_HOME: process.env.HUD_HOME, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1' });
  const children = [];
  const spawn = cp.spawn;
  t.mock.method(cp, 'spawn', (file, args, ...rest) => {
    if (file !== process.execPath || !args.at(-1)?.endsWith('/hud-watch.mjs')) return spawn(file, args, ...rest);
    const child = Object.assign(new EventEmitter(), { unref() {} });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const { openRuntime } = await import('../../dist/mcp/thin-main.js');
  const runtime = openRuntime();
  await runtime.start();
  t.after(() => runtime.stop());
  const scans = t.mock.method(JobIndexCache.prototype, 'listJobIds');
  let id = 0;
  const rpc = (method, params) => runtime.request(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
  await rpc('initialize', { clientInfo: { name: 'hud-pi' } });
  const call = async (name, args = {}) => {
    const { result } = await rpc('tools/call', { name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  for (let i = 0; i < 5; i++) assert.deepEqual(await call('hud_read'), { jobs: [] });
  assert.equal(children.length, 0);
  assert.equal(scans.mock.callCount(), 5);

  const seed = (n, state, project = {}) => {
    const job = `j${String(n).padStart(16, '0')}`, dir = join(home, 'jobs', job);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, role: 'imp', cwd: process.cwd(), herdr_pane: 'w4E:p1',
      created_at: new Date(n * 1000).toISOString(), ...project }));
    writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state }));
    return job;
  };
  seed(1, 'closed');
  await call('hud_read');
  assert.equal(children.length, 0);
  seed(2, 'queued', { project_root: join(home, 'other-project') });
  const a = seed(3, 'queued'), b = seed(4, 'queued');
  scans.mock.resetCalls();
  const roster = await call('hud_roster');
  assert.equal(scans.mock.callCount(), 1);
  assert.ok(roster.changes.includes(`${a} imp: queued (#2)`));
  assert.ok(roster.changes.includes(`${b} imp: queued (#3)`));

  scans.mock.resetCalls();
  const [batch, list] = await Promise.all([call('hud_read', { jobs: [a, b] }), call('hud_read')]);
  assert.equal(children.length, 1, 'concurrent reads share the pending watcher launch');
  assert.equal(scans.mock.callCount(), 2);
  assert.deepEqual(batch.jobs.map(row => row.queue_position), [2, 3]);
  assert.deepEqual(list.jobs.map(row => row.queue_position), [3, 2]);
  children[0].emit('message', 'ready');
  await call('hud_read');
  assert.equal(children.length, 2, 'a ready watcher that removed its PID file does not block a new launch');
  children[0].emit('exit', 0);
  await call('hud_read');
  assert.equal(children.length, 2, 'the old watcher exiting does not clear the new launch');
  children[1].emit('exit', 1);
  await call('hud_read');
  assert.equal(children.length, 3, 'a failed launch can be retried');

  const answers = [5, 6, 7, 8].map(n => {
    const job = seed(n, 'working'), qa = join(home, 'jobs', job, 'qa');
    mkdirSync(qa);
    writeFileSync(join(qa, 'q1.md'), 'Synthetic question');
    return { job, request_id: 'q1', answer: 'Synthetic answer' };
  });
  scans.mock.resetCalls();
  const response = await call('hud_respond', { answers });
  assert.ok(response.answers.every(item => item.written));
  assert.equal(scans.mock.callCount(), 1, 'one call scan shared with the batch census');
  const summary = JSON.parse(readFileSync(join(home, 'display/work-summary.v1.json'), 'utf8'));
  assert.equal(summary.generation, 1, 'publish the final census, not intermediate answers');
  assert.equal(summary.global.asking, 0);
});

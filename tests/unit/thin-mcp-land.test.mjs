import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { landTask } from '../../dist/mcp/land.js';
import { takeLease } from '../../dist/roles/lease.js';
import { procStat } from '../../dist/utils/proc.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { entry, rpcClient, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { checkout, job, settle } from '../helpers/thin-mcp-land.mjs';

test('land queues for the checkout lease; watcher restart during the gate yields one tested push and one notice', async t => {
  const f = await checkout(t, ['test "$WRAPPED" = yes && test "$(tail -1 tracked)" = second', 'while test ! -f "$HOME/release"; do sleep .05; done']);
  assert.equal((await f.call('hud_lease', { name: 'main-checkout' })).granted, true);
  const { flow, state } = await f.call('hud_land', { job });
  assert.equal(state, 'queued');
  assert.equal((await f.call('hud_read', { job: flow })).step, 'main-checkout lease');
  assert.equal((await f.call('hud_land', { job })).flow, flow);
  assert.equal((await f.call('hud_lease', { name: 'main-checkout', release: true })).released, true);
  await until(() => f.flowState(flow).step.startsWith('gate[2]'), t.signal);
  // Run a fresh watcher against the same receipt while the helper owns the gate.
  const pidFile = join(f.home, 'watch.pid');
  if (fs.existsSync(pidFile)) { process.kill(Number(fs.readFileSync(pidFile)), 'SIGTERM'); await until(() => !fs.existsSync(pidFile), t.signal); }
  const watcher = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env: f.env, stdio: 'ignore' });
  const watcherExited = once(watcher, 'exit');
  f.onCleanup(() => stopChild(watcher, watcherExited, { killMs: 1000 }));
  await until(() => fs.existsSync(pidFile), t.signal);
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), t.signal);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.changes.filter(s => s.includes(flow)).length, 1);
  assert.equal(done.reruns, undefined);
  assert.equal(fs.readdirSync(join(f.home, 'flows')).some(name => name.endsWith('.log')), false);
  const again = await f.call('hud_land', { job });
  assert.equal(again.flow, flow); assert.equal(again.state, 'completed');
  assert.equal(again.changes?.some(s => s.includes(flow)) ?? false, false);
  assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/base'), done.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(done.tested_tree, f.git(f.main, 'rev-parse', 'base^{tree}'));
  assert.equal(done.published_tree, done.tested_tree);
  assert.equal(fs.readFileSync(join(f.main, 'after-ran'), 'utf8').trim(), f.main);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..base`), '2');
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
});

test('land resolves another project from the job, requires registration, and notifies the caller', async t => {
  const f = await checkout(t, ['test "$WRAPPED" = yes'], { crossProject: true });
  const registry = join(f.home, 'projects.json');
  f.git(f.root, 'init', '-qb', 'caller');
  fs.writeFileSync(registry, JSON.stringify({ version: 1, projects: [{ root: f.root }] }));
  const { result } = await f.rpc('tools/call', { name: 'hud_land', arguments: { job } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /hud_land requires a registered project/);

  fs.writeFileSync(registry, JSON.stringify({ version: 1, projects: [{ root: f.root }, { root: f.main }] }));
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.changes.filter(s => s.includes(flow)).length, 1);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.root, 'branch', '--show-current'), 'caller');
});

test('MCP reconnect polls a create and land, re-fences follow-ups, and preserves the terminal notices', { timeout: 60000 }, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done']);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const create = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic reconnect job.' });
  const worker = taskJob(f, create);
  const land = await taskCall(rpc, 'hud_land', { job });
  await until(() => f.flowState(land.taskId).step.startsWith('gate[1]'), t.signal);
  const dir = join(f.home, 'mcp-tasks');
  const receipt = ({ taskId }) => join(dir, fs.readdirSync(dir).find(name => name.startsWith(`${taskId}.`)));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const task of [create, land]) assert.equal(fs.statSync(receipt(task)).mode & 0o777, 0o600);
  const get = (client, { taskId }) => client('tasks/get', { taskId });
  async function reconnect(env = f.env) {
    const child = spawn(process.execPath, [entry], { cwd: f.root, env, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = once(child, 'exit');
    let stopping;
    const stop = () => stopping ??= stopChild(child, exited, { closeStdin: true, graceMs: 1500, killMs: 400 });
    f.onCleanup(stop);
    const client = taskRpc(rpcClient(child));
    await client('server/discover');
    return { client, stop };
  }
  assert.deepEqual((await f.stopMcp()).result, [0, null]);
  const other = await reconnect({ ...f.env, HERDR_PANE_ID: 'w4E:p9' });
  for (const task of [create, land]) assert.match((await get(other.client, task)).statusMessage, /Unknown or expired task/);
  await other.stop();

  const { client, stop } = await reconnect();
  const before = JSON.parse(fs.readFileSync(receipt(create), 'utf8'));
  const followUp = await taskCall(client, 'hud_send', { job: worker.job, text: 'Synthetic reconnect follow-up.' });
  assert.equal(followUp.resultType, 'complete', 'the existing task carries the follow-up even before its first poll');
  const after = JSON.parse(fs.readFileSync(receipt(create), 'utf8'));
  assert.notEqual(after.fence, before.fence);
  assert.ok(after.expiresAt > before.expiresAt);
  for (const task of [create, land]) {
    const working = await get(client, task);
    assert.equal(working.status, 'working');
    assert.equal(working.createdAt, task.createdAt);
    assert.equal(working.result, undefined);
    assert.match((await client('tasks/cancel', { taskId: task.taskId })).statusMessage, /Unknown or expired task/);
  }
  assert.equal(fs.existsSync(join(f.home, 'flows', `${land.taskId}.json.cancel`)), false);

  settle(f, worker.job, 'Synthetic settled pi report.\n');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(land.taskId).state === 'completed', t.signal);
  const createDone = await get(client, create);
  assert.equal(createDone.status, 'completed');
  assert.equal(createDone.result.content[0].text, `${worker.job} (imp) — closed\nReport: hud_read job=${worker.job} (mode: "full" for the whole report)\nSummary: Synthetic settled pi report.`);
  const landDone = await get(client, land);
  assert.deepEqual(landDone, { resultType: 'complete', ...landTask(f.home, f.flowState(land.taskId)) });
  assert.deepEqual(await get(client, create), createDone);
  assert.deepEqual(await get(client, land), landDone);
  assert.deepEqual((await stop()).result, [0, null]);

  // A terminal task retains its original result even after a report has changed.
  writeFixtureFile(join(worker.task_dir, 'report.md'), 'Synthetic replacement report.');
  const again = await reconnect();
  assert.deepEqual(await get(again.client, create), createDone);
  assert.deepEqual(await get(again.client, land), landDone);
  await again.stop();

  // A recently written but logically expired receipt is unknown; old receipts are swept on reconnect.
  writeFixtureFile(receipt(create), JSON.stringify({ ...after, expiresAt: Date.now() - 1 }));
  const old = new Date(Date.now() - land.ttlMs - 1000);
  fs.utimesSync(receipt(land), old, old);
  const expired = await reconnect();
  for (const task of [create, land]) assert.match((await get(expired.client, task)).statusMessage, /Unknown or expired task/);
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith(`${land.taskId}.`)), false);
  assert.equal(f.flowState(land.taskId).state, 'completed', 'the flow receipt is not swept with the task receipt');
});

test('hud_read names the land holding the lease and how long its gate step has run', async t => {
  const f = await checkout(t, ['true']);
  const holder = 'f0000000000000456', lease = { home: f.home, cwd: f.main, holder };
  assert.equal((await takeLease({ name: 'main-checkout', wait_s: 0 }, lease)).granted, true);
  fs.mkdirSync(join(f.home, 'flows'));
  fs.writeFileSync(join(f.home, 'flows', `${holder}.json`), JSON.stringify({
    state: 'running', step: 'gate[2]: npm test', pid: process.pid, start: procStat(process.pid).start,
    updated_at: new Date(Date.now() - 121000).toISOString(),
  }));
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('waiting for'), t.signal);
  const queued = await f.call('hud_read', { job: flow });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.step, `waiting for ${holder} (gate step 2, 2 min)`);
  await takeLease({ name: 'main-checkout', release: true }, lease);
  await until(() => f.flowState(flow).state === 'completed', 15000);
});

for (const scenario of ['dirty touched path', 'moved base on overlapping path']) test(`land refuses ${scenario} without publishing`, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done']);
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_land', { job });
  assert.equal(task.resultType, 'task'); assert.equal(task.status, 'working');
  await until(() => f.flowState(task.taskId).step.startsWith('gate[1]'), t.signal);
  if (scenario === 'moved base on overlapping path') {
    fs.appendFileSync(join(f.main, 'tracked'), 'main overlap\n');
    f.git(f.main, 'commit', '-qam', 'moved overlapping');
  } else fs.writeFileSync(join(f.main, 'tracked'), 'owner edit\n');
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(task.taskId).state === 'failed', t.signal);
  const done = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(done.status, 'failed');
  assert.match(done.result.content[0].text, /fast-forward/);
  assert.equal(f.flowState(task.taskId).repairs, undefined);
  assert.equal(f.flowState(task.taskId).replayed_onto, undefined);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(fs.existsSync(join(f.main, 'after-ran')), false);
  assert.equal(fs.existsSync(f.worktree), true);
  if (scenario === 'dirty touched path') {
    assert.equal(fs.readFileSync(join(f.main, 'tracked'), 'utf8'), 'owner edit\n');
    f.git(f.main, 'restore', 'tracked');
    const old = f.flowState(task.taskId), scratch = join(`${f.main}-wt`, `land-${task.taskId}`);
    fs.writeFileSync(join(scratch, 'test-output'), 'disposable');
    const launches = await Promise.all([taskCall(rpc, 'hud_land', { job }), taskCall(rpc, 'hud_land', { job })]);
    const flow = launches[0].taskId;
    assert.notEqual(flow, task.taskId);
    assert.equal(launches[1].taskId, flow);
    await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
    assert.equal(f.flowState(flow).state, 'completed', JSON.stringify(f.flowState(flow)));
    assert.equal((await rpc('tasks/get', { taskId: task.taskId })).status, 'failed');
    assert.deepEqual(f.flowState(task.taskId), old);
    assert.equal(fs.existsSync(scratch), false);
  }
});

test('a cancelled attempt can be retried with a new task and no stale cancel marker or scratch worktree', async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done']);
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: old } = await taskCall(rpc, 'hud_land', { job });
  await until(() => f.flowState(old).step.startsWith('gate[1]'), t.signal);
  await rpc('tasks/cancel', { taskId: old });
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(old).state === 'cancelled', t.signal);
  const scratch = join(`${f.main}-wt`, `land-${old}`);
  assert.equal(fs.existsSync(scratch), true);
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  assert.notEqual(flow, old);
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  assert.equal(f.flowState(flow).state, 'completed', JSON.stringify(f.flowState(flow)));
  assert.equal((await rpc('tasks/get', { taskId: old })).status, 'cancelled');
  assert.equal(fs.existsSync(scratch), false);
});

test('a failed after command does not retry an already landed flow', async t => {
  const f = await checkout(t, ['true']);
  const configFile = join(f.main, '.hud/project.json'), config = JSON.parse(fs.readFileSync(configFile));
  config.land.after = ['exit 7'];
  fs.writeFileSync(configFile, JSON.stringify(config));
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'failed', 15000);
  const landed = f.git(f.main, 'rev-parse', 'base');
  assert.notEqual(landed, f.base_head);
  const again = await f.call('hud_land', { job });
  assert.equal(again.flow, flow); assert.equal(again.landed_sha, landed);
});

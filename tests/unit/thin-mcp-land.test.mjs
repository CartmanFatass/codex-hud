import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { withDistLock } from '../../scripts/dist-lock.mjs';
import { entry, fixture, rpcClient, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { stopChild } from '../helpers/process-cleanup.mjs';

import { writeReportMeta, cachedReportSignature } from '../../dist/roles/report-meta.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { takeLease } from '../../dist/roles/lease.js';
import { procStat, isProcAlive } from '../../dist/utils/proc.js';
import { landTask } from '../../dist/mcp/land.js';

const job = 'j0000000000000123';
const jobDir = (f, id = job) => join(f.home, 'jobs', id);
function settle(f, id, text) {
  writeFixtureFile(join(jobDir(f, id), 'report.md'), text);
  writeFixtureFile(join(jobDir(f, id), 'STATUS.json'), JSON.stringify({ state: 'closed', settled_at: new Date().toISOString() }));
}
async function repair(f, flow, index) {
  await until(() => {
    const state = f.flowState(flow);
    assert.notEqual(state.state, 'failed', JSON.stringify(state));
    return state.repairs?.[index]?.outcome === 'waiting for worker';
  }, 20000);
  return f.flowState(flow).repairs[index].job;
}
async function checkout(t, gate, { after = ['test "$WRAPPED" = yes && pwd > after-ran'], timeout_s, mcpEntry } = {}) {
  const f = await fixture(t, { mcpEntry });
  const home = f.env.HUD_HOME, main = f.root, root = join(`${main}-wt`, 'sample-000123'), branch = 'wt/sample-000123';
  t.after(() => fs.rmSync(`${main}-wt`, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(main, 'init', '-qb', 'base');
  git(main, 'config', 'user.name', 'Synthetic'); git(main, 'config', 'user.email', 'sample@example.invalid');
  fs.mkdirSync(join(main, '.hud'));
  fs.writeFileSync(join(main, '.hud/project.json'), JSON.stringify({ worktree: { disposable: ['dist/**'] },
    land: { base: 'base', gate, after, push: true, wrapper: 'wrap', timeout_s } }));
  fs.writeFileSync(join(main, 'wrap'), '#!/bin/sh\nunset NODE_TEST_CONTEXT\nexport WRAPPED=yes\nexec "$@"\n', { mode: 0o700 });
  fs.writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: main }] }));
  fs.writeFileSync(join(main, '.gitignore'), 'dist/\n');
  fs.writeFileSync(join(main, 'tracked'), 'start\n');
  git(main, 'add', '.gitignore', '.hud', 'tracked', 'wrap'); git(main, 'commit', '-qm', 'start');
  const base_head = git(main, 'rev-parse', 'HEAD');
  const remote = join(main, 'remote.git');
  git(main, 'init', '--bare', '-q', remote); git(main, 'remote', 'add', 'origin', remote); git(main, 'push', '-q', 'origin', 'base');
  git(main, 'worktree', 'add', '-qb', branch, root, base_head);
  for (const text of ['first', 'second']) { fs.appendFileSync(join(root, 'tracked'), `${text}\n`); git(root, 'commit', '-qam', text); }
  fs.mkdirSync(join(root, 'dist')); fs.writeFileSync(join(root, 'dist/output'), 'ignored build output');
  const dir = join(home, 'jobs', job); fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, cwd: root, project_root: main, role: 'imp', herdr_pane: f.env.HERDR_PANE_ID,
    created_at: now, dispatch_exit_code: 0, worktree: { main_root: main, root, base_head, branch } }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: now }));
  const flowState = flow => JSON.parse(fs.readFileSync(join(home, 'flows', `${flow}.json`)));
  return { ...f, home, main, git, branch, worktree: root, remote, base_head, flowState };
}

test('land queues for the checkout lease; watcher restart during the gate yields one tested push and one notice', async t => {
  const f = await checkout(t, ['test "$WRAPPED" = yes && test "$(tail -1 tracked)" = second', 'while test ! -f "$HOME/release"; do sleep .05; done']);
  assert.equal((await f.call('hud_lease', { name: 'main-checkout' })).granted, true);
  const { flow, state } = await f.call('hud_land', { job });
  assert.equal(state, 'queued');
  assert.equal((await f.call('hud_read', { job: flow })).step, 'main-checkout lease');
  assert.equal((await f.call('hud_land', { job })).flow, flow);
  assert.equal((await f.call('hud_lease', { name: 'main-checkout', release: true })).released, true);
  await until(() => f.flowState(flow).step.startsWith('gate[2]'), 10000);
  // Run a fresh watcher against the same receipt while the helper owns the gate.
  const pidFile = join(f.home, 'watch.pid');
  if (fs.existsSync(pidFile)) { process.kill(Number(fs.readFileSync(pidFile)), 'SIGTERM'); await until(() => !fs.existsSync(pidFile)); }
  const watcher = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env: f.env, stdio: 'ignore' });
  const watcherExited = once(watcher, 'exit');
  f.onCleanup(() => stopChild(watcher, watcherExited, { killMs: 1000 }));
  await until(() => fs.existsSync(pidFile));
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 10000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.changes.filter(s => s.includes(flow)).length, 1);
  const again = await f.call('hud_land', { job });
  assert.equal(again.flow, flow); assert.equal(again.state, 'completed');
  assert.equal(again.changes?.some(s => s.includes(flow)) ?? false, false);
  assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/base'), done.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(fs.readFileSync(join(f.main, 'after-ran'), 'utf8').trim(), f.main);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..base`), '2');
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
});

test('MCP reconnect polls a create and land, re-fences follow-ups, and preserves the terminal notices', { timeout: 15000 }, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done']);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const create = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic reconnect job.' });
  const worker = taskJob(f, create);
  const land = await taskCall(rpc, 'hud_land', { job });
  await until(() => f.flowState(land.taskId).step.startsWith('gate[1]'));
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
  await until(() => f.flowState(land.taskId).state === 'completed');
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
  await until(() => f.flowState(flow).step.startsWith('waiting for'));
  const queued = await f.call('hud_read', { job: flow });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.step, `waiting for ${holder} (gate step 2, 2 min)`);
  await takeLease({ name: 'main-checkout', release: true }, lease);
  await until(() => f.flowState(flow).state === 'completed', 15000);
});

for (const kind of ['gate', 'after']) test(`land bounds a hung ${kind} and kills children holding the output pipes`, async t => {
  // In the gate case the shell itself exits successfully, but its child still holds the pipes.
  const hung = `seq 50; sleep 60 & echo $! > "$HOME/sleeper"; ${kind === 'gate' ? 'exit 0' : 'wait'}`;
  const f = await checkout(t, kind === 'gate' ? [hung] : ['true'], { timeout_s: 1, ...(kind === 'after' ? { after: [hung] } : {}) });
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'failed', 10000);
  const done = await f.call('hud_read', { job: flow });
  assert.ok(done.step.startsWith(`${kind}[1]:`));
  assert.equal(done.error, 'timeout');
  assert.deepEqual(done.tail, Array.from({ length: 40 }, (_, i) => String(i + 11)));
  assert.equal(done.repairs, undefined);
  assert.equal(done.reruns, undefined);
  const pid = Number(fs.readFileSync(join(f.env.HOME, 'sleeper'), 'utf8'));
  await until(() => !isProcAlive(pid));
  assert.equal((await f.call('hud_lease', { name: 'main-checkout', wait_s: 2 })).granted, true);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(!!done.landed_sha, kind === 'after');
});

for (const scenario of ['dirty touched path', 'moved base on overlapping path']) test(`land refuses ${scenario} without publishing`, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done']);
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_land', { job });
  assert.equal(task.resultType, 'task'); assert.equal(task.status, 'working');
  await until(() => f.flowState(task.taskId).step.startsWith('gate[1]'), 10000);
  if (scenario === 'moved base on overlapping path') {
    fs.appendFileSync(join(f.main, 'tracked'), 'main overlap\n');
    f.git(f.main, 'commit', '-qam', 'moved overlapping');
  } else fs.writeFileSync(join(f.main, 'tracked'), 'owner edit\n');
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(task.taskId).state === 'failed', 10000);
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
  await until(() => f.flowState(old).step.startsWith('gate[1]'), 10000);
  await rpc('tasks/cancel', { taskId: old });
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(old).state === 'cancelled', 10000);
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

for (const dirty of [false, true]) test(`land ${dirty ? 'refuses to push dirty landed paths' : 'pushes the advanced HEAD and cleans up'} after fast-forward`, async t => {
  const f = await checkout(t, ['true'], { after: ['while test ! -f "$HOME/release"; do sleep .05; done'] });
  const receipt = join(jobDir(f), 'job.json'), ticket = '.scratch/feature/issues/01-example.md';
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01' }));
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), '# 01: Example ticket\n**Status:** claimed\n\n## Comments\n');
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed records');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('after[1]'), 10000);
  const { landed_sha, tested_sha } = f.flowState(flow);
  assert.notEqual(landed_sha, tested_sha);
  assert.ok(f.git(f.main, 'show', `${landed_sha}:${ticket}`).includes(`Landed ${tested_sha}; gate 1/1`));
  const other = '.scratch/feature/issues/02-unrelated.md';
  fs.writeFileSync(join(f.main, other), '# 02: Unrelated ticket\n');
  f.git(f.main, 'add', other); f.git(f.main, 'commit', '-qm', 'claim unrelated ticket');
  const advanced = f.git(f.main, 'rev-parse', 'HEAD');
  if (dirty) fs.appendFileSync(join(f.main, 'tracked'), 'uncommitted owner edit\n');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 10000);
  const done = f.flowState(flow);
  assert.equal(done.state, dirty ? 'failed' : 'completed', JSON.stringify(done));
  assert.equal(done.step, dirty ? 'push' : 'done');
  assert.equal(done.landed_sha, landed_sha);
  assert.equal(done.records_sha, undefined);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), advanced);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD^'), landed_sha);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), dirty ? f.base_head : advanced);
  assert.equal(fs.existsSync(f.worktree), dirty);
});

test('land fast-forwards a rebased worker branch with only its own commits beyond the base tip', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.main, 'upstream'), 'new base\n');
  f.git(f.main, 'add', 'upstream'); f.git(f.main, 'commit', '-qm', 'advance base');
  const base = f.git(f.main, 'rev-parse', 'base');
  f.git(f.worktree, 'rebase', 'base');
  const source = f.git(f.worktree, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.landed_sha, source);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), source);
  assert.equal(f.git(f.main, 'log', '--reverse', '--format=%s', `${base}..base`), 'first\nsecond');
});

test('red gate continues the source in grace; its rebased fix passes on a fresh checkout', async t => {
  const f = await checkout(t, ['grep fixed tracked || { echo repair-needed; exit 1; }']);
  fs.writeFileSync(join(jobDir(f), 'SESSION.txt'), 'PRIMARY=source-agent\n');
  fs.writeFileSync(join(jobDir(f), 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  fs.writeFileSync(join(f.main, 'upstream'), 'new base');
  f.git(f.main, 'add', 'upstream'); f.git(f.main, 'commit', '-qm', 'advance base');
  const { flow } = await f.call('hud_land', { job });
  assert.equal(await repair(f, flow, 0), job);
  const prompt = f.commands().find(({ args }) => args[0] === 'agent' && args[1] === 'prompt').args.at(-1);
  assert.match(prompt, /Rebase onto the current base base/); assert.match(prompt, /gate\[1\][\s\S]*Log tail:\nrepair-needed/);
  f.git(f.worktree, 'rebase', 'base'); fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
  f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done)); assert.equal(done.repairs[0].outcome, 'gate passed');
  assert.equal(done.changes.length, 1); assert.match(done.changes[0], /Repair 1: .*gate passed/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
});

async function isolatedLand(t, gate) {
  // Publish to a private installation so the real dist and other test processes are untouched.
  const install = fs.mkdtempSync(join(tmpdir(), 'hud-land-build-'));
  for (const name of ['dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(install, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(install, 'node_modules'));
  const f = await checkout(t, gate, { mcpEntry: join(install, 'packages/hud-mcp/bin/hud-mcp.mjs') });
  t.after(() => fs.rmSync(install, { recursive: true, force: true }));
  const dist = join(install, 'dist');
  const publish = (files) => withDistLock(() => {
    for (const [name, content] of Object.entries(files)) {
      const file = join(dist, name);
      fs.writeFileSync(`${file}.next`, content);
      fs.renameSync(`${file}.next`, file);
    }
    const now = new Date(); fs.utimesSync(join(dist, 'index.js'), now, now);
  }, install);
  return { ...f, dist, publish };
}

test('land repairs using its original modules after dist is rebuilt during the gate', async t => {
  const f = await isolatedLand(t, ['while test ! -f "$HOME/release"; do sleep .05; done; grep fixed tracked']);
  fs.writeFileSync(join(jobDir(f), 'SESSION.txt'), 'PRIMARY=source-agent\n');
  fs.writeFileSync(join(jobDir(f), 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), 10000);
  // The old lazy repair path imported thin-main here, but abstract-lock was already cached.
  const read = (name) => fs.readFileSync(join(f.dist, name), 'utf8');
  await f.publish({
    'utils/abstract-lock.js': read('utils/abstract-lock.js') + '\nexport const newBuildOnly = true;\n',
    'mcp/thin-main.js': read('mcp/thin-main.js') + "\nimport { newBuildOnly } from '../utils/abstract-lock.js';\nif (!newBuildOnly) throw Error('mixed build');\n",
  });
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  assert.equal(await repair(f, flow, 0), job);
  fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
  f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  assert.equal(f.flowState(flow).state, 'completed', JSON.stringify(f.flowState(flow)));
  assert.equal(f.flowState(flow).repairs[0].outcome, 'gate passed');
});

test('a land helper that cannot import its build leaves a retryable flow', async t => {
  const f = await isolatedLand(t, ['true']);
  const entry = 'mcp/land-runner.js', original = fs.readFileSync(join(f.dist, entry), 'utf8');
  await f.publish({ [entry]: original + "\nimport { missingAfterBuild } from '../utils/abstract-lock.js';\n" });
  const { flow } = await f.call('hud_land', { job });
  const failed = await f.call('hud_read', { job: flow });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 'load land helper');
  assert.equal(failed.error, 'HUD was rebuilt; retry the land');
  assert.equal(f.git(f.main, 'rev-parse', 'base'), f.base_head);
  await f.publish({ [entry]: original });
  const retry = await f.call('hud_land', { job });
  assert.notEqual(retry.flow, flow);
  await until(() => ['failed', 'completed'].includes(f.flowState(retry.flow).state), 15000);
  assert.equal(f.flowState(retry.flow).state, 'completed', JSON.stringify(f.flowState(retry.flow)));
});

test('a red gate resumes the closed source session in its managed checkout', async t => {
  const f = await checkout(t, ['grep fixed tracked || { echo repair-needed; exit 1; }']);
  const dir = jobDir(f), file = join(f.env.PI_CODING_AGENT_DIR, 'synthetic.jsonl');
  const id = 'synthetic-land-session', now = new Date().toISOString();
  writeFixtureFile(file, JSON.stringify({ type: 'session', id, cwd: f.worktree }) + '\n');
  const jobFile = join(dir, 'job.json');
  const source = JSON.parse(fs.readFileSync(jobFile));
  writeFixtureFile(jobFile, JSON.stringify({ ...source, reaped_at: now, resume_s: 1620,
    place: { harness: 'pi', pi_role: 'implementer' } }));
  writeFixtureFile(join(dir, 'SESSION.txt'), 'TAB=w4E:t1\nLEFT=w4E:p1\nPRIMARY=source-agent\n');
  writeFixtureFile(join(dir, 'report.md'), 'Synthetic original report.');
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true,
    exit_reason: 'closed after declared report', settled_at: now, ended_at: now, session_id: id, session_file: file }));
  const { flow } = await f.call('hud_land', { job });
  assert.equal(await repair(f, flow, 0), job);
  const cmds = f.commands();
  assert.ok(cmds.find(({ args }) => args[0] === 'agent' && args[1] === 'start').args.includes(file));
  assert.ok(cmds.find(({ args }) => args[0] === 'tab' && args[1] === 'create').args.includes(f.worktree));
  const receipt = JSON.parse(fs.readFileSync(jobFile));
  assert.deepEqual(receipt.worktree, source.worktree);
  assert.equal(receipt.send_outcomes.at(-1).resumed, true);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'))).session_id, id);
  fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
  f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  await until(() => f.flowState(flow).state === 'completed', 15000);
  assert.equal(f.flowState(flow).repairs[0].outcome, 'gate passed');
});

test('a persistently red gate creates same-role repairs and hands back once after two', async t => {
  const f = await checkout(t, ['echo run >> "$HOME/count"; seq 50; exit 7']);
  // The role and the original context come from the registered main checkout, not the worker's copy.
  fs.mkdirSync(join(f.main, '.hud/roles'));
  fs.writeFileSync(join(f.main, '.hud/roles/builder.json'), JSON.stringify({ role: 'builder', can_continue: true,
    instructions: 'implementer', run: [{ harness: 'pi', pi_role: 'implementer' }] }));
  const source = join(jobDir(f), 'job.json');
  const original = JSON.parse(fs.readFileSync(source));
  fs.writeFileSync(source, JSON.stringify({ ...original, role: 'builder', context_files: [join(f.main, 'tracked')],
    create_options: { ...original.create_options, thinking: 'high' } }));
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  let prior = job;
  for (const i of [0, 1]) {
    const id = await repair(f, flow, i), dir = jobDir(f, id);
    const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
    assert.equal(receipt.role, 'builder'); assert.equal(receipt.retry_of, prior); assert.equal(receipt.cwd, f.worktree);
    assert.deepEqual(receipt.context_files, [join(f.main, 'tracked')]);
    assert.equal(receipt.thinking, 'high', 'land repair retains internal placement options');
    assert.match(fs.readFileSync(join(dir, 'brief.md'), 'utf8'), /Log tail:\n11\n[\s\S]*50/);
    settle(f, id, `Attempt ${i}.`); prior = id;
  }
  await until(() => f.flowState(flow).state === 'failed', 15000);
  const done = await rpc('tasks/get', { taskId: flow });
  assert.match(done.result.content[0].text, /gate\[1\].*exit 7\nRepair 1:[^\n]+\nRepair 2:[^\n]+\n11\n[\s\S]*50$/);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'count'), 'utf8'), 'run\n'.repeat(6));
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.base_head);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
});

test('cherry-pick conflict goes to the repair worker; even a quickly answered question stops the land', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.main, 'tracked'), 'conflict\n'); f.git(f.main, 'commit', '-qam', 'conflict');
  const { flow } = await f.call('hud_land', { job });
  const id = await repair(f, flow, 0), dir = jobDir(f, id);
  assert.match(fs.readFileSync(join(dir, 'brief.md'), 'utf8'), /cherry-pick[\s\S]*CONFLICT/);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'qa/q1.md'), 'Which version?'); fs.writeFileSync(join(dir, 'qa/q1.answer.md'), 'Keep both.');
  settle(f, id, 'Answered.');
  await until(() => f.flowState(flow).state === 'failed', 15000);
  const done = f.flowState(flow); assert.match(done.error, /needs the main session: q1/); assert.equal(done.repairs.length, 1);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
});

test('gate reruns only the failing step once and reports its recovery without dispatch', async t => {
  const f = await checkout(t, ['echo first >> "$HOME/count"', 'echo flaky >> "$HOME/count"; test -f "$HOME/once" || { touch "$HOME/once"; exit 1; }']);
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'completed', 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.repairs, undefined); assert.equal(done.reruns.length, 1);
  assert.match(done.changes.join('\n'), /gate\[2\].*passed on immediate rerun/);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'count'), 'utf8'), 'first\nflaky\nflaky\n');
});

test('gate reruns only the node:test files that failed and reports the flaky test names', async t => {
  const f = await checkout(t, ['npm run test:sample']);
  fs.writeFileSync(join(f.worktree, 'package.json'), JSON.stringify({ scripts: { 'test:sample': 'node --test -- sample/*.test.mjs' } }));
  fs.mkdirSync(join(f.worktree, 'sample'));
  for (const [file, names] of [['alpha.test.mjs', ['alpha recovers', 'another alpha recovers']], ["beta's test.test.mjs", ['beta recovers']], ['green.test.mjs', []]]) {
    fs.writeFileSync(join(f.worktree, 'sample', file), `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const marker = join(process.env.HOME, ${JSON.stringify(file)});
const seen = existsSync(marker);
appendFileSync(marker, 'run\\n');
for (const name of ${JSON.stringify(names)}) test(name, () => assert.ok(seen));
`);
  }
  f.git(f.worktree, 'add', 'sample', 'package.json'); f.git(f.worktree, 'commit', '-qm', 'add tests');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.repairs, undefined);
  assert.deepEqual(done.reruns[0].tests, [
    'alpha recovers (sample/alpha.test.mjs)', 'another alpha recovers (sample/alpha.test.mjs)', "beta recovers (sample/beta's test.test.mjs)",
  ]);
  assert.match(done.changes.join('\n'), /flaky tests: alpha recovers .*another alpha recovers .*beta recovers/);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'green.test.mjs'), 'utf8'), 'run\n');
  for (const file of ['alpha.test.mjs', "beta's test.test.mjs"])
    assert.equal(fs.readFileSync(join(f.env.HOME, file), 'utf8'), 'run\nrun\n');
});

test('gate reruns a timed-out test file once, not its passing neighbor', async t => {
  const f = await checkout(t, ['node --test --test-timeout=200 --test-force-exit -- *.test.mjs']);
  fs.writeFileSync(join(f.worktree, 'hung.test.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('times out on the first run', async () => {
  const marker = join(process.env.HOME, 'timeout-ran');
  if (existsSync(marker)) return;
  writeFileSync(marker, 'yes');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`);
  fs.writeFileSync(join(f.worktree, 'green.test.mjs'), `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('passing neighbor', () => appendFileSync(join(process.env.HOME, 'green-ran'), 'run\\n'));
`);
  f.git(f.worktree, 'add', 'hung.test.mjs', 'green.test.mjs'); f.git(f.worktree, 'commit', '-qm', 'add timed test');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.deepEqual(done.reruns[0].tests, ['times out on the first run (hung.test.mjs)']);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'green-ran'), 'utf8'), 'run\n');
});

for (const [label, ownerTryLine, expectedStatus] of [
  ['omitted', '', 'ready-for-human'],
  ['yes', '**Owner try:** yes\n', 'ready-for-human'],
  ['no', '**Owner try:** no\n', 'done'],
]) test(`land folds ${expectedStatus} and sha into one commit without STATE.md change (owner_try ${label})`, async t => {
  const f = await checkout(t, ['true']), dir = jobDir(f), ticket = '.scratch/feature/issues/01-example.md', file = join(dir, 'job.json');
  // Squash the worker branch to one commit so we verify one commit on main per landed slice.
  f.git(f.worktree, 'reset', '--soft', f.base_head);
  f.git(f.worktree, 'commit', '-qm', 'single slice commit');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Report'); writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  const initialState = '## Slices\n\n<!-- Row format -->\n\n- try · SAMPLE · SAMPLE-01 · Existing\n';
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), `# 01: Example ticket\n**Status:** ready-for-agent\n${ownerTryLine}- [ ] first\n- [ ] second\n\n## Comments\n- [ ] preserve me\n`);
  fs.writeFileSync(join(f.main, 'STATE.md'), initialState);
  f.git(f.main, 'add', ticket, 'STATE.md'); f.git(f.main, 'commit', '-qm', 'seed ticket and state');
  const beforeBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.main, 'owner'), 'unrelated staged edit'); f.git(f.main, 'add', 'owner');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow); assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.records_sha, undefined);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.remote, 'rev-list', '--count', `${beforeBase}..base`), '1');
  assert.equal(f.git(f.remote, 'log', '-1', '--format=%s', 'base'), 'single slice commit');
  assert.equal(f.git(f.main, 'diff', '--cached', '--name-only'), 'owner');
  assert.deepEqual(f.git(f.remote, 'diff', '--name-only', beforeBase, 'base').split('\n').sort(), [ticket, 'tracked']);
  const body = f.git(f.remote, 'show', `base:${ticket}`);
  assert.match(body, new RegExp(`\\*\\*Status:\\*\\* ${expectedStatus}\\n${ownerTryLine ? '\\*\\*Owner try:\\*\\* (?:yes|no)\\n' : ''}- \\[x\\] first\\n- \\[x\\] second[\\s\\S]*- \\[ \\] preserve me`));
  assert.ok(body.includes(`Landed ${done.tested_sha}; gate 1/1`));
  assert.equal(f.git(f.remote, 'show', 'base:STATE.md') + '\n', initialState);
});

test('land cleanup removes clean source worktree when picked patch differs from source commit', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.main, 'ticket.md'), 'status: open\n\nline 1\nline 2\nline 3\nitem: a\n');
  f.git(f.main, 'add', 'ticket.md'); f.git(f.main, 'commit', '-qm', 'add ticket');
  f.git(f.worktree, 'rebase', 'base');
  // Base advances the status line that the source commit also changes to the same value.
  fs.writeFileSync(join(f.main, 'ticket.md'), 'status: ready\n\nline 1\nline 2\nline 3\nitem: a\n');
  f.git(f.main, 'commit', '-qam', 'advance status on base');
  fs.writeFileSync(join(f.worktree, 'ticket.md'), 'status: ready\n\nline 1\nline 2\nline 3\nitem: b\n');
  f.git(f.worktree, 'commit', '-qam', 'update ticket and item');
  const sourceSha = f.git(f.worktree, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.step, 'done');
  assert.equal(done.error, undefined);
  assert.equal(done.cleanup_note, undefined);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.main, 'show', 'base:ticket.md'), 'status: ready\n\nline 1\nline 2\nline 3\nitem: b');
  assert.equal(f.git(f.main, 'rev-list', '--cherry-pick', '--right-only', '-1', `${done.landed_sha}...${sourceSha}`), sourceSha);
  assert.equal(fs.existsSync(f.worktree), false);
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
  const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json'), 'utf8'));
  assert.ok(receipt.worktree_removed_at);
  assert.equal(receipt.worktree_kept_reason, undefined);
});

test('a cleanup error after push completes as landed with a cleanup note, not failed', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.worktree, 'untracked-note.txt'), 'keep me\n');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.step, 'done');
  assert.equal(done.error, undefined);
  assert.match(done.cleanup_note ?? '', /dirty/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(done.changes.filter(s => s.includes(flow)).length, 1);
  assert.match(done.changes.find(s => s.includes(flow)) ?? '', new RegExp(`completed: done ${done.landed_sha} \\| Cleanup note: .*dirty`));
  assert.equal(fs.readFileSync(join(f.worktree, 'untracked-note.txt'), 'utf8'), 'keep me\n');
  assert.equal(f.git(f.main, 'branch', '--list', '--format=%(refname:short)', f.branch), f.branch);
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 3);
  const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json'), 'utf8'));
  assert.match(receipt.worktree_kept_reason ?? '', /dirty/);
  assert.equal((await f.call('hud_land', { job })).flow, flow);
});

test('land cleanup preserves commits added to the source worktree after landing and still reports completed with a note', async t => {
  const f = await checkout(t, ['true']);
  const configFile = join(f.main, '.hud/project.json'), config = JSON.parse(fs.readFileSync(configFile));
  config.land.after = [`echo extra > ${JSON.stringify(join(f.worktree, 'extra'))} && git -C ${JSON.stringify(f.worktree)} add extra && git -C ${JSON.stringify(f.worktree)} commit -qm extra`];
  fs.writeFileSync(configFile, JSON.stringify(config));
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  assert.equal(state.state, 'completed', JSON.stringify(state));
  assert.equal(state.error, undefined);
  assert.match(state.cleanup_note ?? '', /unmerged commits/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
  const done = await rpc('tasks/get', { taskId: flow });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, new RegExp(`completed: done ${state.landed_sha}\\nCleanup note: .*unmerged commits`));
  assert.equal(fs.existsSync(join(f.worktree, 'extra')), true);
  assert.equal(f.git(f.main, 'branch', '--list', '--format=%(refname:short)', f.branch), f.branch);
});

test('a main commit on unrelated paths including STATE.md during the gate replays tested commits and ticket update without rerunning the gate', async t => {
  const f = await checkout(t, ['echo run >> "$HOME/gate-count"; while test ! -f "$HOME/release"; do sleep .05; done']);
  const dir = jobDir(f), ticket = '.scratch/feature/issues/01-example.md', file = join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Report'); writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), '# 01: Example ticket\n**Status:** claimed\n- [ ] first\n\n## Comments\n');
  fs.writeFileSync(join(f.main, 'STATE.md'), '## Slices\n\n<!-- Row format -->\n\n- try · SAMPLE · SAMPLE-01 · Existing\n');
  f.git(f.main, 'add', ticket, 'STATE.md'); f.git(f.main, 'commit', '-qm', 'seed records');
  const beforeBase = f.git(f.main, 'rev-parse', 'HEAD');
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), 10000);
  // Commit an unrelated ticket and STATE.md milestone edit on main while the gate is running.
  fs.mkdirSync(join(f.main, '.scratch/other/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, '.scratch/other/issues/02-unrelated.md'), '# 02: Unrelated\n**Status:** claimed\n');
  fs.appendFileSync(join(f.main, 'STATE.md'), '\nMilestone boundary note\n');
  f.git(f.main, 'add', '.scratch/other/issues/02-unrelated.md', 'STATE.md'); f.git(f.main, 'commit', '-qm', 'unrelated ticket and state');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  assert.equal(state.state, 'completed', JSON.stringify(state));
  assert.equal(state.step, 'done');
  assert.equal(state.repairs, undefined);
  assert.equal(state.records_sha, undefined);
  assert.equal(state.replayed_onto, movedBase);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-count'), 'utf8'), 'run\n');
  const done = await rpc('tasks/get', { taskId: flow });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, new RegExp(`Replayed onto ${movedBase} \\(base moved from ${beforeBase}\\)`));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), state.landed_sha);
  assert.equal(f.git(f.remote, 'rev-list', '--count', `${movedBase}..base`), '2');
  assert.equal(f.git(f.main, 'merge-base', movedBase, state.landed_sha), movedBase);
  assert.match(f.git(f.remote, 'show', 'base:.scratch/other/issues/02-unrelated.md'), /Unrelated/);
  assert.ok(f.git(f.remote, 'show', `base:${ticket}`).includes(`Landed ${state.tested_sha}; gate 1/1`));
  assert.match(f.git(f.remote, 'show', 'base:STATE.md'), /Milestone boundary note/);
  assert.doesNotMatch(f.git(f.remote, 'show', 'base:STATE.md'), /FEATURE-01/);
  assert.equal(fs.readFileSync(join(f.main, 'after-ran'), 'utf8').trim(), f.main);
  assert.equal(fs.existsSync(f.worktree), false);
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
});

test('a main commit touching the landing ticket path during the gate stops before fast-forward', async t => {
  const f = await checkout(t, ['echo run >> "$HOME/gate-count"; while test ! -f "$HOME/release"; do sleep .05; done']);
  const dir = jobDir(f), ticket = '.scratch/feature/issues/01-example.md', file = join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Report'); writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), '# 01: Example ticket\n**Status:** ready-for-agent\n- [ ] first\n\n## Comments\n');
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed ticket');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), 10000);
  fs.appendFileSync(join(f.main, ticket), '- Concurrent ticket note\n');
  f.git(f.main, 'commit', '-qam', 'edit ticket during gate');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  assert.equal(state.state, 'failed', JSON.stringify(state));
  assert.equal(state.step, 'fast-forward');
  assert.equal(state.error, 'Main checkout is not at the recorded base tip');
  assert.equal(state.replayed_onto, undefined);
  assert.equal(state.landed_sha, undefined);
  assert.equal(state.repairs, undefined);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-count'), 'utf8'), 'run\n');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), movedBase);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(fs.existsSync(join(f.main, 'after-ran')), false);
  assert.equal(fs.existsSync(f.worktree), true);
});

test('flow receipt records per-step timings including separate gate reruns', async t => {
  const f = await checkout(t, ['true', 'test -f "$HOME/once" || { touch "$HOME/once"; exit 1; }']);
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'completed', 15000);
  const state = f.flowState(flow);
  const view = await f.call('hud_read', { job: flow });
  assert.deepEqual(view.timings, state.timings);
  const steps = state.timings.map(e => `${e.step}${e.rerun ? ':rerun' : ''}:${e.ok}`);
  assert.ok(steps.includes('create integration:true'), JSON.stringify(steps));
  assert.ok(steps.includes('gate[1]: true:true'), JSON.stringify(steps));
  assert.ok(steps.some(s => s.startsWith('gate[2]:') && s.endsWith(':false')), JSON.stringify(steps));
  assert.ok(steps.some(s => s.startsWith('gate[2]:') && s.endsWith(':rerun:true')), JSON.stringify(steps));
  assert.ok(steps.includes('records:true') && steps.includes('fast-forward:true') && steps.includes('push:true') && steps.includes('cleanup:true'));
  for (const entry of state.timings) {
    assert.equal(typeof entry.ms, 'number');
    assert.ok(Number.isInteger(entry.ms) && entry.ms >= 0);
  }
});

async function buildableCheckout(t, { gate = ['npm run build'], after = ['npm run build'] } = {}) {
  const f = await checkout(t, gate, { after });
  const put = (base, rel, body) => {
    const full = join(base, rel);
    fs.mkdirSync(join(full, '..'), { recursive: true });
    fs.writeFileSync(full, body);
  };
  put(f.main, '.gitignore', 'dist/\ndist-test/\n.tsbuild/\n.dist-stage-*/\n.dist-test-stage-*/\n');
  put(f.main, 'package.json', JSON.stringify({ type: 'module', scripts: { build: 'node scripts/build.mjs' } }));
  put(f.main, 'tsconfig.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', rootDir: 'src', types: [], declaration: true, sourceMap: true },
    include: ['src/**/*'],
  }));
  fs.mkdirSync(join(f.main, 'scripts'), { recursive: true });
  fs.copyFileSync(resolve('scripts/build.mjs'), join(f.main, 'scripts/build.mjs'));
  fs.copyFileSync(resolve('scripts/dist-lock.mjs'), join(f.main, 'scripts/dist-lock.mjs'));
  fs.mkdirSync(join(f.main, 'node_modules'), { recursive: true });
  fs.symlinkSync(resolve('node_modules/typescript'), join(f.main, 'node_modules/typescript'), 'dir');
  put(f.main, 'src/index.ts', 'export const index = 1;\n');
  put(f.main, 'src/tree-page.ts', 'export const page = 1;\n');
  put(f.main, 'src/mcp/thin-main.ts', 'export const version = 1;\n');
  put(f.main, '.hud/project.json', JSON.stringify({
    worktree: { disposable: ['dist/**', 'dist-test/**', '.tsbuild/**'] },
    land: { base: 'base', gate, after, push: true, wrapper: 'wrap' },
  }));
  f.git(f.main, 'add', '.gitignore', 'package.json', 'tsconfig.json', 'scripts', 'node_modules/typescript', 'src', '.hud/project.json');
  f.git(f.main, 'commit', '-qm', 'add buildable project');
  const seeded = f.git(f.main, 'rev-parse', 'HEAD');
  f.git(f.main, 'push', '-q', 'origin', 'base');
  f.git(f.worktree, 'rebase', 'base');
  put(f.worktree, 'src/mcp/thin-main.ts', 'export const version = 2;\n');
  f.git(f.worktree, 'commit', '-qam', 'bump version');
  return { ...f, seeded, put };
}

test('after npm run build is skipped via staged publish when inputs match, even with a folded ticket commit', async t => {
  const f = await buildableCheckout(t);
  const dir = jobDir(f), ticket = '.scratch/feature/issues/01-example.md', receipt = join(dir, 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01' }));
  f.put(f.main, ticket, '# 01: Example\n**Status:** ready-for-agent\n**Owner try:** no\n- [ ] done\n');
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed ticket');
  f.git(f.worktree, 'rebase', 'base');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 20000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.notEqual(done.landed_sha, done.tested_sha);
  const afterTiming = done.timings.find(e => e.step === 'after[1]: npm run build');
  assert.equal(afterTiming?.ok, true);
  assert.equal(afterTiming?.skipped, true);
  assert.match(fs.readFileSync(join(f.main, 'dist/mcp/thin-main.js'), 'utf8'), /version = 2/);
  // No compiler run occurred in main checkout because dist was published from the tested integration checkout.
  assert.equal(fs.existsSync(join(f.main, '.tsbuild')), false);
});

for (const reason of ['dirty main src', 'replayed base']) test(`after npm run build rebuilds when inputs do not match (${reason})`, async t => {
  const f = await buildableCheckout(t, {
    gate: reason === 'replayed base' ? ['npm run build', 'while test ! -f "$HOME/release"; do sleep .05; done'] : ['npm run build'],
  });
  if (reason === 'dirty main src') f.put(f.main, 'src/local-extra.ts', 'export const localExtra = true;\n');
  const { flow } = await f.call('hud_land', { job });
  if (reason === 'replayed base') {
    await until(() => f.flowState(flow).step.startsWith('gate[2]'), 15000);
    f.put(f.main, 'src/unrelated.ts', 'export const unrelated = 7;\n');
    f.git(f.main, 'add', 'src/unrelated.ts'); f.git(f.main, 'commit', '-qm', 'unrelated src on base');
    fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  }
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 20000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const afterTiming = done.timings.find(e => e.step === 'after[1]: npm run build');
  assert.equal(afterTiming?.ok, true);
  assert.equal(afterTiming?.skipped, undefined);
  assert.equal(fs.existsSync(join(f.main, '.tsbuild/main.tsbuildinfo')), true);
  assert.match(fs.readFileSync(join(f.main, 'dist/mcp/thin-main.js'), 'utf8'), /version = 2/);
  if (reason === 'dirty main src') {
    assert.match(fs.readFileSync(join(f.main, 'dist/local-extra.js'), 'utf8'), /localExtra = true/);
  } else {
    assert.match(fs.readFileSync(join(f.main, 'dist/unrelated.js'), 'utf8'), /unrelated = 7/);
  }
});

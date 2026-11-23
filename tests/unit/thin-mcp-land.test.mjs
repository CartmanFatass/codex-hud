import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { withDistLock } from '../../scripts/dist-lock.mjs';
import { entry, fixture, rpcClient, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';

import { writeReportMeta, cachedReportSignature } from '../../dist/roles/report-meta.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { takeLease } from '../../dist/roles/lease.js';
import { procStat, isProcAlive } from '../../dist/utils/proc.js';
import { landTask } from '../../dist/mcp/land.js';
import { LandOutput } from '../../dist/mcp/land-evidence.js';
import { landNotice } from '../../dist/mcp/land-state.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { landedNewest } from '../../dist/render/project-view.js';

const EMPTY_BOARD = { revision: 'synthetic', lanes: [], workers: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: '' } };
const job = 'j0000000000000123';
const jobDir = (f, id = job) => join(f.home, 'jobs', id);
function assertLandingRecord(f, ticket, replayBase, landed) {
  const body = f.git(f.main, 'show', `base:${ticket}`);
  const record = body.match(/^- Landed in this commit \(replay base ([0-9a-f]+)\); gate 1\/1 passed\.$/m);
  assert.ok(record, body);
  assert.equal(record[1], replayBase);
  assert.equal(f.git(f.main, 'log', '--first-parent', '--format=%H', '-S', record[0], `${record[1]}..base`, '--', ticket), landed);
}
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
async function checkout(t, gate, { after = ['test "$WRAPPED" = yes && pwd > after-ran'], timeout_s, mcpEntry, probe, crossProject = false } = {}) {
  const f = await fixture(t, { mcpEntry, probe });
  const home = f.env.HUD_HOME, main = crossProject ? join(f.root, 'project') : f.root;
  const root = join(`${main}-wt`, 'sample-000123'), branch = 'wt/sample-000123';
  if (crossProject) fs.mkdirSync(main);
  cleanupFixture(t, { root: `${main}-wt` });
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

async function trainCheckout(t, gate = 'true') {
  const f = await checkout(t, [`if test ! -f "$HOME/started"; then
    touch "$HOME/started"; while test ! -f "$HOME/release"; do sleep .05; done
  fi
  git rev-parse HEAD >> "$HOME/gate-heads"
  ${gate}`], { after: ['git rev-parse HEAD >> "$HOME/after-heads"'] });
  const log = file => fs.readFileSync(join(f.env.HOME, file), 'utf8').trim().split('\n');
  const rows = [];
  const add = (name, { ticket, conflict, start = f.base_head } = {}) => {
    const suffix = (0x345 - rows.length).toString(16).padStart(6, '0'), id = `j${suffix.padStart(16, '0')}`;
    const label = `train-${suffix}`, root = join(`${f.main}-wt`, label), branch = `wt/${label}`;
    f.git(f.main, 'worktree', 'add', '-qb', branch, root, start);
    fs.writeFileSync(join(root, name), `${name}\n`);
    f.git(root, 'add', name); f.git(root, 'commit', '-qm', name);
    if (conflict) {
      fs.writeFileSync(join(root, 'overlap'), `${name}\n`);
      f.git(root, 'commit', '-qam', `overlap ${name}`);
    }
    const dir = jobDir(f, id); fs.mkdirSync(dir, { recursive: true });
    const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json')));
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ ...receipt, job: id, cwd: root, ticket,
      worktree: { main_root: f.main, root, branch, base_head: start } }));
    settle(f, id, 'Synthetic result.');
    const row = { id, root, source: f.git(root, 'rev-parse', 'HEAD') }; rows.push(row);
    return row;
  };
  const start = async id => (await f.call('hud_land', { job: id })).flow;
  const release = async list => {
    const blocker = await start(job);
    await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
    const flows = [];
    for (const { id } of list) {
      const flow = await start(id);
      assert.equal(f.flowState(flow).state, 'queued');
      flows.push(flow);
    }
    fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
    return { blocker, flows };
  };
  const complete = async flows => {
    await until(() => flows.every(flow => ['completed', 'failed', 'cancelled'].includes(f.flowState(flow).state)), 15000);
    return flows.map(flow => {
      const row = f.flowState(flow); assert.equal(row.state, 'completed', JSON.stringify(row)); return row;
    });
  };
  return { ...f, add, start, release, complete, log };
}

test('land train gates and pushes two queued jobs once, with a ticket record and receipt per job', async t => {
  const f = await trainCheckout(t);
  const tickets = ['01', '02'].map(n => `.scratch/train/issues/${n}-sample.md`);
  fs.mkdirSync(join(f.main, '.scratch/train/issues'), { recursive: true });
  for (const [i, path] of tickets.entries())
    fs.writeFileSync(join(f.main, path), `# 0${i + 1}: Sample\n**Status:** ready-for-agent\n**Owner try:** no\n- [ ] Work\n\n## Comments\n`);
  f.git(f.main, 'add', '.scratch'); f.git(f.main, 'commit', '-qm', 'seed tickets');
  const jobs = ['alpha', 'beta'].map((name, i) => f.add(name, { ticket: `train/0${i + 1}` }));
  const { blocker, flows } = await f.release(jobs);
  const [first, ...rows] = await f.complete([blocker, ...flows]);
  const tip = f.git(f.remote, 'rev-parse', 'base');
  assert.deepEqual(f.log('gate-heads'), [first.landed_sha, tip]);
  assert.deepEqual(f.log('after-heads'), [first.landed_sha, tip]);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), tip);
  assert.equal(f.git(f.main, 'log', '--format=%s', '--reverse', `${first.landed_sha}..base`), 'alpha\nbeta');
  for (const [i, row] of rows.entries()) {
    assert.equal(row.train, flows[0]); assert.equal(row.job, jobs[i].id); assert.equal(row.source_sha, jobs[i].source);
    assert.equal(row.tested_sha, tip); assert.equal(row.published_sha, tip);
    assert.equal(row.tested_tree, f.git(f.remote, 'rev-parse', 'base^{tree}'));
    assert.equal(row.published_tree, row.tested_tree);
    assertLandingRecord(f, tickets[i], first.landed_sha, row.landed_sha);
    assert.equal(fs.existsSync(jobs[i].root), false);
    const view = await f.call('hud_land', { job: row.job });
    assert.equal(view.flow, flows[i]); assert.equal(view.train, flows[0]);
  }
  assert.equal(rows[1].landed_sha, tip);
  assert.equal(fs.readdirSync(join(f.home, 'flows')).filter(name => name.endsWith('.json')).length, 3);
});

test('land train rolls back every pick of the conflicting job, which repairs and lands alone', async t => {
  const f = await trainCheckout(t);
  fs.writeFileSync(join(f.main, 'overlap'), 'base\n');
  f.git(f.main, 'add', 'overlap'); f.git(f.main, 'commit', '-qm', 'seed overlap');
  const start = f.git(f.main, 'rev-parse', 'HEAD');
  const jobs = ['alpha', 'beta', 'gamma'].map(name => f.add(name, { start, conflict: name !== 'gamma' }));
  const { blocker, flows: [a, b, c] } = await f.release(jobs);
  const [first, alpha, gamma] = await f.complete([blocker, a, c]);
  const repairJob = await repair(f, b, 0);
  assert.match(fs.readFileSync(join(jobDir(f, repairJob), 'brief.md'), 'utf8'), /cherry-pick[\s\S]*CONFLICT/);
  assert.equal(alpha.train, a); assert.equal(gamma.train, a);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), gamma.landed_sha);
  assert.throws(() => f.git(f.remote, 'cat-file', '-e', 'base:beta')); // Even beta's first, clean pick was rolled back.
  assert.deepEqual(f.log('gate-heads'), [first.landed_sha, gamma.landed_sha]);
  const root = jobs[1].root;
  assert.throws(() => f.git(root, 'rebase', 'base'));
  fs.writeFileSync(join(root, 'overlap'), 'alpha and beta\n'); f.git(root, 'add', 'overlap');
  f.git(root, '-c', 'core.editor=true', 'rebase', '--continue');
  settle(f, repairJob, 'Synthetic conflict resolved.');
  const [beta] = await f.complete([b]);
  assert.equal(beta.train, undefined); assert.equal(beta.repairs[0].outcome, 'gate passed');
  assert.deepEqual(f.log('gate-heads'), [first.landed_sha, gamma.landed_sha, beta.tested_sha]);
  assert.equal(f.git(f.remote, 'show', 'base:overlap'), 'alpha and beta');
});

test('red land train falls back to single gates, without a train rerun or repair', async t => {
  const f = await trainCheckout(t, `if test -f alpha && test -f beta &&
    ! git cat-file -e base:alpha 2>/dev/null && ! git cat-file -e base:beta 2>/dev/null; then
    git rev-parse base >> "$HOME/rejected-on"; exit 7
  fi`);
  const { blocker, flows } = await f.release(['alpha', 'beta'].map(name => f.add(name)));
  const [first, ...rows] = await f.complete([blocker, ...flows]);
  const [initial, rejected, ...singles] = f.log('gate-heads');
  assert.equal(initial, first.landed_sha);
  assert.equal(singles.length, 2);
  assert.deepEqual(f.log('rejected-on'), [initial]);
  assert.equal(f.git(f.main, 'show', `${rejected}:alpha`), 'alpha');
  assert.equal(f.git(f.main, 'show', `${rejected}:beta`), 'beta');
  // The final single may independently create and gate the same commit as the rejected train.
  assert.deepEqual(new Set(singles), new Set(rows.map(row => row.landed_sha)));
  assert.deepEqual(f.log('after-heads'), [initial, ...singles]);
  const failedTrain = rows.flatMap(row => row.timings.filter(e => e.train));
  assert.equal(failedTrain.length, 1); assert.equal(failedTrain[0].ok, false);
  for (const row of rows) {
    assert.equal(row.train, undefined); assert.equal(row.reruns, undefined); assert.equal(row.repairs, undefined);
    assert.equal(row.tested_tree, row.published_tree);
  }
});

test('land train timings count one paid gate for a synthetic three-job queue instead of three', async t => {
  const f = await trainCheckout(t, 'sleep .15');
  const { flows } = await f.release(['alpha', 'beta', 'gamma'].map(name => f.add(name)));
  const batch = await f.complete(flows);
  const singles = [];
  for (const name of ['delta', 'epsilon', 'zeta']) {
    const { id } = f.add(name);
    singles.push(...await f.complete([await f.start(id)]));
  }
  const gateTimings = rows => rows.flatMap(row => row.timings?.filter(e => /^gate\[/.test(e.step)) ?? []);
  const shared = gateTimings(batch), solo = gateTimings(singles);
  assert.deepEqual(shared.map(e => e.train), [flows[0]]);
  assert.equal(solo.length, 3);
  assert.ok([...shared, ...solo].every(e => e.ok && e.ms >= 150));
  t.diagnostic(`Fake gate, 3 jobs: ${shared[0].ms} ms in 1 shared run; ${solo.reduce((ms, e) => ms + e.ms, 0)} ms in 3 single runs.`);
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

for (const kind of ['gate', 'after']) test(`land bounds a hung ${kind} and kills children holding the output pipes`, async t => {
  // In the gate case the shell itself exits successfully, but its child still holds the pipes.
  const hung = `seq 50; sleep 60 & echo $! > "$HOME/sleeper"; ${kind === 'gate' ? 'exit 0' : 'wait'}`;
  const f = await checkout(t, kind === 'gate' ? [hung] : ['true'], { timeout_s: 1, ...(kind === 'after' ? { after: [hung] } : {}) });
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'failed', t.signal);
  const done = await f.call('hud_read', { job: flow });
  assert.ok(done.step.startsWith(`${kind}[1]:`));
  assert.equal(done.error, 'timeout');
  assert.deepEqual(done.tail, Array.from({ length: 40 }, (_, i) => String(i + 11)));
  assert.equal(done.repairs, undefined);
  if (kind === 'gate') {
    assert.equal(done.reruns[0].rerun_ok, undefined);
    assert.equal(fs.readFileSync(done.reruns[0].output_path, 'utf8'), done.tail.join('\n'));
  } else assert.equal(done.reruns, undefined);
  const pid = Number(fs.readFileSync(join(f.env.HOME, 'sleeper'), 'utf8'));
  await until(() => !isProcAlive(pid), t.signal);
  assert.equal((await f.call('hud_lease', { name: 'main-checkout', wait_s: 2 })).granted, true);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(!!done.landed_sha, kind === 'after');
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

for (const dirty of [false, true]) test(`land ${dirty ? 'refuses to push dirty landed paths' : 'pushes only the approved commit'} after fast-forward`, async t => {
  const f = await checkout(t, ['true'], { after: ['while test ! -f "$HOME/release"; do sleep .05; done'] });
  const receipt = join(jobDir(f), 'job.json'), ticket = '.scratch/feature/issues/01-example.md';
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01' }));
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), '# 01: Example ticket\n**Status:** claimed\n\n## Comments\n');
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed records');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('after[1]'), t.signal);
  const { landed_sha, tested_sha, base_sha } = f.flowState(flow);
  assert.notEqual(landed_sha, tested_sha);
  fs.writeFileSync(join(f.main, 'unapproved'), 'unapproved code change\n');
  f.git(f.main, 'add', 'unapproved'); f.git(f.main, 'commit', '-qm', 'advance during after');
  const advanced = f.git(f.main, 'rev-parse', 'HEAD');
  if (dirty) fs.appendFileSync(join(f.main, 'tracked'), 'uncommitted owner edit\n');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, dirty ? 'failed' : 'completed', JSON.stringify(done));
  assert.equal(done.step, dirty ? 'push' : 'done');
  assert.equal(done.landed_sha, landed_sha);
  assert.equal(done.records_sha, undefined);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), advanced);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD^'), landed_sha);
  assertLandingRecord(f, ticket, base_sha, landed_sha);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), dirty ? f.base_head : landed_sha);
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

test('red gate continues the source in grace with clean assertion evidence; its rebased fix passes', async t => {
  const f = await checkout(t, [`grep fixed tracked || {
cat <<'TAP'
not ok 1 - sees the fix
  ---
  location: 'sample.test.mjs:1:1'
  error: |-
    synthetic assertion: expected fix
    首页 ?1  项目  控制
    synthetic panel row
    \x1b[32m   \x1b[0m
  code: 'ERR_ASSERTION'
  ...
TAP
seq 50
exit 1
}`]);
  fs.writeFileSync(join(jobDir(f), 'SESSION.txt'), 'PRIMARY=source-agent\n');
  fs.writeFileSync(join(jobDir(f), 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  fs.writeFileSync(join(f.main, 'upstream'), 'new base');
  f.git(f.main, 'add', 'upstream'); f.git(f.main, 'commit', '-qm', 'advance base');
  const { flow } = await f.call('hud_land', { job });
  assert.equal(await repair(f, flow, 0), job);
  const prompt = f.commands().find(({ args }) => args[0] === 'agent' && args[1] === 'prompt').args.at(-1);
  assert.match(prompt, /Rebase onto the current base base/);
  const evidence = prompt.split('Log tail:\n').at(-1).trimEnd();
  assert.match(evidence, /^not ok 1 - sees the fix[\s\S]*synthetic assertion: expected fix[\s\S]*ERR_ASSERTION/);
  assert.doesNotMatch(evidence, /^\s*$|synthetic panel row|首页|^50$/m);
  const [rerun] = f.flowState(flow).reruns;
  assert.deepEqual(rerun.tests, ['sees the fix (sample.test.mjs)']);
  for (const path of [rerun.output_path, rerun.rerun_output_path]) assert.equal(fs.readFileSync(path, 'utf8'), evidence);
  f.git(f.worktree, 'rebase', 'base'); fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
  f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done)); assert.equal(done.repairs[0].outcome, 'gate passed');
  assert.equal(done.changes.length, 1); assert.match(done.changes[0], /Repair 1: .*gate passed/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
});

for (const ask of [false, true]) test(`a CLI land repair ignores pre-turn attention and ${ask ? 'hands back its new question' : 'lands its fresh report'}`, async t => {
  const preload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const stat = fs.statSync;
fs.statSync = (path, ...args) => {
  if (String(path).endsWith('/${job}/STATUS.json') && new Error().stack.includes('at repairLand ')) {
    fs.appendFileSync(process.env.HOME + '/repair-polls', 'poll\\n');
  }
  return stat(path, ...args);
};
syncBuiltinESMExports();`;
  const f = await checkout(t, ['grep fixed tracked'], {
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`,
  });
  const dir = jobDir(f), jobFile = join(dir, 'job.json'), statusFile = join(dir, 'STATUS.json');
  writeFixtureFile(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile)),
    cli: { agent: 'claude', can_continue: true, idle_grace_s: 60 } }));
  writeFixtureFile(join(dir, 'SESSION.txt'), 'PRIMARY=source-agent\n');
  writeFixtureFile(join(dir, 'report.md'), 'Synthetic previous report.');
  const previous = new Date(Date.now() - 60000);
  writeFixtureFile(join(dir, 'turn.json'), JSON.stringify({ seq: 1, sent_at: previous.toISOString(), report_sig: null }));
  writeFixtureFile(statusFile, JSON.stringify({ state: 'idle_grace' }));
  // Admission sees a settled source. Hold back the new status so land's first poll sees an old attention row.
  writeFixtureFile(`${statusFile}.previous`, JSON.stringify({ state: 'waiting_orchestrator', blocked: true, updated_at: previous.toISOString() }));
  fs.utimesSync(`${statusFile}.previous`, previous, previous);
  f.overrideBin('herdr', `#!/bin/sh
set -e
if [ "$1 $2 $3" = 'agent prompt source-agent' ]; then
  status="$HUD_HOME/jobs/${job}/STATUS.json"
  mv "$status.previous" "$status"
fi
exec node "$FAKE_BIN" herdr "$@"
`);
  const { flow } = await f.call('hud_land', { job });
  assert.equal(await repair(f, flow, 0), job);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'turn.json'))).seq, 2);
  const polls = join(f.env.HOME, 'repair-polls');
  // Two polls prove the first one already ignored the unchanged pre-turn row.
  await until(() => fs.existsSync(polls) && fs.readFileSync(polls, 'utf8').startsWith('poll\npoll\n'), t.signal);
  assert.equal(f.flowState(flow).state, 'running', JSON.stringify(f.flowState(flow)));
  if (ask) {
    fs.mkdirSync(join(dir, 'qa'));
    writeFixtureFile(join(dir, 'qa/q1.md'), 'Which synthetic version?');
  } else {
    fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
    f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  }
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow);
  if (ask) {
    assert.equal(done.state, 'failed');
    assert.equal(done.error, `${job} needs the main session: q1`);
  } else {
    assert.equal(done.state, 'completed', JSON.stringify(done));
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  }
});

async function isolatedLand(t, gate) {
  // Publish to a private installation so the real dist and other test processes are untouched.
  const install = fs.mkdtempSync(join(tmpdir(), 'hud-land-build-'));
  let f;
  cleanupFixture(t, { root: install }, () => f?.stopMcp());
  for (const name of ['dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(install, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(install, 'node_modules'));
  f = await checkout(t, gate, { mcpEntry: join(install, 'packages/hud-mcp/bin/hud-mcp.mjs') });
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
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
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
  assert.match(done.result.content[0].text, /gate\[1\].*exit 7\nRepair 1:[^\n]+\nRepair 2:[^\n]+\ngate\[1\][\s\S]*\n11\n[\s\S]*50$/);
  const paths = f.flowState(flow).reruns.flatMap(({ rerun_ok, output_path, rerun_output_path }) => {
    assert.equal(rerun_ok, false);
    return [output_path, rerun_output_path];
  });
  assert.equal(paths.length, 6);
  assert.equal(new Set(paths).size, 6);
  for (const path of paths) assert.equal(fs.readFileSync(path, 'utf8'), Array.from({ length: 40 }, (_, i) => i + 11).join('\n'));
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

test('gate evidence drops panel frames and reserves the first assertion from each file', () => {
  const output = new LandOutput('/synthetic');
  const stream = output.stream();
  const panelRow = '\x1b[32m  ┃ synthetic panel card                \x1b[0m';
  const log = [
    'test at first.test.mjs:4:5', '✖ first check (1ms)', '  AssertionError: first assertion',
    '\x1b[32m   Home ?1  Project ?2  Control   models off  \x1b[0m',
    ...Array.from({ length: 900 }, () => [' '.repeat(80), panelRow]).flat(),
    ...Array.from({ length: 8 }, () => '      at ' + '✓'.repeat(700)),
    'test at first.test.mjs:8:5', '✖ another check (1ms)', '  AssertionError: another assertion',
    'test at second.test.mjs:2:5', '✖ second check (1ms)', '  AssertionError: second assertion',
    ...Array.from({ length: 60 }, (_, i) => `post-test output ${i}`),
  ];
  log.forEach(stream.line); stream.finish();
  const { excerpt, tail, tests } = output.evidence();
  assert.ok(Buffer.byteLength(excerpt) <= 8192);
  assert.ok(tail.length <= 40);
  assert.doesNotMatch(excerpt, /^\s*$|panel card|models off|post-test output|\uFFFD/m);
  for (const [name, assertion] of [['first check', 'first assertion'], ['another check', 'another assertion'], ['second check', 'second assertion']]) {
    assert.ok(excerpt.includes(`✖ ${name} (1ms)\n  AssertionError: ${assertion}`));
    assert.ok(tail.includes(`  AssertionError: ${assertion}`));
  }
  const step = 'gate[2]: npm run test:sample';
  const flow = { flow: 'f0000000000000123', job, state: 'failed', step: 'repair 1', error: 'worker stopped', tail,
    repairs: [{ step, outcome: 'worker stopped' }],
    reruns: [{ step, tests: [...tests, 'undisplayed fourth check'], output_path: 'sample.log', rerun_ok: false }] };
  const notice = landNotice(flow);
  const headline = /failed: gate\[2\]: npm run test:sample \(repair 1\).*failing tests: first check .*another check .*second check/;
  assert.match(notice.split('\n')[0], headline);
  assert.match(landTask('/synthetic', flow).statusMessage, headline);
  assert.doesNotMatch(notice, /undisplayed fourth check/);
});

test('gate reruns only the failing step once and reports its recovery without dispatch', async t => {
  const f = await checkout(t, ['echo first >> "$HOME/count"', `echo flaky >> "$HOME/count"; test -f "$HOME/once" || {
    touch "$HOME/once"; node -e 'console.log("✓".repeat(4000)); console.log("synthetic final line")'; exit 1;
  }`]);
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'completed', 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.repairs, undefined); assert.equal(done.reruns.length, 1);
  assert.match(done.changes.join('\n'), /gate\[2\].*passed on immediate rerun/);
  const excerpt = fs.readFileSync(done.reruns[0].output_path);
  assert.ok(excerpt.length <= 8192);
  assert.match(excerpt.toString('utf8'), /^✓+\nsynthetic final line$/);
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
for (const name of ${JSON.stringify(names)}) test(name, () => assert.ok(seen, 'synthetic assertion: ' + name));
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
  const { output_path: path, rerun_output_path } = done.reruns[0];
  const notice = done.changes.find(line => line.includes('flaky tests:'));
  assert.match(notice, /flaky tests: alpha recovers .*another alpha recovers .*beta recovers/);
  assert.ok(notice.includes(path));
  assert.equal(rerun_output_path, undefined);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  const excerpt = fs.readFileSync(path, 'utf8');
  assert.ok(path.startsWith(join(f.home, 'flows', `${flow}.json.`)));
  assert.match(excerpt, /^test at .*alpha\.test\.mjs:/);
  for (const name of ['alpha recovers', 'another alpha recovers', 'beta recovers'])
    assert.ok(excerpt.includes(`AssertionError [ERR_ASSERTION]: synthetic assertion: ${name}`));
  assert.doesNotMatch(excerpt, /ℹ tests|✖ failing tests:/);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'green.test.mjs'), 'utf8'), 'run\n');
  for (const file of ['alpha.test.mjs', "beta's test.test.mjs"])
    assert.equal(fs.readFileSync(join(f.env.HOME, file), 'utf8'), 'run\nrun\n');
  assert.equal((await f.call('hud_read', { job: flow })).reruns[0].output_path, path);
  fs.unlinkSync(join(f.home, 'flows', `${flow}.json`));
  assert.equal((await f.call('hud_read', { job: flow })).code, 'flow_not_found');
  assert.equal(fs.existsSync(path), false);
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
  ['omitted', '', 'done'],
  ['yes', '**Owner try:** yes\n', 'ready-for-human'],
  ['no', '**Owner try:** no\n', 'done'],
]) test(`land folds ${expectedStatus} and a resolvable record into one commit without STATE.md change (owner_try ${label})`, async t => {
  const f = await checkout(t, ['true']), dir = jobDir(f), ticket = '.scratch/feature/issues/01-example.md', file = join(dir, 'job.json');
  // Squash the worker branch to one commit so we verify one commit on main per landed slice.
  f.git(f.worktree, 'reset', '--soft', f.base_head);
  f.git(f.worktree, 'commit', '-qm', 'single slice commit');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Report'); writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  const initialState = '## Slices\n\n<!-- Row format -->\n\n- try · SAMPLE · SAMPLE-01 · Existing\n';
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), `# 01: Example ticket\n**Status:** ready-for-agent\n${ownerTryLine}**Blocked by:** none\n- [ ] first\n- [ ] second\n\n## Comments\n- [ ] preserve me\n`);
  fs.writeFileSync(join(f.main, '.scratch/feature/issues/02-legacy.md'),
    `# 02: Legacy ticket\n**Status:** ready-for-human\n**Blocked by:** none\n\n## Comments\n- Landed ${f.base_head.slice(0, 8)}; gate 1/1 passed.\n`);
  fs.writeFileSync(join(f.main, 'STATE.md'), initialState);
  f.git(f.main, 'add', '.scratch', 'STATE.md'); f.git(f.main, 'commit', '-qm', 'seed tickets and state');
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
  assert.match(body, new RegExp(`\\*\\*Status:\\*\\* ${expectedStatus}\\n${ownerTryLine ? '\\*\\*Owner try:\\*\\* (?:yes|no)\\n' : ''}\\*\\*Blocked by:\\*\\* none\\n- \\[x\\] first\\n- \\[x\\] second[\\s\\S]*- \\[ \\] preserve me`));
  assertLandingRecord(f, ticket, beforeBase, done.landed_sha);
  assert.equal(f.git(f.remote, 'show', 'base:STATE.md') + '\n', initialState);
  const project = await new ProjectCollector(f.main, f.home, f.env, f.env.HOME).collect(true, EMPTY_BOARD, Date.now());
  const latest = landedNewest(project).map(({ r }) => r);
  assert.equal(latest.find(r => r.id === 'FEATURE-01')?.commit, done.landed_sha);
  assert.equal(latest.find(r => r.id === 'FEATURE-01')?.state, expectedStatus === 'done' ? 'accepted' : 'try');
  assert.equal(latest.find(r => r.id === 'FEATURE-02')?.state, 'try');
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
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  // Commit an unrelated ticket and STATE.md milestone edit on main while the gate is running.
  fs.mkdirSync(join(f.main, '.scratch/other/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, '.scratch/other/issues/02-unrelated.md'), '# 02: Unrelated\n**Status:** claimed\n');
  fs.appendFileSync(join(f.main, 'STATE.md'), '\nMilestone boundary note\n');
  fs.mkdirSync(join(f.main, 'docs/handoff'), { recursive: true });
  fs.writeFileSync(join(f.main, 'docs/handoff/STATE.md'), 'Milestone handoff\n');
  f.git(f.main, 'add', '.scratch/other/issues/02-unrelated.md', 'STATE.md', 'docs/handoff/STATE.md');
  f.git(f.main, 'commit', '-qm', 'unrelated ticket and state');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  assert.equal(state.state, 'completed', JSON.stringify(state));
  assert.equal(state.step, 'done');
  assert.equal(state.repairs, undefined);
  assert.equal(state.records_sha, undefined);
  assert.equal(state.replayed_onto, movedBase);
  assert.equal(state.tested_tree, f.git(f.main, 'rev-parse', `${state.tested_sha}^{tree}`));
  assert.equal(state.published_tree, f.git(f.remote, 'rev-parse', 'base^{tree}'));
  assert.notEqual(state.tested_tree, state.published_tree);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-count'), 'utf8'), 'run\n');
  const done = await rpc('tasks/get', { taskId: flow });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, new RegExp(`Replayed onto ${movedBase} \\(base moved from ${beforeBase}\\)`));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), state.landed_sha);
  assert.equal(f.git(f.remote, 'rev-list', '--count', `${movedBase}..base`), '2');
  assert.equal(f.git(f.main, 'merge-base', movedBase, state.landed_sha), movedBase);
  assert.match(f.git(f.remote, 'show', 'base:.scratch/other/issues/02-unrelated.md'), /Unrelated/);
  assertLandingRecord(f, ticket, movedBase, state.landed_sha);
  assert.match(f.git(f.remote, 'show', 'base:STATE.md'), /Milestone boundary note/);
  assert.doesNotMatch(f.git(f.remote, 'show', 'base:STATE.md'), /FEATURE-01/);
  assert.equal(fs.readFileSync(join(f.main, 'after-ran'), 'utf8').trim(), f.main);
  assert.equal(fs.existsSync(f.worktree), false);
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
});

for (const green of [true, false]) test(`land re-gates disjoint code changes and ${green ? 'pushes the gated candidate' : 'stops when they break the gate'}`, async t => {
  const f = await checkout(t, ['git rev-parse HEAD >> "$HOME/gate-heads"; while test ! -f "$HOME/release"; do sleep .05; done; test "$(tail -1 tracked)" = "$(cat contract)"']);
  // The source's change to tracked depends on a contract in a different file.
  const receipt = join(jobDir(f), 'job.json'), ticket = '.scratch/feature/issues/01-example.md';
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01' }));
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), '# 01: Example ticket\n**Status:** claimed\n\n## Comments\n');
  fs.writeFileSync(join(f.main, 'contract'), 'second\n');
  f.git(f.main, 'add', 'contract', ticket); f.git(f.main, 'commit', '-qm', 'seed contract and ticket');
  const { flow } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'gate-heads')), t.signal);
  fs.writeFileSync(join(f.main, 'contract'), green ? 'second\n\n' : 'incompatible\n');
  f.git(f.main, 'commit', '-qam', 'change contract on base');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  const heads = fs.readFileSync(join(f.env.HOME, 'gate-heads'), 'utf8').trim().split('\n');
  const [initial, candidate] = heads;
  assert.notEqual(candidate, initial);
  assert.equal(state.published_tree, f.git(f.main, 'rev-parse', `${candidate}^{tree}`));
  if (green) {
    assert.equal(state.state, 'completed', JSON.stringify(state));
    assert.deepEqual(heads, [initial, candidate]);
    const view = await f.call('hud_read', { job: flow });
    assert.equal(view.base_moves, 1);
    assert.match(view.changes.find(line => line.includes(flow)), /Base moves absorbed: 1/);
    assert.equal(state.replayed_onto, movedBase);
    assert.equal(state.tested_tree, state.published_tree);
    assert.equal(state.landed_sha, candidate);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), candidate);
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), candidate);
    assertLandingRecord(f, ticket, movedBase, candidate);
  } else {
    assert.equal(state.state, 'failed', JSON.stringify(state));
    assert.match(state.step, /^gate\[1\]:/);
    assert.deepEqual(heads, [initial, candidate, candidate]); // One immediate retry of the failed command.
    assert.equal(state.tested_tree, f.git(f.main, 'rev-parse', `${initial}^{tree}`));
    assert.notEqual(state.tested_tree, state.published_tree);
    assert.equal(state.landed_sha, undefined);
    assert.equal(state.repairs, undefined);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), movedBase);
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  }
});

for (const moves of [2, 3]) test(`land ${moves === 2 ? 'absorbs another move during the replay gate' : 'stops at the base move limit'}`, { timeout: 30_000 }, async t => {
  const f = await checkout(t, [`run=1; while test -f "$HOME/gate-$run"; do run=$((run+1)); done
    git rev-parse HEAD > "$HOME/gate-$run"
    while test ! -f "$HOME/release-$run"; do sleep .05; done`]);
  const { flow } = await f.call('hud_land', { job });
  for (const run of [1, 2, 3]) {
    await until(() => fs.existsSync(join(f.env.HOME, `gate-${run}`)), t.signal);
    if (run <= moves) {
      fs.writeFileSync(join(f.main, `unrelated-${run}`), `Synthetic ${run}\n`);
      f.git(f.main, 'add', `unrelated-${run}`);
      f.git(f.main, 'commit', '-qm', `base move ${run}`);
    }
    fs.writeFileSync(join(f.env.HOME, `release-${run}`), 'go');
  }
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), t.signal);
  const state = f.flowState(flow);
  assert.equal(state.base_moves, 2);
  assert.equal(fs.existsSync(join(f.env.HOME, 'gate-4')), false);
  if (moves === 2) {
    assert.equal(state.state, 'completed', JSON.stringify(state));
    assert.equal(state.landed_sha, fs.readFileSync(join(f.env.HOME, 'gate-3'), 'utf8').trim());
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
    for (const n of [1, 2]) assert.equal(f.git(f.remote, 'show', `base:unrelated-${n}`), `Synthetic ${n}`);
  } else {
    assert.equal(state.state, 'failed', JSON.stringify(state));
    assert.match(state.error, /base move retry limit reached/);
    assert.equal(state.landed_sha, undefined);
    assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'base move 3');
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  }
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
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
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

async function buildableCheckout(t, { gate = ['npm run build'], after = ['npm run build'], native = false } = {}) {
  const f = await checkout(t, gate, { after });
  const put = (base, rel, body) => {
    const full = join(base, rel);
    fs.mkdirSync(join(full, '..'), { recursive: true });
    fs.writeFileSync(full, body);
  };
  put(f.main, '.gitignore', 'dist/\ndist-test/\n.tsbuild/\n.dist-stage-*/\n.dist-test-stage-*/\n');
  put(f.main, 'package.json', JSON.stringify({ type: 'module', scripts: { build: 'node scripts/build.mjs' } }));
  fs.copyFileSync(resolve('tsconfig.json'), join(f.main, 'tsconfig.json'));
  fs.mkdirSync(join(f.main, 'scripts'), { recursive: true });
  for (const name of ['build.mjs', 'build-native.mjs', 'dist-lock.mjs', 'dist-lock.d.mts']) {
    fs.copyFileSync(resolve('scripts', name), join(f.main, 'scripts', name));
  }
  fs.symlinkSync(resolve('node_modules'), join(f.main, 'node_modules'), 'dir');
  const binder = 'packages/hud-mcp/bin/agy-events.d.mts';
  put(f.main, binder, fs.readFileSync(resolve(binder)));
  put(f.main, 'src/index.ts', "export { buildStamp } from '../scripts/dist-lock.mjs';\nexport { hasAgyEvents } from '../packages/hud-mcp/bin/agy-events.mjs';\n");
  put(f.main, 'src/tree-page.ts', 'export const page = 1;\n');
  put(f.main, 'src/mcp/thin-main.ts', 'export const version = 1;\n');
  put(f.main, '.hud/project.json', JSON.stringify({
    worktree: { disposable: ['dist/**', 'dist-test/**', '.tsbuild/**'] },
    land: { base: 'base', gate, after, push: true, wrapper: 'wrap' },
  }));
  if (native) put(f.main, 'native/Cargo.toml', '# synthetic native sources\n');
  f.git(f.main, 'add', '.gitignore', 'package.json', 'tsconfig.json', 'scripts', 'packages', 'node_modules', 'src', '.hud/project.json',
    ...(native ? ['native'] : []));
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

for (const scenario of ['publish changed native', 'reuse tested native despite a TS rebuild', 'keep existing native', 'missing Cargo']) test(`land: ${scenario}`, {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async t => {
  const f = await buildableCheckout(t, {
    native: true,
    gate: scenario === 'keep existing native' ? ['npm run build', '/bin/rm -r dist/native'] : undefined,
    after: scenario === 'missing Cargo' ? ['npm run build', 'npm run build'] : undefined,
  });
  const tools = join(f.main, 'tools'), cargo = join(tools, 'cargo'), log = join(f.main, 'cargo.log');
  fs.mkdirSync(tools);
  fs.symlinkSync(process.execPath, join(tools, 'node'));
  fs.symlinkSync(execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim(), join(tools, 'npm'));
  fs.symlinkSync('/bin/sh', join(tools, 'sh'));
  fs.writeFileSync(join(f.main, 'wrap'), `#!/bin/sh
unset NODE_TEST_CONTEXT
export PATH="\${0%/*}/tools" HOME="$HOME/wrapped" CARGO_LOG="\${0%/*}/cargo.log"
exec "$@"
`);
  fs.writeFileSync(cargo, `#!/bin/sh
set -eu
# Simulate a rustup shim requiring the original toolchain homes under a wrapped HOME.
[ -n "$RUSTUP_HOME" ] && [ "$RUSTUP_HOME" != "$HOME/.rustup" ]
[ -n "$CARGO_HOME" ] && [ "$CARGO_HOME" != "$HOME/.cargo" ]
printf '%s\\n' "$1" >> "$CARGO_LOG"
[ "$1" != --version ] || exit 0
while [ "$1" != --target-dir ]; do shift; done
out=$2/x86_64-unknown-linux-gnu/release
/bin/mkdir -p "$out"
/bin/cp Cargo.toml "$out/hud-statusline"
`, { mode: 0o700 });
  const binary = join(f.main, 'dist/native/hud-statusline'), stamp = join(f.main, 'dist/native/source.sha256');
  let before;
  if (scenario === 'keep existing native' || scenario === 'missing Cargo') {
    execFileSync(join(f.main, 'wrap'), ['npm', 'run', 'build'], { cwd: f.main, env: {
      ...f.env, RUSTUP_HOME: join(f.env.HOME, '.rustup'), CARGO_HOME: join(f.env.HOME, '.cargo'),
    } });
    before = fs.statSync(binary).ino;
    fs.rmSync(join(f.main, '.tsbuild/native'), { recursive: true });
    fs.unlinkSync(cargo);
  }
  if (scenario !== 'keep existing native') {
    f.put(f.worktree, 'native/Cargo.toml', '# changed native sources\n');
    f.git(f.worktree, 'commit', '-qam', 'change native sources');
  }
  const rebuild = scenario === 'reuse tested native despite a TS rebuild';
  if (rebuild) f.put(f.main, 'src/local-extra.ts', 'export const localExtra = true;\n');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 20000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const after = done.timings.filter(e => e.step.startsWith('after['));
  assert.ok(after.length && after.every(e => e.ok && Boolean(e.skipped) === !rebuild), JSON.stringify(after));
  if (scenario === 'missing Cargo') {
    assert.equal(fs.existsSync(binary), false);
    assert.equal(fs.existsSync(stamp), false);
    const note = 'Cargo unavailable; the TS statusline stays in use.';
    assert.equal(done.after_note, note);
    const notice = done.changes.find(line => line.includes(flow));
    assert.equal(notice?.split(note).length, 2, notice);
  } else {
    const source = fs.readFileSync(join(f.main, 'native/Cargo.toml'));
    assert.deepEqual(fs.readFileSync(binary), source);
    const [sourceHash, binaryHash] = fs.readFileSync(stamp, 'utf8').split('\n');
    assert.match(sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(binaryHash, createHash('sha256').update(source).digest('hex'));
    assert.equal(fs.statSync(binary).mode & 0o111, 0o111);
    assert.equal(done.after_note, undefined);
    assert.equal(fs.readFileSync(log, 'utf8'), '--version\nbuild\n');
    if (before !== undefined) assert.equal(fs.statSync(binary).ino, before);
  }
});

for (const reason of ['dirty main src', 'dirty declaration', 'replayed base']) test(`after npm run build rebuilds when inputs do not match (${reason})`, async t => {
  const f = await buildableCheckout(t, {
    gate: reason === 'replayed base' ? ['npm run build', 'while test ! -f "$HOME/release"; do sleep .05; done'] : ['npm run build'],
  });
  if (reason === 'dirty main src') f.put(f.main, 'src/local-extra.ts', 'export const localExtra = true;\n');
  if (reason === 'dirty declaration') f.put(f.main, 'packages/hud-mcp/bin/agy-events.d.mts', 'export function hasAgyEvents(): false;\n');
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
  } else if (reason === 'replayed base') {
    assert.match(fs.readFileSync(join(f.main, 'dist/unrelated.js'), 'utf8'), /unrelated = 7/);
  }
});

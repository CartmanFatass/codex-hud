import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fixture, taskCall, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';

const job = 'j0000000000000123';
async function checkout(t, gate) {
  const f = await fixture(t);
  const home = f.env.HUD_HOME, main = f.root, root = join(`${main}-wt`, 'sample-000123'), branch = 'wt/sample-000123';
  t.after(() => fs.rmSync(`${main}-wt`, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(main, 'init', '-qb', 'base');
  git(main, 'config', 'user.name', 'Synthetic'); git(main, 'config', 'user.email', 'sample@example.invalid');
  fs.mkdirSync(join(main, '.hud'));
  fs.writeFileSync(join(main, '.hud/project.json'), JSON.stringify({ worktree: { disposable: ['dist/**'] },
    land: { base: 'base', gate, after: ['test "$WRAPPED" = yes && pwd > after-ran'], push: true, wrapper: 'wrap' } }));
  fs.writeFileSync(join(main, 'wrap'), '#!/bin/sh\nexport WRAPPED=yes\nexec "$@"\n', { mode: 0o700 });
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
  assert.equal((await f.call('hud_lease', { name: 'main-checkout', release: true })).released, true);
  await until(() => f.flowState(flow).step.startsWith('gate[2]'), 10000);
  // Run a fresh watcher against the same receipt while the helper owns the gate.
  const pidFile = join(f.home, 'watch.pid');
  if (fs.existsSync(pidFile)) { process.kill(Number(fs.readFileSync(pidFile)), 'SIGTERM'); await until(() => !fs.existsSync(pidFile)); }
  const watcher = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env: f.env, stdio: 'ignore' });
  t.after(() => watcher.kill());
  await until(() => fs.existsSync(pidFile));
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 10000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.changes.filter(s => s.includes(flow)).length, 1);
  assert.equal((await f.call('hud_land', { job })).changes?.some(s => s.includes(flow)) ?? false, false);
  assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/base'), done.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(fs.readFileSync(join(f.main, 'after-ran'), 'utf8').trim(), f.main);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..base`), '2');
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
});

for (const scenario of ['red gate', 'conflict', 'dirty touched path', 'moved base']) test(`land refuses ${scenario} without publishing`, async t => {
  const f = await checkout(t, [scenario === 'red gate' ? 'seq 50; exit 7' : 'while test ! -f "$HOME/release"; do sleep .05; done']);
  if (scenario === 'conflict') { fs.writeFileSync(join(f.main, 'tracked'), 'conflict\n'); f.git(f.main, 'commit', '-qam', 'conflict'); }
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_land', { job });
  assert.equal(task.resultType, 'task'); assert.equal(task.status, 'working');
  if (scenario !== 'conflict' && scenario !== 'red gate') {
    await until(() => f.flowState(task.taskId).step.startsWith('gate[1]'), 10000);
    if (scenario === 'moved base') f.git(f.main, 'commit', '--allow-empty', '-qm', 'moved');
    else fs.writeFileSync(join(f.main, 'tracked'), 'owner edit\n');
  }
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(task.taskId).state === 'failed', 10000);
  const done = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(done.status, 'failed');
  assert.match(done.result.content[0].text, scenario === 'red gate' ? /gate\[1\].*exit 7\n11\n[\s\S]*50$/ : scenario === 'conflict' ? /cherry-pick/ : /fast-forward/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(fs.existsSync(join(f.main, 'after-ran')), false);
  assert.equal(fs.existsSync(f.worktree), true);
  if (scenario === 'dirty touched path') assert.equal(fs.readFileSync(join(f.main, 'tracked'), 'utf8'), 'owner edit\n');
});

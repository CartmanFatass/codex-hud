import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fixture, taskCall, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';

import { writeReportMeta, cachedReportSignature } from '../../dist/roles/report-meta.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

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

for (const scenario of ['dirty touched path', 'moved base']) test(`land refuses ${scenario} without publishing`, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done']);
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_land', { job });
  assert.equal(task.resultType, 'task'); assert.equal(task.status, 'working');
  await until(() => f.flowState(task.taskId).step.startsWith('gate[1]'), 10000);
  if (scenario === 'moved base') f.git(f.main, 'commit', '--allow-empty', '-qm', 'moved');
  else fs.writeFileSync(join(f.main, 'tracked'), 'owner edit\n');
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(task.taskId).state === 'failed', 10000);
  const done = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(done.status, 'failed');
  assert.match(done.result.content[0].text, /fast-forward/);
  assert.equal(f.flowState(task.taskId).repairs, undefined);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(fs.existsSync(join(f.main, 'after-ran')), false);
  assert.equal(fs.existsSync(f.worktree), true);
  if (scenario === 'dirty touched path') assert.equal(fs.readFileSync(join(f.main, 'tracked'), 'utf8'), 'owner edit\n');
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
  await until(() => f.flowState(flow).state !== 'running', 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done)); assert.equal(done.repairs[0].outcome, 'gate passed');
  assert.equal(done.changes.length, 1); assert.match(done.changes[0], /Repair 1: .*gate passed/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
});

test('a persistently red gate creates same-role repairs and hands back once after two', async t => {
  const f = await checkout(t, ['echo run >> "$HOME/count"; seq 50; exit 7']);
  // The role and the original context come from the registered main checkout, not the worker's copy.
  fs.mkdirSync(join(f.main, '.hud/roles'));
  fs.writeFileSync(join(f.main, '.hud/roles/builder.json'), JSON.stringify({ role: 'builder', can_continue: true,
    instructions: 'implementer', run: [{ harness: 'pi', pi_role: 'implementer' }] }));
  const source = join(jobDir(f), 'job.json');
  fs.writeFileSync(source, JSON.stringify({ ...JSON.parse(fs.readFileSync(source)), role: 'builder', context_files: [join(f.main, 'tracked')] }));
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  let prior = job;
  for (const i of [0, 1]) {
    const id = await repair(f, flow, i), dir = jobDir(f, id);
    const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
    assert.equal(receipt.role, 'builder'); assert.equal(receipt.retry_of, prior); assert.equal(receipt.cwd, f.worktree);
    assert.deepEqual(receipt.context_files, [join(f.main, 'tracked')]);
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

for (const stale of [false, true]) test(`land pushes scoped records (${stale ? 'stale' : 'bound'} summary)`, async t => {
  const f = await checkout(t, ['true']), dir = jobDir(f), ticket = '.scratch/feature/issues/01-example.md', file = join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Report'); writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  if (stale) fs.appendFileSync(join(dir, 'report.md'), ' superseded');
  fs.mkdirSync(join(f.main, '.scratch/feature/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, ticket), '# Example\n**Status:** claimed\n- [ ] first\n- [ ] second\n\n## Comments\n- [ ] preserve me\n');
  fs.writeFileSync(join(f.main, 'STATE.md'), '## Slices\n\n<!-- Row format -->\n\n- try · SAMPLE · SAMPLE-01 · Existing\n');
  f.git(f.main, 'add', ticket, 'STATE.md'); f.git(f.main, 'commit', '-qm', 'ledger');
  fs.writeFileSync(join(f.main, 'owner'), 'unrelated staged edit'); f.git(f.main, 'add', 'owner');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow); assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.records_sha);
  assert.equal(f.git(f.remote, 'rev-parse', 'base^'), done.landed_sha);
  assert.equal(f.git(f.main, 'diff', '--cached', '--name-only'), 'owner');
  assert.deepEqual(f.git(f.remote, 'diff', '--name-only', 'base^', 'base').split('\n'), stale ? [ticket] : [ticket, 'STATE.md']);
  assert.match(f.git(f.remote, 'show', `base:${ticket}`), /ready-for-human\n- \[x\] first\n- \[x\] second[\s\S]*- \[ \] preserve me/);
  assert.ok(f.git(f.remote, 'show', `base:${ticket}`).includes(`Landed ${done.landed_sha}; gate 1/1`));
  assert.equal(f.git(f.remote, 'show', 'base:STATE.md').includes(`- try · FEATURE · FEATURE-01 · Synthetic change. (${done.landed_sha})\n- try · SAMPLE`), !stale);
});

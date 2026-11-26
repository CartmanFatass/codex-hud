import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { panelDelivery } from '../../dist/mcp/panel-delivery.js';
import { taskNoticeSource } from '../../dist/workflows/events.js';
import { saveHeader } from '../../dist/workflows/store.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { enableOptionalRoles, fixture, sonicTask, until } from '../helpers/thin-mcp-harness.mjs';
import { setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';
import { writeFixtureFile as put } from '../helpers/thin-mcp-files.mjs';

const call = (f, op, args) => f.call('hud_workflow', { op, ...args });
const start = (f, { run, hash }) => call(f, 'start', { run, hash, confirm: true });
const graph = steps => ({ name: 'synthetic-recipe', version: 1, steps });
const task = { kind: 'job', role: 'sonic', task: 'Read synthetic inputs' };
const batch = (role, n, task = 'Read synthetic input') => ({ kind: 'batch', role, items: Array.from({ length: n }, () => ({ task })) });
const reply = (f, job, answer, request_id = 'h-accept') => f.call('hud_respond', { job, request_id, answer });
const sample = graph({
  build: { kind: 'job', role: 'imp', isolation: 'worktree', task: 'Build synthetic feature' },
  verify: { kind: 'check', job: 'build', needs: ['build'], run: ['node', '-e', 'process.exit(+!require("node:fs").existsSync("feature.txt"))'] },
  review: { kind: 'job', role: 'reviewer', task: 'Review synthetic feature', needs: ['verify'], from: ['build', 'verify'] },
  accept: { kind: 'handback', to: 'main', ask: 'Land the synthetic feature?', options: ['land', 'skip'], needs: ['review'], from: ['build', 'verify', 'review'] },
  publish: { kind: 'land', job: 'build', needs: ['accept'], when: { step: 'accept', is: 'land' } },
  alternative: { ...task, needs: ['accept'], when: { step: 'accept', is: 'skip' } },
  skipped_child: { ...task, needs: ['alternative'] },
});
const template = `version = 1
name = 'synthetic-recipe'
[steps.build]
kind = 'job'
role = 'imp'
isolation = 'worktree'
task = 'Build synthetic feature'
[steps.verify]
kind = 'check'
job = 'build'
needs = ['build']
use = 'verify'
[steps.review]
kind = 'job'
role = 'reviewer'
needs = ['verify']
from = ['build', 'verify']
task = 'Review synthetic feature'
[steps.accept]
kind = 'handback'
to = 'main'
ask = 'Land the synthetic feature?'
options = ['land', 'skip']
needs = ['review']
from = ['build', 'verify', 'review']
[steps.publish]
kind = 'land'
job = 'build'
needs = ['accept']
when = {step = 'accept', is = 'land'}
[steps.alternative]
kind = 'job'
role = 'sonic'
task = 'Read synthetic inputs'
needs = ['accept']
when = {step = 'accept', is = 'skip'}
[steps.skipped_child]
kind = 'job'
role = 'sonic'
task = 'Read synthetic inputs'
needs = ['alternative']
`;

for (const format of ['json', 'toml']) test(`main composes, checks, reviews, answers once and lands (${format})`, { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  await f.startCliSocket();
  put(join(f.env.HOME, 'defer-pi-report'), '');
  put(join(f.env.HOME, 'hold-turn'), '');
  const project = join(f.root, '.hud', 'project.json');
  const config = JSON.parse(fs.readFileSync(project, 'utf8'));
  config.commands = { verify: sample.steps.verify.run };
  put(project, JSON.stringify(config));
  if (format === 'toml') {
    const dir = join(f.root, '.hud', 'workflows');
    fs.mkdirSync(dir);
    put(join(dir, 'synthetic.toml'), template);
    const homeDir = join(f.home, 'workflows');
    fs.mkdirSync(homeDir);
    put(join(homeDir, 'synthetic.toml'), 'invalid project override outside project');
  }
  // The land helper's base must stay clean.
  f.git(f.root, 'add', '.hud'); f.git(f.root, 'commit', '-qm', 'Synthetic check command');
  const lines = [];
  const watch = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'ignore'] });
  const exit = once(watch, 'exit');
  f.onCleanup(() => stopChild(watch, exit));
  createInterface({ input: watch.stdout }).on('line', line => lines.push(line));
  await until(() => fs.existsSync(join(f.home, 'watchers', `${f.env.HERDR_PANE_ID}.pid`)), 10_000);
  const p = await call(f, 'plan', format === 'toml' ? { template: 'synthetic' } : { graph: sample });
  assert.equal(p.state, 'proposed', JSON.stringify(p));
  assert.equal(p.cost, 'cheap'); assert.match(p.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(p.plan.steps.verify.run, sample.steps.verify.run);
  assert.equal(p.scale.build.role, 'imp');
  assert.equal(fs.existsSync(join(f.home, 'jobs')), false);
  assert.equal((await call(f, 'start', { run: p.run, hash: p.hash })).code, 'workflow_confirmation_required');
  if (format === 'toml') {
    // Rewriting the template and command after planning does not change the frozen run.
    fs.writeFileSync(join(f.root, '.hud', 'workflows', 'synthetic.toml'), 'name = "changed"');
    config.commands.verify = ['false']; put(project, JSON.stringify(config));
    f.git(f.root, 'add', '.hud'); f.git(f.root, 'commit', '-qm', 'Change command after proposal');
  }
  assert.equal((await start(f, p)).state, 'working');
  await until(() => !!f.flow(p.run).steps.build.job, 15_000);
  const build = f.flow(p.run).steps.build.job;
  assert.equal(f.job(build).workflow, p.run);
  await f.settle(build, { file: 'feature.txt' });
  await until(() => !!f.flow(p.run).steps.review.job || f.flow(p.run).state === 'paused', 15_000);
  const ready = f.flow(p.run);
  assert.equal(ready.steps.verify.check?.exit_code, 0, JSON.stringify(ready));
  const review = ready.steps.review.job;
  assert.ok(review, JSON.stringify(ready));
  assert.deepEqual(f.job(review).from_jobs, [build]);
  await f.settleReview(review);
  await until(() => f.flow(p.run).state === 'paused', 10_000);
  await until(() => lines.some(line => line.includes(`${p.run} hand-back`)), 10_000);
  const ask = (await call(f, 'status', { run: p.run })).handback;
  assert.deepEqual(ask, { request_id: 'h-accept', step: 'accept', ask: 'Land the synthetic feature?', choices: ['land', 'skip'],
    refs: [build, review, join(f.home, 'flows', p.run, 'verify.check.json')] });
  assert.equal(fs.existsSync(join(f.root, 'feature.txt')), false);
  assert.equal((await call(f, 'control', { run: p.run, action: 'resume' })).code, 'handback_answer_required');
  assert.equal((await reply(f, p.run, 'invalid')).code, 'invalid_answer');
  assert.equal((await reply(f, p.run, 'land')).written, true);
  await until(() => f.flow(p.run).state === 'completed' || f.flow(p.run).state === 'paused', 15_000);
  const end = f.flow(p.run);
  assert.equal(end.state, 'completed', JSON.stringify(end));
  assert.equal(end.steps.publish.state, 'done');
  assert.equal(end.steps.alternative.state, 'skipped'); assert.equal(end.steps.skipped_child.state, 'skipped');
  assert.match(f.git(f.root, 'show', 'HEAD:feature.txt'), /Synthetic implementation/);
  await until(() => lines.some(line => line === `${p.run} workflow completed`), 10_000);
  const duplicate = await reply(f, p.run, 'skip');
  assert.equal(duplicate.written, false); assert.equal(duplicate.answer, 'land');
  assert.equal(lines.filter(line => line.includes(`${p.run} hand-back`)).length, 1);
  assert.equal(lines.filter(line => line.includes(`${p.run} workflow completed`)).length, 1);
});

test('plan validates cycles, ancestor references, roles, shell placeholders, and project template registration', async t => {
  const f = await fixture(t);
  const refused = async (args, pattern) => {
    const { result } = await f.rpc('tools/call', { name: 'hud_workflow', arguments: { op: 'plan', ...args } });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, pattern);
  };
  for (const [pattern, steps] of [
    [/cycle/, { a: { ...task, needs: ['b'] }, b: { ...task, needs: ['a'] } }],
    [/not an ancestor/, { a: task, b: { ...task, from: ['a'] } }],
    [/unknown.*role/, { a: { ...task, role: 'unknown' } }],
    [/shell placeholders/, { a: task, b: { kind: 'check', job: 'a', needs: ['a'], run: ['echo', '${a.path}'] } }],
    [/shell executables/, { a: task, b: { kind: 'check', job: 'a', needs: ['a'], run: ['/bin/sh', '-c', 'true'] } }],
  ]) await refused({ graph: graph(steps) }, pattern);
  const projectTemplates = join(f.root, '.hud', 'workflows'), homeTemplates = join(f.env.HUD_HOME, 'workflows');
  fs.mkdirSync(projectTemplates, { recursive: true }); fs.mkdirSync(homeTemplates);
  const text = 'version=1\nname="synthetic"\n[steps.a]\nkind="job"\nrole="sonic"\ntask="Home template"';
  put(join(projectTemplates, 'sample.toml'), 'invalid unregistered template');
  await refused({ template: 'sample' }, /template not found/);
  put(join(homeTemplates, 'sample.toml'), text);
  assert.equal((await call(f, 'plan', { template: 'sample' })).plan.steps.a.task, 'Home template');
  put(join(homeTemplates, 'council.toml'), text);
  await refused({ template: 'council' }, /reserved template/);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'jobs')), false);
});

test('costly starts require the owner grant for that run and hash, not a standalone grant or split batches', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro');
  const owner = (...args) => execFileSync(process.execPath, ['bin/hud', ...args], { env: f.env, encoding: 'utf8' });
  const a = await call(f, 'plan', { graph: graph({ a: batch('sonic', 26), b: batch('sonic', 25) }) });
  assert.equal(a.cost, 'costly', JSON.stringify(a));
  assert.deepEqual(a.cost_reasons, ['51 sonic items across the run']);
  const b = await call(f, 'plan', { graph: graph({ a: batch('imp', 7), b: batch('reviewer', 6) }) });
  assert.equal(b.cost, 'costly', JSON.stringify(b));
  const limit = await call(f, 'plan', { graph: graph({ a: batch('sonic', 25), b: batch('sonic', 25) }) });
  assert.equal(limit.cost, 'cheap');
  fs.writeFileSync(join(f.root, 'sample.data'), Buffer.alloc(2 ** 21));
  const bytes = await call(f, 'plan', { graph: graph({ a: batch('sonic', 1, 'Read `sample.data`') }) });
  assert.equal(bytes.cost, 'costly'); assert.match(bytes.cost_reasons[0], /Sonic input bytes/);
  const costly = await call(f, 'plan', { graph: graph({
    ask: { kind: 'handback', to: 'main', ask: 'Start costly work?', options: ['yes', 'no'] },
    browser: { kind: 'job', role: 'pro', task: 'Synthetic browser work', needs: ['ask'], when: { step: 'ask', is: 'yes' } },
  }) });
  assert.equal(costly.cost, 'costly', JSON.stringify(costly));
  assert.equal((await start(f, a)).code, 'owner_grant_required');
  owner('council', 'allow');
  assert.equal((await start(f, b)).code, 'owner_grant_required');
  assert.match(owner('workflow', 'allow', costly.run, costly.hash), /authorized/);
  assert.equal(fs.statSync(join(f.env.HUD_HOME, 'workflow-grant.json')).mode & 0o777, 0o600);
  assert.equal((await start(f, b)).code, 'owner_grant_required');
  const grantFile = join(f.env.HUD_HOME, 'workflow-grant.json');
  const grant = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
  put(grantFile, JSON.stringify({ ...grant, created_at: '2000-01-01T00:00:00.000Z' }));
  assert.equal((await start(f, costly)).code, 'owner_grant_required');
  owner('workflow', 'allow', costly.run, costly.hash);
  assert.equal((await call(f, 'start', { run: costly.run, hash: a.hash, confirm: true })).code, 'workflow_confirmation_required');
  assert.equal(spawnSync(process.execPath, ['bin/hud', 'workflow', 'allow', a.run, a.hash], { env: { ...f.env, HUD_JOB_DIR: 'synthetic-worker' } }).status, 2);
  assert.equal((await start(f, costly)).state, 'working');
  const state = () => JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'flows', `${costly.run}.json`), 'utf8'));
  await until(() => state().handback?.request_id === 'h-ask', 10_000);
  assert.equal((await reply(f, costly.run, 'no', 'h-ask')).written, true);
  await until(() => state().state === 'completed', 10_000);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), []);
});

test('a failed check repairs the source checkout at most twice and retains bounded exit evidence', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  put(join(f.env.HOME, 'defer-pi-report'), '');
  const p = await call(f, 'plan', { graph: graph({
    build: sample.steps.build,
    verify: { kind: 'check', needs: ['build'], job: 'build', repair: 2, run: ['node', '-e', 'for(let i=0;i<50;i++) console.log(i); process.exit(7)'] },
    publish: { kind: 'land', job: 'build', needs: ['verify'] },
  }) });
  assert.equal((await start(f, p)).state, 'working');
  const run = () => f.flow(p.run);
  await until(() => !!run().steps.build.job, 15_000);
  const build = run().steps.build.job;
  await f.settle(build, { file: 'feature.txt' });
  for (const n of [1, 2]) {
    const step = () => run().steps.verify;
    await until(() => step().repairs === n && !!step().job || run().state === 'paused', 15_000);
    assert.equal(run().state, 'working', JSON.stringify(run()));
    const repair = step().job;
    assert.equal(f.job(repair).cwd, f.job(build).worktree.root);
    assert.equal(f.job(repair).workflow, p.run);
    await f.settleReview(repair);
  }
  await until(() => run().state === 'paused', 15_000);
  const failed = run().steps.verify;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.repairs, 2);
  assert.equal(failed.check.exit_code, 7);
  assert.deepEqual(failed.check.tail.split('\n'), Array.from({ length: 40 }, (_, i) => String(i + 10)));
  assert.equal(run().steps.publish.state, 'waiting');
  assert.equal((await call(f, 'control', { run: p.run, action: 'stop' })).state, 'stopped');
});

test('an in-place repair waits for the new report before rerunning the check, handing back and landing', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  put(join(f.env.HOME, 'defer-pi-report'), '');
  const count = join(f.env.HOME, 'check-count');
  const p = await call(f, 'plan', { graph: graph({
    build: sample.steps.build,
    verify: { kind: 'check', job: 'build', needs: ['build'], repair: 1, run: ['node', '-e',
      'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "check\\n"); process.exit(+!fs.existsSync("repair.txt"));', count] },
    accept: { ...sample.steps.accept, needs: ['verify'], from: ['build', 'verify'] },
    publish: sample.steps.publish,
  }) });
  assert.equal(p.cost, 'cheap');
  assert.equal((await start(f, p)).state, 'working');
  const run = () => f.flow(p.run), status = () => call(f, 'status', { run: p.run });
  await until(() => run().steps.build.job, t.signal);
  const id = run().steps.build.job, dir = f.dir(id), statusFile = join(dir, 'STATUS.json');
  const cwd = f.job(id).cwd;
  put(join(cwd, 'feature.txt'), 'Synthetic implementation');
  f.git(cwd, 'add', 'feature.txt'); f.git(cwd, 'commit', '-qm', 'Synthetic build');
  // Live grace with a prior settled report (the fake worker has not closed itself).
  put(join(dir, 'report.md'), 'Synthetic build report');
  put(statusFile, JSON.stringify({ state: 'idle_grace', output_written: true }));
  await until(() => run().steps.verify.job || run().state !== 'working', t.signal);
  assert.equal(run().steps.verify.job, id, JSON.stringify(run()));
  const send = f.job(id).send_outcomes.at(-1);
  assert.equal(send.key, `workflow:${p.run}:verify:repair:1`);
  assert.equal(send.exit_code, 0);
  // Leave the old report in place even when an updated status looks settled.
  put(statusFile, JSON.stringify({ state: 'idle_grace', output_written: true, settled_at: new Date().toISOString() }));
  await delay(1_250, undefined, { signal: t.signal });
  assert.equal(fs.readFileSync(count, 'utf8'), 'check\n');
  assert.equal((await status()).steps.verify.repair_pending, true);
  await f.settle(id, { file: 'repair.txt', report: 'Synthetic fresh repair report' });
  await until(() => run().handback?.request_id === 'h-accept', t.signal);
  assert.equal((await status()).steps.verify.check.exit_code, 0);
  assert.equal(fs.readFileSync(count, 'utf8'), 'check\ncheck\n');
  assert.equal((await reply(f, p.run, 'land')).written, true);
  await until(() => run().state === 'completed' || run().state === 'paused', t.signal);
  assert.equal((await status()).steps.publish.state, 'done', JSON.stringify(run()));
  assert.match(f.git(f.root, 'show', 'HEAD:repair.txt'), /Synthetic implementation/);
});

test('a composed batch settles the pilot and applies the first breaker before admitting the tail', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { failedRetentionMs: 60_000 });
  sonicTask(f);
  const p = await call(f, 'plan', { graph: { ...graph({ items: { ...batch('sonic', 3), max_parallel: 1 } }), policy: { breaker: 'first' } } });
  assert.equal(p.cost, 'cheap');
  assert.equal((await start(f, p)).state, 'working');
  const dir = join(f.env.HUD_HOME, 'jobs');
  const run = () => JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'flows', `${p.run}.json`), 'utf8'));
  const items = () => run().steps.items.items;
  await until(() => items()?.[0].job, t.signal);
  put(join(dir, items()[0].job, 'release-sonic'), '');
  await until(() => items()[1].job, t.signal);
  const failed = items()[1].job;
  put(join(dir, failed, 'fail-sonic'), '');
  put(join(dir, failed, 'release-sonic'), '');
  await until(() => run().state === 'paused', t.signal);
  const value = await call(f, 'status', { run: p.run });
  assert.match(value.reason, /failure circuit breaker/);
  assert.deepEqual(value.steps.items.items.map(i => i.state), ['done', 'failed', 'waiting']);
  assert.equal(value.steps.items.items[2].job, undefined);
  const reason = value.steps.items.items[1].reason;
  assert.match(reason, /exited/);
  assert.deepEqual(value.steps.items.failure_groups, [{ reason, count: 1, example: failed }]);
  assert.equal(run().settled, 2);
  assert.equal(fs.readdirSync(dir).filter(name => /^j[0-9a-f]{16}$/.test(name)).length, 2);
  assert.equal((await call(f, 'control', { run: p.run, action: 'retry_failed' })).state, 'working');
  await until(() => items()[1].job && items()[1].job !== failed, t.signal);
  const retried = items()[1].job;
  assert.equal(items()[0].state, 'done');
  assert.equal(items()[2].job, undefined);
  put(join(dir, retried, 'release-sonic'), '');
  await until(() => items()[2].job, t.signal);
  put(join(dir, items()[2].job, 'release-sonic'), '');
  await until(() => run().state === 'completed', t.signal);
});

test('a cheap workflow remeasures aggregate Sonic inputs when a later step is admitted', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const a = join(f.root, 'a.txt'), b = join(f.root, 'b.txt');
  put(a, Buffer.alloc(1024 * 1024)); put(b, 'Synthetic initial input');
  const p = await call(f, 'plan', { graph: graph({
    a: { ...task, task: 'Read `a.txt`' },
    b: { ...batch('sonic', 1, 'Read `b.txt`'), needs: ['a'] },
  }) });
  assert.equal(p.cost, 'cheap');
  assert.equal((await start(f, p)).state, 'working');
  await until(() => f.flow(p.run).steps.a.job, t.signal);
  const first = f.flow(p.run).steps.a.job;
  // The second input is still below 2 MiB in isolation; shrinking the first
  // file does not refund bytes already admitted for the first dispatch.
  put(a, ''); put(b, Buffer.alloc(1024 * 1024));
  put(join(f.dir(first), 'release-sonic'), '');
  await until(() => f.flow(p.run).state !== 'working', t.signal);
  const paused = await call(f, 'status', { run: p.run });
  assert.equal(paused.state, 'paused');
  assert.match(paused.reason, /Sonic input bytes across the run.*re-plan/);
  assert.equal(paused.steps.b.items[0].state, 'waiting');
  assert.equal(paused.steps.b.items[0].job, undefined);
  assert.deepEqual(fs.readdirSync(join(f.home, 'jobs')).filter(name => /^j[0-9a-f]{16}$/.test(name)), [first]);
});

test('a stopped job with a written report completes its composed step', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  put(join(f.env.HOME, 'defer-pi-report'), '');
  const p = await call(f, 'plan', { graph: graph({ build: sample.steps.build }) });
  assert.equal((await start(f, p)).state, 'working');
  await until(() => f.flow(p.run).steps.build.job, t.signal);
  const dir = f.dir(f.flow(p.run).steps.build.job);
  put(join(dir, 'report.md'), 'Synthetic completed work');
  put(join(dir, 'STATUS.json'), JSON.stringify({ state: 'stopped', output_written: true }));
  await until(() => f.flow(p.run).state !== 'working', t.signal);
  const value = await call(f, 'status', { run: p.run });
  assert.equal(value.state, 'completed', JSON.stringify(value));
  assert.equal(value.steps.build.state, 'done');
});

for (const fails of [false, true]) test(`a composed hand-back push ${fails ? 'retries on the quiet timer' : 'is delivered once'}`, { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const home = f.env.HUD_HOME, pane = f.env.HERDR_PANE_ID;
  const flow = 'w0000000000000001', line = `${flow} synthetic hand-back`;
  fs.mkdirSync(join(home, 'flows', flow), { recursive: true });
  saveHeader(home, { flow, template: 'composed', state: 'paused', pane, project_root: f.root, notices: { 'handback-accept': line } });
  const calls = [];
  const delivery = panelDelivery(home, pane, f.root, () => false, async text => {
    calls.push(text);
    return !fails || calls.length > 1;
  }, taskNoticeSource(home, pane, f.root));
  t.after(() => delivery.stop());
  const expected = fails ? [line, line] : [line];
  await until(() => calls.length >= expected.length, t.signal);
  await delay(1_100, undefined, { signal: t.signal });
  assert.deepEqual(calls, expected);
  assert.ok(fs.existsSync(join(home, 'flows', flow, 'handback-accept.noticed')));
});

test('the default lead hand-back closes its decision session before selecting a branch', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  put(join(f.env.HOME, 'hold-turn'), '');
  const p = await call(f, 'plan', { graph: graph({ accept: { kind: 'handback', ask: 'Which branch?', options: ['continue', 'skip'] },
    unused: { ...task, needs: ['accept'], when: { step: 'accept', is: 'continue' } },
  }) });
  assert.equal(p.cost, 'cheap');
  assert.equal((await start(f, p)).state, 'working');
  const state = () => f.flow(p.run);
  await until(() => !!state().steps.accept.job || state().state === 'paused', 15_000);
  const lead = state().steps.accept.job;
  assert.equal(f.job(lead).role, 'lead');
  await f.settleLead(lead, 'Decision: skip\nReason: Synthetic result is ready.\n');
  await until(() => state().state !== 'working', 15_000);
  assert.equal(state().state, 'completed', JSON.stringify(state()));
  assert.equal(state().steps.accept.answer, 'skip');
  assert.equal(state().steps.accept.decision_reason, 'Synthetic result is ready.');
  assert.equal(state().steps.unused.state, 'skipped');
  assert.ok(f.job(lead).reaped_at);
});

test('a composed council uses its bound grant without consuming the standalone grant', { timeout: 35_000 }, async t => {
  const f = await fixture(t);
  const home = f.env.HUD_HOME;
  enableOptionalRoles(f, 'council');
  put(join(f.env.HOME, 'hold-turn'), '');
  put(join(f.env.HOME, 'defer-pi-report'), '');
  const cli = (...args) => execFileSync(process.execPath, ['bin/hud', ...args], { env: f.env });
  const readJson = path => JSON.parse(fs.readFileSync(path, 'utf8'));
  const dir = id => join(home, 'jobs', id), job = id => readJson(join(dir(id), 'job.json'));
  const p = await call(f, 'plan', { graph: graph({ propose: { kind: 'council', task: 'Synthetic options' } }) });
  assert.equal(p.cost, 'costly', JSON.stringify(p));
  assert.deepEqual(p.plan.steps.propose.members, ['fable', 'astra', 'carbon']);
  cli('council', 'allow');
  assert.equal((await start(f, p)).code, 'owner_grant_required');
  cli('workflow', 'allow', p.run, p.hash);
  assert.equal((await start(f, p)).state, 'working');
  const state = () => readJson(join(home, 'flows', `${p.run}.json`));
  await until(() => !!state().steps.propose.job || state().state !== 'working', 15_000);
  const council = state().steps.propose.job;
  assert.equal(job(council).workflow, p.run);
  await until(() => job(council).council_members.every(m => m.job), 15_000);
  for (const { job: member } of job(council).council_members) {
    put(join(dir(member), 'report.md'), 'Synthetic proposal');
    put(join(dir(member), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, ended_at: new Date().toISOString() }));
  }
  await until(() => state().state !== 'working', 15_000);
  assert.equal(state().state, 'completed', JSON.stringify(state()));
  assert.equal(readJson(join(home, 'council-grant.json')).claimed_by, undefined);
  assert.equal(readJson(join(home, 'workflow-grant.json')).claimed_by, p.run);
});
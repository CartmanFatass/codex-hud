import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readExecutionRuns } from '../../dist/collectors/execution-runs.js';
import { panelDelivery } from '../../dist/mcp/panel-delivery.js';
import { setHarnessDisabled } from '../../dist/roles/harness-switches.js';
import { WORKFLOW_WORKER_RULE_NO_ASK } from '../../dist/mcp/workflow-lead.js';
import { SONIC_LEDGER_VERSION } from '../../dist/workflows/composed-state.js';
import { SONIC_BYTES_LIMIT } from '../../dist/workflows/graph.js';
import { taskNoticeSource } from '../../dist/workflows/events.js';
import { noticeEvents, saveHeader } from '../../dist/workflows/store.js';
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
const stations = (f, run, workers = new Map()) =>
  readExecutionRuns(f.home, { root: f.root, pane: null }, workers).find(r => r.flow === run).metro.stations;
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
  assert.equal((await f.call('hud_lease', { name: 'main-checkout' })).granted, true);
  assert.equal((await reply(f, p.run, 'land')).written, true);
  await until(() => f.flow(p.run).steps.publish.land, 10_000);
  const buildWorker = { id: `thin-job:${build}`, laneId: 'synthetic', settledAt: Date.now() };
  const publish = stations(f, p.run, new Map([[build, buildWorker]])).find(s => s.id === 'publish');
  assert.equal(publish.state, 'working', 'the land step is running even though its source worker settled');
  assert.equal(publish.jobId, build);
  assert.equal(publish.execJob.target.workerId, buildWorker.id);
  assert.equal(publish.changedAt, Date.parse(f.flow(p.run).steps.publish.changed_at));
  await f.call('hud_lease', { name: 'main-checkout', release: true });
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

test('a composed breaker settles staggered sibling failures while paused and retries both without admitting the tail early', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { failedRetentionMs: 60_000 });
  sonicTask(f);
  const p = await call(f, 'plan', { graph: { ...graph({ items: { ...batch('sonic', 4), max_parallel: 2 } }), policy: { breaker: 'first' } } });
  assert.equal(p.cost, 'cheap');
  assert.equal((await start(f, p)).state, 'working');
  const dir = join(f.env.HUD_HOME, 'jobs');
  const run = () => JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'flows', `${p.run}.json`), 'utf8'));
  const items = () => run().steps.items.items;
  const status = () => call(f, 'status', { run: p.run });
  const release = (job, fail = false) => {
    if (fail) put(join(dir, job, 'fail-sonic'), '');
    put(join(dir, job, 'release-sonic'), '');
  };
  await until(() => items()?.[0].job, t.signal);
  assert.equal(items()[1].state, 'waiting');
  release(items()[0].job);
  await until(() => items()[1].job && items()[2].job, t.signal);
  const [pilot, first, second] = items().map(i => i.job);
  release(first, true);
  await until(() => run().state === 'paused', t.signal);
  const paused = await status();
  assert.match(paused.reason, /failure circuit breaker/);
  assert.deepEqual(paused.steps.items.items.map(i => i.state), ['done', 'failed', 'running', 'waiting']);
  await delay(2_000, undefined, { signal: t.signal });
  release(second, true);
  await until(() => items()[2].state === 'failed', t.signal);
  const value = await status();
  assert.equal(value.state, 'paused');
  assert.deepEqual(value.steps.items.items.map(i => i.state), ['done', 'failed', 'failed', 'waiting']);
  assert.equal(value.steps.items.items[3].job, undefined);
  const reason = value.steps.items.items[1].reason;
  assert.match(reason, /exited/);
  assert.deepEqual(value.steps.items.failure_groups, [{ reason, count: 2, example: first }]);
  assert.equal(run().settled, 2, 'a paused sibling does not change the breaker window');
  assert.deepEqual(fs.readdirSync(dir).filter(name => /^j[0-9a-f]{16}$/.test(name)).sort(), [pilot, first, second].sort());
  const retry = await call(f, 'control', { run: p.run, action: 'retry_failed' });
  assert.equal(retry.state, 'working');
  assert.deepEqual(retry.steps.items.items.map(i => i.attempt), [0, 1, 1, 0]);
  await until(() => items()[1].job && items()[2].job, t.signal);
  assert.deepEqual(items().map(i => i.state), ['done', 'running', 'running', 'waiting']);
  assert.notEqual(items()[1].job, first);
  assert.notEqual(items()[2].job, second);
  release(items()[1].job);
  release(items()[2].job);
  await until(() => items()[3].job, t.signal);
  release(items()[3].job);
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
  assert.deepEqual(fs.readdirSync(join(f.home, 'jobs')).filter(name => /^j[0-9a-f]{16}$/.test(name) && f.job(name).used_place), [first]);
});

test('a subdirectory Sonic cwd charges sibling data at plan and admission with the same byte count', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const cwd = join(f.root, 'docs'), source = join(f.root, 'data', 'synthetic input.txt');
  fs.mkdirSync(join(f.root, 'data'));
  put(source, 'Small synthetic input');
  const recipe = graph({ read: { ...task, task: 'Read `../data/synthetic input.txt`' } });
  const cheap = await call(f, 'plan', { cwd, graph: recipe });
  assert.equal(cheap.cost, 'cheap');
  fs.truncateSync(source, 3 * 1024 ** 2);
  const costly = await call(f, 'plan', { cwd, graph: recipe });
  const total = costly.scale.read.input_bytes;
  assert.equal(costly.cost, 'costly');
  assert.equal(total - cheap.scale.read.input_bytes, fs.statSync(source).size - Buffer.byteLength('Small synthetic input'));
  assert.deepEqual(costly.cost_reasons, [`${total} Sonic input bytes across the run`]);
  assert.equal((await start(f, costly)).code, 'owner_grant_required');
  await start(f, cheap);
  await until(() => f.flow(cheap.run).state === 'paused' && !f.flow(cheap.run).pid, t.signal);
  const paused = f.flow(cheap.run);
  assert.equal(paused.reason, `${total} Sonic input bytes across the run (limit ${SONIC_BYTES_LIMIT}); re-plan or reduce inputs`);
  assert.equal(paused.steps.read.job, undefined);
  assert.equal(paused.sonic_input_bytes, 0);
  put(source, 'Small synthetic input');
  await call(f, 'control', { run: cheap.run, action: 'resume' });
  await until(() => f.flow(cheap.run).steps.read.job, t.signal);
  const launched = f.flow(cheap.run), job = launched.steps.read.job;
  assert.equal(f.job(job).cwd, cwd);
  assert.equal(launched.sonic_input_bytes, cheap.scale.read.input_bytes, JSON.stringify({ launched, job: f.job(job) }));
  put(join(f.dir(job), 'release-sonic'), '');
  await until(() => f.flow(cheap.run).state === 'completed', t.signal);
});

test('plan, admission and dispatch charge the same assembled references including standing brief', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const standingPath = join(f.root, '.hud', 'brief.md');
  put(standingPath, 'Synthetic standing brief.\n'.repeat(160));
  f.git(f.root, 'add', '.hud/brief.md'); f.git(f.root, 'commit', '-qm', 'Larger synthetic standing brief');
  const file = join(f.root, 'sample.txt'), readTask = 'Read `sample.txt`';
  const finalTask = `${readTask}\n\n${WORKFLOW_WORKER_RULE_NO_ASK}`;
  const specBytes = fs.statSync(join(f.root, 'docs', 'spec.md')).size; // Named by the worker rule.
  const expectedBrief = `${finalTask}\n\nRead the project standing brief: ${JSON.stringify(standingPath)}.\n\nFinish with \`hud_report\`.\n`;
  const standingBytes = fs.statSync(standingPath).size;
  const exactFileBytes = SONIC_BYTES_LIMIT - Buffer.byteLength(expectedBrief) - specBytes - standingBytes;
  put(file, Buffer.alloc(exactFileBytes));
  const recipe = graph({ read: { kind: 'job', role: 'sonic', task: readTask } });
  const p = await call(f, 'plan', { graph: recipe });
  assert.equal(p.cost, 'cheap');
  assert.equal(p.scale.read.input_bytes, SONIC_BYTES_LIMIT);
  fs.truncateSync(standingPath, standingBytes + 1);
  const costly = await call(f, 'plan', { graph: recipe });
  assert.equal(costly.cost, 'costly');
  assert.equal(costly.scale.read.input_bytes, SONIC_BYTES_LIMIT + 1);
  await start(f, p);
  await until(() => f.flow(p.run).state === 'paused', t.signal);
  assert.match((await call(f, 'status', { run: p.run })).reason, new RegExp(`${SONIC_BYTES_LIMIT + 1} Sonic input bytes across the run.*re-plan`));
  assert.equal(f.flow(p.run).sonic_input_bytes, 0);
  assert.equal(f.flow(p.run).sonic_ledger_version, SONIC_LEDGER_VERSION);
  assert.equal(f.flow(p.run).steps.read.job, undefined);
  fs.truncateSync(standingPath, standingBytes);
  assert.equal((await call(f, 'control', { run: p.run, action: 'resume' })).state, 'working');
  await until(() => f.flow(p.run).steps.read.job || f.flow(p.run).state === 'paused', t.signal);
  assert.equal(f.flow(p.run).state, 'working', JSON.stringify(f.flow(p.run)));
  assert.equal(f.flow(p.run).sonic_input_bytes, SONIC_BYTES_LIMIT);
  const job = f.flow(p.run).steps.read.job;
  const writtenBrief = fs.readFileSync(join(f.dir(job), 'brief.md'), 'utf8');
  assert.equal(writtenBrief, expectedBrief);
  assert.equal(Buffer.byteLength(writtenBrief) + specBytes + standingBytes + exactFileBytes, SONIC_BYTES_LIMIT);
  put(join(f.dir(job), 'release-sonic'), '');
  await until(() => f.flow(p.run).state === 'completed', t.signal);
});

test('Sonic charges a prerequisite report once it exists', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  put(join(f.env.HOME, 'defer-pi-report'), '');
  put(join(f.root, 'sample.txt'), Buffer.alloc(1024 * 1024));
  const readTask = 'Read `sample.txt` and the build report';
  const p = await call(f, 'plan', { graph: graph({
    build: sample.steps.build,
    verify: sample.steps.verify,
    read: { ...task, task: readTask, needs: ['verify'], from: ['build', 'verify'] },
  }) });
  assert.equal(p.cost, 'cheap');
  await start(f, p);
  await until(() => f.flow(p.run).steps.build.job, t.signal);
  const build = f.flow(p.run).steps.build.job;
  await f.settle(build, { file: 'feature.txt', report: 'r'.repeat(1024 * 1024) });
  await until(() => f.flow(p.run).state === 'paused' || f.flow(p.run).steps.read.job, t.signal);
  const status = await call(f, 'status', { run: p.run });
  assert.equal(status.state, 'paused');
  const check = join(f.home, 'flows', p.run, 'verify.check.json');
  const standing = join(f.root, '.hud', 'brief.md');
  const report = join(f.dir(build), 'report.md');
  const assembled = `${readTask}\n\n${WORKFLOW_WORKER_RULE_NO_ASK}\n\nWorkflow results: ${check}\n\n` +
    `Read the project standing brief: ${JSON.stringify(standing)}.\n\n` +
    `## Context References\n\nRead these files for task context:\n\n- ${build} report: ${JSON.stringify(report)}\n\n` +
    'Finish with `hud_report`.\n';
  const total = Buffer.byteLength(assembled) +
    [check, standing, join(f.root, 'docs', 'spec.md'), join(f.root, 'sample.txt'), report]
      .reduce((n, file) => n + fs.statSync(file).size, 0);
  assert.equal(status.reason, `${total} Sonic input bytes across the run (limit ${SONIC_BYTES_LIMIT}); re-plan or reduce inputs`);
  assert.equal(status.steps.read.job, undefined);
});

test('a cheap worktree Sonic job sizes its populated checkout, not the Git blob', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const file = join(f.root, 'input.txt');
  put(join(f.root, '.gitattributes'), 'input.txt text eol=crlf\n');
  put(file, 'x\n'.repeat(800_000));
  f.git(f.root, 'add', '.gitattributes', 'input.txt'); f.git(f.root, 'commit', '-qm', 'Synthetic CRLF checkout input');
  const blobBytes = Number(f.git(f.root, 'cat-file', '-s', 'HEAD:input.txt'));
  assert.equal(blobBytes, fs.statSync(file).size);
  assert.ok(blobBytes < SONIC_BYTES_LIMIT);
  const p = await call(f, 'plan', { graph: graph({ read: { kind: 'job', role: 'sonic', isolation: 'worktree', task: 'Read `input.txt`' } }) });
  assert.equal(p.cost, 'cheap');
  await start(f, p);
  await until(() => f.flow(p.run).state === 'paused' && !f.flow(p.run).pid, t.signal);
  const paused = await call(f, 'status', { run: p.run });
  const jobs = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[0-9a-f]{16}$/.test(id));
  assert.equal(jobs.length, 1);
  const receipt = f.job(jobs[0]), checkedOutBytes = 2_400_000;
  assert.equal(receipt.used_place, undefined);
  assert.deepEqual(receipt.attempts, []);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reason, `${p.scale.read.input_bytes - blobBytes + checkedOutBytes} Sonic input bytes across the run (limit ${SONIC_BYTES_LIMIT}); re-plan or reduce inputs`);
  assert.ok(receipt.worktree, JSON.stringify(receipt));
  assert.equal(paused.steps.read.job, undefined);

  const nonGit = await fixture(t);
  sonicTask(nonGit);
  put(join(nonGit.root, 'sample.txt'), 'small');
  const p2 = await call(nonGit, 'plan', { graph: graph({ read: { kind: 'job', role: 'sonic', isolation: 'worktree', task: 'Read `sample.txt`' } }) });
  assert.equal(p2.cost, 'cheap');
  await start(nonGit, p2);
  const run2 = () => JSON.parse(fs.readFileSync(join(nonGit.env.HUD_HOME, 'flows', `${p2.run}.json`), 'utf8'));
  await until(() => run2().state === 'paused', t.signal);
  const paused2 = await call(nonGit, 'status', { run: p2.run });
  assert.match(paused2.reason, /worktree isolation requires a Git checkout with a HEAD commit/);
  assert.equal(paused2.steps.read.job, undefined);
  assert.deepEqual(fs.existsSync(join(nonGit.env.HUD_HOME, 'jobs')) ? fs.readdirSync(join(nonGit.env.HUD_HOME, 'jobs')) : [], []);
});

test('Sonic sizing includes undecided branches but excludes branches ruled out by a recorded answer', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const source = join(f.root, 'branch.txt');
  put(source, 'Small branch input');
  const accept = { kind: 'handback', to: 'main', ask: 'Run branch?', options: ['go', 'skip'] };
  const branch = { ...task, task: 'Read `branch.txt`', needs: ['accept'], when: { step: 'accept', is: 'go' } };
  const child = { ...task, task: 'Read `branch.txt` again', needs: ['branch'] };
  const undecided = await call(f, 'plan', { graph: graph({ probe: task, accept, branch, child }) });
  const decided = await call(f, 'plan', { graph: graph({ accept, probe: task, branch, child }) });
  assert.equal(undecided.cost, 'cheap');
  assert.equal(decided.cost, 'cheap');
  fs.truncateSync(source, 3 * 1024 ** 2);
  assert.equal((await call(f, 'plan', { graph: graph({ probe: task, accept, branch, child }) })).cost, 'costly');
  await start(f, undecided);
  await until(() => f.flow(undecided.run).state === 'paused', t.signal);
  const held = f.flow(undecided.run);
  assert.equal(held.handback.step, 'probe');
  assert.match(held.reason, /Sonic input bytes across the run/);
  assert.equal(held.steps.accept.answer, undefined);
  assert.equal(held.steps.probe.job, undefined);

  await start(f, decided);
  await until(() => f.flow(decided.run).handback?.request_id === 'h-accept', t.signal);
  assert.equal((await reply(f, decided.run, 'skip')).written, true);
  await until(() => f.flow(decided.run).steps.probe.job || f.flow(decided.run).state === 'paused', t.signal);
  const active = f.flow(decided.run);
  assert.equal(active.state, 'working', JSON.stringify(active));
  assert.equal(active.sonic_input_bytes, decided.scale.probe.input_bytes);
  put(join(f.dir(active.steps.probe.job), 'release-sonic'), '');
  await until(() => f.flow(decided.run).state === 'completed', t.signal);
  assert.equal(f.flow(decided.run).steps.branch.state, 'skipped');
  assert.equal(f.flow(decided.run).steps.child.state, 'skipped');
});

test('a cheap Sonic step waits in the workflow at the role cap and remeasures before starting', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  put(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, roleCaps: { sonic: 1 } }));
  const busy = await f.call('hud_create', { role: 'sonic', task: 'Occupy the synthetic Sonic slot' });
  assert.equal(busy.state, 'working');
  const file = join(f.root, 'sample.txt');
  put(file, 'small input');
  const p = await call(f, 'plan', { graph: graph({ read: { ...task, task: 'Read `sample.txt`' } }) });
  assert.equal(p.cost, 'cheap');
  await start(f, p);
  await until(() => f.flow(p.run).steps.read.state === 'running', t.signal);
  const held = await call(f, 'status', { run: p.run });
  assert.equal(held.steps.read.admitted, undefined);
  assert.equal(held.steps.read.job, undefined);
  fs.truncateSync(file, SONIC_BYTES_LIMIT);
  put(join(busy.task_dir, 'release-sonic'), '');
  await until(() => f.flow(p.run).state === 'paused' || f.flow(p.run).steps.read.job, t.signal);
  const paused = await call(f, 'status', { run: p.run });
  assert.equal(paused.state, 'paused');
  assert.match(paused.reason, /Sonic input bytes across the run.*re-plan/);
  assert.equal(paused.steps.read.job, undefined);
});

for (const browser of [false, true]) test(`a legacy queued cheap Sonic job is fenced at launch (${browser ? 'browser' : 'unaccounted inputs'})`,
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, { failedRetentionMs: 60_000 });
    sonicTask(f);
    put(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, roleCaps: { sonic: 1 } }));
    const create = task => f.call('hud_create', { role: 'sonic', task });
    const busy = await create('Occupy the synthetic Sonic slot');
    const file = join(f.root, 'sample.txt');
    put(file, 'small input');
    const queued = await create('Read `sample.txt`');
    assert.equal(queued.queued, true);
    const path = join(queued.task_dir, 'job.json');
    const receipt = JSON.parse(fs.readFileSync(path, 'utf8'));
    put(path, JSON.stringify({ ...receipt, workflow: 'w0000000000000001', workflow_cheap: true }));
    fs.truncateSync(file, SONIC_BYTES_LIMIT);
    if (browser) {
      const path = join(f.env.HUD_HOME, 'roles', 'sonic.json');
      const role = JSON.parse(fs.readFileSync(path, 'utf8'));
      role.run.push({ harness: 'bro', tool: 'jev-ask', provider: 'gemini' });
      put(path, JSON.stringify(role));
    }
    put(join(busy.task_dir, 'release-sonic'), '');
    const status = () => JSON.parse(fs.readFileSync(join(queued.task_dir, 'STATUS.json'), 'utf8'));
    await until(() => status().state !== 'queued', t.signal);
    assert.equal(status().state, 'failed', JSON.stringify(status()));
    assert.match(status().error, browser ? /browser place; re-plan/ : /Earlier Sonic input bytes.*re-plan/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')).attempts, []);
  });

for (const mode of ['missing', 'legacy-populated', 'current']) test(`resuming a cheap workflow verifies Sonic ledger version (${mode})`, { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const p = await call(f, 'plan', { graph: graph({
    a: task,
    accept: { ...sample.steps.accept, needs: ['a'], from: ['a'] },
    b: { ...task, needs: ['accept'] },
  }) });
  assert.equal(p.cost, 'cheap');
  await start(f, p);
  await until(() => f.flow(p.run).steps.a.job, t.signal);
  const charged = f.flow(p.run).sonic_input_bytes;
  assert.ok(charged > 0, 'a fresh run starts accounting at zero');
  assert.equal(f.flow(p.run).sonic_ledger_version, SONIC_LEDGER_VERSION);
  put(join(f.dir(f.flow(p.run).steps.a.job), 'release-sonic'), '');
  await until(() => f.flow(p.run).handback?.request_id === 'h-accept' && !f.flow(p.run).pid, t.signal);
  if (mode !== 'current') {
    const legacy = f.flow(p.run);
    delete legacy.sonic_ledger_version;
    if (mode === 'missing') delete legacy.sonic_input_bytes;
    else legacy.sonic_input_bytes = 123;
    saveHeader(f.home, legacy);
  }
  assert.equal((await reply(f, p.run, 'land')).written, true);
  if (mode === 'current') {
    await until(() => f.flow(p.run).steps.b.job || f.flow(p.run).state === 'paused', t.signal);
    assert.equal(f.flow(p.run).state, 'working', JSON.stringify(f.flow(p.run)));
    assert.ok(f.flow(p.run).sonic_input_bytes > charged);
    put(join(f.dir(f.flow(p.run).steps.b.job), 'release-sonic'), '');
    await until(() => f.flow(p.run).state === 'completed', t.signal);
  } else {
    await until(() => f.flow(p.run).state === 'paused' || f.flow(p.run).steps.b.job, t.signal);
    const status = await call(f, 'status', { run: p.run });
    assert.equal(status.state, 'paused');
    assert.match(status.reason, /Earlier Sonic input bytes.*re-plan/);
    assert.equal(status.steps.b.job, undefined);
    assert.equal(f.flow(p.run).sonic_input_bytes, mode === 'missing' ? undefined : 123);
    assert.equal(f.flow(p.run).sonic_ledger_version, undefined);
  }
});

test('pre-input Sonic refusals reverse byte charges on job and batch steps while unknown outcomes keep them', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const file = join(f.root, 'sample.txt');
  put(file, Buffer.alloc(1_200_000));
  for (const kind of ['job', 'batch']) {
    const step = kind === 'job' ? { kind: 'job', role: 'sonic', task: 'Read `sample.txt`' } : batch('sonic', 1, 'Read `sample.txt`');
    const p = await call(f, 'plan', { graph: graph({ read: step }) });
    assert.equal(p.cost, 'cheap');
    // Switch pi off after planning so dispatch refuses with no_available_place before any receipt.
    setHarnessDisabled(f.home, 'pi', true);
    await start(f, p);
    await until(() => f.flow(p.run).state === 'paused' && !f.flow(p.run).pid, t.signal);
    assert.equal(f.flow(p.run).sonic_input_bytes, 0, `${kind} refusal reverses its byte charge`);
    assert.equal(f.flow(p.run).steps.read.state, 'failed');
    assert.match(f.flow(p.run).reason, /off \(pi\)/);
    setHarnessDisabled(f.home, 'pi', false);
    assert.equal((await call(f, 'control', { run: p.run, action: 'retry_failed' })).state, 'working');
    const jobId = () => kind === 'job' ? f.flow(p.run).steps.read.job : f.flow(p.run).steps.read.items?.[0].job;
    await until(() => jobId() || f.flow(p.run).state === 'paused', t.signal);
    assert.ok(jobId(), `${kind} retry_failed launches instead of pausing at 2 MiB: ${JSON.stringify(f.flow(p.run))}`);
    assert.ok(f.flow(p.run).sonic_input_bytes > 1_200_000);
    put(join(f.dir(jobId()), 'release-sonic'), '');
    await until(() => f.flow(p.run).state === 'completed', t.signal);
  }
  // Unknown outcome (interrupted dispatch without a job receipt) keeps its charge and pauses on retry_failed.
  const u = await call(f, 'plan', { graph: graph({
    accept: { kind: 'handback', to: 'main', ask: 'Proceed?', options: ['go', 'skip'] },
    read: { kind: 'job', role: 'sonic', task: 'Read `sample.txt`', needs: ['accept'] },
  }) });
  assert.equal(u.cost, 'cheap');
  await start(f, u);
  await until(() => f.flow(u.run).handback?.request_id === 'h-accept' && !f.flow(u.run).pid, t.signal);
  const interrupted = f.flow(u.run);
  interrupted.steps.accept.state = 'done';
  delete interrupted.handback;
  interrupted.sonic_input_bytes = 1_200_000;
  interrupted.sonic_ledger_version = SONIC_LEDGER_VERSION;
  interrupted.steps.read = { state: 'running', admitted: true };
  saveHeader(f.home, interrupted);
  assert.equal((await call(f, 'control', { run: u.run, action: 'resume' })).state, 'working');
  await until(() => f.flow(u.run).state === 'paused' && !f.flow(u.run).pid, t.signal);
  assert.equal(f.flow(u.run).steps.read.state, 'failed');
  assert.equal(f.flow(u.run).sonic_input_bytes, 1_200_000);
  assert.equal((await call(f, 'control', { run: u.run, action: 'retry_failed' })).state, 'working');
  await until(() => f.flow(u.run).state === 'paused' || f.flow(u.run).steps.read.job, t.signal);
  const guard = await call(f, 'status', { run: u.run });
  assert.equal(guard.state, 'paused');
  assert.match(guard.reason, /Sonic input bytes across the run.*re-plan/);
  assert.equal(guard.steps.read.job, undefined);
});

test('a required batch failure remains outstanding while main answers an independent hand-back', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const p = await call(f, 'plan', { graph: graph({
    items: batch('sonic', 1),
    accept: { kind: 'handback', to: 'main', ask: 'Continue?', options: ['go', 'skip'] },
    after: { ...task, needs: ['items'] },
  }) });
  await start(f, p);
  const run = () => f.flow(p.run);
  await until(() => run().handback?.request_id === 'h-accept' && run().steps.items.items[0].job, t.signal);
  const jobDir = f.dir(run().steps.items.items[0].job);
  put(join(jobDir, 'fail-sonic'), '');
  put(join(jobDir, 'release-sonic'), '');
  await until(() => run().steps.items.items[0].state === 'failed', t.signal);
  assert.equal(run().handback.request_id, 'h-accept');
  assert.equal(run().steps.items.state, 'running');
  assert.equal((await reply(f, p.run, 'go')).written, true);
  await until(() => run().state === 'paused' && run().handback?.step === 'items', t.signal);
  assert.match(run().reason, /batch items failed/);
  assert.equal(run().steps.items.state, 'failed');
  assert.equal(run().steps.after.state, 'waiting');
  await call(f, 'control', { run: p.run, action: 'resume' });
  await until(() => run().state === 'completed', t.signal);
  assert.equal(run().steps.after.state, 'skipped');
});

test('a one-item breaker-first batch pauses once, skips on one resume, and reruns on retry_failed', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { failedRetentionMs: 60_000 });
  sonicTask(f);
  const jobsDir = join(f.env.HUD_HOME, 'jobs');
  const flow = id => JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'flows', `${id}.json`), 'utf8'));
  const release = (job, fail = false) => {
    if (fail) put(join(jobsDir, job, 'fail-sonic'), '');
    put(join(jobsDir, job, 'release-sonic'), '');
  };
  const recipe = { ...graph({ items: batch('sonic', 1), after: { ...task, needs: ['items'] } }), policy: { breaker: 'first' } };

  const p1 = await call(f, 'plan', { graph: recipe });
  assert.equal((await start(f, p1)).state, 'working');
  await until(() => flow(p1.run).steps.items.items?.[0].job, t.signal);
  release(flow(p1.run).steps.items.items[0].job, true);
  await until(() => flow(p1.run).state === 'paused' && !flow(p1.run).pid, t.signal);
  const paused1 = await call(f, 'status', { run: p1.run });
  assert.match(paused1.reason, /pilot failed/);
  assert.equal(paused1.steps.items.state, 'failed');
  assert.equal(paused1.steps.items.items[0].state, 'failed');
  assert.equal(Object.keys(flow(p1.run).notices).filter(k => k.startsWith('pause-')).length, 1);
  assert.equal((await call(f, 'control', { run: p1.run, action: 'resume' })).state, 'working');
  await until(() => flow(p1.run).state !== 'working', t.signal);
  const done1 = await call(f, 'status', { run: p1.run });
  assert.equal(done1.state, 'completed', JSON.stringify(done1));
  assert.equal(done1.steps.items.state, 'skipped');
  assert.equal(done1.steps.after.state, 'skipped');
  assert.equal(Object.keys(flow(p1.run).notices).filter(k => k.startsWith('pause-')).length, 1);

  const p2 = await call(f, 'plan', { graph: recipe });
  assert.equal((await start(f, p2)).state, 'working');
  await until(() => flow(p2.run).steps.items.items?.[0].job, t.signal);
  const firstJob = flow(p2.run).steps.items.items[0].job;
  release(firstJob, true);
  await until(() => flow(p2.run).state === 'paused' && !flow(p2.run).pid, t.signal);
  assert.equal(flow(p2.run).steps.items.state, 'failed');
  assert.equal((await call(f, 'control', { run: p2.run, action: 'retry_failed' })).state, 'working');
  await until(() => flow(p2.run).steps.items.items?.[0].job && flow(p2.run).steps.items.items[0].job !== firstJob, t.signal);
  assert.equal(flow(p2.run).steps.items.items[0].attempt, 1);
  release(flow(p2.run).steps.items.items[0].job);
  await until(() => flow(p2.run).steps.after.job, t.signal);
  release(flow(p2.run).steps.after.job);
  await until(() => flow(p2.run).state === 'completed', t.signal);
  const done2 = await call(f, 'status', { run: p2.run });
  assert.equal(done2.steps.items.state, 'done');
  assert.equal(done2.steps.after.state, 'done');
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
  saveHeader(home, { flow, template: 'composed', state: 'paused', pane, project_root: f.root, steps: {}, notices: { 'handback-accept': line } });
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

test('a quiet composed notice tick claims a marker released by another reader', async t => {
  const f = await fixture(t);
  const home = f.env.HUD_HOME, pane = f.env.HERDR_PANE_ID, flows = join(home, 'flows');
  const flow = 'w0000000000000001', line = `${flow} synthetic hand-back`;
  fs.mkdirSync(join(flows, flow), { recursive: true });
  const run = { flow, template: 'composed', state: 'paused', pane, project_root: f.root, steps: {}, notices: { 'handback-accept': line } };
  saveHeader(home, run);
  const [claim] = noticeEvents(home, run);
  const tick = taskNoticeSource(home, pane, f.root);
  assert.deepEqual(tick(), [], 'prime the quiet cache while another reader holds the claim');
  const stamp = fs.statSync(flows, { bigint: true });
  fs.unlinkSync(claim.marker);
  const unchanged = fs.statSync(flows, { bigint: true });
  assert.equal(unchanged.mtimeNs, stamp.mtimeNs);
  assert.equal(unchanged.ctimeNs, stamp.ctimeNs);
  assert.deepEqual(tick(), [{ line, marker: claim.marker }]);
  assert.deepEqual(tick(), []);
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

test('Execution uses the composed hand-back cursor after its lead escalates', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  put(join(f.env.HOME, 'hold-turn'), '');
  const p = await call(f, 'plan', { graph: graph({ accept: { kind: 'handback', ask: 'Continue?', options: ['continue', 'skip'] } }) });
  assert.equal((await start(f, p)).state, 'working');
  const state = () => f.flow(p.run);
  await until(() => state().steps.accept.job, 15_000);
  const lead = state().steps.accept.job;
  await f.settleLead(lead, 'Decision: escalate\nReason: Main must make a synthetic choice.\n');
  await until(() => state().state === 'paused', 15_000);
  assert.ok(f.job(lead).reaped_at);
  const accept = stations(f, p.run).find(s => s.id === 'accept');
  assert.equal(accept.state, 'asking');
  assert.equal(accept.jobId, lead);
  assert.equal(accept.changedAt, Date.parse(state().steps.accept.changed_at));
});

test('Execution shows planned and recorded members of a composed batch', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  sonicTask(f);
  const p = await call(f, 'plan', { graph: graph({
    accept: { kind: 'handback', to: 'main', ask: 'Start?', options: ['continue', 'skip'] },
    read: { ...batch('sonic', 3), needs: ['accept'], when: { step: 'accept', is: 'continue' }, max_parallel: 1 },
  }) });
  assert.equal((await start(f, p)).state, 'working');
  const state = () => f.flow(p.run);
  const pool = () => stations(f, p.run).find(s => s.id === 'read');
  await until(() => state().state === 'paused', 10_000);
  assert.equal(state().steps.read.items, undefined);
  assert.equal(pool().kind, 'pool');
  assert.equal(pool().state, 'waiting');
  assert.equal(pool().count, 3);
  assert.deepEqual(pool().pool, { waiting: 3 });
  assert.equal((await reply(f, p.run, 'continue')).written, true);
  await until(() => state().steps.read.items?.[0].job, 15_000);
  const first = state().steps.read.items[0].job;
  put(join(f.dir(first), 'release-sonic'), '');
  await until(() => state().steps.read.items?.[1].job, 15_000);
  assert.equal(pool().state, 'working');
  assert.equal(pool().count, 3);
  assert.deepEqual(pool().pool, { done: 1, working: 1, waiting: 1 });
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
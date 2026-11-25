import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { startSessionWatch } from '../../dist/cli/watch.js';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { enableOptionalRoles, fixture, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as put } from '../helpers/thin-mcp-files.mjs';
import { git } from '../fixtures/managed-worktree.mjs';

const text = path => fs.readFileSync(path, 'utf8');
const json = path => JSON.parse(text(path));
const dir = (f, id) => join(f.env.HUD_HOME, 'jobs', id);
const receipt = (f, id) => json(join(dir(f, id), 'job.json'));
const brief = (f, id) => text(join(dir(f, id), 'brief.md'));
const states = (f, id) => json(join(dir(f, id), 'STATUS.json'));
const grantFile = f => join(f.env.HUD_HOME, 'council-grant.json');
async function allow(f, ...via) {
  execFileSync(process.execPath, ['bin/hud', 'council', 'allow', ...via], { env: f.env });
  return json(grantFile(f));
}
async function setup(t) {
  const f = await fixture(t);
  enableOptionalRoles(f, 'council', 'pro');
  put(join(f.env.HOME, 'hold-turn'), '');
  put(join(f.env.HOME, 'defer-pi-report'), '');
  await f.startCliSocket();
  f.grant = await allow(f);
  return f;
}
async function members(f, id) {
  await until(() => receipt(f, id).council_members.every(m => m.job || m.failure), 30000);
  return receipt(f, id).council_members;
}
function finish(f, { job }, report, failure) {
  if (report) put(join(dir(f, job), 'report.md'), report);
  put(join(dir(f, job), 'STATUS.json'), JSON.stringify({ state: failure ? 'failed' : 'closed', exit_reason: failure, ended_at: new Date().toISOString() }));
}
async function outcome(f, job) {
  await until(() => ['closed', 'failed'].includes(states(f, job).state), 30000);
  return f.call('hud_read', { job, mode: 'full' });
}

test('shipped council runs three independent members and one browser synthesis; only the council notifies', async t => {
  const f = await setup(t);
  git(f.root, 'init', '-qb', 'trunk');
  put(join(f.root, 'public.md'), 'Original tracked body.');
  put(join(f.root, 'changed.md'), 'Original committed version.');
  git(f.root, 'add', 'public.md', 'changed.md');
  git(f.root, '-c', 'user.name=Synthetic', '-c', 'user.email=test@synthetic.invalid', 'commit', '-qm', 'test');
  const commit = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'remote', 'add', 'origin', 'git@github.com:synthetic/example.git');
  git(f.root, 'update-ref', 'refs/remotes/origin/trunk', commit);
  git(f.root, 'branch', '--set-upstream-to=origin/trunk');
  put(join(f.root, 'changed.md'), 'Original modified body.');
  put(join(f.root, 'local.md'), 'Original untracked body.');
  put(join(f.root, 'brief.md'), 'Plan synthetic work.');
  const lines = [];
  t.after(startSessionWatch(f.env.HUD_HOME, f.env.HERDR_PANE_ID, f.root, batch => lines.push(...batch), 10));
  const { job } = await f.call('hud_create', { role: 'council', brief_file: 'brief.md', synthesizer: 'pro', context_files: ['public.md', 'changed.md', 'local.md'] });
  const seats = await members(f, job);
  assert.equal(f.grant.via, 'cli');
  assert.deepEqual(receipt(f, job).grant, f.grant);
  assert.equal((await f.call('hud_create', { role: 'council', task: 'Another council.' })).code, 'owner_grant_required');
  assert.deepEqual(seats.map(m => m.preset), ['fable', 'astra', 'carbon']);
  for (const [i, m] of seats.entries()) {
    assert.ok(m.job, JSON.stringify(m));
    const child = receipt(f, m.job);
    assert.deepEqual(child.council, { id: job, part: 'member' });
    assert.equal(child.instructions_from, 'oracle');
    assert.equal(child.from_jobs, undefined);
    assert.match(brief(f, m.job), /Plan synthetic work\./);
    assert.match(brief(f, m.job), /public\.md/);
    for (const other of seats.filter(o => o !== m)) assert.ok(!brief(f, m.job).includes(other.job));
    finish(f, m, `Independent idea ${i}.`);
  }
  await until(() => lines.some(l => l.includes(job)), 30000);
  const result = await outcome(f, job);
  assert.equal(result.report, 'Synthetic Jev answer.', JSON.stringify(result));
  const synth = receipt(f, result.synthesis_job), prompt = brief(f, synth.job);
  assert.deepEqual(synth.council, { id: job, part: 'synthesizer' });
  assert.deepEqual(synth.from_jobs, seats.map(m => m.job));
  for (const i of seats.keys()) assert.match(prompt, new RegExp(`Independent idea ${i}`));
  assert.match(prompt, /table of disagreements/);
  assert.match(prompt, new RegExp(`github.com/synthetic/example/blob/${commit}/public.md`));
  assert.match(prompt, /"local.md": local-only/);
  assert.match(prompt, /"changed.md": local-only/);
  assert.doesNotMatch(prompt, /Original (tracked|untracked|modified) body/);
  assert.equal(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).length, 5);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  for (const child of [...seats.map(m => receipt(f, m.job)), synth])
    archiveJob(f.env.HUD_HOME, dir(f, child.job), child.job, child, states(f, child.job), Date.now(), assert.fail);
  archiveJob(f.env.HUD_HOME, dir(f, job), job, receipt(f, job), states(f, job), Date.now(), assert.fail);
  const archive = join(f.env.HUD_HOME, 'archive');
  const rows = fs.readdirSync(archive).flatMap(file => text(join(archive, file)).trim().split('\n').map(JSON.parse));
  assert.deepEqual(rows.find(r => r.job === job).grant, f.grant);
  const children = rows.filter(r => r.job !== job);
  assert.deepEqual(children.map(r => r.council.part).sort(), ['member','member','member','synthesizer']);
  assert.ok(children.every(r => r.council.id === job && !r.grant));
});

test('shipped council defaults to main synthesis and returns member digests and instructions', async t => {
  const f = await setup(t);
  enableOptionalRoles(f, 'council');
  const { job } = await f.call('hud_create', { role: 'council', task: 'Compare plans.' });
  const seats = await members(f, job);
  const plans = seats.map(m => `Plan from ${m.preset}.`);
  seats.forEach((m, i) => finish(f, m, plans[i]));
  await until(() => states(f, job).state === 'closed', 30000);
  const result = await f.call('hud_read', { job });
  assert.deepEqual(result.members.map(m => m.digest), plans);
  assert.match(result.synthesis_template, /table of disagreements/);
  assert.equal(result.synthesis_job, undefined);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).sort(), [job, ...seats.map(m => m.job)].sort());
});

test('local synthesis with one failed member gets local references, successful reports and a failure note', async t => {
  const f = await setup(t);
  enableOptionalRoles(f, 'council');
  put(join(f.root, 'notes.md'), 'local facts');
  const { job } = await f.call('hud_create', { role: 'council', task: 'Local plan.', members: ['astra','astra','astra'], synthesizer: 'fable', context_files: ['notes.md'] });
  const seats = await members(f, job);
  seats.forEach((m,i) => finish(f, m, i ? `Local plan ${i}.` : undefined, i ? undefined : 'synthetic failure'));
  await until(() => receipt(f, job).synthesis_job, 30000);
  const child = receipt(f, receipt(f, job).synthesis_job);
  assert.equal(child.model, 'claude-fable-5-2');
  assert.equal(child.instructions_from, 'oracle');
  assert.deepEqual(child.from_jobs, seats.slice(1).map(m => m.job));
  assert.deepEqual(child.context_files, [join(f.root, 'notes.md')]);
  assert.match(brief(f, child.job), new RegExp(`${seats[0].job}.*failed — synthetic failure`));
  finish(f, child, 'Local synthesis.');
  assert.equal((await outcome(f, job)).report, 'Local synthesis.');
});

test('main synthesis returns member digests and the template with one MCP task, no extra job', async t => {
  const f = await setup(t);
  // An owner adds a model with just a new preset; the shipped presets and defaults remain usable.
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  put(join(f.env.HUD_HOME, 'roles/council.json'), JSON.stringify({ role: 'council', presets: [{ name: 'web', run: [{ harness: 'bro', tool: 'jev-ask', provider: 'gemini' }] }] }));
  const previous = await f.call('hud_create', { role: 'general', task: 'Original source.' });
  finish(f, previous, 'Local-only original report.');
  put(join(f.root, 'original.txt'), 'Local-only original file.');
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'council', task: 'Plan only.', members: ['astra', 'web'], synthesizer: 'main',
    from_jobs: [previous.job], context_files: ['original.txt'] });
  const { job } = taskJob(f, task);
  const seats = await members(f, job);
  assert.equal((await rpc('tasks/get', { taskId: task.taskId })).status, 'working');
  const browserBrief = brief(f, seats[1].job);
  assert.match(browserBrief, /^# Role: oracle/);
  assert.match(browserBrief, /independent plan/);
  assert.match(browserBrief, new RegExp(`${previous.job} report\": local-only`));
  assert.match(browserBrief, /original.txt\": local-only/);
  assert.doesNotMatch(browserBrief, /Local-only original/);
  assert.deepEqual(receipt(f, seats[0].job).from_jobs, [previous.job]);
  finish(f, seats[0], 'Member one plan.');
  await until(() => states(f, job).state === 'closed', 10000);
  assert.equal((await rpc('tasks/get', { taskId: task.taskId })).status, 'completed');
  const result = await f.call('hud_read', { job });
  assert.match(result.synthesis_template, /open questions/);
  assert.deepEqual(result.members.map(m => m.digest), ['Member one plan.', 'Synthetic Jev answer.']);
  assert.equal(result.synthesis_job, undefined);
  assert.equal(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).length, 4);
  for (const m of seats) assert.ok(!fs.existsSync(join(dir(f, m.job), 'mcp-task.json')));
});

for (const overflow of [false, true]) test(overflow ? 'browser overflow fails plainly without sending' : 'fewer than two reports fails without synthesis', async t => {
  const f = await setup(t);
  const { job } = await f.call('hud_create', { role: 'council', task: 'Plan.', members: ['astra','astra','astra'], synthesizer: 'pro' });
  const seats = await members(f, job);
  seats.forEach((m,i) => finish(f, m, overflow ? 'x'.repeat(65537) : i ? undefined : 'One plan.', !overflow && i ? `failure ${i}` : undefined));
  const result = await outcome(f, job);
  assert.equal(result.state, 'failed');
  assert.match(result.reason, overflow ? /context_too_large/ : /failure 1[\s\S]*failure 2/);
  assert.equal(result.synthesis_job, undefined);
  assert.ok(!f.commands().some(c => c.command === 'jev-ask'));
});

test('one global grant: missing and expired grants start nothing, replacement does not stack, concurrent creates admit one', async t => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'council', 'pro');
  const create = task => f.call('hud_create', { role: 'council', task, members: ['astra','astra'], synthesizer: 'main' });
  const refused = async promise => {
    const no = await promise;
    assert.equal(no.code, 'owner_grant_required');
    assert.match(no.reason, /ask the owner/i);
    assert.doesNotMatch(no.reason, /\/council|council allow/);
  };
  await refused(create('No grant.'));
  put(grantFile(f), JSON.stringify({ via: 'cli', created_at: new Date(Date.now() - 30 * 60_000).toISOString() }));
  await refused(create('Expired grant.'));
  assert.ok(!fs.existsSync(join(f.env.HUD_HOME, 'jobs')));
  await allow(f);
  const latest = await allow(f, '--via', 'claude-mod');
  assert.equal(latest.via, 'claude-mod');
  assert.equal(fs.statSync(grantFile(f)).mode & 0o777, 0o600);
  const replies = await Promise.all([create('First.'), create('Second.')]);
  const jobs = replies.filter(r => r.job);
  assert.equal(jobs.length, 1);
  assert.equal(replies.find(r => !r.job)?.code, 'owner_grant_required');
  await members(f, jobs[0].job);
  assert.deepEqual(receipt(f, jobs[0].job).grant, latest);
  await refused(create('Third.'));
});

test('all member launches refused before input leave the same grant usable', async t => {
  const f = await setup(t), fail = join(f.env.HOME, 'fail-start');
  const create = task => f.call('hud_create', { role: 'council', task, members: ['fable','fable'], synthesizer: 'main' });
  put(fail, 'Synthetic startup failure');
  const first = await create('Cannot launch members.');
  assert.equal((await outcome(f, first.job)).state, 'failed');
  assert.equal(receipt(f, first.job).grant, undefined);
  assert.deepEqual(json(grantFile(f)), f.grant);
  fs.unlinkSync(fail);
  const next = await create('Now launch.');
  for (const m of await members(f, next.job)) finish(f, m, 'Independent idea.');
  assert.equal((await outcome(f, next.job)).state, 'closed');
  assert.deepEqual(receipt(f, next.job).grant, f.grant);
});

test('disabled council, browser switch, bad count, unknown or unavailable seat start nothing', async t => {
  const f = await fixture(t);
  const create = args => f.call('hud_create', { role: 'council', task: 'Plan.', ...args });
  assert.match((await create({})).reason, /council is off.*Control/);
  const grant = await allow(f);
  enableOptionalRoles(f, 'council');
  assert.match((await create({ synthesizer: 'pro' })).reason, /Enable pro.*Control/);
  assert.match((await create({ members: ['missing','astra'] })).reason, /Unknown council preset.*Valid council presets:.*fable/);
  assert.match((await create({ members: ['astra'] })).reason, /2–5/);
  assert.match((await create({ synthesizer: 'missing' })).reason, /Unknown council preset/);
  put(join(f.env.HUD_HOME, 'harnesses.json'), JSON.stringify({ disabled: ['cli:claude'] }));
  assert.match((await create({ members: ['astra','astra'], synthesizer: 'fable' })).reason, /fable unavailable/);
  assert.deepEqual(json(grantFile(f)), grant);
  assert.ok(!fs.existsSync(join(f.env.HUD_HOME, 'jobs')));
});

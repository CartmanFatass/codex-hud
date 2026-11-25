import assert from 'node:assert/strict';
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
async function setup(t) {
  const f = await fixture(t);
  enableOptionalRoles(f, 'council', 'pro');
  put(join(f.env.HOME, 'hold-turn'), '');
  put(join(f.env.HOME, 'defer-pi-report'), '');
  await f.startCliSocket();
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
  const { job } = await f.call('hud_create', { role: 'council', brief_file: 'brief.md', context_files: ['public.md', 'changed.md', 'local.md'] });
  const seats = await members(f, job);
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
  const archive = join(f.env.HUD_HOME, 'archive');
  const rows = fs.readdirSync(archive).flatMap(file => text(join(archive, file)).trim().split('\n').map(JSON.parse));
  assert.deepEqual(rows.map(r => r.council.part).sort(), ['member','member','member','synthesizer']);
  assert.ok(rows.every(r => r.council.id === job));
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
  const { job } = await f.call('hud_create', { role: 'council', task: 'Plan.', members: ['astra','astra','astra'] });
  const seats = await members(f, job);
  seats.forEach((m,i) => finish(f, m, overflow ? 'x'.repeat(65537) : i ? undefined : 'One plan.', !overflow && i ? `failure ${i}` : undefined));
  const result = await outcome(f, job);
  assert.equal(result.state, 'failed');
  assert.match(result.reason, overflow ? /context_too_large/ : /failure 1[\s\S]*failure 2/);
  assert.equal(result.synthesis_job, undefined);
  assert.ok(!f.commands().some(c => c.command === 'jev-ask'));
});

test('disabled council, browser switch, bad count, unknown or unavailable seat start nothing', async t => {
  const f = await fixture(t);
  const create = args => f.call('hud_create', { role: 'council', task: 'Plan.', ...args });
  assert.match((await create({})).reason, /council is off.*Control/);
  enableOptionalRoles(f, 'council');
  assert.match((await create({})).reason, /Enable pro.*Control/);
  assert.match((await create({ members: ['missing','astra'] })).reason, /Unknown council preset.*Valid council presets:.*fable/);
  assert.match((await create({ members: ['astra'] })).reason, /2–5/);
  assert.match((await create({ synthesizer: 'missing' })).reason, /Unknown council preset/);
  put(join(f.env.HUD_HOME, 'harnesses.json'), JSON.stringify({ disabled: ['cli:claude'] }));
  assert.match((await create({ members: ['astra','astra'], synthesizer: 'fable' })).reason, /fable unavailable/);
  assert.ok(!fs.existsSync(join(f.env.HUD_HOME, 'jobs')));
});

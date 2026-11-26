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
  const lines = [];
  t.after(startSessionWatch(f.env.HUD_HOME, f.env.HERDR_PANE_ID, f.root, batch => lines.push(...batch), 10));
  const { job } = await f.call('hud_create', { role: 'council', task: 'Compare plans.' });
  const seats = await members(f, job);
  const plans = seats.map(m => `Plan from ${m.preset}.`);
  seats.forEach((m, i) => finish(f, m, plans[i]));
  await until(() => states(f, job).state === 'closed', 30000);
  await until(() => lines.some(l => l.includes(job)), 30000);
  assert.equal(states(f, job).reason, undefined);
  assert.equal(states(f, job).exit_reason, undefined);
  assert.equal(receipt(f, job).read_at, undefined);
  const result = await f.call('hud_read', { job });
  assert.equal(result.state, 'closed');
  assert.equal(result.reason, 'members collected by main');
  assert.equal(result.exit_reason, 'members collected by main');
  assert.deepEqual(result.members.map(m => m.digest), plans);
  assert.match(result.synthesis_template, /table of disagreements/);
  assert.equal(result.synthesis_job, undefined);
  assert.equal(states(f, job).state, 'closed');
  assert.equal(states(f, job).reason, 'members collected by main');
  assert.equal(states(f, job).exit_reason, 'members collected by main');
  assert.ok(receipt(f, job).read_at);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).sort(), [job, ...seats.map(m => m.job)].sort());

  // Reading a closed main-synthesized council that already has a reason preserves it.
  const keptId = 'j0000000000000191';
  writeSyntheticCouncil(f, keptId, {
    status: { state: 'closed', output_written: true, reason: 'existing reason', exit_reason: 'existing reason' },
    members: [
      { preset: 'fable', job: 'j0000000000000192', report: 'Plan 1.', digest: 'Plan 1.' },
      { preset: 'astra', job: 'j0000000000000193', report: 'Plan 2.', digest: 'Plan 2.' },
    ],
  });
  const kept = await f.call('hud_read', { job: keptId });
  assert.equal(kept.reason, 'existing reason');
  assert.equal(states(f, keptId).reason, 'existing reason');
  assert.equal(states(f, keptId).exit_reason, 'existing reason');
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

function writeSyntheticCouncil(f, id, { members: specs, readAt, status = { state: 'working', reason: 'Council in progress' } }) {
  const now = new Date().toISOString();
  const councilMembers = specs.map(({ preset, job, digest }) => ({ preset, job, ...(digest !== undefined ? { digest } : {}) }));
  for (const m of specs) {
    fs.mkdirSync(dir(f, m.job), { recursive: true });
    put(join(dir(f, m.job), 'job.json'), JSON.stringify({
      job: m.job, role: 'general', cwd: f.root, project_root: f.root, herdr_pane: f.env.HERDR_PANE_ID,
      parent_job: id, request_key: `council:${id}:${m.preset}`, created_at: now, dispatch_exit_code: 0, stderr_tail: '',
      council: { id, part: 'member' }, ...(m.readAt ? { read_at: m.readAt } : {}),
    }));
    put(join(dir(f, m.job), 'STATUS.json'), JSON.stringify({
      state: m.state ?? 'closed', output_written: m.report !== undefined,
      ...(m.state === 'working' ? {} : { settled_at: now, ended_at: now }),
    }));
    if (m.report !== undefined) put(join(dir(f, m.job), 'report.md'), m.report);
  }
  const task = 'Compare synthetic plans.';
  fs.mkdirSync(dir(f, id), { recursive: true });
  put(join(dir(f, id), 'brief.md'), `${task}\n\nExtra context.`);
  put(join(dir(f, id), 'job.json'), JSON.stringify({
    job: id, role: 'council', cwd: f.root, project_root: f.root, herdr_pane: f.env.HERDR_PANE_ID,
    request_key: `create:${id}`, created_at: now, task_length: task.length, dispatch_exit_code: 0, stderr_tail: '',
    council_members: councilMembers, synthesizer: 'main',
    create_options: { members: specs.map(m => m.preset), synthesizer: 'main' },
    ...(readAt ? { read_at: readAt } : {}),
  }));
  put(join(dir(f, id), 'STATUS.json'), JSON.stringify(status));
}

test('synthesizer:main council closes after main hud_read once every member has settled', async t => {
  const f = await fixture(t);
  const id = 'j0000000000000101';
  const m1 = 'j0000000000000102', m2 = 'j0000000000000103', m3 = 'j0000000000000104';
  writeSyntheticCouncil(f, id, {
    members: [
      { preset: 'fable', job: m1, report: 'Synthetic fable plan.' },
      { preset: 'astra', job: m2, report: 'Synthetic astra plan.', digest: 'Synthetic astra plan.' },
      { preset: 'carbon', job: m3, state: 'working' },
    ],
  });

  // Still working while any member has not settled.
  const mid = await f.call('hud_read', { job: id });
  assert.equal(mid.state, 'working');
  assert.equal(mid.synthesis_template, undefined);
  assert.equal(states(f, id).state, 'working');
  assert.equal(receipt(f, id).read_at, undefined);
  assert.ok((await f.call('hud_read', {})).jobs.some(j => j.job === id && j.state === 'working'));

  // Settle the last member; main's hud_read collects digests and closes the council.
  finish(f, { job: m3 }, 'Synthetic carbon plan.');
  const done = await f.call('hud_read', { job: id });
  assert.equal(done.state, 'closed');
  assert.equal(done.reason, 'members collected by main');
  assert.deepEqual(done.members.map(m => m.digest), ['Synthetic fable plan.', 'Synthetic astra plan.', 'Synthetic carbon plan.']);
  assert.match(done.synthesis_template, /table of disagreements/);
  assert.equal(done.report_exists, true);
  assert.equal(states(f, id).state, 'closed');
  assert.equal(states(f, id).reason, 'members collected by main');
  assert.ok(receipt(f, id).read_at);
  assert.ok(!(await f.call('hud_read', {})).jobs.some(j => j.job === id));
});

test('hud_close on a council parent closes it and still-running members without a SESSION.txt error', async t => {
  const f = await setup(t);
  enableOptionalRoles(f, 'council');

  // 1. Pre-existing flowless stuck council parent with already-closed members and no SESSION.txt.
  const stuckId = 'j0000000000000201';
  writeSyntheticCouncil(f, stuckId, {
    members: [
      { preset: 'fable', job: 'j0000000000000202', report: 'Member one.' },
      { preset: 'astra', job: 'j0000000000000203', report: 'Member two.' },
    ],
  });
  const closedStuck = await f.call('hud_close', { job: stuckId });
  assert.equal(closedStuck.exit_code, 0, JSON.stringify(closedStuck));
  assert.doesNotMatch(closedStuck.last_line, /SESSION\.txt/);
  assert.equal(states(f, stuckId).state, 'stopped');
  assert.equal(receipt(f, stuckId).stop_origin.actor, 'mcp');
  const closedAgain = await f.call('hud_close', { job: stuckId });
  assert.equal(closedAgain.exit_code, 0, JSON.stringify(closedAgain));
  assert.doesNotMatch(closedAgain.last_line, /SESSION\.txt/);

  // 2. Live council parent with still-running members closes both parent and members cleanly.
  const { job } = await f.call('hud_create', { role: 'council', task: 'Close live council.', members: ['astra', 'astra'], synthesizer: 'main' });
  const seats = await members(f, job);
  const closedLive = await f.call('hud_close', { job });
  assert.equal(closedLive.exit_code, 0, JSON.stringify(closedLive));
  assert.doesNotMatch(closedLive.last_line, /SESSION\.txt/);
  assert.equal(states(f, job).state, 'stopped');
  assert.ok(!f.commands().some(c => c.command === 'hud-reap' && c.args[0] === dir(f, job)));
  for (const seat of seats) {
    assert.ok(f.commands().some(c => c.command === 'hud-reap' && c.args[0] === dir(f, seat.job)),
      `expected normal hud-reap closure for running member ${seat.job}`);
    assert.equal(receipt(f, seat.job).stop_origin.actor, 'mcp');
    assert.ok(fs.existsSync(join(dir(f, seat.job), 'STATUS.json.stop-requested')));
  }
  assert.ok(!(await f.call('hud_read', {})).jobs.some(j => j.job === job));
});

test('stuck pre-existing council records with settled members and a prior read settle on the next watcher pass', async t => {
  const f = await fixture(t);
  const prior = new Date(Date.now() - 60_000).toISOString();
  const parentReadId = 'j0000000000000301';
  const membersReadId = 'j0000000000000311';
  const unreadId = 'j0000000000000321';

  // Prior read recorded on the parent council receipt.
  writeSyntheticCouncil(f, parentReadId, {
    readAt: prior,
    members: [
      { preset: 'fable', job: 'j0000000000000302', report: 'Parent-read member 1.' },
      { preset: 'astra', job: 'j0000000000000303', report: 'Parent-read member 2.' },
    ],
  });
  // No read_at on parent, but all settled members were read by main (matches legacy stuck records).
  writeSyntheticCouncil(f, membersReadId, {
    members: [
      { preset: 'fable', job: 'j0000000000000312', report: 'Members-read plan 1.', readAt: prior },
      { preset: 'astra', job: 'j0000000000000313', report: 'Members-read plan 2.', digest: 'Members-read plan 2.', readAt: prior },
      { preset: 'carbon', job: 'j0000000000000314', report: 'Members-read plan 3.', readAt: prior },
    ],
  });
  // Settled members with no prior read stay working until main reads them.
  writeSyntheticCouncil(f, unreadId, {
    members: [
      { preset: 'fable', job: 'j0000000000000322', report: 'Unread member 1.' },
      { preset: 'astra', job: 'j0000000000000323', report: 'Unread member 2.' },
    ],
  });

  // Trigger the watcher via hud_read list.
  await f.call('hud_read', {});
  await until(() => states(f, parentReadId).state === 'closed' && states(f, membersReadId).state === 'closed', 15000);

  for (const id of [parentReadId, membersReadId]) {
    assert.equal(states(f, id).state, 'closed');
    assert.equal(states(f, id).reason, 'members collected by main');
    assert.ok(fs.existsSync(join(dir(f, id), 'report.md')));
    assert.ok(receipt(f, id).read_at);
    assert.ok(receipt(f, id).read_report_stamp);
  }
  assert.deepEqual(receipt(f, membersReadId).council_members.map(m => m.digest), [
    'Members-read plan 1.', 'Members-read plan 2.', 'Members-read plan 3.',
  ]);
  assert.equal(states(f, unreadId).state, 'working');

  const list = await f.call('hud_read', {});
  assert.deepEqual(list.jobs.map(j => j.job), [unreadId]);
  const summaryFile = join(f.env.HUD_HOME, 'display', 'work-summary.v1.json');
  await until(() => fs.existsSync(summaryFile) && json(summaryFile).global.running === 1, 15000);
  assert.equal(json(summaryFile).global.running, 1);

  // Reading the unread council settles it as well.
  const collected = await f.call('hud_read', { job: unreadId });
  assert.equal(collected.state, 'closed');
  assert.equal(collected.reason, 'members collected by main');
  assert.deepEqual((await f.call('hud_read', {})).jobs, []);
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { configureFakeDecision, fakeDecisionServer, fixture, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const role = 'frontend-imp';
const pi = model => ({ harness: 'pi', pi_role: 'implementer', model: `synthetic/${model}` });
const frontend = { role, instructions: 'implementer', can_continue: true, run: [pi('owner')] };
const read = (file) => fs.readFileSync(file, 'utf8');
const record = (job) => JSON.parse(read(join(job.task_dir, 'job.json')));
const brief = (job) => read(join(job.task_dir, 'brief.md'));
const create = (f, task, options) => f.call('hud_create', { role, task, ...options });
function poolFixture(f) {
  const dir = join(f.env.HOME, 'style-pool');
  fs.mkdirSync(dir);
  write(join(dir, 'accent.md'), '# Accent\nSmall visual accents.\n## Details\nNot for the Decision API.\n');
  write(join(dir, 'columns.md'), '# Columns\n' + 'é'.repeat(210));
  write(join(dir, 'neutral.md'), '# Neutral\nThe quick default.\n');
  write(join(dir, 'type-scale.md'), '# Type scale\nFor text-heavy screens.\n');
  return { dir, max: 4, default: ['neutral.md'] };
}
function ownerRole(f, definition) {
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  write(join(roles, `${definition.role}.json`), JSON.stringify(definition));
}
function picked(body, names) {
  return { answers: body.questions.map(({ name, choices }, i) => {
    const choice = names[i] ?? 'NONE';
    return { name, type: 'choice', choice, confidence: 1,
      probabilities: choices.map(({ value }) => ({ value, probability: value === choice ? 1 : 0 })) };
  }) };
}

test('pool Decision uses a bounded index; valid picks are referenced, recorded and archived', async t => {
  const f = await fixture(t);
  const api = await fakeDecisionServer(t, body => picked(body, ['type-scale.md', 'unknown.md', 'accent.md', 'type-scale.md']));
  configureFakeDecision(f, api.baseUrl);
  const pool = poolFixture(f);
  ownerRole(f, { ...frontend, pool, active_preset: 'daily', presets: [{ name: 'daily', run: [pi('daily')] }] });
  const rules = 'Use accent when it complements the primary entry.\n'.padEnd(8192, 'x');
  write(join(pool.dir, 'README.md'), rules + '\nNot part of the rules excerpt.');
  for (let i = 1; i <= 61; i++) write(join(pool.dir, `z${String(i).padStart(2, '0')}.md`), '# Extra\n');
  fs.symlinkSync(join(pool.dir, 'neutral.md'), join(pool.dir, 'alias.md'));
  const task = 'Build a dashboard. '.padEnd(4000, 'x') + ' Do not send this suffix.';
  const job = await create(f, task);
  assert.equal(job.pool_pick.source, 'decision');
  assert.deepEqual(job.pool_pick.entries, ['type-scale.md', 'accent.md']);
  assert.equal(job.pool_pick.reason, 'Decision: Type scale + Accent');
  assert.ok(Number.isInteger(job.pool_pick.ms) && job.pool_pick.ms >= 0);
  const jobRecord = record(job);
  assert.deepEqual(jobRecord.pool_pick, job.pool_pick);
  assert.equal(jobRecord.model, 'synthetic/daily', 'selecting a preset preserves the owner pool');
  const context = brief(job).slice(task.length);
  assert.ok(context.includes(`- ${JSON.stringify(join(pool.dir, 'type-scale.md'))}\n- ${JSON.stringify(join(pool.dir, 'accent.md'))}`));
  assert.doesNotMatch(context, /unknown\.md|neutral\.md|Small visual accents/);

  assert.equal(api.requests.length, 1);
  const body = api.requests[0];
  assert.equal(body.prompt_cache_key, 'pool-pick');
  const data = body.input[0].content.filter(item => item.type === 'input_json').map(item => item.data);
  assert.equal(data[0].page.text, task.slice(0, 4000));
  const facts = data[1].facts;
  const { index, selection_rules } = facts;
  assert.equal(selection_rules, rules);
  assert.equal(index.length, 64);
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) <= 48 * 1024);
  assert.deepEqual(index[0], { name: 'accent.md', title: 'Accent', header: 'Small visual accents.' });
  assert.ok(Buffer.byteLength(index[1].name + index[1].title + index[1].header) <= 400);
  assert.doesNotMatch(index[1].header, /\uFFFD/);
  assert.doesNotMatch(JSON.stringify(body), /Not for the Decision API|alias\.md|z61\.md/);
  assert.equal(body.questions.length, 4);
  assert.match(body.questions[0].instructions, /untrusted data/);
  assert.deepEqual(body.questions[0].choices.map(({ value }) => value), index.map(({ name }) => name));
  assert.equal(body.questions[1].choices.at(-1).value, 'NONE');
  assert.deepEqual((await create(f, task)).pool_pick, job.pool_pick);
  assert.equal(api.requests.length, 1);

  const ended_at = '2026-11-25T00:00:00.000Z';
  archiveJob(f.env.HUD_HOME, job.task_dir, job.job, jobRecord, { state: 'closed', ended_at }, Date.parse(ended_at), assert.fail);
  const archived = JSON.parse(read(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl')));
  assert.equal(archived.job, job.job);
  assert.deepEqual(archived.pool_pick, job.pool_pick);
  assert.equal(archived.pool_files, undefined);
});

test('named entries skip the API; unrelated roles, disabled selection and API failure behave independently', async t => {
  const f = await fixture(t);
  const api = await fakeDecisionServer(t, () => ({ status: 503 }));
  configureFakeDecision(f, api.baseUrl);
  const pool = poolFixture(f);
  ownerRole(f, { ...frontend, pool });
  write(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.root, registered_at: new Date().toISOString() }] }));
  const projectRoles = join(f.root, '.hud', 'roles');
  fs.mkdirSync(projectRoles, { recursive: true });
  write(join(projectRoles, `${role}.json`), JSON.stringify({ ...frontend, run: [pi('project')] }));

  const named = await create(f, 'Build a dashboard. '.padEnd(4000, 'x') + ' Use `accent.md` and type-scale. Ignore columns.css.');
  assert.equal(named.pool_pick.source, 'brief');
  assert.deepEqual(named.pool_pick.entries, ['accent.md', 'type-scale.md']);
  assert.ok(brief(named).includes(JSON.stringify(join(pool.dir, 'accent.md'))));
  assert.equal(record(named).model, 'synthetic/project', 'project launch override retains the owner pool');
  const unrelated = await create(f, 'Build an unrelated dashboard.', { role: 'general' });
  assert.equal(unrelated.pool_pick, undefined);
  write(join(projectRoles, 'project-only.json'), JSON.stringify({ ...frontend, role: 'project-only', pool }));
  const refused = await create(f, 'Try a project-only pool.', { role: 'project-only' });
  assert.equal(refused.code, 'role_unavailable');
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ poolPick: false }));
  const disabled = await create(f, 'Build a dashboard with the picker off.');
  assert.equal(disabled.pool_pick.source, 'default');
  assert.deepEqual(disabled.pool_pick.entries, pool.default);
  assert.ok(brief(disabled).includes(JSON.stringify(join(pool.dir, 'neutral.md'))));
  assert.equal(api.requests.length, 0);

  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ poolPick: true }));
  const failed = await create(f, 'Build a dashboard with picker unavailable.');
  assert.equal(api.requests.length, 1);
  assert.equal(failed.pool_pick.source, 'default');
  assert.deepEqual(failed.pool_pick.entries, pool.default);
  assert.ok(brief(failed).includes(JSON.stringify(join(pool.dir, 'neutral.md'))));
});

test('timeout falls back once at create and the queued launch retains the original pick', async t => {
  const f = await fixture(t);
  const api = await fakeDecisionServer(t, () => new Promise(() => {}));
  configureFakeDecision(f, api.baseUrl);
  const pool = poolFixture(f);
  ownerRole(f, { ...frontend, pool });
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { [role]: 1 } }));
  const first = await create(f, 'Use accent.');
  assert.equal(first.pool_pick.source, 'brief');
  const queued = await create(f, 'Build a queued dashboard.');
  assert.equal(queued.state, 'queued');
  assert.equal(queued.pool_pick.source, 'default');
  assert.match(queued.pool_pick.reason, /timed out/);
  assert.deepEqual(queued.pool_pick.entries, pool.default);

  ownerRole(f, { ...frontend, pool: { ...pool, default: ['columns.md'] } });
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { [role]: 0 } }));
  await until(() => record(queued).dispatch_exit_code === 0, t.signal);
  assert.deepEqual(record(queued).pool_pick, queued.pool_pick);
  assert.ok(brief(queued).includes(JSON.stringify(join(pool.dir, 'neutral.md'))));
  assert.equal(api.requests.length, 1);
});

test('browser pool references are bounded inline and task creates return pool picks', async t => {
  const f = await fixture(t);
  const pool = poolFixture(f);
  ownerRole(f, { role: 'pro', run: [{ harness: 'bro', tool: 'jev-ask', provider: 'chatgpt' }], pool });
  const task = 'Use accent.';
  const path = join(pool.dir, 'accent.md');
  write(path, '# Accent\n' + 'é'.repeat(32 * 1024));
  const oversized = await create(f, task, { role: 'pro' });
  assert.equal(oversized.code, 'context_too_large');
  const body = '# Accent\n````\nSynthetic example\n````\n';
  write(path, body);
  const browser = await create(f, task, { role: 'pro' });
  assert.equal(browser.pool_pick.source, 'brief');
  assert.equal(brief(browser), `${task}\n\n## Context\n\n### ${JSON.stringify(path)}\n\n\`\`\`\`\`\n${body}\`\`\`\`\`\n`);

  ownerRole(f, { ...frontend, pool });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const receipt = await taskCall(rpc, 'hud_create', { role, task });
  assert.equal(receipt.resultType, 'task');
  assert.deepEqual(receipt.pool_pick.entries, ['accent.md']);
  assert.deepEqual(record(taskJob(f, receipt)).pool_pick, receipt.pool_pick);
});

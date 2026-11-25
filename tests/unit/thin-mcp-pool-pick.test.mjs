import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
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
const create = (f, task, options) => f.call('hud_create', { role, task, scouts: [], ...options });
const poolEntry = (job) => job.prewalk?.find(entry => entry.kind === 'pool');
function poolFixture(f) {
  const dir = join(f.env.HOME, 'style-pool');
  fs.mkdirSync(dir);
  write(join(dir, 'colour-accent.md'), '# Accent\nKind: personal tool · Status: candidate\nFits: working tools\nNot metadata.\n## Details\nNot for the Decision API.\n');
  write(join(dir, 'layout-columns.md'), '# Columns\nFits: ' + 'é'.repeat(210));
  write(join(dir, 'style-poster.md'), '# Poster\nKind: showcase\n');
  write(join(dir, 'theme-grey.md'), '# Grey\nKind: either\nStatus: seen\n');
  return { dir, max: 4 };
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
test('new look uses a bounded index, drops unknown and incompatible choices, and keeps pool dimension order', async t => {
  const f = await fixture(t, { autoPrewalk: true });
  const api = await fakeDecisionServer(t, body => picked(body, ['new', 'personal', 'colour-accent.md', 'unknown.md', 'style-poster.md', 'theme-grey.md']));
  configureFakeDecision(f, api.baseUrl);
  const pool = poolFixture(f);
  ownerRole(f, { ...frontend, pool, active_preset: 'daily', presets: [{ name: 'daily', run: [pi('daily')] }] });
  const rules = 'Theme: [grey](theme-grey.md)\nColour: [accent](colour-accent.md)\n'.padEnd(8192, 'x');
  write(join(pool.dir, 'README.md'), rules + '\nNot part of the rules excerpt.');
  for (let i = 1; i <= 61; i++) write(join(pool.dir, `z${String(i).padStart(2, '0')}.md`), '# Extra\n');
  fs.symlinkSync(join(pool.dir, 'theme-grey.md'), join(pool.dir, 'alias.md'));
  const task = 'Build a dashboard. '.padEnd(4000, 'x') + ' Do not send this suffix.';
  const job = await create(f, task);
  const { ms, ...pick } = poolEntry(job);
  assert.ok(Number.isInteger(ms) && ms >= 0);
  assert.deepEqual(pick, { kind: 'pool', source: 'decision', result: 'attached', need: 'new', pool_kind: 'personal',
    entries: ['theme-grey.md', 'colour-accent.md'],
    dropped: [{ entry: 'unknown.md', reason: 'unknown' }, { entry: 'style-poster.md', reason: 'kind' }] });
  assert.equal(job.pick_summary, 'pick: personal · theme-grey + colour-accent');
  const jobRecord = record(job);
  assert.deepEqual(jobRecord.prewalk, job.prewalk);
  assert.equal(jobRecord.model, 'synthetic/daily', 'selecting a preset preserves the owner pool');
  const context = brief(job).slice(task.length);
  assert.ok(context.includes(`- ${JSON.stringify(join(pool.dir, 'theme-grey.md'))}\n- ${JSON.stringify(join(pool.dir, 'colour-accent.md'))}`));
  assert.doesNotMatch(context, /unknown\.md|style-poster\.md|working tools/);

  const poolRequests = api.requests.filter(req => req.prompt_cache_key === 'pool-pick');
  assert.equal(poolRequests.length, 1);
  const body = poolRequests[0];
  const data = body.input[0].content.filter(item => item.type === 'input_json').map(item => item.data);
  assert.equal(data[0].page.text, task.slice(0, 4000));
  const facts = data[1].facts;
  const { index, selection_rules } = facts;
  assert.deepEqual(Object.keys(facts).sort(), ['index', 'project', 'role', 'selection_rules']);
  assert.equal(facts.role, role);
  assert.equal(facts.project, basename(f.root));
  assert.equal(selection_rules, rules);
  assert.equal(index.length, 64);
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) <= 48 * 1024);
  assert.deepEqual(index[0], { name: 'colour-accent.md', title: 'Accent', kind: 'personal tool', status: 'candidate', fits: 'working tools' });
  assert.ok(Buffer.byteLength(index[1].name + index[1].title + index[1].fits) <= 400);
  assert.doesNotMatch(index[1].fits, /\uFFFD/);
  assert.doesNotMatch(JSON.stringify(body), /Not for the Decision API|Not metadata|alias\.md|z61\.md/);
  assert.deepEqual(body.questions.map(({ name }) => name), ['need', 'kind', 'pool_pick_1', 'pool_pick_2', 'pool_pick_3', 'pool_pick_4']);
  assert.ok(body.questions.every(q => q.type === 'choice' && /untrusted data/.test(q.instructions)));
  const values = question => question.choices.map(({ value }) => value);
  assert.deepEqual(values(body.questions[0]), ['existing', 'new']);
  assert.deepEqual(values(body.questions[1]), ['personal', 'showcase']);
  assert.deepEqual(values(body.questions[2]), [...index.map(({ name }) => name), 'NONE']);
  assert.match(body.questions[2].instructions, /If need is existing, choose NONE.*If need is new.*required/);
  assert.deepEqual((await create(f, task)).prewalk, job.prewalk);
  assert.equal(api.requests.filter(req => req.prompt_cache_key === 'pool-pick').length, 1);

  const ended_at = '2026-11-25T00:00:00.000Z';
  archiveJob(f.env.HUD_HOME, job.task_dir, job.job, jobRecord, { state: 'closed', ended_at }, Date.parse(ended_at), assert.fail);
  const archived = JSON.parse(read(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl')));
  assert.equal(archived.job, job.job);
  assert.deepEqual(archived.prewalk, job.prewalk);
  assert.equal(archived.pool_files, undefined);
});

test('existing look ignores ranked slots, and a new look can have no surviving entries', async t => {
  const f = await fixture(t, { autoPrewalk: true });
  let poolCount = 0;
  const api = await fakeDecisionServer(t, body => picked(body, [++poolCount === 1 ? 'existing' : 'new', 'personal', 'style-poster.md']));
  configureFakeDecision(f, api.baseUrl);
  const pool = poolFixture(f);
  ownerRole(f, { ...frontend, pool });

  const existing = await create(f, 'Add filters to the existing dashboard.');
  assert.deepEqual(poolEntry(existing), { kind: 'pool', source: 'decision', result: 'none', need: 'existing', pool_kind: 'personal', entries: [], ms: poolEntry(existing).ms });
  assert.equal(existing.pick_summary, 'pick: none (existing look)');
  assert.deepEqual(record(existing).pool_files, []);
  assert.doesNotMatch(brief(existing), /Context References/);

  const newLook = await create(f, 'Design a new dashboard.');
  assert.equal(poolEntry(newLook).need, 'new');
  assert.equal(poolEntry(newLook).result, 'none');
  assert.deepEqual(poolEntry(newLook).entries, []);
  assert.deepEqual(poolEntry(newLook).dropped, [{ entry: 'style-poster.md', reason: 'kind' }]);
  assert.equal(newLook.pick_summary, 'pick: none (no valid entries)');
  assert.doesNotMatch(brief(newLook), /Context References/);
  assert.equal(poolCount, 2);
});

test('explicit entries and registered project design skip the API; switches take precedence', async t => {
  const f = await fixture(t, { autoPrewalk: true });
  const api = await fakeDecisionServer(t, () => ({ status: 503 }));
  configureFakeDecision(f, api.baseUrl);
  const pool = poolFixture(f);
  ownerRole(f, { ...frontend, pool });
  write(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.root, registered_at: new Date().toISOString() }] }));
  const projectRoles = join(f.root, '.hud', 'roles');
  fs.mkdirSync(projectRoles, { recursive: true });
  write(join(projectRoles, `${role}.json`), JSON.stringify({ ...frontend, run: [pi('project')] }));
  const design = 'design.md';
  const projectFile = join(f.root, '.hud', 'project.json');
  write(join(f.root, design), '# Established design\n');
  write(projectFile, JSON.stringify({ design }));

  const named = await create(f, 'Build a dashboard. '.padEnd(4000, 'x') + ' Use `colour-accent.md` and theme-grey. Ignore layout-columns.css.');
  assert.equal(poolEntry(named).source, 'brief');
  assert.equal(poolEntry(named).result, 'attached');
  assert.deepEqual(poolEntry(named).entries, ['colour-accent.md', 'theme-grey.md']);
  assert.ok(brief(named).includes(JSON.stringify(join(pool.dir, 'colour-accent.md'))));
  assert.doesNotMatch(brief(named), /design\.md/);
  assert.equal(record(named).model, 'synthetic/project', 'project launch override retains the owner pool');
  const established = await create(f, 'Build a second dashboard.');
  assert.deepEqual(poolEntry(established), { kind: 'pool', source: 'project', result: 'attached', need: 'existing', pool_kind: null, entries: [design], ms: poolEntry(established).ms });
  assert.equal(established.pick_summary, 'pick: project design · design.md');
  assert.ok(brief(established).includes(JSON.stringify(join(f.root, design))));
  assert.doesNotMatch(brief(established), /style-pool/);
  const unrelated = await create(f, 'Build an unrelated dashboard.', { role: 'general', scouts: undefined });
  assert.equal(unrelated.prewalk, undefined);
  write(join(projectRoles, 'project-only.json'), JSON.stringify({ ...frontend, role: 'project-only', pool }));
  const refused = await create(f, 'Try a project-only pool.', { role: 'project-only' });
  assert.equal(refused.code, 'role_unavailable');

  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ poolPick: false }));
  const disabled = await create(f, 'Use colour-accent with the picker off.');
  assert.equal(poolEntry(disabled), undefined);
  assert.doesNotMatch(brief(disabled), /Context References/);
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, poolPick: true }));
  const autoOff = await create(f, 'Use colour-accent with autoPrewalk off.', { scouts: undefined });
  assert.equal(autoOff.prewalk, undefined);
  assert.doesNotMatch(brief(autoOff), /Context References/);
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: true, poolPick: true }));
  ownerRole(f, { ...frontend, pool, prewalk: 'off' });
  const prewalkOff = await create(f, 'Use colour-accent with prewalk off.', { scouts: undefined });
  assert.equal(prewalkOff.prewalk, undefined);
  assert.doesNotMatch(brief(prewalkOff), /Context References/);
  ownerRole(f, { ...frontend, pool });
  write(projectFile, JSON.stringify({ design: '../outside.md' }));
  const invalidDesign = await create(f, 'Build with an invalid project reference.');
  assert.equal(poolEntry(invalidDesign).source, 'project');
  assert.equal(poolEntry(invalidDesign).result, 'failed');
  assert.equal(invalidDesign.pick_summary, 'pick: none (project design unavailable)');
  assert.doesNotMatch(brief(invalidDesign), /Context References/);
  assert.equal(api.requests.filter(req => req.prompt_cache_key === 'pool-pick').length, 0);

  write(projectFile, '{}');
  const failed = await create(f, 'Build a dashboard with picker unavailable.');
  assert.equal(api.requests.filter(req => req.prompt_cache_key === 'pool-pick').length, 1);
  assert.equal(poolEntry(failed).source, 'decision');
  assert.equal(poolEntry(failed).result, 'failed');
  assert.deepEqual(poolEntry(failed).entries, []);
  assert.doesNotMatch(brief(failed), /Context References/);

  // Use a non-default-scout role (pro) to verify pool-pick with no credentials without launching a fallback code scout.
  ownerRole(f, { role: 'pro', run: [{ harness: 'bro', tool: 'jev-ask', provider: 'chatgpt' }], pool });
  fs.unlinkSync(join(f.env.HUD_HOME, 'credentials.env'));
  const noApi = await create(f, 'Build a dashboard without a configured decision provider.', { role: 'pro' });
  assert.equal(poolEntry(noApi).source, 'decision');
  assert.equal(poolEntry(noApi).result, 'failed');
  assert.doesNotMatch(brief(noApi), /Context References/);
  assert.equal(api.requests.filter(req => req.prompt_cache_key === 'pool-pick').length, 1);
});

test('timeout attaches nothing once at create and the queued launch retains the original pick', async t => {
  const f = await fixture(t, { autoPrewalk: true });
  const api = await fakeDecisionServer(t, () => new Promise(() => {}));
  configureFakeDecision(f, api.baseUrl);
  const pool = poolFixture(f);
  ownerRole(f, { ...frontend, pool });
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { [role]: 1 } }));
  const first = await create(f, 'Use colour-accent.');
  assert.equal(poolEntry(first).source, 'brief');
  const queued = await create(f, 'Build a queued dashboard.');
  assert.equal(queued.state, 'queued');
  assert.equal(poolEntry(queued).source, 'decision');
  assert.equal(poolEntry(queued).result, 'failed');
  assert.equal(queued.pick_summary, 'pick: none (pick unavailable)');
  assert.deepEqual(poolEntry(queued).entries, []);

  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { [role]: 0 } }));
  await until(() => record(queued).dispatch_exit_code === 0, t.signal);
  assert.deepEqual(record(queued).prewalk, queued.prewalk);
  assert.doesNotMatch(brief(queued), /Context References/);
  assert.equal(api.requests.filter(req => req.prompt_cache_key === 'pool-pick').length, 1);
});

test('browser pool references are bounded inline and task receipts show the pick', async t => {
  const f = await fixture(t, { autoPrewalk: true });
  const pool = poolFixture(f);
  ownerRole(f, { role: 'pro', run: [{ harness: 'bro', tool: 'jev-ask', provider: 'chatgpt' }], pool });
  const task = 'Use colour-accent.';
  const path = join(pool.dir, 'colour-accent.md');
  write(path, '# Accent\n' + 'é'.repeat(32 * 1024));
  const oversized = await create(f, task, { role: 'pro' });
  assert.equal(oversized.code, 'context_too_large');
  const body = '# Accent\n````\nSynthetic example\n````\n';
  write(path, body);
  const browser = await create(f, task, { role: 'pro' });
  assert.equal(poolEntry(browser).source, 'brief');
  assert.equal(brief(browser), `${task}\n\n## Context\n\n### ${JSON.stringify(path)}\n\n\`\`\`\`\`\n${body}\`\`\`\`\`\n`);

  ownerRole(f, { ...frontend, pool });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const receipt = await taskCall(rpc, 'hud_create', { role, task, scouts: [] });
  assert.equal(receipt.resultType, 'task');
  assert.deepEqual(poolEntry(receipt).entries, ['colour-accent.md']);
  assert.equal(receipt.pick_summary, 'pick: colour-accent');
  assert.match(receipt.statusMessage, /pick: colour-accent$/);
  assert.deepEqual(record(taskJob(f, receipt)).prewalk, receipt.prewalk);
});

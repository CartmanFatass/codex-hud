import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { markExhausted } from '../../dist/roles/roster.js';
import { defaultSettings } from '../../dist/settings.js';
import { SETTING_ROWS, resetSettingsGroup } from '../../dist/render/settings-page.js';
import { cardText, configureFakeDecision, fakeDecisionServer, fixture, until, waitFixtureJob, workerFor } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const pi = model => ({ harness: 'pi', pi_role: 'implementer', model: `synthetic/${model}`, thinking: 'high' });
const light = { use: 'Small edits on an existing pattern', preset: 'small' };
const standard = { use: 'Ordinary slices' };
const hard = { use: 'Cross-module and process lifecycle work', preset: 'deep' };
const modes = { tab: 'Likely questions or long runs', headless: 'Likely one shot' };
const routing = { light, standard, hard, modes };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const receipt = job => read(join(job.task_dir, 'job.json'));
const create = (f, task, options = {}) => f.call('hud_create', { role: 'imp', task, ...options });
const settings = (f, patch) => write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ impRouting: true, roleCaps: { imp: 0 }, ...patch }));
function role(f, routing, small = pi('small')) {
  const dir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  write(join(dir, 'imp.json'), JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true,
    run: [pi('file-run')], active_preset: 'daily', routing, presets: [
      { name: 'small', run: [small] }, { name: 'deep', run: [pi('deep')] }, { name: 'daily', run: [pi('daily')] },
    ] }));
}
function answer(body, tier, mode) {
  return { answers: body.questions.map(({ name, choices }) => {
    const choice = name === 'tier' ? tier : mode;
    return { name, type: 'choice', choice, confidence: 1,
      probabilities: choices.map(({ value }) => ({ value, probability: value === choice ? 1 : 0 })) };
  }) };
}
async function setup(t, handler) {
  const f = await fixture(t);
  const api = await fakeDecisionServer(t, handler);
  configureFakeDecision(f, api.baseUrl);
  settings(f);
  return { f, api };
}

test('Imp routing is an opt-in Models setting and resets to off', () => {
  assert.equal(defaultSettings().impRouting, false);
  assert.ok(SETTING_ROWS.some(row => row.group === 'Models' && row.key === 'impRouting'));
  assert.equal(resetSettingsGroup({ ...defaultSettings(), impRouting: true }, 'Models').impRouting, false);
});

test('one-file brief chooses light/headless and cross-module brief chooses hard/tab; inputs are bounded metadata', async t => {
  const { f, api } = await setup(t, body => JSON.stringify(body).includes('Cross-module rewrite')
    ? answer(body, 'hard', 'tab') : answer(body, 'light', 'headless'));
  role(f, routing);
  write(join(f.root, 'doc.md'), 'Synthetic private body.');
  const ticketDir = join(f.root, '.scratch', 'sample', 'issues');
  fs.mkdirSync(ticketDir, { recursive: true });
  write(join(ticketDir, '01-doc.md'), '# 01: Synthetic ticket body');
  const doc = await create(f, 'Adjust one line in doc.md.', { ticket: 'sample/01', context_files: ['doc.md'] });
  assert.deepEqual(doc.route, { tier: 'light', mode: 'headless', reason: `${light.use}; ${modes.headless}`, source: 'decision' });
  assert.equal(receipt(doc).model, 'synthetic/small');
  assert.equal(receipt(doc).headless, true);
  assert.deepEqual(receipt(doc).route, doc.route);
  assert.deepEqual((await f.call('hud_read', { job: doc.job })).route, doc.route);
  assert.match(cardText(workerFor(f, doc.job)), /Route: light · headless/);
  assert.equal(f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create'), false);

  const wire = api.requests[0];
  const { facts } = wire.input[0].content.find(row => row.data?.facts).data;
  assert.deepEqual(facts, { ticket: '# 01: Synthetic ticket body', context_files: [{ name: 'doc.md', bytes: 23 }] });
  assert.doesNotMatch(JSON.stringify(wire), /Synthetic private body|synthetic\/small|synthetic\/daily/);
  assert.deepEqual(wire.questions.map(q => q.name), ['tier', 'mode']);

  const complex = await create(f, 'Cross-module rewrite of the launch lifecycle.');
  assert.equal(complex.route.tier, 'hard');
  assert.equal(complex.route.mode, 'tab');
  assert.equal(receipt(complex).model, 'synthetic/deep');
  assert.equal(api.requests.length, 2);
});

test('shipped light uses Antigravity headless; a harness without headless support uses a tab', async t => {
  const { f } = await setup(t, body => answer(body, 'light', 'headless'));
  f.overrideBin('agy', `#!${process.execPath}
const args = process.argv.slice(2);
if (!args.includes('--output-format') || args[args.indexOf('--output-format') + 1] !== 'stream-json' || args.at(-2) !== '-p') process.exit(1);
console.log(JSON.stringify({ event: 'init', conversation_id: 'synthetic-routing' }));
`);
  const doc = await create(f, 'Fix one line in the guide.');
  assert.equal(doc.route.tier, 'light');
  assert.equal(doc.route.mode, 'headless');
  assert.equal(doc.route.mode_reason, undefined);
  assert.equal(receipt(doc).model, 'gemini-4-hydrogen-high');
  assert.equal(receipt(doc).cli.agent, 'agy');
  const output = join(doc.task_dir, 'stdout.jsonl');
  await until(() => fs.readFileSync(output, 'utf8').includes('synthetic-routing'));
  assert.equal(f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create'), false);

  role(f, routing, { harness: 'cli', agent: 'codex', model: 'synthetic-small' });
  const tab = await create(f, 'Fix a different line in the guide.');
  assert.equal(tab.route.tier, 'light');
  assert.equal(tab.route.mode, 'tab');
  assert.match(tab.route.mode_reason, /headless/);
  assert.equal(receipt(tab).cli.agent, 'codex');
});

test('a winning role without routing never asks; unlisted tiers are not offered or accepted', async t => {
  const { f, api } = await setup(t, body => answer(body, 'light', 'tab'));
  role(f, undefined);
  assert.equal((await create(f, 'An owner role without routing.')).route, undefined);
  assert.equal(api.requests.length, 0);
  role(f, { standard, modes });
  const invalid = await create(f, 'The stub returns an unoffered tier.');
  assert.deepEqual(api.requests[0].questions[0].choices.map(c => c.value), ['standard', 'NONE']);
  assert.equal(invalid.route.tier, 'standard');
  assert.equal(invalid.route.source, 'default');
  assert.match(invalid.route.reason, /invalid/);
  assert.equal(receipt(invalid).model, 'synthetic/daily');
});

test('disabled, exhausted, and pre-input failures fall back to the active preset in a tab', async t => {
  const { f, api } = await setup(t, body => answer(body, 'light', 'headless'));
  role(f, routing, { harness: 'cli', agent: 'agy', model: 'synthetic-small' });
  const harnesses = join(f.env.HUD_HOME, 'harnesses.json');
  write(harnesses, JSON.stringify({ disabled: ['cli:agy'] }));
  const off = await create(f, 'Small work with disabled tier.');
  write(harnesses, '{}');
  write(join(f.env.HOME, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ trustedWorkspaces: [] }));
  const failed = await create(f, 'Small work with a refused launch.');
  assert.equal(failed.attempts.length, 2);
  assert.match(failed.attempts[0].reason, /has not trusted/);
  markExhausted(f.env.HUD_HOME, 'cli:agy:synthetic-small', 'rate limit');
  const quota = await create(f, 'Small work with exhausted quota.');
  assert.equal(quota.attempts.length, 1);
  for (const result of [off, failed, quota]) {
    assert.equal(result.route.source, 'decision');
    assert.equal(result.route.tier, 'standard');
    assert.equal(result.route.mode, 'tab');
    assert.match(result.route.fallback, /light.*standard/);
    assert.equal(receipt(result).model, 'synthetic/daily');
  }
  assert.equal(api.requests.length, 3);
});

test('a pre-input headless launch failure falls through to a tab on the standard preset', async t => {
  const { f } = await setup(t, body => answer(body, 'light', 'headless'));
  role(f, routing);
  f.overrideBin('pi-role', '#!/bin/sh\ncase " $* " in\n  *" synthetic/small "*) echo "Synthetic headless launcher failure" >&2; exit 1;;\nesac\nexec node "$FAKE_BIN" pi-role "$@"\n');
  const result = await create(f, 'Small work with a refused headless launch.');
  assert.equal(result.attempts.length, 2);
  assert.match(result.attempts[0].reason, /headless launcher failure/);
  assert.equal(result.route.tier, 'standard');
  assert.equal(result.route.mode, 'tab');
  assert.match(result.route.fallback, /light.*standard/);
  assert.equal(receipt(result).headless, undefined);
  assert.equal(receipt(result).model, 'synthetic/daily');
});

test('API error and timeout are visible; explicit headless wins and asks only for tier', { timeout: 18000 }, async t => {
  const { f, api } = await setup(t, (body, n) => n === 1 ? { status: 400 }
    : n === 2 ? new Promise(() => {}) : answer(body, 'light', 'tab'));
  role(f, routing);
  for (const [task, reason] of [['Synthetic API error dispatch.', /unavailable/], ['Synthetic timeout dispatch.', /timed out/]]) {
    const result = await create(f, task);
    assert.equal(result.route.source, 'default');
    assert.equal(result.route.mode, 'tab');
    assert.match(result.route.reason, reason);
    assert.equal(receipt(result).model, 'synthetic/daily');
  }
  const explicit = await create(f, 'Explicit headless dispatch.', { mode: 'headless' });
  assert.deepEqual(api.requests[2].questions.map(q => q.name), ['tier']);
  assert.equal(explicit.route.tier, 'light');
  assert.equal(explicit.route.mode, 'headless');

  settings(f, { impRouting: false });
  const off = await create(f, 'Disabled setting dispatch.');
  assert.deepEqual(off.route, { tier: 'standard', mode: 'tab', source: 'default', reason: 'Imp routing is off' });
  const offExplicit = await create(f, 'Disabled setting with explicit headless.', { mode: 'headless' });
  assert.equal(offExplicit.route.mode, 'headless');
  assert.equal(api.requests.length, 3);
});

test('overflow, queued overflow and retry keep the routed imp chain', async t => {
  const { f, api } = await setup(t, body => JSON.stringify(body).includes('One-shot overflow')
    ? answer(body, 'light', 'headless') : answer(body, 'hard', 'tab'));
  role(f, routing);
  write(join(f.env.HUD_HOME, 'roles', 'general.json'), JSON.stringify({ role: 'general', can_continue: false, run: [pi('general')] }));
  waitFixtureJob(f, 1);
  settings(f, { impOverflow: false, roleCaps: { imp: 1, general: 0 } });
  const queued = await create(f, 'Synthetic queued work.');
  assert.equal(queued.state, 'queued');
  assert.equal(queued.route.tier, 'hard');
  settings(f, { impOverflow: true, roleCaps: { imp: 1, general: 0 } });
  await until(() => receipt(queued).dispatch_exit_code === 0, 10000);
  assert.equal(receipt(queued).role, 'general');
  assert.equal(receipt(queued).model, 'synthetic/deep');
  assert.equal(api.requests.length, 1);

  const overflow = await create(f, 'Synthetic immediate overflow.');
  assert.equal(overflow.role, 'general');
  assert.equal(overflow.overflow_from, 'imp');
  assert.equal(receipt(overflow).model, 'synthetic/deep');
  write(join(overflow.task_dir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'Synthetic exit' }));
  const retry = await f.call('hud_create', { retry_of: overflow.job });
  assert.equal(retry.route?.tier, 'hard', JSON.stringify(retry));
  assert.equal(retry.overflow_from, 'imp');
  assert.equal(receipt(retry).model, 'synthetic/deep');
  assert.equal(api.requests.length, 2);

  const manual = await f.call('hud_create', { retry_of: overflow.job, model: 'synthetic/manual', request_key: 'manual-general-retry' });
  assert.equal(manual.overflow_from, undefined);
  assert.equal(receipt(manual).model, 'synthetic/manual');
  assert.equal(api.requests.length, 2);

  const headless = await create(f, 'One-shot overflow for a small edit.');
  assert.equal(headless.overflow_from, 'imp');
  assert.equal(headless.route.mode, 'headless');
  assert.equal(receipt(headless).model, 'synthetic/small');
});

test('land repair of a light job in grace starts a standard replacement without a decision', async t => {
  const { f, api } = await setup(t, body => answer(body, 'light', 'tab'));
  role(f, routing);
  const lightJob = await create(f, 'One-file synthetic repair source.');
  write(join(lightJob.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  const module = new URL('../../dist/mcp/thin-main.js', import.meta.url).href;
  const script = `import { dispatchLandRepair } from ${JSON.stringify(module)};
    console.log(await dispatchLandRepair(${JSON.stringify(lightJob.job)}, process.cwd(), 'Synthetic repair.', 'land:test', null));`;
  const replacement = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: f.env, encoding: 'utf8' }).trim();
  assert.notEqual(replacement, lightJob.job);
  const job = read(join(f.env.HUD_HOME, 'jobs', replacement, 'job.json'));
  assert.equal(job.retry_of, lightJob.job);
  assert.equal(job.route.tier, 'standard');
  assert.equal(job.route.mode, 'tab');
  assert.equal(job.model, 'synthetic/daily');
  assert.equal(api.requests.length, 1);
});

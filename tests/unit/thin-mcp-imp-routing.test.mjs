import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { markExhausted } from '../../dist/roles/roster.js';
import { defaultSettings, loadSettings } from '../../dist/settings.js';
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
const settings = (f, patch) => write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, impPlacement: 'auto', roleCaps: { imp: 0 }, ...patch }));
const landRepair = (f, source) => {
  const module = new URL('../../dist/mcp/thin-main.js', import.meta.url).href;
  const script = `import { dispatchLandRepair } from ${JSON.stringify(module)};
    console.log(await dispatchLandRepair(${JSON.stringify(source.job)}, process.cwd(), 'Synthetic repair.', 'land:test', null));`;
  const id = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: f.env, encoding: 'utf8' }).trim();
  return read(join(f.env.HUD_HOME, 'jobs', id, 'job.json'));
};
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
async function setup(t, handler, probe = '') {
  const f = await fixture(t, probe ? { probe } : undefined);
  const api = await fakeDecisionServer(t, handler);
  configureFakeDecision(f, api.baseUrl);
  settings(f);
  return { f, api };
}

test('Imp placement defaults and resets to fixed; legacy switches migrate without writing', async t => {
  const f = await fixture(t);
  assert.equal(defaultSettings().impPlacement, 'fixed');
  assert.ok(SETTING_ROWS.some(row => row.group === 'Models' && row.key === 'impPlacement'));
  const reset = resetSettingsGroup({ ...defaultSettings(), impPlacement: 'even', impEvenPool: ['small'] }, 'Models');
  assert.equal(reset.impPlacement, 'fixed');
  assert.deepEqual(reset.impEvenPool, []);
  for (const [raw, expected] of [[{ impRouting: true }, 'auto'], [{ impRouting: false }, 'fixed'],
    [{ impRouting: true, impPlacement: 'even', impEvenPool: ['small'] }, 'even']]) {
    const body = JSON.stringify(raw) + '\n';
    write(f.env.HUD_SETTINGS_PATH, body);
    assert.equal(loadSettings(f.env).impPlacement, expected);
    assert.equal(fs.readFileSync(f.env.HUD_SETTINGS_PATH, 'utf8'), body);
  }
});

test('Even rotates in pool order, skips unavailable presets, wraps around and pins overflow, retry and repair', async t => {
  const { f, api } = await setup(t, body => answer(body, 'hard', 'tab'));
  role(f, undefined);
  const pool = { impPlacement: 'even', impEvenPool: ['deep', 'missing', 'small'] };
  settings(f, pool);
  const first = await create(f, 'First even placement.');
  assert.equal(first.route.placement, 'even');
  assert.equal(first.route.preset, 'deep');
  assert.equal(first.route.fallback, undefined);
  assert.equal(receipt(first).model, 'synthetic/deep');
  assert.deepEqual(receipt(first).route, first.route);
  assert.match(cardText(workerFor(f, first.job)), /Placement: even · deep/);

  waitFixtureJob(f, 1);
  settings(f, { ...pool, impOverflow: false, roleCaps: { imp: 1, general: 0 } });
  const second = await create(f, 'Queue the second even placement.');
  assert.equal(second.state, 'queued');
  assert.equal(second.route.preset, 'small');
  assert.match(second.route.fallback, /Skipped unavailable presets: missing/);
  settings(f, { ...pool, impEvenPool: ['deep'], impOverflow: true, roleCaps: { imp: 1, general: 0 } });
  await until(() => receipt(second).dispatch_exit_code === 0, t.signal);
  assert.equal(receipt(second).overflow_from, 'imp');
  assert.equal(receipt(second).model, 'synthetic/small');

  write(join(second.task_dir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'Synthetic exit' }));
  const retry = await f.call('hud_create', { retry_of: second.job });
  assert.equal(retry.route.preset, 'small');
  assert.equal(receipt(retry).model, 'synthetic/small');
  write(join(retry.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  const repair = landRepair(f, retry);
  assert.equal(repair.retry_of, retry.job);
  assert.equal(repair.route.preset, 'small');
  assert.equal(repair.model, 'synthetic/small');

  for (const [impEvenPool, reason] of [[[], /Even pool empty/], [['missing'], /Even pool unavailable/]]) {
    settings(f, { ...pool, impEvenPool });
    const fallback = await create(f, `Even fallback ${reason}.`);
    assert.equal(fallback.route.preset, 'daily');
    assert.match(fallback.route.fallback, reason);
    assert.equal(receipt(fallback).model, 'synthetic/daily');
  }
  assert.equal(api.requests.length, 0);
});

test('Queued Imp even launch rotates from its pinned preset on quota refusal', async t => {
  const f = await fixture(t);
  role(f, undefined);
  waitFixtureJob(f, 1);
  const pool = { impPlacement: 'even', impEvenPool: ['deep', 'small', 'daily'], roleCaps: { imp: 1, general: 0 } };
  settings(f, { ...pool, impOverflow: false });
  write(join(f.env.HOME, 'quota-pi-model'), 'synthetic/deep');
  const queued = await create(f, 'Queued even quota refusal.');
  assert.equal(queued.state, 'queued');
  assert.equal(queued.route.preset, 'deep');
  settings(f, { ...pool, impOverflow: true });
  await until(() => receipt(queued).dispatch_exit_code !== null, 8000);
  const ran = receipt(queued);
  assert.equal(ran.dispatch_exit_code, 0, JSON.stringify(ran.attempts));
  assert.equal(ran.job, queued.job);
  assert.equal(ran.overflow_from, 'imp');
  assert.equal(ran.route.preset, 'small');
  assert.match(ran.route.fallback, /Skipped preset deep: HTTP 429/);
  assert.equal(ran.model, 'synthetic/small');
  assert.equal(ran.attempts.length, 2);
});

test('detailed imp roster labels routing presets as auto-route only', async t => {
  const f = await fixture(t);
  const imp = roster => roster.roles.find(({ role }) => role === 'imp');
  const detail = imp(await f.call('hud_roster', { detail: true }));
  assert.equal(detail.routing.hard.preset, 'astra');
  assert.match(detail.routing_hint, /Auto-route chooses .* do not pass .* hud_create/);
  assert.ok(!detail.accepts_options.includes('preset'));
  const compact = imp(await f.call('hud_roster'));
  assert.equal(compact.routing, undefined);
  assert.equal(compact.routing_hint, undefined);
  assert.equal((await create(f, 'Synthetic task.', { preset: detail.routing.hard.preset })).code, 'invalid_arguments');
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
  await until(() => fs.readFileSync(output, 'utf8').includes('synthetic-routing'), t.signal);
  assert.equal(f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create'), false);

  role(f, routing, { harness: 'cli', agent: 'codex', model: 'synthetic-small' });
  const tab = await create(f, 'Fix a different line in the guide.');
  assert.equal(tab.route.tier, 'light');
  assert.equal(tab.route.mode, 'tab');
  assert.match(tab.route.mode_reason, /headless/);
  assert.equal(receipt(tab).cli.agent, 'codex');
});

test('explicit tab on a non-continuable role asks only for tier', async t => {
  const { f, api } = await setup(t, body => answer(body, 'light', 'headless'));
  role(f, routing);
  const { result: listed } = await f.rpc('tools/list');
  assert.deepEqual(listed.tools.find(tool => tool.name === 'hud_create').inputSchema.properties.mode.enum, ['tab', 'headless']);
  const file = join(f.env.HUD_HOME, 'roles', 'imp.json');
  write(file, JSON.stringify({ ...read(file), can_continue: false }));
  const job = await create(f, 'Pin this edit to a tab.', { mode: 'tab' });
  assert.deepEqual(api.requests[0]?.questions.map(q => q.name), ['tier']);
  assert.equal(job.route.tier, 'light');
  assert.equal(job.route.mode, 'tab');
  assert.equal(job.route.reason, `${light.use}; ${modes.tab}`);
  assert.equal(receipt(job).headless, undefined);
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

test('standard/headless falls back to the active tab on validation or pre-input rejection', async t => {
  const { f } = await setup(t, body => answer(body, 'standard', 'headless'));
  role(f, routing);
  f.overrideBin('pi-role', '#!/bin/sh\ncase " $* " in *" --print "*) echo "Headless rejected" >&2; exit 1;; esac\nexec node "$FAKE_BIN" pi-role "$@"\n');
  for (const [task, options, attempts] of [['Invalid in headless.', { pi_args: ['--session-dir', f.root] }, 1], ['Headless launch rejected.', {}, 2]]) {
    const job = await create(f, task, options);
    assert.equal(job.state, 'working', JSON.stringify(job));
    assert.equal(job.attempts.length, attempts);
    assert.equal(job.route.tier, 'standard');
    assert.equal(job.route.mode, 'tab');
    assert.equal(receipt(job).model, 'synthetic/daily');
  }
  const pinned = await create(f, 'Pinned headless launch rejected.', { mode: 'headless' });
  assert.equal(pinned.state, 'failed');
  assert.equal(pinned.attempts.length, 1);
  f.overrideBin('pi-role', '#!/bin/sh\nexec node "$FAKE_BIN" pi-role "$@"\n');
  f.overrideBin('pi', '#!/bin/sh\necho "Received prompt"; exit 1\n');
  const delivered = await create(f, 'Failure after input reached pi.');
  await until(() => read(join(delivered.task_dir, 'STATUS.json')).state === 'failed', t.signal);
  assert.equal(receipt(delivered).route.mode, 'headless');
  assert.equal(receipt(delivered).attempts.length, 1);
});

test('API error and timeout are visible; explicit headless wins and asks only for tier', { timeout: 18000 }, async t => {
  const probe = `const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms) => realAbortTimeout(ms === 5000 ? 50 : ms);`;
  const { f, api } = await setup(t, (body, n) => n === 1 ? { status: 400 }
    : n === 2 ? new Promise(() => {}) : answer(body, 'light', 'tab'), probe);
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

  settings(f, { impPlacement: 'fixed' });
  const off = await create(f, 'Fixed placement dispatch.');
  assert.deepEqual(off.route, { tier: 'standard', mode: 'tab', source: 'default', reason: 'Imp routing is off', preset: 'daily' });
  assert.equal(receipt(off).model, 'synthetic/daily');
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
  await until(() => receipt(queued).dispatch_exit_code === 0, t.signal);
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
  const lightJob = await create(f, 'One-file synthetic repair source.', { experiment: 'synthetic-speed', arm: 'light' });
  write(join(lightJob.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  const job = landRepair(f, lightJob);
  assert.notEqual(job.job, lightJob.job);
  assert.equal(job.retry_of, lightJob.job);
  assert.equal(job.experiment, 'synthetic-speed');
  assert.equal(job.arm, 'light');
  assert.equal(job.route.tier, 'standard');
  assert.equal(job.route.mode, 'tab');
  assert.equal(job.model, 'synthetic/daily');
  assert.equal(api.requests.length, 1);
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { markExhausted } from '../../dist/roles/roster.js';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { defaultSettings, loadSettings } from '../../dist/settings.js';
import { pickEvenPreset } from '../../dist/mcp/imp-routing.js';
import { SETTING_ROWS, handleSettingsInput, renderSettingsPage, resetSettingsGroup } from '../../dist/render/settings-page.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { cliState, configureFakeDecision, fakeDecisionServer, fixture, runSonic, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const pi = (provider, model) => ({ harness: 'pi', pi_role: 'sonic', model: `${provider}/${model}`, thinking: 'high', split: false });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const receipt = dir => read(join(dir, 'job.json'));
// A job directory appears before its first job.json write; skip it until the receipt exists.
const readCreated = file => {
  try { return read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const settings = (f, patch) => write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ ...defaultSettings(), autoPrewalk: false, ...patch }));

function writeSonicRole(f) {
  const dir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  write(join(dir, 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false,
    run: [pi('synth-ds', 'deepseek')], active_preset: 'deepseek',
    presets: [
      { name: 'deepseek', run: [pi('synth-ds', 'deepseek')] },
      { name: 'haiku', run: [pi('synth-haiku', 'haiku')] },
      { name: 'luna', run: [pi('synth-luna', 'luna')] },
    ],
  }));
}

function sonicJobs(f) {
  const root = join(f.env.HUD_HOME, 'jobs');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(id => /^j[0-9a-f]{16}$/.test(id))
    .map(id => readCreated(join(root, id, 'job.json')))
    .filter(job => job?.role === 'sonic');
}

test('Sonic even rotates round-robin in pool order across creates, scouts and hud_sonic; retries keep preset and callers cannot override', async t => {
  const f = await fixture(t);
  // Independent per-role rotators advance in pool order and wrap around.
  const known = new Set(['deepseek', 'haiku', 'luna']);
  assert.deepEqual(await pickEvenPreset(f.env.HUD_HOME, 'imp', known, ['haiku', 'deepseek'], () => true), { preset: 'haiku', skipped: [] });
  assert.deepEqual(await pickEvenPreset(f.env.HUD_HOME, 'imp', known, ['haiku', 'deepseek'], () => true), { preset: 'deepseek', skipped: [] });
  assert.deepEqual(await pickEvenPreset(f.env.HUD_HOME, 'imp', known, ['haiku', 'deepseek'], () => true), { preset: 'haiku', skipped: [] });
  assert.equal(fs.statSync(join(f.env.HUD_HOME, 'even-imp.json')).mode & 0o777, 0o600);

  writeSonicRole(f);
  settings(f, { sonicPlacement: 'even', sonicEvenPool: ['luna', 'deepseek', 'haiku'], roleCaps: { sonic: 1 } });
  write(join(f.env.HOME, 'hold-sonic'), '');

  // Callers still cannot pass placement overrides for sonic.
  for (const override of [{ preset: 'haiku' }, { on: 'pi' }, { model: 'synth-haiku/haiku' }, { thinking: 'low' }]) {
    assert.equal((await f.call('hud_create', { role: 'sonic', task: 'Refused override.', ...override })).code, 'invalid_arguments');
  }

  // 1. Direct sonic create picks luna (first in pool order).
  const first = await f.call('hud_create', { role: 'sonic', task: 'First sonic lookup.' });
  assert.equal(first.route.placement, 'even');
  assert.equal(first.route.preset, 'luna');
  assert.equal(receipt(first.task_dir).model, 'synth-luna/luna');
  assert.deepEqual(receipt(first.task_dir).route, first.route);
  assert.equal(fs.statSync(join(f.env.HUD_HOME, 'even-sonic.json')).mode & 0o777, 0o600);

  // 2. Scout picks deepseek (second in pool order).
  const scouted = await f.call('hud_create', { role: 'imp', task: 'Scouted imp work.', scouts: [{ kind: 'code', ask: 'Find the file.' }] });
  await until(() => sonicJobs(f).some(j => j.parent_job === scouted.job && j.used_place), t.signal);
  const scout = sonicJobs(f).find(j => j.parent_job === scouted.job);
  assert.equal(scout.route.placement, 'even');
  assert.equal(scout.route.preset, 'deepseek');
  assert.equal(scout.model, 'synth-ds/deepseek');

  // 3. Worker hud_sonic picks haiku (third in pool order).
  const parent = await f.call('hud_create', { role: 'imp', task: 'Worker parent.' });
  const launched = await runSonic(f, 'start', parent.task_dir, '--task', 'Worker sonic lookup.');
  assert.equal(launched.status, 0, launched.stderr);
  const child = receipt(join(f.env.HUD_HOME, 'jobs', launched.stdout.trim()));
  assert.equal(child.route.placement, 'even');
  assert.equal(child.route.preset, 'haiku');
  assert.equal(child.model, 'synth-haiku/haiku');

  // Only the direct create takes a slot: helpers started at cap and do not block the queued job.
  const fourth = await f.call('hud_create', { role: 'sonic', task: 'Fourth sonic lookup.' });
  assert.equal(fourth.queued, true);
  assert.equal(fourth.route.preset, 'luna');
  markExhausted(f.env.HUD_HOME, 'pi:synth-luna/luna', 'rate limit');
  write(join(first.task_dir, 'release-sonic'), '');
  await until(() => receipt(fourth.task_dir).used_place, t.signal);
  assert.equal(receipt(fourth.task_dir).route.preset, 'deepseek');
  assert.equal(receipt(fourth.task_dir).headless, true);

  // 5. Retry keeps the chosen preset even after settings change.
  settings(f, { sonicPlacement: 'even', sonicEvenPool: ['deepseek'] });
  const childDir = join(f.env.HUD_HOME, 'jobs', child.job);
  write(join(childDir, 'fail-sonic'), '');
  write(join(childDir, 'release-sonic'), '');
  await until(() => cliState(childDir)?.state === 'failed', t.signal);
  const retry = await f.call('hud_create', { role: 'sonic', retry_of: child.job });
  assert.equal(retry.route.placement, 'even');
  assert.equal(retry.route.preset, 'haiku');
  assert.equal(receipt(retry.task_dir).model, 'synth-haiku/haiku');
});

test('Sonic even skips unavailable or exhausted presets, reports them, and falls back to active preset when empty or unavailable', async t => {
  const f = await fixture(t);
  writeSonicRole(f);
  markExhausted(f.env.HUD_HOME, 'pi:synth-haiku/haiku', 'rate limit');
  write(join(f.env.HUD_HOME, 'harnesses.json'), JSON.stringify({ disabled: ['pi:synth-luna'] }));
  settings(f, { sonicPlacement: 'even', sonicEvenPool: ['missing', 'haiku', 'luna', 'deepseek'] });

  const picked = await f.call('hud_create', { role: 'sonic', task: 'Pick available preset.' });
  assert.equal(picked.route.placement, 'even');
  assert.equal(picked.route.preset, 'deepseek');
  assert.match(picked.route.fallback, /Skipped unavailable presets: missing, haiku, luna/);
  assert.equal(receipt(picked.task_dir).model, 'synth-ds/deepseek');

  for (const [sonicEvenPool, reason] of [[[], /Even pool empty/], [['missing', 'haiku'], /Even pool unavailable/]]) {
    settings(f, { sonicPlacement: 'even', sonicEvenPool });
    const fallback = await f.call('hud_create', { role: 'sonic', task: `Fallback ${reason}.` });
    assert.equal(fallback.route.placement, 'even');
    assert.equal(fallback.route.preset, 'deepseek');
    assert.match(fallback.route.fallback, reason);
    assert.equal(receipt(fallback.task_dir).model, 'synth-ds/deepseek');
  }
});

test('Sonic skips first places marked after planning in fixed, even and prewalk launches', async t => {
  const f = await fixture(t);
  const run = [pi('synthetic', 'first'), pi('synthetic', 'second')];
  const keys = run.map(place => `pi:${place.model}`);
  const dir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  write(join(dir, 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false, run,
    presets: [{ name: 'pair', run }], active_preset: 'pair',
  }));
  const file = join(f.env.HUD_HOME, 'exhausted.json');
  const expire = () => {
    const marks = read(file);
    for (const mark of Object.values(marks.places)) mark.until = new Date(Date.now() - 1).toISOString();
    write(file, JSON.stringify(marks));
  };
  let markOnPick = [keys[0]];
  const decision = await fakeDecisionServer(t, () => {
    // The Sonic thinking request runs after the dispatch has chosen its candidate list.
    for (const key of markOnPick) markExhausted(f.env.HUD_HOME, key, 'HTTP 402: budget exceeded');
    return { answers: [] };
  });
  configureFakeDecision(f, decision.baseUrl);
  const place = sonicPlacement => settings(f, { sonicPlacement, sonicEvenPool: ['pair'], sonicAutoThinking: true });
  const create = task => f.call('hud_create', { role: 'sonic', task });
  const assertLaunch = async (job, index) => {
    const expected = run[index].model;
    assert.deepEqual(job.attempts, [{ index, place: `pi (${expected})` }]);
    const dir = join(f.env.HUD_HOME, 'jobs', job.job);
    await until(() => f.commands().some(command => command.dir === dir), t.signal);
    assert.deepEqual(f.commands().filter(command => command.dir === dir).map(({ args }) => args[args.indexOf('--model') + 1]), [expected]);
  };

  for (const placement of ['fixed', 'even']) {
    place(placement);
    await assertLaunch(await create(`Synthetic ${placement} lookup.`), 1);
    expire();
  }

  place('fixed');
  const target = await f.call('hud_create', { role: 'imp', task: 'Scouted work.', scouts: [{ kind: 'code', ask: 'Find the file.' }] });
  let scout;
  await until(() => scout = sonicJobs(f).find(job => job.parent_job === target.job && job.dispatch_exit_code !== null), t.signal);
  await assertLaunch(scout, 1);
  assert.equal(scout.prewalk_kind, 'code');
  expire();

  markOnPick = keys;
  const failed = await create('Both places marked after planning.');
  assert.equal(failed.ok, false);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.attempts, []);
  assert.equal(failed.used_place, null);
  assert.match(failed.reason, /No launch attempted; exhausted places/);
  const refused = await create('Both places already marked.');
  assert.equal(refused.code, 'no_available_place');
  for (const key of keys) {
    assert.ok(failed.reason.includes(key));
    assert.ok(refused.reason.includes(key));
  }
  assert.ok(!f.commands().some(command => command.dir === failed.task_dir));
  assert.ok(!fs.existsSync(join(failed.task_dir, 'SESSION.txt')));

  expire();
  markOnPick = [];
  await assertLaunch(await create('Marks expired.'), 0);
});

test('Sonic remaps the original Decision pick after a pre-input rejection without creating a second job', async t => {
  const f = await fixture(t);
  const dir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  write(join(dir, 'sonic.json'), JSON.stringify({ role: 'sonic', instructions: 'sonic', can_continue: false, run: [
    { ...pi('synthetic', 'first'), mcp: true }, pi('synthetic', 'second'),
  ] }));
  write(join(f.env.HOME, 'pi-model-caps.json'), JSON.stringify({
    'synthetic/first': { provider: 'synthetic', id: 'first', reasoning: true, thinkingLevelMap: { minimal: null } },
    'synthetic/second': { provider: 'synthetic', id: 'second', reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' } },
  }));
  const decision = await fakeDecisionServer(t, () => ({ answers: [{ name: 'sonic_thinking', type: 'choice', choice: 'high',
    confidence: 0.9, probabilities: [{ value: 'high', probability: 0.9 }, { value: 'low', probability: 0.1 }] }] }));
  configureFakeDecision(f, decision.baseUrl);
  settings(f, { sonicAutoThinking: true });

  const job = await f.call('hud_create', { role: 'sonic', task: 'Synthetic fallback.' });
  assert.equal(decision.requests.length, 1);
  assert.equal(job.attempts.length, 2, JSON.stringify(job));
  assert.match(job.attempts[0].reason, /missing: .*pi-mcp-adapter/);
  assert.equal(job.used_place, 'pi (synthetic/second)');
  const saved = receipt(job.task_dir);
  assert.equal(saved.model, 'synthetic/second');
  assert.equal(saved.thinking_source, 'decision');
  assert.equal(saved.thinking_pick, 'high');
  assert.deepEqual(saved.attempts.map(({ thinking }) => thinking), ['medium', 'high']);
  assert.equal(saved.thinking, 'high');
  assert.equal(read(join(job.task_dir, 'pi-worker.json')).thinking, 'high');
  assert.deepEqual(sonicJobs(f).map(j => j.job), [job.job]);
});

test('Sonic even records a provider 429 after input without replaying and reuses the preset at expiry', async t => {
  const f = await fixture(t);
  writeSonicRole(f);
  settings(f, { sonicPlacement: 'even', sonicEvenPool: ['luna', 'haiku', 'deepseek'] });
  const refused = join(f.env.HOME, 'quota-pi-model');
  write(refused, 'synth-luna/luna');
  const create = task => f.call('hud_create', { role: 'sonic', task });
  const first = await create('Post-input quota error.');
  assert.equal(first.route.preset, 'luna');
  assert.equal(first.attempts.length, 1);
  await until(() => receipt(first.task_dir).exhaustion_marked, t.signal);
  assert.equal(receipt(first.task_dir).model, 'synth-luna/luna');
  assert.deepEqual(receipt(first.task_dir).route, first.route);
  assert.deepEqual(sonicJobs(f).map(job => job.job), [first.job]);
  const file = join(f.env.HUD_HOME, 'exhausted.json');
  const marks = read(file);
  assert.match(marks.places['pi:synth-luna/luna'].reason, /quota exceeded/i);

  fs.rmSync(refused); // The provider is ready again, but HUD still honors the cooldown.
  assert.equal((await create('Next healthy preset.')).route.preset, 'haiku');
  assert.equal((await create('Advance past the replacement.')).route.preset, 'deepseek');
  const skipped = await create('Wrap past the quota mark.');
  assert.equal(skipped.route.preset, 'haiku');
  assert.match(skipped.route.fallback, /Skipped unavailable presets: luna/);
  assert.equal(skipped.attempts.length, 1);

  marks.places['pi:synth-luna/luna'].until = new Date(Date.now() - 1).toISOString();
  write(file, JSON.stringify(marks));
  assert.equal((await create('Continue after expiry.')).route.preset, 'deepseek');
  const rejoined = await create('Wrap to the restored preset.');
  assert.equal(rejoined.route.preset, 'luna');
  assert.equal(rejoined.route.fallback, undefined);
  assert.equal(receipt(rejoined.task_dir).model, 'synth-luna/luna');
  assert.deepEqual(read(file), marks, 'rejoining requires no change to the expired mark');
});

test('Job archive keeps sonic even preset and route placement', async t => {
  const f = await fixture(t);
  writeSonicRole(f);
  settings(f, { sonicPlacement: 'even', sonicEvenPool: ['deepseek', 'haiku', 'luna'] });

  const sonic = await f.call('hud_create', { role: 'sonic', task: 'Settled sonic report.' });
  const ended = '2026-11-24T10:00:00.000Z';
  write(join(sonic.task_dir, 'report.md'), '# Sonic report\n\nFound src/settings.ts.\n');
  write(join(sonic.task_dir, 'STATUS.json'), JSON.stringify({ state: 'done', started_at: ended, settled_at: ended, ended_at: ended, output_written: true }));

  const logs = [];
  archiveJob(f.env.HUD_HOME, sonic.task_dir, sonic.job, receipt(sonic.task_dir), read(join(sonic.task_dir, 'STATUS.json')), Date.parse(ended), m => logs.push(m));
  assert.deepEqual(logs, []);
  const archived = read(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl'));
  assert.equal(archived.preset, 'deepseek');
  assert.deepEqual(archived.route, { tier: 'standard', mode: 'headless', placement: 'even', preset: 'deepseek' });
});

test('Settings -> Models shows, edits, resets and persists Sonic placement and Sonic even pool', async t => {
  const f = await fixture(t);
  assert.equal(defaultSettings().sonicPlacement, 'fixed');
  assert.deepEqual(defaultSettings().sonicEvenPool, []);
  assert.ok(SETTING_ROWS.some(row => row.group === 'Models' && row.key === 'sonicPlacement'));
  assert.ok(SETTING_ROWS.some(row => row.group === 'Models' && row.key === 'sonicEvenPool'));

  const reset = resetSettingsGroup({ ...defaultSettings(), sonicPlacement: 'even', sonicEvenPool: ['deepseek', 'haiku'] }, 'Models');
  assert.equal(reset.sonicPlacement, 'fixed');
  assert.deepEqual(reset.sonicEvenPool, []);

  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ sonicPlacement: 'even', sonicEvenPool: ['deepseek', 'haiku', 'luna'] }));
  const loaded = loadSettings(f.env);
  assert.equal(loaded.sonicPlacement, 'even');
  assert.deepEqual(loaded.sonicEvenPool, ['deepseek', 'haiku', 'luna']);

  let state = {
    draft: defaultSettings(),
    sonicPresets: ['deepseek', 'haiku', 'luna'],
    selected: SETTING_ROWS.findIndex(r => r.key === 'sonicPlacement'),
    offset: 0,
    message: '',
  };
  for (const key of ['right', 'down', 'enter', 'right', 'enter'])
    state = handleSettingsInput(state, { type: 'key', key }, renderSettingsPage(state, 80, 40)).state;
  assert.equal(state.draft.sonicPlacement, 'even');
  assert.deepEqual(state.draft.sonicEvenPool, ['deepseek', 'haiku']);
  const text = stripAnsi(renderSettingsPage(state, 80, 40).lines.join('\n'));
  assert.match(text, /Sonic placement\s+even/);
  assert.match(text, /Sonic even pool\s+‹ haiku · included ›/);
});

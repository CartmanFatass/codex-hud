import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { EXHAUSTED_TTL_MS, parseQuotaResetMs } from '../../dist/roles/exhausted.js';
import { clearExhausted, markExhausted, placeKey, readExhausted, roleRegistry } from '../../dist/roles/roster.js';
import { setHarnessDisabled } from '../../dist/roles/harness-switches.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { handleMonitorInput, renderMonitor } from '../../dist/render/monitor.js';
import { finishChain } from '../../dist/render/chain-input.js';
import { editPreset } from '../../dist/roles/role-control.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { plain, onControl, TREE } from '../fixtures/project-page.mjs';
import { enableOptionalRoles, rolePlacesFixture as fixture, until } from '../helpers/thin-mcp-harness.mjs';
const bundled = resolve('packages/hud-mcp');

test('empty draft cancel writes nothing; a reordered two-place draft is the chain used by roster and create', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), home = f.env.HUD_HOME, file = join(home, 'roles/owner-imp.json');
  const put = (path, json) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, JSON.stringify(json)); };
  const pi = { harness: 'pi', model: 'xai/grok-4.7', thinking: 'high' };
  const cli = { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high' };
  const saved = { role: 'imp', instructions: 'implementer', can_continue: true, run: [{ harness: 'pi', model: 'synthetic/file-chain' }],
    active_preset: 'daily', presets: [{ name: 'daily', run: [pi, cli] }], unknown: { keep: true } };
  put(file, saved);
  const now = Date.now();
  put(join(home, 'display/model-lists.json'), { version: 1, fetchedAt: now, pi: [pi.model] });
  setHarnessDisabled(home, 'cli:grok', true);
  const before = fs.readFileSync(file), inode = fs.statSync(file).ino;
  const collector = new ProjectCollector(f.root, home, f.env, f.env.HOME), data = await collector.collect('control', {}, now);
  const decoder = new WorkbenchInputDecoder('workboard');
  let state = onControl({ cursor: 'project:role:imp' }, { prefs: { panelLayout: 'split' } });
  const frame = () => renderMonitor({ state, tree: TREE, project: data, projectName: 'harbor-api', width: 40, height: 28, nowMs: now });
  const keys = (raw) => {
    for (const input of [...decoder.push(Buffer.from(raw)), ...decoder.flushEscape()]) {
      const view = frame(), out = handleMonitorInput(view.state, input, { frame: view, tree: TREE, nowMs: now });
      state = out.state;
      if (out.action?.type === 'preset-edit') {
        const done = editPreset(home, f.root, f.env, out.action);
        assert.equal(done.ok, true, JSON.stringify(done));
        state = finishChain(state);
        collector.refreshRoles(data, now);
      } else assert.equal(out.action, undefined);
    }
  };
  keys('Icancelled\r');
  assert.match(plain(frame()).join('\n'), /Not saved · needs a place to save/);
  keys('\x1b');
  assert.match(plain(frame()).join('\n'), /Discard edits\?/);
  keys('\r');
  assert.equal(state.overlay, undefined);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).ino, inode);

  const DOWN = '\x1b[B', END = '\x1b[F';
  keys('Inightly\ri\rgrok\r');
  assert.match(plain(frame()).join('\n'), /Off targets cannot be selected/);
  assert.equal(state.overlay.mode.place, undefined);
  keys('\x1b');
  keys(`\rpi\r${DOWN}\r${pi.model}\r${DOWN}\rhigh\r${END}\r`);
  keys(`i\ragy\r${DOWN}\rhydrogen\r${END}\r`);
  assert.deepEqual(state.overlay.draft.run.map((p) => p.raw.harness), ['pi', 'cli']);
  keys('K');
  assert.match(plain(frame()).join('\n'), /saved +\[daily\] → pi\/xai\ndraft +agy \(unsaved\)/);
  assert.deepEqual(fs.readFileSync(file), before, 'no write before the whole draft is saved');
  assert.deepEqual(f.commands(), [], 'typing and Save preparation launch nothing');
  keys('s');
  assert.equal(state.overlay, undefined);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk, { ...saved, active_preset: 'nightly', presets: [saved.presets[0], { name: 'nightly', run: [cli, { ...pi, pi_role: 'implementer', split: false }] }] });
  assert.deepEqual(fs.readdirSync(join(home, 'roles')), ['owner-imp.json']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.notEqual(fs.statSync(file).ino, inode);
  const roster = async () => (await f.call('hud_roster', { detail: true })).roles.find((r) => r.role === 'imp');
  const create = (request_key) => f.call('hud_create', { role: 'imp', request_key, task: 'Synthetic draft order check.' });
  const role = await roster();
  assert.deepEqual([role.preset, role.run.map((p) => p.harness), role.runs_on.agent], ['nightly', ['cli', 'pi'], 'agy']);
  const first = await create('draft-order-cli');
  assert.equal(JSON.parse(fs.readFileSync(join(first.task_dir, 'job.json'), 'utf8')).place.agent, 'agy');
  markExhausted(home, placeKey(cli), 'HTTP 429', Date.now());
  const fallback = await create('draft-order-pi');
  assert.equal(JSON.parse(fs.readFileSync(join(fallback.task_dir, 'job.json'), 'utf8')).place_key, 'pi:xai/grok-4.7');
  assert.equal((await roster()).runs_on.harness, 'pi');
});

test('machine switches: panel, roster and create use the same daily chain, without editing it', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), home = f.env.HUD_HOME;
  const roleFile = join(home, 'roles', 'imp.json'), switches = join(home, 'harnesses.json'), jobs = join(home, 'jobs');
  const run = [{ harness: 'pi', model: 'xai/grok-4.7', lens: false, pi_args: ['--synthetic-flag'] },
    { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high' }];
  const roleBytes = JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', model: 'synthetic/file-chain' }], active_preset: 'daily', presets: [{ name: 'daily', run }] }, null, 2) + '\n';
  fs.mkdirSync(join(home, 'roles'));
  fs.writeFileSync(roleFile, roleBytes);
  fs.writeFileSync(join(home, 'roles', 'general.json'), JSON.stringify({ ...JSON.parse(roleBytes), role: 'general' }));
  const other = { grok: { state_trust: 'advisory' }, catalog: { pi: { include: {} } }, unknown: { keep: true } };
  fs.writeFileSync(switches, JSON.stringify(other), { mode: 0o644 });
  const roster = async (detail = true) => (await f.call('hud_roster', { detail })).roles.find((r) => r.role === 'imp');
  const create = (key, extras) => f.call('hud_create', { role: 'imp', request_key: key, task: 'Synthetic task.', ...extras });
  assert.equal((await roster()).places[0].state, 'active');
  const inode = fs.statSync(switches).ino;
  setHarnessDisabled(home, 'cli:grok', true);
  const firstWrite = fs.statSync(switches).ino;
  assert.notEqual(firstWrite, inode);
  assert.equal((await roster()).places[0].state, 'active', 'CLI Grok is not the xai provider');
  setHarnessDisabled(home, 'pi:xai', true);
  // Compare adjacent replacements; after two renames the original inode can have been reused.
  assert.notEqual(fs.statSync(switches).ino, firstWrite);
  assert.equal(fs.statSync(switches).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(switches, 'utf8')), { ...other, disabled: ['cli:grok', 'pi:xai'] });
  const assigned = await roster();
  assert.equal(assigned.preset, 'daily');
  assert.equal(assigned.runs_on.agent, 'agy');
  assert.deepEqual(assigned.places.map((p) => [p.state, p.off_by ?? null]), [['off', 'pi:xai'], ['active', null]]);
  assert.equal((await roster(false)).places[0].off_by, 'pi:xai');
  const snapshot = await new ProjectCollector(f.root, home, f.env, f.env.HOME).collect('control', {}, Date.now());
  const role = snapshot.roles.find((r) => r.role === 'imp');
  assert.deepEqual(role.places.map((p) => p.state), assigned.places.map((p) => p.state));
  const state = onControl({ cursor: 'project:role:imp' }, { prefs: { panelLayout: 'split' } });
  const draw = state => renderMonitor({ state, tree: TREE, project: snapshot, projectName: 'harbor-api', width: 40, height: 38 });
  const view = draw(state);
  const panel = plain(draw(handleMonitorInput(view.state, { type: 'key', key: 'enter' }, { frame: view }).state));
  assert.match(panel.join('\n'), /imp \[daily\] → agy/);
  assert.match(panel.join('\n'), /1 ⊘ pi\/xai +\[grok-4.7 ▾\][\s\S]*Switched off/);
  for (const [key, options] of [['on-off', { on: 'pi' }], ['model-off', { model: 'xai/other' }],
    ['preset-model-off', { preset: 'daily', model: 'xai/other' }], ['cli-off', { on: 'grok' }]]) {
    const res = await create(key, { role: 'general', ...options });
    assert.equal(res.code, 'no_available_place');
    assert.equal(res.places[0].state, 'off');
    assert.ok(!fs.existsSync(jobs) || fs.readdirSync(jobs).length === 0, 'no job created for a refused override');
  }
  assert.deepEqual(f.commands().filter(({ command, args }) =>
    !(command === 'herdr' && args[0] === 'pane' && args[1] === 'get' && args[2] === f.env.HERDR_PANE_ID)),
  [], 'roster and refusals only look up the caller; no launch or discovery');
  const fallback = await create('daily');
  assert.equal(JSON.parse(fs.readFileSync(join(fallback.task_dir, 'job.json'), 'utf8')).place.agent, 'agy');
  const enabledOverride = await create('model-on', { role: 'general', model: 'other/new-model' });
  const job = JSON.parse(fs.readFileSync(join(enabledOverride.task_dir, 'job.json'), 'utf8'));
  assert.equal(job.place_key, 'pi:other/new-model');
  assert.equal(job.lens, false);
  assert.ok(f.commands().some(({ command, args }) => command === 'herdr' && args[0] === 'agent' && args[1] === 'start' && args.includes('--synthetic-flag')));
  const key = placeKey(assigned.run[0]);
  markExhausted(home, key, 'quota exceeded');
  const both = await roster();
  assert.equal(both.places[0].state, 'off');
  assert.equal(both.exhausted[0].key, key);
  const quotaFile = join(home, 'exhausted.json'), quotaBytes = fs.readFileSync(quotaFile);
  setHarnessDisabled(home, 'pi', true);
  setHarnessDisabled(home, 'pi', false);
  assert.deepEqual(JSON.parse(fs.readFileSync(switches, 'utf8')).disabled, ['cli:grok', 'pi:xai']);
  setHarnessDisabled(home, 'pi:xai', false);
  assert.deepEqual(fs.readFileSync(quotaFile), quotaBytes);
  assert.equal((await roster()).places[0].state, 'exhausted');
  assert.equal((await create('on-quota', { role: 'general', on: 'pi' })).code, 'no_available_place');
  clearExhausted(home, key);
  assert.equal((await roster()).places[0].state, 'active');
  const restored = await create('restored');
  assert.equal(JSON.parse(fs.readFileSync(join(restored.task_dir, 'job.json'), 'utf8')).place_key, key);
  assert.equal(fs.readFileSync(roleFile, 'utf8'), roleBytes);
});

test('provider attribution uses local settings or the unfiltered cache; unknown still dispatches', { timeout: 10000 }, async (t) => {
  const f = await fixture(t), home = f.env.HUD_HOME, settings = join(f.env.PI_CODING_AGENT_DIR, 'settings.json');
  const put = (path, value) => fs.writeFileSync(path, JSON.stringify(value));
  const roster = async (name) => (await f.call('hud_roster', { detail: true })).roles.find((r) => r.role === name).places[0];
  const create = (role, request_key, other) => f.call('hud_create', { role, request_key, task: 'Synthetic task.', ...other });
  put(settings, { defaultProvider: 'xai', defaultModel: 'settings-model' });
  fs.mkdirSync(join(home, 'roles'));
  put(join(home, 'roles', 'defaulted.json'), { role: 'defaulted', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', pi_role: 'general' }] });
  put(join(home, 'roles', 'imp.json'), { role: 'imp', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', pi_role: 'implementer', model: 'gpt-6.1-sol' }] });
  const unknown = await roster('imp'); // The place names a bare ID and there is no cache yet.
  assert.equal(unknown.provider, null);
  assert.equal(unknown.state, 'active');
  const fresh = await create('imp', 'without-cache');
  assert.ok(fresh.task_dir);
  setHarnessDisabled(home, 'pi:xai', true);
  const configured = await roster('defaulted');
  assert.equal(configured.provider_source, 'pi_settings');
  assert.equal(configured.off_by, 'pi:xai');
  assert.equal(configured.key, 'pi:', 'settings attribution preserves the quota key of a place that passes no model');
  put(settings, { defaultProvider: 'other', defaultModel: 'settings-model' });
  assert.equal((await roster('defaulted')).provider, 'other', 'settings edits invalidate the cached signature');
  fs.mkdirSync(join(home, 'display'), { recursive: true });
  const cache = join(home, 'display', 'model-lists.json');
  put(cache, { version: 1, fetchedAt: Date.now(), pi: ['xai/gpt-6.1-sol'] });
  assert.equal((await roster('imp')).off_by, 'pi:xai');
  put(cache, { version: 1, fetchedAt: Date.now(), pi: ['xai/gpt-6.1-sol', 'other/gpt-6.1-sol'] });
  assert.equal((await roster('imp')).provider, null, 'off providers still count toward ambiguity');
  assert.ok((await create('general', 'ambiguous-cache', { model: 'gpt-6.1-sol' })).task_dir);
  setHarnessDisabled(home, 'pi', true);
  assert.equal((await roster('imp')).off_by, 'pi');
  assert.equal((await create('imp', 'runner-off')).code, 'no_available_place');
  enableOptionalRoles(f, 'pro');
  setHarnessDisabled(home, 'bro:jev-ask', true);
  for (const on of ['chatgpt', 'gemini']) assert.equal((await create('general', `alias-${on}`, { on })).places[0].off_by, 'bro:jev-ask');
  const bad = join(home, 'harnesses.json');
  fs.writeFileSync(bad, '{"disabled":null}');
  assert.throws(() => setHarnessDisabled(home, 'pi', false), { code: 'invalid_harness_switches' });
  assert.equal(fs.readFileSync(bad, 'utf8'), '{"disabled":null}');
  assert.equal((await f.call('hud_roster')).code, 'invalid_harness_switches');
  assert.equal((await create('imp', 'invalid-switch-file')).code, 'invalid_harness_switches');
  assert.equal((await create('imp', 'without-cache')).job, fresh.job, 'retry returns the already-created job');
});

/** The owner's own imp: pi first, agy as fallback. */
function ownImp(f) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'imp.json'), JSON.stringify({
    role: 'imp', instructions: 'implementer', can_continue: true, idle_grace_s: 600,
    run: [{ harness: 'pi', pi_role: 'implementer', split: false },
      { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high', args: [] }],
  }));
}

test('imp falls back to agy when pi is missing on PATH', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: false });
  ownImp(f);
  const roster = await f.call('hud_roster', { detail: true });
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.equal(imp.available, true);
  assert.equal(imp.harness, 'cli');
  assert.equal(imp.agent, 'agy');
  assert.equal(imp.model, 'gemini-4-hydrogen-high');
  assert.deepEqual(imp.runs_on, {
    harness: 'cli',
    agent: 'agy',
    model: 'gemini-4-hydrogen-high',
    args: [],
  });

  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-missing', task: 'Synthetic task.' });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  await until(() => f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(job.job)), t.signal);
  const start = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'start');
  assert.equal(start.args[3], '--kind');
  assert.equal(start.args[4], 'agy');
  assert.ok(start.args.includes('gemini-4-hydrogen-high'));
  const prompt = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt');
  const implementerText = fs.readFileSync('packages/hud-mcp/instructions/implementer.md', 'utf8').trimEnd();
  assert.ok(prompt.args[3].startsWith(`${implementerText}\n\nCarry out this brief:\n\nSynthetic task.`));
});

test('quota failure marks pi exhausted for 1h, names next place, and falls back to agy on next dispatch', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: true });
  ownImp(f);
  fs.writeFileSync(join(f.env.HOME, 'pi-quota-fail'), '');
  const first = await f.call('hud_create', { role: 'imp', request_key: 'pi-quota-1', task: 'Synthetic task.' });
  const read = await f.call('hud_read', { job: first.job });
  assert.equal(read.state, 'failed');
  assert.equal(read.exit_reason, 'dispatch_failed');
  assert.match(read.reason, /429/);
  assert.match(read.reason, /next dispatch will use cli\/agy \(gemini-4-hydrogen-high\)/);

  const marks = readExhausted(f.env.HUD_HOME);
  assert.equal(marks.has('pi:openai/gpt-6.2-sol'), true);

  const roster = await f.call('hud_roster', { detail: true });
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.equal(imp.available, true);
  assert.deepEqual(imp.runs_on, {
    harness: 'cli',
    agent: 'agy',
    model: 'gemini-4-hydrogen-high',
    args: [],
  });
  assert.equal(imp.exhausted.length, 1);
  assert.equal(imp.exhausted[0].key, 'pi:openai/gpt-6.2-sol');

  fs.unlinkSync(join(f.env.HOME, 'pi-quota-fail'));
  const second = await f.call('hud_create', { role: 'imp', request_key: 'pi-quota-2', task: 'Synthetic task 2.' });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  await until(() => f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(second.job)), t.signal);
  const agyStart = f.commands().find((c) => c.command === 'herdr' && c.args[2] === `${second.job}-primary`);
  assert.equal(agyStart.args[4], 'agy');

  // Exhausting agy too makes imp unavailable and hud_create returns no_available_place.
  markExhausted(f.env.HUD_HOME, 'cli:agy:gemini-4-hydrogen-high', 'quota exceeded');
  const noPlace = await f.call('hud_create', { role: 'imp', request_key: 'pi-quota-3', task: 'Synthetic task 3.' });
  assert.equal(noPlace.ok, false);
  assert.equal(noPlace.code, 'no_available_place');
  assert.equal(noPlace.exhausted.length, 2);
});

test('parses relative, ISO, epoch and UTC clock quota resets and clamps the resulting delay', () => {
  const now = Date.parse('2026-11-18T14:00:00Z');
  const epoch = Date.parse('2026-11-18T15:30:00Z');
  for (const [reason, expected] of [
    ['try again in 18m', 18 * 60_000],
    ['in 2h 15m', 135 * 60_000],
    ['in 45s', 60_000],
    ['retry after 120 seconds', 120_000],
    ['resets in 1 hour and 30 minutes', 90 * 60_000],
    ['Retry-After: 900', 900_000],
    ['retry-after: 2 days', null],
    ['resets in 48h', 24 * EXHAUSTED_TTL_MS],
    ['resets at 2026-11-18T15:30:00Z', 90 * 60_000],
    ['exhausted until 2026-11-18T16:30:00+01:00', 90 * 60_000],
    [`reset: ${epoch / 1000}`, 90 * 60_000],
    [`x-ratelimit-reset: ${epoch}`, 90 * 60_000],
    ['resets at 14:30 UTC', 30 * 60_000],
    ['resets at 13:30 UTC', 1410 * 60_000],
    ['resets at 14:90 UTC', null],
    ['resets at 2026-11-18T13:30:00Z', null],
    ['retry after 0 seconds', null],
    ['rate limit exceeded (429)', null],
  ]) assert.equal(parseQuotaResetMs(reason, now), expected, reason);
});

test('exhausted marks expire at the parsed reset, or after 1 hour when no reset is named', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'exhausted-ttl-'));
  try {
    const t0 = Date.parse('2026-11-14T00:00:00Z');
    markExhausted(dir, 'pi:gpt-6.1-sol', 'rate limit', t0);
    markExhausted(dir, 'cli:agy:model', 'rate limit; try again in 18m', t0);
    assert.equal(readExhausted(dir, t0 + 18 * 60_000 - 1).size, 2);
    assert.equal(readExhausted(dir, t0 + 18 * 60_000).has('cli:agy:model'), false);
    assert.equal(readExhausted(dir, t0 + EXHAUSTED_TTL_MS - 1).has('pi:gpt-6.1-sol'), true);
    assert.equal(readExhausted(dir, t0 + EXHAUSTED_TTL_MS).has('pi:gpt-6.1-sol'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hud_roster drops expired exhausted marks when queried through hud-mcp', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: true });
  ownImp(f);
  markExhausted(f.env.HUD_HOME, 'pi:openai/gpt-6.2-sol', 'rate limit', Date.now() - 2 * EXHAUSTED_TTL_MS);

  const roster = await f.call('hud_roster', { detail: true });
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.equal(imp.available, true);
  assert.equal(imp.runs_on.harness, 'pi');
  assert.deepEqual(imp.exhausted, []);
});

// Three launches share a test hang guard, not a 10 s product budget.
test('hud_create on uses harnesses.json (and HUD_HOME override), and model still wins', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const job1 = await f.call('hud_create', { role: 'general', on: 'agy', request_key: 'on-agy-default', task: 'Task 1.' });
  const rec1 = JSON.parse(fs.readFileSync(join(job1.task_dir, 'job.json'), 'utf8'));
  assert.equal(rec1.model, 'gemini-4-argon-high');
  assert.equal(rec1.model_source, join(bundled, 'harnesses.json'));

  fs.writeFileSync(
    join(f.env.HUD_HOME, 'harnesses.json'),
    JSON.stringify({ agy: { model: 'home-agy-model' } })
  );
  const job2 = await f.call('hud_create', { role: 'general', on: 'agy', request_key: 'on-agy-home', task: 'Task 2.' });
  const rec2 = JSON.parse(fs.readFileSync(join(job2.task_dir, 'job.json'), 'utf8'));
  assert.equal(rec2.model, 'home-agy-model');
  assert.equal(rec2.model_source, join(f.env.HUD_HOME, 'harnesses.json'));

  const job3 = await f.call('hud_create', {
    role: 'general',
    on: 'agy',
    model: 'explicit-model',
    request_key: 'on-agy-model',
    task: 'Task 3.',
  });
  const rec3 = JSON.parse(fs.readFileSync(join(job3.task_dir, 'job.json'), 'utf8'));
  assert.equal(rec3.model, 'explicit-model');
  assert.equal(rec3.model_source, 'hud_create');
});

test('optional browser roles stay out of roster and dispatch until enabled, without changing owner definitions', async (t) => {
  const f = await fixture(t), hud = f.env.HUD_HOME;
  const names = async () => (await f.call('hud_roster')).roles.map(({ role }) => role);
  const create = (role) => f.call('hud_create', { role, task: 'Synthetic request.' });
  assert.deepEqual((await names()).filter((name) => ['pro', 'flow'].includes(name)), []);
  const off = await create('pro');
  assert.equal(off.code, 'role_unavailable');
  assert.match(off.reason, /Optional role pro is off.*Control.*role-switches\.json/);

  const registry = roleRegistry(hud, f.root, f.env);
  registry.setOptionalRoleEnabled('pro', true);
  assert.ok((await names()).includes('pro'));
  assert.ok((await create('pro')).job);
  assert.ok(!(await names()).includes('flow'));

  const owner = join(hud, 'roles', 'my-flow.json');
  const body = JSON.stringify({ role: 'flow', harness: 'bro', tool: 'jev-flow', kind: 'video' });
  fs.mkdirSync(join(hud, 'roles'));
  fs.writeFileSync(owner, body);
  const flow = (await f.call('hud_roster', { detail: true })).roles.find(({ role }) => role === 'flow');
  assert.equal(flow.kind, 'video');
  assert.equal(flow.source_file, owner);
  registry.setOptionalRoleEnabled('flow', false);
  assert.ok(!(await names()).includes('flow'));
  assert.equal((await create('flow')).code, 'role_unavailable');
  assert.equal(fs.readFileSync(owner, 'utf8'), body);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(hud, 'role-switches.json'), 'utf8')), { pro: true, flow: false });
  assert.equal(fs.statSync(join(hud, 'role-switches.json')).mode & 0o777, 0o600);
});

test('pro falls back across chatgpt -> gemini -> argon and flow passes kind', { timeout: 45000 }, async (t) => {
  // Four independent dispatches: await their results within a test-only hang guard.
  const wait_ms = 30000;
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro', 'flow');
  fs.writeFileSync(join(f.env.HOME, 'bro-quota-fail'), '');
  const fail1 = await f.call('hud_create', { role: 'pro', request_key: 'pro-1', task: 'Ask 1.' });
  const read1 = await f.call('hud_read', { job: fail1.job, wait_ms });
  assert.equal(read1.state, 'failed');
  assert.match(read1.exit_reason, /quota exceeded/);
  assert.match(read1.exit_reason, /next dispatch will use bro\/gemini/);

  fs.unlinkSync(join(f.env.HOME, 'bro-quota-fail'));
  const ok2 = await f.call('hud_create', { role: 'pro', request_key: 'pro-2', task: 'Ask 2.' });
  const read2 = await f.call('hud_read', { job: ok2.job, wait_ms });
  assert.equal(read2.state, 'closed');
  const gemCmd = f.commands().find((c) => c.command === 'jev-ask' && c.args.includes(ok2.job));
  assert.ok(gemCmd.args.includes('gemini'));

  markExhausted(f.env.HUD_HOME, placeKey({ harness: 'bro', tool: 'jev-ask', provider: 'gemini' }), '429');
  const ok3 = await f.call('hud_create', { role: 'pro', request_key: 'pro-3', task: 'Ask 3.' });
  const read3 = await f.call('hud_read', { job: ok3.job, wait_ms });
  assert.equal(read3.state, 'closed');
  const argonCmd = f.commands().find((c) => c.command === 'jev-aistudio' && c.args.includes(ok3.job));
  assert.ok(argonCmd.args.includes('gemini-4-argon'));

  const flowVid = await f.call('hud_create', { role: 'flow', kind: 'video', request_key: 'flow-vid', task: 'Video; cost: 10 credits' });
  const readVid = await f.call('hud_read', { job: flowVid.job, wait_ms });
  assert.equal(readVid.state, 'closed');
  const flowCmd = f.commands().find((c) => c.command === 'jev-flow' && c.args.includes(flowVid.job));
  assert.equal(flowCmd.args[flowCmd.args.indexOf('--kind') + 1], 'video');
});

// The three launches share a test hang guard, not a 10 s dispatch budget.
test('oracle runs locally on claude fable with oracle.md and falls back to pi architect', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const roster = await f.call('hud_roster', { detail: true });
  const oracle = roster.roles.find((r) => r.role === 'oracle');
  assert.equal(oracle.instructions, 'oracle');
  assert.equal(oracle.can_continue, false);
  assert.equal(oracle.harness, 'cli');
  assert.equal(oracle.agent, 'claude');
  assert.equal(oracle.model, 'fable');
  assert.deepEqual(oracle.run, [
    { harness: 'cli', agent: 'claude', model: 'fable', thinking: 'high' },
    { harness: 'pi', pi_role: 'architect', split: false },
  ]);
  const job = await f.call('hud_create', { role: 'oracle', request_key: 'ora-cli', task: 'Design question?' });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  await until(() => f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(job.job)), t.signal);
  const start = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'start');
  assert.equal(start.args[4], 'claude');
  assert.deepEqual(start.args.slice(start.args.indexOf('--model'), start.args.indexOf('--model') + 2), ['--model', 'fable']);
  const prompt = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt');
  assert.equal(start.args[start.args.indexOf('--append-system-prompt-file') + 1], join(bundled, 'instructions/oracle.md'));
  assert.match(prompt.args[3], /^Carry out this brief:\n\nDesign question\?/);

  fs.unlinkSync(join(f.env.PATH, 'claude'));
  const fbRoster = (await f.call('hud_roster', { detail: true })).roles.find((r) => r.role === 'oracle');
  assert.deepEqual(fbRoster.runs_on, { harness: 'pi', pi_role: 'architect', split: false });
  const fbJob = await f.call('hud_create', { role: 'oracle', request_key: 'ora-pi', task: 'Fallback design question?' });
  assert.ok(fbJob.job);
  const fbContract = JSON.parse(fs.readFileSync(join(fbJob.task_dir, 'pi-worker.json'), 'utf8'));
  assert.equal(fbContract.tab?.profile, 'architect');
  assert.equal(fbContract.guard, 'oracle');
  assert.equal(fbContract.instructions, 'oracle');

  const alias = await f.call('hud_create', { role: 'architect', request_key: 'ora-alias', task: 'Alias question?' });
  assert.ok(alias.job);
  assert.equal((await f.call('hud_read', { job: alias.job })).role, 'oracle');
});

test('reviewer uses its CLI instructions; sonic refuses interactive overrides; missing instructions are unsupported', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: false });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  const sonic = await f.call('hud_create', { role: 'sonic', on: 'claude', task: 'Task.' });
  assert.equal(sonic.code, 'invalid_arguments');
  assert.match(sonic.error, /role file and Control.*general/);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  const run = [{ harness: 'cli', agent: 'claude' }];
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'reviewer.json'), JSON.stringify({ role: 'reviewer', instructions: 'reviewer', can_continue: true, run }));
  const job = await f.call('hud_create', { role: 'reviewer', request_key: 'reviewer-cli', task: 'Task.' });
  const promptOf = () => f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(job.job));
  await until(promptOf, t.signal);
  const { args } = f.commands().find((c) => c.args[1] === 'start' && c.args[2] === `${job.job}-primary`);
  assert.equal(args[args.indexOf('--append-system-prompt-file') + 1], join(bundled, 'instructions/reviewer.md'));
  assert.match(promptOf().args[3], /^Carry out this brief:\n\nTask\./);

  // One role, one text on every harness (WORKER-UNIFY): a role whose instruction file is missing has no CLI place.
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'textless.json'), JSON.stringify({
    role: 'textless', instructions: 'textless', can_continue: true, run,
  }));
  const res = await f.call('hud_create', { role: 'textless', request_key: 'unsup-textless', task: 'Task.' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unsupported_harness');
  assert.match(res.path, /instructions\/textless\.md$/);
});

test('legacy role files including harness: jev load and deleted names are absent', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'legacy-roles-'));
  try {
    const hud = join(dir, 'hud'),
      cwd = join(dir, 'cwd'),
      bin = join(dir, 'bin');
    fs.mkdirSync(join(hud, 'roles'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const cmd of ['pi', 'jev-ask']) fs.writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(
      join(hud, 'roles', 'old-jev.json'),
      JSON.stringify({ role: 'old-jev', harness: 'jev', tool: 'jev-ask', provider: 'gemini' })
    );
    fs.writeFileSync(
      join(hud, 'roles', 'old-pi.json'),
      JSON.stringify({ role: 'old-pi', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true })
    );
    const reg = roleRegistry(hud, cwd, { PATH: bin }, undefined, undefined, bundled);
    const roles = reg.roles();
    for (const deleted of ['architect', 'grok-imp', 'agy-imp', 'claude-imp', 'codex-imp', 'argon', 'gemini', 'flow-video']) {
      assert.equal(roles.has(deleted), false, deleted);
    }
    const oldJev = roles.get('old-jev');
    assert.equal(oldJev.harness, 'bro');
    assert.deepEqual(oldJev.run, [{ harness: 'bro', tool: 'jev-ask', provider: 'gemini' }]);
    const oldPi = roles.get('old-pi');
    assert.equal(oldPi.harness, 'pi');
    assert.deepEqual(oldPi.run, [{ harness: 'pi', pi_role: 'implementer', split: true }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { withState } from '../fixtures/state-helpers.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { runningVerb } from '../../dist/collectors/thin-jobs.js';
import { createWorkSummaryPublisher, workSummaryPath } from '../../dist/collectors/work-summary-snapshot.js';
import { expNativePath } from '../../dist/collectors/exp-native.js';
import { readExpData } from '../../dist/collectors/exp-store.js';
import { defaultExpConfig } from '../../dist/exp-config.js';
import { cliKinds } from '../../dist/roles/cli-kinds.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { PI_ROLE_TOOLS } from '../../dist/harness/pi/role-client.js';
import { harnessDefaults, markExhausted, placeKey } from '../../dist/roles/roster.js';
import {
  withoutHint,
  withoutCallerLookups,
  fixture,
  enableOptionalRoles,
  until,
  sonicTask,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { syntheticProc } from '../fixtures/local-load.mjs';

test('CLI state trust defaults, owner overrides, roster facts and dispatch snapshots agree', async (t) => {
  const f = await fixture(t);
  const config = join(f.env.HUD_HOME, 'harnesses.json');
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  for (const agent of ['agy', 'claude', 'codex', 'grok']) {
    fs.writeFileSync(join(f.env.HUD_HOME, 'roles', `${agent}-check.json`), JSON.stringify({
      role: `${agent}-check`, instructions: 'implementer', can_continue: true,
      run: [{ harness: 'cli', agent }],
    }));
  }
  // The owner's existing model-only file still inherits the shipped trust levels.
  fs.writeFileSync(config, JSON.stringify({ agy: { model: 'synthetic/override' } }));
  const bundled = resolve('packages/hud-mcp');
  const defaults = harnessDefaults(f.env.HUD_HOME, bundled);
  assert.equal(defaults.agy.model, 'synthetic/override');
  let roster = (await f.call('hud_roster', { detail: true })).roles;
  for (const agent of ['agy', 'claude', 'codex', 'grok']) {
    assert.equal(defaults[agent].state_trust, 'turn');
    assert.equal(roster.find((r) => r.role === `${agent}-check`).state_trust, 'turn');
  }
  fs.writeFileSync(config, JSON.stringify({ agy: { model: 'synthetic/override', state_trust: 'turn' }, grok: { state_trust: 'advisory' } }));
  roster = (await f.call('hud_roster', { detail: true })).roles;
  assert.equal(roster.find((r) => r.role === 'agy-check').state_trust, 'turn');
  assert.equal(roster.find((r) => r.role === 'grok-check').state_trust, 'advisory');
  // Dispatch through the normal MCP path, rejecting the fake launch before any worker is started.
  fs.writeFileSync(join(f.env.HOME, 'fail-start'), '');
  const agy = await f.call('hud_create', { role: 'agy-check', request_key: 'trust-agy', task: 'Synthetic task.' });
  const grok = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'trust-grok', task: 'Synthetic task.' });
  const record = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(record(agy).cli.state_trust, 'turn');
  assert.equal(record(grok).cli.state_trust, 'advisory');
  fs.writeFileSync(config, JSON.stringify({ agy: { state_trust: 'advisory' }, grok: { state_trust: 'turn' } }));
  assert.equal(record(agy).cli.state_trust, 'turn');
  assert.equal(record(grok).cli.state_trust, 'advisory');
});

test('roster and create report pane watcher liveness, with Claude delivery guidance', async (t) => {
  const f = await fixture(t);
  const create = () => f.call('hud_create', { role: 'imp', request_key: 'watcher-live', task: 'Synthetic task.' });
  const roster = await f.call('hud_roster');
  assert.equal(roster.watcher_alive, false);
  assert.match(roster.hint, /^Claude Code: run `hud watch` under Monitor; re-arm after expiry\./);
  const initial = await create();
  assert.equal(initial.watcher_alive, false);
  assert.equal(initial.hint, roster.hint);

  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { env: f.env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(() => child.kill('SIGKILL'));
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watchers/w4E:p1.pid')), t.signal);
  const live = await f.call('hud_roster');
  assert.equal(live.watcher_alive, true);
  assert.match(live.hint, /^Claude Code: `hud watch` is live under Monitor;/);
  const retry = await create();
  assert.equal(retry.job, initial.job);
  assert.equal(retry.watcher_alive, true);
  assert.equal(Object.hasOwn(retry, 'hint'), false);

  child.kill('SIGTERM');
  await exited;
  assert.equal((await f.call('hud_roster')).watcher_alive, false);
});

test('roster rejects a role file with a multiline thinking purpose', async (t) => {
  const f = await fixture(t);
  sonicTask(f);
  const path = join(f.env.HUD_HOME, 'roles', 'sonic.json');
  const role = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.writeFileSync(path, JSON.stringify({ ...role, thinking_choices: { low: 'First line\nSecond line' } }));
  const roster = await f.call('hud_roster', { detail: true });
  assert.deepEqual(roster.invalid, [{ path, reason: 'bad thinking_choices' }]);
  assert.ok(roster.roles.some(({ role, thinking_choices }) => role === 'sonic' && thinking_choices.low));
});

test('interactive roles share the unanswered-question policy; sonic reports blockers instead', () => {
  const dir = resolve('packages/hud-mcp/instructions');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    const body = fs.readFileSync(join(dir, file), 'utf8').replace(/\s+/g, ' ');
    if (file === 'sonic.md' || file === 'lead.md') {
      assert.doesNotMatch(body, /Ask the orchestrator with `hud_ask`/);
      assert.match(body, /name it as blocked in your report/);
      continue;
    }
    assert.match(body, /If unanswered after 20 minutes, proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report/, file);
  }
});

test('pi role tools match the real MCP tools/list', async (t) => {
  const f = await fixture(t);
  const tools = (await f.rpc('tools/list')).result.tools.filter(({ name }) => name !== 'hud_statusline');
  assert.deepEqual(PI_ROLE_TOOLS, tools);
  // Allow 200 bytes for experiment tags, 225 for ticket Objective links, 160 for workflow/07 lead/live_try options,
  // 110 for unattended/03 cancel run ID, 1750 for JSON ticket editing, bulk updates, and linked ticket briefs,
  // and 270 for ticket repairs refs on add/update.
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const separateBudgets = { hud_objective: 1350, hud_schedule: 1100, hud_workflow: 850 };
  const combinedBudget = 9708 + 200 + 225 + 160 + 110 + 1750 + 270;
  const combinedBytes = bytes(tools.filter(({ name }) => !Object.hasOwn(separateBudgets, name)));
  assert.ok(combinedBytes <= combinedBudget, `existing role declarations: ${combinedBytes} bytes exceeds ${combinedBudget}-byte budget`);
  for (const [name, budget] of Object.entries(separateBudgets)) {
    assert.ok(bytes(tools.find((tool) => tool.name === name)) <= budget, `${name} declaration fits its ${budget}-byte budget`);
  }
  assert.match(tools.find(({ name }) => name === 'hud_read').description, /close at turn end with a declared report, read or not/);
  assert.match(tools.find(({ name }) => name === 'hud_create').inputSchema.properties.mode.description, /Imp routing may select it/);
});

const statuslineState = 'com.openai/codex-statusline-state';
const footerUri = 'ui://myhud/codex-statusline';
const footerMime = 'application/json';
async function readFooter(f, state) {
  const params = { uri: footerUri, ...(state === undefined ? {} : { _meta: { [statuslineState]: state } }) };
  const reply = await f.rpc('resources/read', params);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.contents.length, 1);
  const [{ uri, mimeType, text }] = reply.result.contents;
  assert.equal(uri, footerUri);
  assert.equal(mimeType, footerMime);
  const tree = JSON.parse(text);
  assert.equal(tree.type, 'row');
  assert.deepEqual(tree.props, { gap: 2, wrap: 'nowrap' });
  return tree;
}
const footerText = (tree) => tree.children.map((node) => node.children.join(''));
const windowOf = (minutes, used, resetsAt = null) => ({ used_percent: used, window_minutes: minutes, resets_at: resetsAt });

test('Codex native footer discovers MyHUD and serves ordered, request-local facts with no width', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, true, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    process.env.HUD_STATUSLINE_PROC_ROOT = process.env.HOME + '/proc';
    const readdir = fs.readdirSync;
    fs.readdirSync = (path, ...args) => {
      if (fs.existsSync(process.env.HOME + '/footer-reads') && /\\/(jobs|sessions)(\\/|$)/.test(String(path))) {
        fs.appendFileSync(process.env.HOME + '/footer-scans', String(path) + '\\n');
      }
      return readdir(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const initialized = await f.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(initialized.result.capabilities.resources, {});
  const { result: { tools } } = await f.rpc('tools/list');
  const providers = tools.filter((tool) => tool._meta?.['openai/ui']?.entrypoints);
  assert.deepEqual(providers.map(({ title, _meta }) => [title, _meta['openai/ui'].entrypoints]), [
    ['MyHUD', [{ type: 'statusline', resourceUri: footerUri }]],
  ]);
  assert.deepEqual((await f.rpc('resources/list')).result.resources, [
    { uri: footerUri, name: 'codex-statusline', mimeType: footerMime },
  ]);
  assert.equal((await f.rpc('resources/read', { uri: 'ui://other/footer' })).error.code, -32002);
  assert.equal((await f.rpc('resources/read')).error.code, -32602);

  const now = Date.now();
  const pendingJob = (id, pane, role) => {
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: id, role, herdr_pane: pane, created_at: new Date(now) }));
    const file = join(dir, 'STATUS.json');
    fs.writeFileSync(file, JSON.stringify({ state: 'waiting_orchestrator', harness: 'cli', blocked: true }));
    return file;
  };
  pendingJob('j0000000000000001', 'w4E:p1', 'imp');
  pendingJob('j0000000000000002', 'w4E:p2', 'other');
  fs.writeFileSync(join(f.env.HUD_HOME, 'watch.pid'), `${process.pid}\n`);
  assert.equal(createWorkSummaryPublisher(f.env.HUD_HOME, 'hud-watch').publish({ watching: true }), true);
  fs.writeFileSync(join(f.env.HOME, 'footer-reads'), '');

  const a = {
    config: { profile: 'synthetic-a' },
    thread: { id: 'synthetic-thread-a', model: { id: 'openai/gpt-6.2-sol', reasoning_level: 'high' },
      usage: { context: { used_percentage: 38 } } },
    account: { rate_limits: [
      { limit_id: 'other-bucket', primary_limit: windowOf(1, 99) },
      { limit_id: 'codex', primary_limit: windowOf(300, 28), secondary_limit: windowOf(10080, 44) },
    ] },
  };
  const b = {
    config: { profile: 'synthetic-b' },
    thread: { id: 'synthetic-thread-b', model: { display_name: 'Example B' },
      usage: { context: { used_tokens: 12, context_window_size: 100 } } },
    account: { rate_limits: [
      { limit_id: 'codex', primary_limit: windowOf(300, 115), secondary_limit: windowOf(10080, 99, 1) },
    ] },
  };
  const { write } = syntheticProc(f.env.HOME, '6.6.0-microsoft-standard-WSL2');
  write('meminfo', 'MemTotal: 8388608 kB\nMemAvailable: 2097152 kB\n');
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ icons: 'text' }));
  const load = ['I1  .1', ...(process.platform === 'linux' ? ['M75%'] : [])];
  const ordered = ['6.2-sol high', 'ctx 38%', '5h 72% left', '7d 56% left', ...load];
  assert.deepEqual(footerText(await readFooter(f, a)), ordered);
  assert.deepEqual(footerText(await readFooter(f, b)), ['Example B', 'ctx 12%', '5h 0% left', ...load]);
  assert.deepEqual(footerText(await readFooter(f, a)), ordered);
  assert.deepEqual(footerText(await readFooter(f, {
    thread: { model: { id: null, display_name: null }, usage: { context: { used_percentage: -1 } } },
    account: { rate_limits: [{ limit_id: 'codex', primary_limit: windowOf(null, 9) }] },
  })), load);

  // Time across stdio with a warmed jobs cache and EXP enabled, including the first last-seen write.
  const exp = join(f.env.HUD_HOME, 'exp');
  fs.mkdirSync(exp);
  fs.writeFileSync(join(exp, 'config.json'), JSON.stringify({ version: 1, codex: { enabled: true } }));
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ experiments: true }));
  for (let batch = 0; batch < 3; batch++) {
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      await readFooter(f, a);
      samples.push(performance.now() - start);
    }
    samples.sort((x, y) => x - y);
    const stats = [15, 29, 30].map((rank) => samples[rank - 1].toFixed(3)).join('/');
    t.diagnostic(`footer stdio n=30 p50/p95/p99=max ${stats} ms`);
    assert.ok(samples.at(-1) < 250, `footer RPC too slow: ${stats} ms`);
  }
  fs.unlinkSync(workSummaryPath(f.env.HUD_HOME));
  assert.deepEqual(footerText(await readFooter(f)), load.slice(1), 'local RAM survives; stale job counts do not');
  assert.equal(fs.existsSync(join(f.env.HOME, 'footer-scans')), false);
  assert.deepEqual(f.commands(), []);
  assert.deepEqual(f.socketRequests, []);
});

test('Codex footer last-seen is opt-in, private, throttled and reaches only its canonical local EXP profile', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, false, `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.env.CODEX_HOME = join(process.env.HOME, '.codex-link');
    process.env.HUD_STATUSLINE_PROC_ROOT = join(process.env.HOME, 'proc');
    const now = Date.now;
    Date.now = () => {
      try { return Number(readFileSync(join(process.env.HOME, 'footer-clock'), 'utf8')); }
      catch { return now(); }
    };
  `);
  const exp = join(f.env.HUD_HOME, 'exp');
  const own = join(f.env.HOME, '.codex-local'), other = join(f.env.HOME, '.codex-other');
  for (const dir of [own, other]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'config.toml'), '# synthetic\n');
  }
  fs.symlinkSync(own, join(f.env.HOME, '.codex-link'));
  const seen = expNativePath(f.env.HUD_HOME, fs.realpathSync(own));
  const clock = (now) => fs.writeFileSync(join(f.env.HOME, 'footer-clock'), String(now));
  const config = (enabled) => {
    const data = defaultExpConfig();
    data.codex.enabled = enabled;
    data.proxy.profile = other;
    data.codex.aliases[fs.realpathSync(own)] = 'Local';
    fs.writeFileSync(join(exp, 'config.json'), JSON.stringify(data));
  };
  const legacySettings = (experiments) => fs.writeFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), JSON.stringify({ experiments }));
  const state = { config: { profile: other }, thread: { model: { display_name: 'Example' } } };
  const firstAt = 1_768_000_000_000;
  clock(firstAt);
  legacySettings(true);
  assert.deepEqual(footerText(await readFooter(f, state)), ['Example']);
  assert.equal(fs.existsSync(exp), false);
  fs.mkdirSync(exp);
  config(false);
  await readFooter(f, state);
  assert.equal(fs.existsSync(seen), false);
  config(true);
  await readFooter(f);
  assert.equal(fs.existsSync(seen), false, 'a discovery read without statusline state is not a native observation');
  await readFooter(f, state);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { version: 1, lastSeenAt: firstAt });
  const first = fs.statSync(seen);
  assert.equal(first.mode & 0o777, 0o600);
  clock(firstAt + 59_999);
  await readFooter(f, state);
  assert.equal(fs.statSync(seen).ino, first.ino);
  legacySettings(false);
  clock(firstAt + 60_000);
  assert.deepEqual(footerText(await readFooter(f, state)), ['Example']);
  const second = fs.statSync(seen);
  assert.notEqual(second.ino, first.ino, 'update atomically replaces the file');
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { version: 1, lastSeenAt: firstAt + 60_000 });
  config(false);
  clock(firstAt + 120_000);
  assert.deepEqual(footerText(await readFooter(f, state)), ['Example']);
  assert.equal(fs.statSync(seen).ino, second.ino);
  config(true);
  assert.deepEqual(fs.readdirSync(exp).sort(), [basename(seen), 'config.json']);
  const expData = readExpData(f.env.HUD_HOME, f.env, firstAt + 120_000);
  assert.deepEqual(expData.profiles.map(({ home, lastNativeSeenAt }) => [home, lastNativeSeenAt]), [
    [fs.realpathSync(own), firstAt + 60_000], [fs.realpathSync(other), undefined],
  ]);
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
  const frame = renderMonitor({ tree, state: withState(initialMonitorState(), { activeTab: 'control', control: { subTab: 'resources' } }),
    expData, width: 40, height: 24, nowMs: firstAt + 120_000 });
  const date = new Date(firstAt + 60_000).toISOString().slice(5, 16).replace('T', ' ');
  const lines = frame.lines.map((line) => stripAnsi(line).trimEnd()).join('\n');
  assert.ok(frame.lines.every((line) => visualLength(line) === 40));
  assert.match(lines, /Track native status line +on/);
  assert.match(lines, new RegExp(`^  Local \\(\\.codex-link\\) +seen ${date}$`, 'm'));
  assert.match(lines, /^  \.codex-other +bar not seen yet$/m);
  assert.equal(fs.readFileSync(join(own, 'config.toml'), 'utf8'), '# synthetic\n');
  assert.equal(fs.readFileSync(join(other, 'config.toml'), 'utf8'), '# synthetic\n');
});

// Breaks if roster omits the shipped convention/path, merges overrides, or reverses project/home/default precedence.
test('thin roster returns the convention and its path with whole-file overrides', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'flow');
  const initialized = await f.rpc('initialize');
  assert.match(initialized.result.instructions, /hud_roster when project dispatch context is missing or stale/);
  const shipped = resolve('packages/hud-mcp/hud-convention.md');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: shipped,
    text: fs.readFileSync(shipped, 'utf8'),
    truncated: false,
  });
  const owner = join(f.env.HUD_HOME, 'hud-convention.md');
  fs.writeFileSync(owner, 'Synthetic owner convention.');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: owner,
    text: 'Synthetic owner convention.',
    truncated: false,
  });
  const project = join(f.root, 'hud-convention.md');
  fs.writeFileSync(project, 'Synthetic project convention.');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: project,
    text: 'Synthetic project convention.',
    truncated: false,
  });
  const first = await f.call('hud_roster');
  const refresh = (version = first.convention_version, cwd = f.root) =>
    f.call('hud_roster', { cwd, convention_version: version });
  const checked = await refresh();
  assert.equal(checked.convention_unchanged, true);
  assert.equal(checked.convention, undefined);
  fs.writeFileSync(project, 'Changed project convention.');
  const changed = await refresh();
  assert.equal(changed.convention.text, 'Changed project convention.');
  fs.writeFileSync(owner, changed.convention.text);
  fs.unlinkSync(project);
  const source = await refresh(changed.convention_version);
  assert.equal(source.convention.path, owner, 'identical text from a new source must be returned');
  const other = join(f.root, 'other-project');
  fs.mkdirSync(other);
  const different = await refresh(source.convention_version, other);
  assert.deepEqual(different.convention, source.convention, 'another project must get the body');
  const model = first.roles.find(({ role }) => role === 'flow').runs_on;
  markExhausted(f.env.HUD_HOME, placeKey(model), 'quota exceeded');
  const refreshed = await refresh(source.convention_version);
  assert.equal(refreshed.convention_unchanged, true);
  const flow = refreshed.roles.find(({ role }) => role === 'flow');
  assert.equal(flow.available, false);
  assert.match(flow.reason, /quota exceeded.*until/);
  const failure = await f.call('hud_create', { role: 'flow', request_key: 'unavailable-flow', task: 'Synthetic.' });
  assert.equal(failure.code, 'no_available_place');
  assert.equal(failure.reason, flow.reason);
  assert.deepEqual(withoutCallerLookups(f.commands()), [], 'unavailable roles do not launch');
  fs.writeFileSync(project, 'x'.repeat(20001));
  const capped = await f.call('hud_roster');
  assert.deepEqual(capped.convention, {
    path: project,
    text: 'x'.repeat(20000),
    truncated: true,
  });
  fs.appendFileSync(project, 'beyond cap');
  assert.deepEqual((await refresh(capped.convention_version)).convention, capped.convention);
});

test('thin roles load a custom role file and dispatch its mapped pi role', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const role = {
    role: 'synthetic-writer',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'synthetic/override',
    thinking: 'high',
  };
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'));
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'writer.json'), JSON.stringify(role));
  const roster = await f.call('hud_roster', { detail: true });
  const place = {
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    model: 'synthetic/override',
    thinking: 'high',
  };
  assert.deepEqual(
    roster.roles.find((entry) => entry.role === role.role),
    {
      ...role,
      instructions: 'implementer',
      run: [place],
      presets: [],
      preset: null,
      runs_on: place,
      places: [{ index: 0, place, state: 'active', key: 'pi:synthetic/override', provider: 'synthetic', provider_source: 'model',
        switch_ids: ['pi', 'pi:synthetic'],
        model: { value: 'synthetic/override', source: join(f.env.HUD_HOME, 'roles', 'writer.json') },
        thinking: { value: 'high', source: join(f.env.HUD_HOME, 'roles', 'writer.json') } }],
      exhausted: [],
      accepts_options: ['lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'],
      available: true,
      source_file: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      model_source: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      thinking_source: join(f.env.HUD_HOME, 'roles', 'writer.json'),
    }
  );
  const imp = roster.roles.find((entry) => entry.role === 'imp');
  assert.equal(imp.model, 'openai/gpt-6.2-sol');
  assert.equal(imp.thinking, 'high');
  assert.equal(imp.model_source, 'pi_role:implementer');
  assert.equal(imp.thinking_source, imp.model_source);
  assert.equal(roster.roles.some((r) => r.role === 'architect'), false);
  const oracle = roster.roles.find((r) => r.role === 'oracle');
  assert.equal(oracle.preset, 'fable');
  assert.deepEqual(oracle.accepts_options, []);
  assert.deepEqual(oracle.presets, [
    { name: 'fable', run: oracle.run },
    { name: 'architect', run: [{ harness: 'pi', pi_role: 'architect', split: false }] },
  ]);
  for (const name of ['imp', 'reviewer']) {
    const r = roster.roles.find((r) => r.role === name);
    assert.equal(r.preset, 'default');
    assert.deepEqual(r.presets[0].run, r.run);
  }
  assert.deepEqual(imp.presets.map((p) => p.name), ['default', 'hydrogen', 'astra']);
  for (const name of ['sonic', 'general']) {
    const r = roster.roles.find((r) => r.role === name);
    if (r) assert.deepEqual([r.presets, r.preset], [[], null]);
  }
  assert.deepEqual(withoutHint(await f.call('hud_create', { role: 'unknown', request_key: 'unknown', task: 'Synthetic task.' })), {
    ok: false,
    code: 'role_unavailable',
    reason: 'Role unknown is not configured or is hidden in this project',
  });
  const job = await f.call('hud_create', { role: role.role, request_key: 'custom-role', task: 'Synthetic task.' });
  const argv = f.commands().find((c) => c.args[0] === 'agent' && c.args[1] === 'start').args;
  const contract = JSON.parse(fs.readFileSync(join(job.task_dir, 'pi-worker.json'), 'utf8'));
  assert.equal(contract.tab?.effortSource, 'orchestrator');
  assert.equal(contract.role, role.role);
  assert.equal(argv[argv.indexOf('--model') + 1], 'synthetic/override');
  assert.equal(argv[argv.indexOf('--thinking') + 1], 'high');
  assert.equal(
    f.commands().some((c) => c.args[1] === 'split'),
    false
  );
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(Object.hasOwn(receipt, 'package'), false);
  assert.equal(Object.hasOwn(receipt, 'preset'), false);
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'custom-send', text: 'Synthetic follow-up.' })).sent,
    true
  );
  assert.equal(Object.hasOwn(await f.call('hud_read', { job: job.job }), 'preset'), false);
});

test('general uses a named preset for one job and falls back within it without editing roles', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles');
  const file = join(roles, 'general.json');
  const role = {
    role: 'general', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', model: 'synthetic/normal', skills: ['normal-only'] }],
    presets: [{ name: 'default', run: [
      { harness: 'pi', model: 'synthetic/primary', thinking: 'low' },
      { harness: 'pi', pi_role: 'reviewer', model: 'synthetic/backup', thinking: 'high', split: true },
    ] }],
  };
  const original = JSON.stringify(role, null, 2) + '\n';
  fs.mkdirSync(roles);
  fs.writeFileSync(file, original);
  const roster = async () => (await f.call('hud_roster', { detail: true })).roles.find((r) => r.role === 'general');
  const before = await roster();
  assert.equal(before.runs_on.model, 'synthetic/normal');
  assert.deepEqual(before.accepts_options, ['on', 'instructions', 'preset', 'model', 'thinking', 'lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args']);

  const args = { role: 'general', preset: 'default', task: 'Synthetic task.' };
  const receipt = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  const piArgv = () => f.commands().filter((c) => c.args[0] === 'agent' && c.args[1] === 'start').at(-1).args;
  const first = await f.call('hud_create', { ...args, request_key: 'preset-primary' });
  assert.equal(receipt(first).dispatch_exit_code, 0);
  assert.equal(receipt(first).preset, 'default');
  assert.equal(piArgv()[piArgv().indexOf('--model') + 1], 'synthetic/primary');
  assert.equal(piArgv()[piArgv().indexOf('--thinking') + 1], 'low');
  assert.equal((await f.call('hud_read', { job: first.job, detail: true })).preset, 'default');
  assert.deepEqual(receipt(first).skipped_skills, []); // No skills inherited from the unselected default run.

  markExhausted(f.env.HUD_HOME, 'pi:synthetic/primary', 'rate limit');
  const fallback = await f.call('hud_create', {
    ...args, request_key: 'preset-fallback', lens: false, split: false,
  });
  const record = receipt(fallback);
  assert.equal(record.dispatch_exit_code, 0);
  assert.equal(record.preset, 'default');
  assert.equal(record.place.pi_role, 'reviewer');
  assert.equal(record.model_source, file);
  assert.equal(piArgv()[piArgv().indexOf('--model') + 1], 'synthetic/backup');
  assert.equal(piArgv()[piArgv().indexOf('--thinking') + 1], 'high');
  assert.equal(piArgv().some((arg) => arg.includes('pi-lens')), false);
  const read = await f.call('hud_read', { job: fallback.job, detail: true });
  assert.deepEqual([read.preset, read.model, read.split], ['default', 'synthetic/backup', false]);
  const override = await f.call('hud_create', { ...args, request_key: 'preset-override', model: 'synthetic/override' });
  assert.equal(receipt(override).place.pi_role, 'implementer', 'quota on the old model does not exhaust an override');
  assert.equal(receipt(override).place_key, 'pi:synthetic/override');
  assert.equal(receipt(override).model_source, 'hud_create');
  assert.equal(piArgv()[piArgv().indexOf('--model') + 1], 'synthetic/override');
  assert.equal(piArgv()[piArgv().indexOf('--thinking') + 1], 'low');
  assert.equal((await f.call('hud_create', { ...args, request_key: 'preset-fallback', preset: 'ignored-on-duplicate' })).job, fallback.job);

  markExhausted(f.env.HUD_HOME, 'pi:synthetic/backup', 'rate limit');
  const unavailable = await f.call('hud_create', { ...args, request_key: 'preset-unavailable' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'no_available_place');
  assert.deepEqual(unavailable.exhausted.map((p) => p.key), ['pi:synthetic/primary', 'pi:synthetic/backup']);
  assert.equal(f.commands().filter((c) => c.args[0] === 'agent' && c.args[1] === 'start').length, 3);
  assert.deepEqual(await roster(), before);
  assert.deepEqual(fs.readdirSync(roles), ['general.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('roster and create use the active imp preset without advertising caller placement options', async (t) => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles'), file = join(roles, 'imp.json');
  const run = [{ harness: 'pi', model: 'synthetic/file' }];
  fs.mkdirSync(roles);
  fs.writeFileSync(file, JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true, run,
    active_preset: 'same-b', hidden_presets: ['hydrogen'], presets: [
      { name: 'same-a', run: [{ harness: 'pi', model: 'synthetic/named', thinking: 'high' }] },
      { name: 'same-b', run: [{ harness: 'pi', model: 'synthetic/named', thinking: 'high' }] },
      { name: 'file-copy', run },
    ] }));
  const start = fs.readFileSync(file, 'utf8');
  const roster = async (detail) => (await f.call('hud_roster', { detail })).roles.find((r) => r.role === 'imp');
  const selected = await roster(true);
  assert.equal((await roster(false)).preset, 'same-b');
  assert.equal(selected.preset, 'same-b');
  assert.equal(selected.run[0].model, 'synthetic/named');
  assert.equal(selected.runs_on.model, 'synthetic/named');
  assert.equal(selected.presets.some((p) => p.name === 'hydrogen'), false);
  assert.deepEqual(selected.accepts_options, ['lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args']);
  const create = async (key) => {
    const job = await f.call('hud_create', { role: 'imp', request_key: key, task: 'Synthetic task.' });
    return JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  };
  assert.equal((await create('selector')).model, 'synthetic/named');
  assert.deepEqual(await roster(true), selected);
  assert.equal(fs.readFileSync(file, 'utf8'), start);
});

test('hud_create rejects unknown, conflicting and malformed preset arguments before dispatch', async (t) => {
  const f = await fixture(t);
  const args = { role: 'general', request_key: 'invalid-preset', task: 'Synthetic task.' };
  assert.deepEqual(withoutHint(await f.call('hud_create', { ...args, preset: 'missing' })), {
    ok: false, code: 'invalid_arguments', error: 'unknown preset: missing',
  });
  assert.deepEqual(await f.call('hud_create', { ...args, preset: 'default', on: 'pi' }), {
    ok: false, code: 'invalid_arguments', error: 'preset and on are mutually exclusive',
  });
  for (const preset of ['', 42, null]) {
    const { result } = await f.rpc('tools/call', { name: 'hud_create', arguments: { ...args, preset } });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: false, code: 'tool_error', error: 'invalid_arguments: preset',
    });
  }
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('a running job says what its role does: only an implementer builds', () => {
  assert.equal(runningVerb('imp', 'pi'), 'build');
  assert.equal(runningVerb('glm-imp', 'pi'), 'build');
  assert.equal(runningVerb('reviewer', 'pi'), 'reviewing');
  assert.equal(runningVerb('architect', 'pi'), 'researching');
  assert.equal(runningVerb('oracle', 'bro'), 'asking web');
  assert.equal(runningVerb('pro', 'bro'), 'asking web');
  assert.equal(runningVerb('flow', 'bro'), 'generating');
  assert.equal(runningVerb('sonic', 'pi'), 'working');
  assert.equal(runningVerb('grok-imp', 'cli'), 'build');
});

test('cli kind table holds launch facts and the registry accepts only a valid cli role', async (t) => {
  assert.deepEqual(cliKinds.grok.model('grok-4.7'), ['-m', 'grok-4.7']);
  assert.deepEqual(cliKinds.grok.effort('high'), ['--reasoning-effort', 'high']);
  assert.deepEqual(cliKinds.grok.bypass, ['--permission-mode', 'bypassPermissions']);
  assert.equal(cliKinds.grok.trust.decline[0], 'n');
  assert.equal(cliKinds.grok.startTimeoutMs, null);
  assert.equal(cliKinds.agy.trust.text, 'Do you trust the contents of this project?');
  assert.deepEqual([...cliKinds.agy.trust.decline], ['down', 'enter']);
  assert.deepEqual(cliKinds.agy.model('gemini-4-hydrogen-high'), ['--model', 'gemini-4-hydrogen-high']);
  assert.deepEqual(cliKinds.agy.bypass, ['--dangerously-skip-permissions']);
  assert.equal(cliKinds.claude.trust.text, 'Is this a project you created or one you trust?');
  assert.deepEqual([...cliKinds.claude.trust.decline], ['enter']);
  assert.deepEqual(cliKinds.claude.model('opus'), ['--model', 'opus']);
  assert.deepEqual(cliKinds.claude.effort('high'), ['--effort', 'high']);
  assert.deepEqual(cliKinds.claude.bypass, ['--dangerously-skip-permissions']);
  assert.equal(cliKinds.codex.startTimeoutMs, 90000);
  assert.equal(cliKinds.codex.startupQuirk, 'phantom-working');
  assert.equal(cliKinds.codex.trust, null);
  assert.deepEqual(cliKinds.codex.model('gpt-6.1-sol'), ['-m', 'gpt-6.1-sol']);
  assert.deepEqual(cliKinds.codex.effort('high'), ['-c', 'model_reasoning_effort=high']);
  assert.deepEqual(cliKinds.codex.bypass, ['--dangerously-bypass-approvals-and-sandbox']);
  const f = await fixture(t);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  const customCli = join(f.env.HUD_HOME, 'roles', 'cli-check.json');
  fs.writeFileSync(
    customCli,
    JSON.stringify({ role: 'cli-check', harness: 'cli', agent: 'grok', model: 'grok-4.7', thinking: 'high', can_continue: true })
  );
  const roster = (await f.call('hud_roster', { detail: true })).roles;
  for (const deleted of ['grok-imp', 'agy-imp', 'claude-imp', 'codex-imp', 'argon', 'gemini', 'flow-video']) {
    assert.equal(roster.some((entry) => entry.role === deleted), false, deleted);
  }
  const role = roster.find((entry) => entry.role === 'cli-check');
  assert.equal(role.harness, 'cli');
  assert.equal(role.agent, 'grok');
  assert.equal(role.model, 'grok-4.7');
  assert.equal(role.thinking, 'high');
  assert.equal(role.can_continue, true);
  assert.deepEqual(role.accepts_options, []);
  assert.equal(Object.hasOwn(role, 'pi_role_file'), false);
  const imp = roster.find((entry) => entry.role === 'imp');
  assert.deepEqual(imp.run.map((place) => place.harness), ['pi']);
  const reviewer = roster.find((entry) => entry.role === 'reviewer');
  assert.deepEqual(reviewer.run.map((place) => place.harness), ['pi', 'cli']);
  fs.unlinkSync(customCli);
  const bad = async (body) => {
    fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
    const path = join(f.env.HUD_HOME, 'roles', 'bad.json');
    fs.writeFileSync(path, JSON.stringify(body));
    const roster = await f.call('hud_roster');
    assert.equal(
      roster.roles.some((entry) => entry.role === 'imp'),
      true
    );
    assert.deepEqual(roster.invalid, [{ path, reason: 'bad cli fields' }]);
    assert.equal(JSON.stringify(roster.invalid).includes('not-an-array'), false);
  };
  await bad({ role: 'bad', harness: 'cli', agent: 'nope', can_continue: true });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok' });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, idle_grace_s: -1 });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, args: 'not-an-array' });
  fs.unlinkSync(join(f.env.HUD_HOME, 'roles', 'bad.json'));
  const cleared = await f.call('hud_roster');
  assert.equal(
    cleared.roles.some((entry) => entry.role === 'imp'),
    true
  );
  assert.equal(cleared.invalid, undefined);
});

test('a bad role file is skipped; roster and create name it without dropping other roles', async (t) => {
  const f = await fixture(t);
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  const writer = { role: 'synthetic-writer', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true };
  fs.writeFileSync(join(rolesDir, 'writer.json'), JSON.stringify(writer));
  const badPath = join(rolesDir, 'bad.json');
  const secret = 'SECRET_ROLE_FILE_BODY_MUST_NOT_LEAK';
  const cases = [
    [`{${secret}`, 'unparseable JSON', null],
    [JSON.stringify({ role: 'bad', harness: 'browser' }), 'unknown harness browser', 'bad'],
    [JSON.stringify({ role: 'bad', harness: secret }), 'unknown harness invalid', 'bad'],
    [JSON.stringify({ harness: 'pi', note: secret }), 'missing role', null],
    [JSON.stringify({ role: 'bad', harness: 'pi', split: false, can_continue: true }), 'bad pi fields', 'bad'],
    [JSON.stringify({ role: 'bad', harness: 'cli', agent: 'nope', can_continue: true }), 'bad cli fields', 'bad'],
    [JSON.stringify({ role: 'bad', mcp_servers: [1] }), 'bad mcp_servers', 'bad'],
    [JSON.stringify({ role: 'bad', harness: 'jev', tool: 'jev-ask' }), 'bad bro fields', 'bad'],
    [
      JSON.stringify({
        role: 'bad',
        harness: 'pi',
        pi_role: 'implementer',
        split: false,
        can_continue: true,
        model: 1,
      }),
      'bad model/thinking/effort',
      'bad',
    ],
  ];
  for (const [body, reason, roleName] of cases) {
    fs.writeFileSync(badPath, body);
    const roster = await f.call('hud_roster');
    assert.equal(
      roster.roles.some((entry) => entry.role === 'imp'),
      true,
      reason
    );
    assert.equal(
      roster.roles.some((entry) => entry.role === 'synthetic-writer'),
      true,
      reason
    );
    assert.deepEqual(roster.invalid, [{ path: badPath, reason }], reason);
    assert.equal(JSON.stringify(roster.invalid).includes(secret), false, reason);
    assert.deepEqual(
      withoutHint(await f.call('hud_create', { role: roleName ?? 'bad', request_key: `bad-${reason}`, task: 'Synthetic task.' })),
      roleName ? { ok: false, code: 'role_unavailable', path: badPath, reason } :
        { ok: false, code: 'role_unavailable', reason: 'Role bad is not configured or is hidden in this project' },
      reason
    );
  }
  assert.deepEqual(
    await f.call('hud_create', { role: 'missing-entirely', request_key: 'none', task: 'Synthetic task.' }),
    {
      ok: false,
      code: 'role_unavailable',
      reason: 'Role missing-entirely is not configured or is hidden in this project',
    }
  );
  assert.deepEqual(await f.call('hud_read'), { jobs: [] });
  fs.writeFileSync(join(rolesDir, 'imp.json'), '{');
  const kept = await f.call('hud_roster', { detail: true });
  assert.equal(
    kept.roles.find((entry) => entry.role === 'imp').source_file,
    resolve('packages/hud-mcp/roles/imp.json')
  );
  assert.ok(
    kept.invalid.some((item) => item.path === join(rolesDir, 'imp.json') && item.reason === 'unparseable JSON')
  );
  fs.writeFileSync(badPath, secret);
  fs.chmodSync(badPath, 0);
  const blocked = await f.call('hud_roster');
  assert.ok(blocked.invalid.some((item) => item.path === badPath && item.reason === 'unreadable'));
  assert.equal(JSON.stringify(blocked).includes(secret), false);
  assert.equal(
    blocked.roles.some((entry) => entry.role === 'imp'),
    true
  );
  fs.chmodSync(badPath, 0o600);
});

test('hud_roster cwd and hud_create use a registered project role', async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'proj');
  fs.mkdirSync(join(proj, 'sub'), { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: proj, encoding: 'utf8' }).status, 0);
  const root = fs.realpathSync(proj);
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  const role = {
    role: 'frontend',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'project/model',
    thinking: 'low',
    skills: ['to-tickets'],
  };
  fs.mkdirSync(join(proj, '.hud/roles'), { recursive: true });
  fs.writeFileSync(join(proj, '.hud/roles/frontend.json'), JSON.stringify(role));
  fs.writeFileSync(join(proj, '.hud/roles/imp.json'), JSON.stringify({ ...role, role: 'imp', model: 'project/imp' }));
  const cli = { harness: 'cli', agent: 'grok', model: 'synthetic-cli', thinking: 'high' };
  const fallback = { harness: 'pi', pi_role: 'implementer', split: false };
  fs.writeFileSync(
    join(proj, '.hud/roles/cli.json'),
    JSON.stringify({ role: 'local-cli', instructions: 'implementer', can_continue: true, run: [cli, fallback] })
  );
  fs.writeFileSync(join(proj, '.hud/project.json'), JSON.stringify({ version: 1, roles: ['frontend', 'local-cli', 'nope'] }));
  fs.writeFileSync(join(proj, '.hud/hud-convention.md'), 'Project convention only.');
  fs.writeFileSync(join(proj, 'hud-convention.md'), 'Cwd convention must lose.');
  const roster = await f.call('hud_roster', { cwd: join(proj, 'sub'), detail: true });
  assert.deepEqual(roster.project, { root, registered: true });
  assert.equal(roster.project_config_ignored, undefined);
  assert.equal(roster.roles.find((entry) => entry.role === 'frontend').model, 'project/model');
  assert.equal(
    roster.roles.find((entry) => entry.role === 'frontend').source_file,
    join(root, '.hud/roles/frontend.json')
  );
  assert.deepEqual(roster.roles.find((entry) => entry.role === 'frontend').skills, ['to-tickets']);
  assert.equal(
    roster.roles.some((entry) => entry.role === 'imp'),
    false
  );
  assert.deepEqual(roster.invalid, []);
  const projectCli = roster.roles.find((entry) => entry.role === 'local-cli');
  assert.equal(projectCli.source_file, join(root, '.hud/roles/cli.json'));
  assert.deepEqual(projectCli.run, [cli, fallback]);
  const compact = await f.call('hud_roster', { cwd: proj });
  assert.deepEqual(compact.roles.find((entry) => entry.role === 'local-cli'), {
    role: 'local-cli', instructions: 'implementer', available: true, can_continue: true, runs_on: cli,
    places: [{ index: 0, state: 'active' }, { index: 1, state: 'standby', provider: 'openai', provider_source: 'pi_role' }],
  });
  const local = await f.call('hud_create', {
    role: 'local-cli', request_key: 'project-cli-untrusted', task: 'Synthetic CLI task.', cwd: proj,
  });
  assert.equal(local.attempts[0].reason, `grok has not trusted ${proj}; run hud trust ${proj}`);
  assert.equal(local.used_place, 'pi (openai/gpt-6.2-sol)');
  assert.equal(roster.convention.path, join(root, '.hud/hud-convention.md'));
  assert.equal(roster.convention.text, 'Project convention only.');
  const server = await f.call('hud_roster');
  assert.equal(server.project.registered, false);
  assert.equal(server.project.root, fs.realpathSync(f.root));
  assert.equal(
    server.roles.some((entry) => entry.role === 'frontend'),
    false
  );
  assert.equal(
    server.roles.some((entry) => entry.role === 'imp'),
    true
  );
  const created = await f.call('hud_create', {
    role: 'frontend',
    request_key: 'project-role',
    task: 'Synthetic project task.',
    cwd: proj,
  });
  const receipt = JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.model, 'project/model');
  assert.equal(receipt.cwd, resolve(proj));
  const launch = f.commands().find((entry) => entry.args[0] === 'agent' && entry.args[1] === 'start').args;
  assert.equal(JSON.parse(fs.readFileSync(join(created.task_dir, 'pi-worker.json'), 'utf8')).tab?.profile, 'implementer');
  assert.equal(launch.includes('--skill'), false);
  assert.deepEqual(
    await f.call('hud_create', { role: 'imp', request_key: 'hidden-imp', task: 'Synthetic task.', cwd: proj }),
    { ok: false, code: 'role_unavailable', reason: 'Role imp is not configured or is hidden in this project' }
  );
  const home = await f.call('hud_create', { role: 'imp', request_key: 'home-imp', task: 'Synthetic task.' });
  assert.equal(JSON.parse(fs.readFileSync(join(home.task_dir, 'job.json'), 'utf8')).model, 'openai/gpt-6.2-sol');
});

test('an unregistered .hud is ignored and roster says so', async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'unreg');
  fs.mkdirSync(join(proj, '.hud/roles'), { recursive: true });
  fs.writeFileSync(
    join(proj, '.hud/roles/frontend.json'),
    JSON.stringify({
      role: 'frontend',
      harness: 'pi',
      pi_role: 'implementer',
      split: false,
      can_continue: true,
      model: 'secret/model',
    })
  );
  fs.writeFileSync(join(proj, '.hud/hud-convention.md'), 'SECRET_CONVENTION');
  const roster = await f.call('hud_roster', { cwd: proj });
  assert.equal(roster.project.registered, false);
  assert.equal(roster.project.root, fs.realpathSync(proj));
  assert.equal(roster.project_config_ignored, fs.realpathSync(proj));
  assert.equal(
    roster.roles.some((entry) => entry.role === 'frontend'),
    false
  );
  assert.equal(JSON.stringify(roster).includes('SECRET_CONVENTION'), false);
  assert.equal(JSON.stringify(roster).includes('secret/model'), false);
  assert.deepEqual(
    await f.call('hud_create', { role: 'frontend', request_key: 'ignored-role', task: 'Synthetic task.', cwd: proj }),
    { ok: false, code: 'role_unavailable', reason: 'Role frontend is not configured or is hidden in this project', hint: roster.hint }
  );
});

function skillFlags(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--skill') paths.push(argv[i + 1]);
  return paths;
}

test('pi dispatch passes role skills and the worker prompt, and records skips', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'proj');
  fs.mkdirSync(proj);
  assert.equal(spawnSync('git', ['init'], { cwd: proj, encoding: 'utf8' }).status, 0);
  const root = fs.realpathSync(proj);
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  const linked = join(f.root, 'skills', 'to-tickets');
  const absolute = join(f.root, 'skills', 'absolute');
  fs.mkdirSync(linked, { recursive: true });
  fs.mkdirSync(absolute);
  fs.mkdirSync(join(root, '.hud', 'skills'), { recursive: true });
  fs.symlinkSync(linked, join(root, '.hud', 'skills', 'to-tickets'));
  fs.symlinkSync(join(f.root, 'skills', 'missing-target'), join(root, '.hud', 'skills', 'gone'));
  const prompt = join(root, '.hud', 'agents', 'frontend.md');
  const promptTarget = join(f.root, 'prompt-target.md');
  fs.mkdirSync(join(root, '.hud', 'agents'), { recursive: true });
  fs.writeFileSync(prompt, 'Synthetic worker prompt.\n');
  fs.writeFileSync(promptTarget, 'Linked worker prompt.\n');
  fs.symlinkSync(promptTarget, join(root, '.hud', 'agents', 'linked.md'));
  fs.symlinkSync(join(f.root, 'missing-prompt.md'), join(root, '.hud', 'agents', 'broken.md'));
  const role = (name, skills) => ({
    role: name,
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    ...(skills ? { skills } : {}),
  });
  fs.mkdirSync(join(root, '.hud', 'roles'));
  fs.writeFileSync(
    join(root, '.hud', 'roles', 'frontend.json'),
    JSON.stringify(role('frontend', ['to-tickets', 'gone', 'no-such', '../escape', absolute]))
  );
  for (const name of ['plain', 'linked', 'broken'])
    fs.writeFileSync(join(root, '.hud', 'roles', `${name}.json`), JSON.stringify({ ...role(name), instructions: name }));
  fs.writeFileSync(
    join(root, '.hud', 'project.json'),
    JSON.stringify({ version: 1, roles: ['frontend', 'plain', 'linked', 'broken'] })
  );
  const piArgs = ['--tools', 'read'];
  const created = await f.call('hud_create', {
    role: 'frontend',
    request_key: 'skills',
    task: 'Synthetic task.',
    cwd: proj,
    pi_args: piArgs,
  });
  const argv = f.commands().find((entry) => entry.args[0] === 'agent' && entry.args[1] === 'start').args;
  const dash = argv.indexOf('--');
  const skillAt = argv.indexOf('--skill');
  const promptAt = argv.indexOf('--append-system-prompt');
  assert.deepEqual(skillFlags(argv), [join(root, '.hud', 'skills', 'to-tickets'), absolute]);
  assert.equal(argv[promptAt + 1], prompt);
  assert.ok(dash >= 0 && dash < skillAt && skillAt < promptAt && promptAt < argv.indexOf('--tools'));
  assert.deepEqual(argv.slice(-2), ['--tools', 'read,hud_report,hud_progress,hud_lease,hud_ask,hud_sonic']);
  assert.equal(
    argv.some((arg) => arg.includes('..')),
    false
  );
  const expected = {
    role_skills: [
      { name: 'to-tickets', path: join(root, '.hud', 'skills', 'to-tickets') },
      { name: absolute, path: absolute },
    ],
    skipped_skills: [
      { name: 'gone', reason: 'broken' },
      { name: 'no-such', reason: 'missing' },
      { name: '../escape', reason: 'invalid' },
    ],
    worker_prompt: prompt,
  };
  const receipt = JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'), 'utf8'));
  const read = await f.call('hud_read', { job: created.job, detail: true });
  for (const value of [receipt, read]) {
    assert.deepEqual(value.role_skills, expected.role_skills);
    assert.deepEqual(value.skipped_skills, expected.skipped_skills);
    assert.equal(value.worker_prompt, expected.worker_prompt);
    assert.deepEqual(value.pi_args, piArgs);
  }
  assert.equal(receipt.dispatch_exit_code, 0);
  assert.equal(read.state, 'working');
  assert.equal(read.skills, undefined);

  const plain = await f.call('hud_create', {
    role: 'plain',
    request_key: 'no-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const plainArgv = f
    .commands()
    .filter((entry) => entry.args[0] === 'agent' && entry.args[1] === 'start')
    .at(-1).args;
  assert.equal(plainArgv.includes('--skill'), false);
  assert.equal(plainArgv.includes('--append-system-prompt'), false);
  assert.equal(JSON.parse(fs.readFileSync(join(plain.task_dir, 'pi-worker.json'), 'utf8')).instructions, 'implementer');
  const plainRead = await f.call('hud_read', { job: plain.job, detail: true });
  assert.deepEqual(plainRead.role_skills, []);
  assert.deepEqual(plainRead.skipped_skills, []);
  assert.equal(plainRead.worker_prompt, null);

  const linkedJob = await f.call('hud_create', {
    role: 'linked',
    request_key: 'linked-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const linkedArgv = f
    .commands()
    .filter((entry) => entry.args[0] === 'agent' && entry.args[1] === 'start')
    .at(-1).args;
  assert.equal(linkedArgv[linkedArgv.indexOf('--append-system-prompt') + 1], join(root, '.hud', 'agents', 'linked.md'));
  assert.equal(
    (await f.call('hud_read', { job: linkedJob.job, detail: true })).worker_prompt,
    join(root, '.hud', 'agents', 'linked.md')
  );

  const broken = await f.call('hud_create', {
    role: 'broken',
    request_key: 'broken-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const brokenArgv = f
    .commands()
    .filter((entry) => entry.args[0] === 'agent' && entry.args[1] === 'start')
    .at(-1).args;
  assert.equal(brokenArgv.includes('--append-system-prompt'), false);
  assert.equal((await f.call('hud_read', { job: broken.job, detail: true })).worker_prompt, null);
  assert.equal(JSON.parse(fs.readFileSync(join(broken.task_dir, 'job.json'), 'utf8')).dispatch_exit_code, 0);
});

test('unregistered skill names are skipped and a CLI role is not given skill flags', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const absolute = join(f.root, 'abs-skill');
  fs.mkdirSync(absolute);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'home-skilled.json'),
    JSON.stringify({
      role: 'home-skilled',
      harness: 'pi',
      pi_role: 'implementer',
      split: false,
      can_continue: true,
      skills: ['to-tickets', absolute],
    })
  );
  fs.mkdirSync(join(f.root, '.hud', 'agents'), { recursive: true });
  fs.writeFileSync(join(f.root, '.hud', 'agents', 'home-skilled.md'), 'Must not load.\n');
  const job = await f.call('hud_create', {
    role: 'home-skilled',
    request_key: 'home-skills',
    task: 'Synthetic task.',
    pi_args: ['--tools', 'read'],
  });
  const argv = f.commands().find((entry) => entry.args[0] === 'agent' && entry.args[1] === 'start').args;
  assert.deepEqual(skillFlags(argv), [absolute]);
  assert.equal(argv.includes('--append-system-prompt'), false);
  assert.ok(argv.indexOf('--') < argv.indexOf('--skill') && argv.indexOf('--skill') < argv.indexOf('--tools'));
  assert.deepEqual(argv.slice(-2), ['--tools', 'read,hud_report,hud_progress,hud_lease,hud_ask,hud_sonic']);
  const read = await f.call('hud_read', { job: job.job, detail: true });
  assert.deepEqual(read.role_skills, [{ name: absolute, path: absolute }]);
  assert.deepEqual(read.skipped_skills, [{ name: 'to-tickets', reason: 'unresolved' }]);
  assert.equal(read.worker_prompt, null);

  const cli = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'cli-untouched',
    task: 'Synthetic cli task.',
  });
  const receipt = JSON.parse(fs.readFileSync(join(cli.task_dir, 'job.json'), 'utf8'));
  assert.equal(Object.hasOwn(receipt, 'role_skills'), false);
  assert.equal(Object.hasOwn(receipt, 'skipped_skills'), false);
  assert.equal(Object.hasOwn(receipt, 'worker_prompt'), false);
  const start = f.commands().find((entry) => entry.args[1] === 'start' && entry.args[2] === `${cli.job}-primary`);
  assert.equal(start.args.includes('--skill'), false);
  assert.equal(start.args.includes('--append-system-prompt'), false);
  const cliRead = await f.call('hud_read', { job: cli.job });
  assert.equal(Object.hasOwn(cliRead, 'role_skills'), false);
  assert.equal(Object.hasOwn(cliRead, 'skipped_skills'), false);
  assert.equal(Object.hasOwn(cliRead, 'worker_prompt'), false);
});

test('hud_create and hud_send do not wait for a slow queue-watcher lookup', { timeout: 25000 }, async (t) => {
  let release;
  t.after(() => { if (release) fs.writeFileSync(release, ''); });
  const f = await fixture(t, true, `
    import cp from 'node:child_process';
    import timers from 'node:timers';
    import { syncBuiltinESMExports } from 'node:module';
    let held = false;
    for (const method of ['spawn', 'spawnSync']) {
      const start = cp[method];
      cp[method] = (bin, args, options) => {
        // The delivery helper supplies an explicit env; tab placement uses the inherited env.
        if (options?.env && bin === 'herdr' && args.join(' ') === 'pane get w4E:p1') {
          held = method === 'spawn';
          options = { ...options, env: { ...options.env, SLOW_DELIVERY_LOOKUP: '1' } };
        }
        return start(bin, args, options);
      };
    }
    const schedule = timers.setTimeout;
    timers.setTimeout = (fn, ms, ...args) => {
      // Only the held lookup gets headroom. Test reply ordering, not its real 2 s timeout.
      const budget = held && ms === 2000 ? 30000 : ms;
      held = false;
      return schedule(fn, budget, ...args);
    };
    syncBuiltinESMExports();
  `);
  release = join(f.env.HOME, 'release-delivery-lookups');
  const started = join(f.env.HOME, 'started-delivery-lookups');
  f.overrideBin('herdr', `#!${process.execPath}
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
if (process.env.SLOW_DELIVERY_LOOKUP === '1') {
  fs.appendFileSync(${JSON.stringify(started)}, 'lookup\\n');
  while (!fs.existsSync(${JSON.stringify(release)})) await delay(20);
} else {
  process.argv.splice(1, 1, process.env.FAKE_BIN, 'herdr');
  await import(process.env.FAKE_BIN);
}
`);
  const lookups = () => fs.existsSync(started) ? fs.readFileSync(started, 'utf8').trim().split('\n').length : 0;
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic async dispatch.' });
  assert.match(job.job, /^j[0-9a-f]{16}$/);
  await until(() => lookups() === 1, t.signal);
  const reply = await f.call('hud_send', { job: job.job, text: 'Synthetic addendum.' });
  assert.equal(reply.sent, true);
  await until(() => lookups() === 2, t.signal);
  fs.writeFileSync(release, '');
});

for (const agent of ['codex', 'claude']) test(`hud_create starts exactly one queue watcher only for Codex (${agent})`, async (t) => {
  const f = await fixture(t, true, `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const spawn = cp.spawn;
    cp.spawn = (command, args, options) => {
      if (args?.includes('--queue')) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: 'queue-watch', args, detached: options.detached, stdio: options.stdio }) + '\\n');
      return spawn(command, args, options);
    };
    syncBuiltinESMExports();
  `);
  fs.writeFileSync(join(f.env.HOME, 'main-agent'), agent);
  const pidFile = join(f.env.HUD_HOME, 'watchers/w4E:p1.pid');
  const args = { role: 'imp', request_key: 'queue-start', task: 'Synthetic queue watcher.' };
  const job = await f.call('hud_create', args);
  await f.call('hud_create', args);
  await f.call('hud_create', { ...args, request_key: 'queue-second' });
  const queueStarts = () => f.commands().filter((c) => c.command === 'queue-watch');
  if (agent === 'codex') await until(() => queueStarts().length > 0, t.signal);
  const starts = queueStarts();
  assert.equal(starts.length, agent === 'codex' ? 1 : 0);
  if (agent === 'codex') {
    assert.deepEqual(starts[0].args, [resolve('bin/hud'), 'watch', '--queue']);
    assert.equal(starts[0].detached, true);
    assert.equal(starts[0].stdio, 'ignore');
    assert.equal(fs.existsSync(pidFile), true);
    fs.writeFileSync(join(f.env.HOME, 'main-agent'), 'claude');
  } else assert.equal(fs.existsSync(pidFile), false);
  assert.notEqual(job.ok, false);
  assert.match(job.job, /^j[0-9a-f]{16}$/);
});

test('roster sends the convention once and returns only the caller’s delivery hint', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'main-agent'), 'codex');
  const first = await f.call('hud_roster');
  assert.doesNotMatch(first.convention.text, /Claude Code:|Codex:|pi:|watcher_alive/);
  assert.match(first.hint, /^Codex: events are queued automatically;/);
  assert.doesNotMatch(first.hint, /Claude Code:|pi:/);
  const repeat = await f.call('hud_roster');
  assert.equal(repeat.convention, undefined);
  assert.equal(repeat.convention_unchanged, true);
  assert.deepEqual(repeat.roles, first.roles);
  assert.equal(repeat.hint, first.hint);
  assert.deepEqual((await f.call('hud_roster', { convention_version: 'force' })).convention, first.convention);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  MODEL_CACHE_TTL_MS,
  discoverModelLists,
  modelListCachePath,
  modelSourceStatus,
  parseAgyModels,
  parseGrokModels,
  parsePiModels,
  readModelListCache,
} from '../../dist/roles/model-discovery.js';
import { controlFacts, editPlaces } from '../../dist/roles/role-control.js';
import { placeCatalog, roleRegistry, writeRolePlaces } from '../../dist/roles/roster.js';
import { setHarnessDisabled } from '../../dist/roles/harness-switches.js';
import { MODEL_LISTS } from '../fixtures/project-page.mjs';
import { stripAnsi } from '../../dist/render/colors.js';
import { initialMonitorState } from '../../dist/render/monitor.js';

const bundled = resolve('packages/hud-mcp');
const NOW = Date.parse('2026-11-14T12:00:00Z');

function sandbox(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'model-discovery-'));
  const hud = join(root, 'hud');
  const cwd = join(root, 'cwd');
  const bin = join(root, 'bin');
  fs.mkdirSync(hud, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, hud, cwd, bin, env: { PATH: bin } };
}

function writeFakeCli(bin, name, script) {
  const file = join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
}

test('parsers extract model ids from pi, agy and grok output shapes and drop prose/format noise', () => {
  const piSample = [
    'provider       model                   context  max-out  thinking  images',
    'openai         gpt-synthetic-1         272K     128K     yes       yes   ',
    'anthropic      claude-synthetic-1      1M       8.2K     no        yes   ',
    'openai         gpt-synthetic-1         272K     128K     yes       yes   ',
  ].join('\n');
  assert.deepEqual(parsePiModels(piSample), {
    ids: ['openai/gpt-synthetic-1', 'anthropic/claude-synthetic-1'],
    facts: { 'openai/gpt-synthetic-1': ['272K', '128K', true, true], 'anthropic/claude-synthetic-1': ['1M', '8.2K', false, true] },
  });
  assert.deepEqual(parsePiModels('provider model\nsynthetic model'), { ids: ['synthetic/model'] });
  assert.equal(parsePiModels('Not logged in or format changed'), null);
  assert.equal(parsePiModels(`${piSample}\nunknown malformed output`), null);
  assert.deepEqual(parsePiModels('No models available. Use /login to log in.\n  /synthetic/providers.md'), { ids: [] });
  assert.deepEqual(parsePiModels('provider model context max-out thinking images\n'), { ids: [] });

  const agySample = [
    'Fetching available models...',
    'gemini-synthetic-high\tGemini Synthetic (High)',
    'claude-synthetic-med\tClaude Synthetic (Medium)',
  ].join('\n');
  assert.deepEqual(parseAgyModels(agySample), ['gemini-synthetic-high', 'claude-synthetic-med']);
  assert.deepEqual(parseAgyModels('Fetching available models...\nUnexpected error text'), []);

  const grokSample = [
    'You are logged in with example.invalid.',
    '',
    'Default model: grok-synthetic-1',
    '',
    'Available models:',
    '  * grok-synthetic-1 (default)',
    '  - grok-synthetic-2',
    '  - oc-synthetic-3',
  ].join('\n');
  assert.deepEqual(parseGrokModels(grokSample), ['grok-synthetic-1', 'grok-synthetic-2', 'oc-synthetic-3']);
  assert.deepEqual(parseGrokModels('Authentication required'), []);
});

test('pi/agy/grok discovery caches under $HUD_HOME/display for a day, merges in order, and keeps claude/codex from catalog', async (t) => {
  const s = sandbox(t);
  writeFakeCli(
    s.bin,
    'pi',
    `
    if (process.argv[2] !== '--list-models') process.exit(2);
    console.log('provider       model              context  max-out  thinking  images');
    console.log('arena          arena-fresh-1      1M       128K     yes       yes');
    console.log('openai         gpt-6.1-sol        272K     128K     yes       yes');
    `
  );
  writeFakeCli(
    s.bin,
    'agy',
    `
    if (process.argv[2] !== 'models') process.exit(2);
    console.error('Fetching available models...');
    console.log('agy-fresh-1\\tAgy Fresh (1)');
    console.log('gemini-4-argon-high\\tGemini 4 Argon (High)');
    `
  );
  writeFakeCli(
    s.bin,
    'grok',
    `
    if (process.argv[2] !== 'models') process.exit(2);
    console.log('You are logged in with example.invalid.');
    console.log('');
    console.log('Default model: grok-fresh-1');
    console.log('');
    console.log('Available models:');
    console.log('  * grok-fresh-1 (default)');
    console.log('  - grok-4.7');
    `
  );
  // claude/codex must never be invoked even if present on PATH.
  for (const name of ['claude', 'codex']) {
    writeFakeCli(s.bin, name, `fs.writeFileSync(${JSON.stringify(join(s.root, `${name}-called`))}, '1');`);
  }

  const cache = await discoverModelLists(s.hud, s.env, NOW);
  assert.equal(cache.fetchedAt, NOW);
  const cacheFile = modelListCachePath(s.hud);
  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(join(s.hud, 'display')).filter((n) => n.endsWith('.tmp')),
    []
  );
  assert.equal(fs.existsSync(join(s.root, 'claude-called')), false);
  assert.equal(fs.existsSync(join(s.root, 'codex-called')), false);

  // Typed models in role files come after discovered and catalog ids.
  writeRolePlaces(
    s.hud,
    'imp',
    [
      { harness: 'pi', pi_role: 'implementer', split: false, model: 'custom/typed-pi' },
      { harness: 'cli', agent: 'agy', model: 'agy-typed-1' },
      { harness: 'cli', agent: 'claude', model: 'claude-typed-1' },
    ],
    bundled
  );

  const catalog = placeCatalog(s.hud, bundled, undefined, NOW + 60_000);
  assert.deepEqual(catalog.pi.models, [
    'arena/arena-fresh-1',
    'openai/gpt-6.1-sol',
    'openai/gpt-6-astra',
    'mistral/deepseek-v4-1-flash-1017',
    'arena/gpt-6.1-sol',
    'custom/typed-pi',
  ]);
  assert.deepEqual(catalog.cli.models.agy, [
    'agy-fresh-1',
    'gemini-4-argon-high',
    'gemini-4-hydrogen-high',
    'gemini-3.8-flash-high',
    'agy-typed-1',
  ]);
  assert.deepEqual(catalog.cli.models.grok, ['grok-fresh-1', 'grok-4.7']);
  assert.deepEqual(catalog.cli.models.claude, ['opus', 'sonnet', 'haiku', 'fable', 'claude-typed-1']);
  assert.deepEqual(catalog.cli.models.codex, ['gpt-6.1-sol', 'gpt-6-luna']);

  // editPlaces cycles discovered -> catalog -> typed -> unset.
  const cycled = editPlaces(s.hud, s.cwd, s.env, { role: 'imp', index: 0, op: 'model', step: 1 }, NOW + 60_000, bundled);
  assert.deepEqual(cycled, { ok: true, index: 0 });
  assert.equal(JSON.parse(fs.readFileSync(join(s.hud, 'roles/imp.json'), 'utf8')).run[0].model, undefined);
  editPlaces(s.hud, s.cwd, s.env, { role: 'imp', index: 0, op: 'model', step: 1 }, NOW + 60_000, bundled);
  assert.equal(JSON.parse(fs.readFileSync(join(s.hud, 'roles/imp.json'), 'utf8')).run[0].model, 'arena/arena-fresh-1');
  editPlaces(s.hud, s.cwd, s.env, { role: 'imp', index: 0, op: 'model', step: 1 }, NOW + 60_000, bundled);
  assert.equal(JSON.parse(fs.readFileSync(join(s.hud, 'roles/imp.json'), 'utf8')).run[0].model, 'openai/gpt-6.1-sol');

  // Expiring the day cache triggers refresh on open, but does not discard the last-good data.
  assert.ok(readModelListCache(s.hud, NOW + MODEL_CACHE_TTL_MS - 1));
  assert.equal(readModelListCache(s.hud, NOW + MODEL_CACHE_TTL_MS), null);
  const expired = placeCatalog(s.hud, bundled, undefined, NOW + MODEL_CACHE_TTL_MS);
  assert.deepEqual(expired.pi.models, catalog.pi.models.filter((id) => id !== 'custom/typed-pi'));
  assert.deepEqual(expired.cli, catalog.cli);
});

test('failed, missing, slow, oversized or symlinked model discovery without a last-good list uses catalog', async (t) => {
  const s = sandbox(t);
  // pi missing, agy exits non-zero, grok emits garbage.
  writeFakeCli(s.bin, 'agy', 'console.log("agy-should-not-stick\\tIgnored"); process.exit(1);');
  writeFakeCli(s.bin, 'grok', 'console.log("unexpected format without list");');

  await discoverModelLists(s.hud, s.env, NOW);
  let catalog = placeCatalog(s.hud, bundled, undefined, NOW);
  assert.deepEqual(catalog.pi.models, [
    'openai/gpt-6.1-sol',
    'openai/gpt-6-astra',
    'mistral/deepseek-v4-1-flash-1017',
    'arena/gpt-6.1-sol',
  ]);
  assert.deepEqual(catalog.cli.models.agy, ['gemini-4-argon-high', 'gemini-4-hydrogen-high', 'gemini-3.8-flash-high']);
  assert.deepEqual(catalog.cli.models.grok, ['grok-4.7']);

  // Timeout and output cap preserve the absence of any successful discovery.
  writeFakeCli(s.bin, 'pi', 'setTimeout(() => console.log("provider model\\na b"), 2000);');
  writeFakeCli(s.bin, 'agy', 'console.log("x\\tX\\n".repeat(500));');
  await discoverModelLists(s.hud, s.env, NOW + 1, { timeoutMs: 80, maxBytes: 256 });
  catalog = placeCatalog(s.hud, bundled, undefined, NOW + 1);
  assert.equal(catalog.pi.models[0], 'openai/gpt-6.1-sol');
  assert.equal(catalog.cli.models.agy[0], 'gemini-4-argon-high');

  // Symlinked cache file is ignored by readModelListCache.
  const decoy = join(s.root, 'decoy.json');
  fs.writeFileSync(decoy, JSON.stringify({ version: 1, fetchedAt: NOW, pi: ['evil/model'] }));
  const cacheFile = modelListCachePath(s.hud);
  fs.unlinkSync(cacheFile);
  fs.symlinkSync(decoy, cacheFile);
  assert.equal(readModelListCache(s.hud, NOW), null);
});

test('a full synthetic pi table survives discovery exactly, off/restore, failure, and then a successful empty reply', async (t) => {
  const s = sandbox(t);
  const ids = [...MODEL_LISTS.pi, 'new-provider/new-provider/nested', 'new-provider/' + 'b'.repeat(115)];
  const header = 'provider model context max-out thinking images';
  const table = [header, ...[...ids, ids[0]].map((id) => {
    const slash = id.indexOf('/');
    return `${id.slice(0, slash)}  ${id.slice(slash + 1)}  272K  128K  yes  no`;
  })].join('\n');
  writeFakeCli(s.bin, 'pi', `console.log(${JSON.stringify(table)});`);
  writeFakeCli(s.bin, 'agy', `console.log('agy-before\\tAgy Before');`);
  writeFakeCli(s.bin, 'grok', `console.log('Available models:\\n * grok-before');`);
  const discovery = await discoverModelLists(s.hud, s.env, NOW);
  assert.deepEqual(discovery.pi, ids);
  assert.deepEqual(discovery.piFacts, Object.fromEntries(ids.map((id) => [id, ['272K', '128K', true, false]])));
  assert.deepEqual(readModelListCache(s.hud, NOW).piFacts, discovery.piFacts);
  s.env.PI_CODING_AGENT_DIR = join(s.root, 'pi');
  fs.mkdirSync(s.env.PI_CODING_AGENT_DIR);
  fs.writeFileSync(join(s.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'xai', defaultModel: 'grok-4.7' }));
  const collect = (now) => controlFacts(roleRegistry(s.hud, s.cwd, s.env), s.hud, now);
  const imp = (now) => collect(now).roles.find((role) => role.role === 'imp').places[0];
  assert.deepEqual(imp(NOW).piModel, { current: 'xai/grok-4.7', isDefault: true, defaultId: 'xai/grok-4.7', defaultSource: 'from pi settings', defaultOff: false });
  assert.deepEqual(collect(NOW).models.pi, ids);
  assert.equal(collect(NOW).harnessSwitches.find((item) => item.id === 'pi:new-provider').off, false);
  setHarnessDisabled(s.hud, 'pi:xai', true);
  assert.deepEqual(collect(NOW).models.pi, ids.filter((id) => !id.startsWith('xai/')));
  assert.equal(imp(NOW).piModel.defaultOff, true);
  assert.equal(imp(NOW).piModel.current, 'xai/grok-4.7');
  setHarnessDisabled(s.hud, 'pi:xai', false);
  assert.deepEqual(collect(NOW).models.pi, ids);
  setHarnessDisabled(s.hud, 'pi', true);
  assert.deepEqual(collect(NOW).models.pi, []);
  setHarnessDisabled(s.hud, 'pi', false);

  const later = NOW + 2 * 3600000;
  writeFakeCli(s.bin, 'pi', 'process.exit(1);');
  writeFakeCli(s.bin, 'agy', `console.log('agy-after\\tAgy After');`);
  writeFakeCli(s.bin, 'grok', 'console.log("unexpected output without model IDs");');
  await discoverModelLists(s.hud, s.env, later);
  writeFakeCli(s.bin, 'pi', 'console.log("unexpected output without a table");');
  await discoverModelLists(s.hud, s.env, later + 1);
  assert.equal(readModelListCache(s.hud, later + 1), null, 'a fresh agy success cannot hide the failed pi refresh');
  const failure = readModelListCache(s.hud, later + 1, undefined, true);
  assert.deepEqual(failure.pi, ids);
  assert.deepEqual(failure.piFacts, discovery.piFacts);
  assert.deepEqual(collect(later + 1).models.piFacts, discovery.piFacts);
  assert.deepEqual(failure.cli, { agy: ['agy-after'], grok: ['grok-before'] });
  assert.deepEqual(modelSourceStatus(failure, 'grok'), { fetchedAt: NOW, failed: true });
  assert.deepEqual(collect(later + 1).models.piStatus, { fetchedAt: NOW, failed: true, offline: false, empty: false, runnerOff: false });

  writeFakeCli(s.bin, 'pi', 'console.log("No models available.");');
  await discoverModelLists(s.hud, s.env, later + 2);
  assert.deepEqual(readModelListCache(s.hud, later + 2).pi, []);
  assert.equal(readModelListCache(s.hud, later + 2).piFacts, undefined);
  assert.deepEqual(collect(later + 2).models.pi, []);
  assert.deepEqual(collect(later + 2).models.piStatus, { fetchedAt: later + 2, failed: false, offline: false, empty: true, runnerOff: false });
});

test('live panel coalesces r and picker Ctrl+R refreshes and starts no discovery on filter input or ticks', { timeout: 20000 }, async (t) => {
  const s = sandbox(t);
  const log = join(s.root, 'spawns.log'), hold = join(s.root, 'hold-pi');
  fs.mkdirSync(join(s.cwd, '.git'), { recursive: true });
  for (const [cmd, body] of [
    ['pi', `while (fs.existsSync(${JSON.stringify(hold)})) await new Promise((resolve) => setTimeout(resolve, 10));
      console.log('provider model context max-out thinking images\\nopenai gpt-live-1 1M 128K yes yes');`],
    ['agy', `console.log('agy-live-1\\tAgy Live');`],
    ['grok', `console.log('Available models:\\n  * grok-live-1 (default)');`],
  ]) {
    writeFakeCli(
      s.bin,
      cmd,
      `
      import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(cmd)} + '\\n');
      ${body}
      `
    );
  }
  for (const cmd of ['pi-role', 'herdr', 'claude', 'codex', 'jev-ask', 'jev-aistudio', 'jev-flow']) {
    writeFakeCli(s.bin, cmd, '');
  }
  fs.writeFileSync(join(s.hud, 'hud-settings.json'), JSON.stringify({ modelEnabled: false, refreshMs: 60, language: 'en' }));

  const runner = join(s.root, 'live.mjs');
  fs.writeFileSync(
    runner,
    `import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};\nawait runLivePage();\nprocess.exit(0);\n`
  );
  const place = JSON.stringify(
    {
      state: {
        ...initialMonitorState(),
        mainTab: 'project',
        controlNav: { projectCursor: 'project:role:imp:0', projectFolded: new Set(['agents', 'files', 'usage', 'role:imp']) },
      },
    },
    (_k, v) => (v instanceof Set ? { panelSet: [...v] } : v)
  );
  const child = spawn(process.execPath, [runner], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...s.env,
      HOME: s.root,
      HUD_HOME: s.hud,
      CODEX_HUD_STANDALONE_PANEL: '1',
      CODEX_HUD_CWD: s.cwd,
      HUD_PANEL_RELOAD_PLACE: place,
    },
  });
  let out = '',
    err = '';
  child.stdout.on('data', (b) => {
    out += b;
  });
  child.stderr.on('data', (b) => {
    err += b;
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const spawns = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const until = async (ok, what) => {
    for (const end = Date.now() + 10000; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
    assert.fail(`${what}: err=${err}`);
  };

  // Hub opens first: wait across several refreshMs=60ms ticks -> 0 spawns.
  await until(() => stripAnsi(out).includes('Progress'), 'Project hub rendered');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(spawns(), []);

  // Open Control with Tab -> spawns pi, agy, grok once each.
  child.stdin.write('\t');
  await until(() => /1 ◉ pi/.test(stripAnsi(out)) && spawns().length === 3, 'Control opened & started discovery');
  assert.deepEqual([...spawns()].sort(), ['agy', 'grok', 'pi']);

  // Sit through multiple refresh ticks -> still 0 extra spawns.
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(spawns().length, 3);

  // Leave Control and open it again within 1 day -> cache hit, 0 extra spawns.
  const left = out.length;
  child.stdin.write('\x1b[D');
  await until(() => stripAnsi(out.slice(left)).includes('Progress'), 'back to hub');
  const back = out.length;
  child.stdin.write('\t');
  await until(() => /1 ◉ pi/.test(stripAnsi(out.slice(back))), 'Control re-opened');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(spawns().length, 3);

  // An r burst is one refresh; send more r keys after the commands have started but pi is still pending.
  const firstList = readModelListCache(s.hud).fetchedAt;
  fs.writeFileSync(hold, 'hold');
  child.stdin.write('rrr');
  await until(() => spawns().length === 6, 'r started a single refresh');
  child.stdin.write('rrm');
  await until(() => /Selected ─/.test(stripAnsi(out)) && /gpt-live-1/.test(stripAnsi(out)), 'picker shows the last-good list during the refresh');
  child.stdin.write('\x12');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(spawns().length, 6, 'picker refresh coalesces with the pending Control refresh');
  fs.unlinkSync(hold);
  await until(() => readModelListCache(s.hud)?.fetchedAt > firstList, 'refresh finished');
  assert.equal(spawns().filter((c) => c === 'pi').length, 2);
  assert.equal(spawns().filter((c) => c === 'agy').length, 2);
  assert.equal(spawns().filter((c) => c === 'grok').length, 2);

  // The picker owns even r, q and Tab; none may spawn a command. A full ID selects directly.
  child.stdin.write('rqq\t');
  await until(() => /rqq▌/.test(stripAnsi(out)), 'refresh/quit keys typed into the picker');
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(spawns().length, 6);
  const secondList = readModelListCache(s.hud).fetchedAt;
  fs.writeFileSync(hold, 'hold');
  child.stdin.write('\x12\x12\x12');
  await until(() => spawns().length === 9, 'Ctrl+R from the open picker refreshes all lists once');
  assert.deepEqual(spawns().slice(-3).sort(), ['agy', 'grok', 'pi']);
  fs.unlinkSync(hold);
  await until(() => readModelListCache(s.hud)?.fetchedAt > secondList, 'picker refresh finished');
  child.stdin.write('\x7f\x7f\x7fOPENAI/GPT-LIVE\r');
  await until(
    () => fs.existsSync(join(s.hud, 'roles/imp.json')) && JSON.parse(fs.readFileSync(join(s.hud, 'roles/imp.json'), 'utf8')).run[0].model === 'openai/gpt-live-1',
    'm selects discovered model'
  );

  child.stdin.write('q');
  await once(child, 'exit');
  assert.equal(err, '');
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { cacheCommand, renderCache } from '../../src/cli/cache.js';
import { loadCacheConfig } from '../../src/core/cache-config.js';
import type { HudIO } from '../../src/cli/link-export.js';
import { REPO_ROOT } from '../fixtures/paths.js';

const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'b20');
const sectionFiveTwo = readFileSync(join(FIXTURES, 'cache-v2.json'), 'utf8');

/** A private temporary HUD_HOME, holding `cache.json` when `text` is given. */
function home(t: test.TestContext, text?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hud-b20-wiring-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (text !== undefined) writeFileSync(join(dir, 'cache.json'), text, { mode: 0o600 });
  return dir;
}

function io(env: NodeJS.ProcessEnv) {
  let stdout = '';
  let stderr = '';
  const value: HudIO = {
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return { value, output: () => ({ stdout, stderr }) };
}

test('hud cache show prints the §5.2 snapshot in human and JSON form without writing', async (t) => {
  const dir = home(t, sectionFiveTwo);
  const before = { files: readdirSync(dir).sort(), bytes: readFileSync(join(dir, 'cache.json'), 'utf8') };
  const human = io({ HUD_HOME: dir });
  assert.equal(await main(['cache', 'show'], human.value), 0);
  assert.equal(human.output().stderr, '');
  const text = human.output().stdout;
  assert.match(text, /^cache\.json: /);
  assert.match(text, /\nvalidation: ok\n/);
  assert.match(text, /\norigin: file\n/);
  assert.match(text, /\nversion: 2\n/);
  assert.match(text, /\nhandoffMinTokens: 60000 \(default 60000\)\n/);
  assert.match(text, /\nentries: 4\n/);
  assert.match(text, /entry 0: harness=claude auth=subscription_included warming=off\n/);
  assert.match(text, /  configured: ttlMs=3600000 source="promptCacheTtl unset/);
  assert.match(text, /  documented: ttlMs=3600000 writeMultiplier=2 /);
  assert.match(text, /readMultiplier=claude-fable-5-1:0\.025,claude-opus-5-5:0\.05,default:0\.1 /);
  assert.match(text, /lifetimeFrom="request_start"/);
  assert.match(text, /  planningAssumption: none\n/);
  assert.match(text, /entry 2: harness=codex auth=chatgpt warming=off\n/);
  assert.match(text, /  planningAssumption: ttlMs=300000 label="conservative, display only"\n/);
  assert.match(text, /entry 3: harness=pi auth=\* warming=native\n/);

  const json = io({ HUD_HOME: dir });
  assert.equal(await main(['cache', 'show', '--json'], json.value), 0);
  assert.equal(json.output().stderr, '');
  assert.deepEqual(JSON.parse(json.output().stdout), loadCacheConfig(dir));

  // Read-only: same files, same bytes, and the direct entry point writes nothing either.
  assert.deepEqual({ files: readdirSync(dir).sort(), bytes: readFileSync(join(dir, 'cache.json'), 'utf8') }, before);
  assert.equal(await cacheCommand(['show'], dir, io({}).value), 0);
  assert.deepEqual({ files: readdirSync(dir).sort(), bytes: readFileSync(join(dir, 'cache.json'), 'utf8') }, before);
});

test('hud cache show treats a missing cache.json as a valid empty snapshot', async (t) => {
  const dir = home(t);
  const human = io({ HUD_HOME: dir });
  assert.equal(await main(['cache', 'show'], human.value), 0);
  assert.match(human.output().stdout, /\nvalidation: ok\n/);
  assert.match(human.output().stdout, /\norigin: missing\n/);
  assert.match(human.output().stdout, /\nhandoffMinTokens: null \(default 60000\)\n/);
  assert.match(human.output().stdout, /\nentries: 0\n/);
  assert.equal(readdirSync(dir).length, 0);

  const json = io({ HUD_HOME: dir });
  assert.equal(await main(['cache', 'show', '--json'], json.value), 0);
  assert.deepEqual(JSON.parse(json.output().stdout), {
    ok: true,
    snapshot: { version: 2, handoffMinTokens: null, entries: [] },
    path: join(dir, 'cache.json'),
    origin: 'missing',
  });
});

test('hud cache show exits 2 with the validator detail code for an invalid file', async (t) => {
  const broken = home(t, '{');
  const json = io({ HUD_HOME: broken });
  assert.equal(await main(['cache', 'show', '--json'], json.value), 2);
  assert.equal(json.output().stdout, '');
  assert.equal(json.output().stderr, 'cache_config_invalid: invalid_json\n');
  const human = io({ HUD_HOME: broken });
  assert.equal(await main(['cache', 'show'], human.value), 2);
  assert.equal(human.output().stdout, '');
  assert.equal(human.output().stderr, 'cache_config_invalid: invalid_json\n');

  const located = home(
    t,
    JSON.stringify({ version: 2, entries: [{ match: { harness: 'claude' }, configured: { ttlMs: 0 } }] })
  );
  const at = io({ HUD_HOME: located });
  assert.equal(await main(['cache', 'show'], at.value), 2);
  assert.equal(at.output().stderr, 'cache_config_invalid: invalid_number at entries[0].configured.ttlMs\n');
});

test('top-level hud --help lists the cache command', async () => {
  const help = io({});
  assert.equal(await main(['--help'], help.value), 0);
  assert.equal(help.output().stderr, '');
  assert.match(help.output().stdout, /^       hud cache show \[--json\]$/m);
  assert.match(help.output().stdout, /^       hud run --help$/m);
});

test('hud cache help needs no HUD_HOME and invalid arguments keep exit 2', async (t) => {
  const env = { PATH: '/usr/bin:/bin' };
  const help = io(env);
  assert.equal(await main(['cache', '--help'], help.value), 0);
  assert.equal(help.output().stderr, '');
  assert.match(help.output().stdout, /^Usage: hud cache show \[--json\]\n/);
  assert.match(help.output().stdout, /Read-only: nothing is created, written or migrated\./);

  const sub = io(env);
  assert.equal(await main(['cache', 'show', '--help'], sub.value), 0);
  assert.equal(sub.output().stdout, 'Usage: hud cache show [--json]\n');

  const dir = home(t, sectionFiveTwo);
  const extra = io({ HUD_HOME: dir });
  assert.equal(await main(['cache', 'show', '--json', '--json'], extra.value), 2);
  assert.equal(extra.output().stderr, 'invalid_arguments\n');
  const unknown = io({ HUD_HOME: dir });
  assert.equal(await main(['cache', 'report'], unknown.value), 2);
  assert.equal(unknown.output().stderr, 'invalid_command: hud cache show [--json]\n');
});

test('renderCache keeps the four provenance blocks separate and never merges them', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hud-b20-render-')));
  try {
    writeFileSync(
      join(dir, 'cache.json'),
      JSON.stringify({
        version: 2,
        entries: [
          {
            match: { harness: 'codex', auth: 'unknown|chatgpt' },
            configured: { ttlMs: 1000, source: 'configured source' },
            documented: { ttlMs: 2000, source: 'documented source' },
            observed: { ttlMs: 3000, source: 'observed source' },
            planningAssumption: { ttlMs: 4000, label: 'planning label' },
            warming: 'off',
          },
        ],
      })
    );
    const load = loadCacheConfig(dir);
    assert.equal(load.ok, true);
    if (!load.ok) return;
    const text = renderCache(load);
    assert.match(text, /entry 0: harness=codex auth=unknown\|chatgpt warming=off\n/);
    assert.match(text, /  configured: ttlMs=1000 source="configured source"\n/);
    assert.match(text, /  documented: ttlMs=2000 source="documented source"\n/);
    assert.match(text, /  observed: ttlMs=3000 source="observed source"\n/);
    assert.match(text, /  planningAssumption: ttlMs=4000 label="planning label"\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

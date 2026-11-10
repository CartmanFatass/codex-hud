import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ASK_MAX_WAIT_CAP_MS,
  ASK_MAX_WAIT_MS,
  chromeProxyFlags,
  credentialsForJob,
  DEFAULT_CDP_TIMEOUT_MS,
  DEFAULT_EFFORT_WORD,
  DEFAULT_GEMINI_EFFORT_LABEL,
  DEFAULT_GEMINI_ROOT,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ROOT,
  DEFAULT_USER_AGENT,
  hostProxyEnv,
  loadJevConfig,
  OPENAI_DECISION_MODEL,
  readJevEnv,
} from '../../src/jev/ask/config.js';
import { getHudHome } from '../../src/hud-home.js';
import { JevFailure } from '../../src/jev/ask/error.js';
function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-jev-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function config(stateDir: string, extra = {}) {
  return {
    stateDir,
    cdpUrl: 'http://127.0.0.1:9333',
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    ...extra,
  };
}
test('one neutral home resolver honors only captured HOME/HUD_HOME; no legacy resolver exports remain', async (t) => {
  const home = workspace(t);
  assert.equal('defaultHudHome' in (await import('../../src/jev/ask/config.js')), false);
  assert.equal('getHudHome' in (await import('../../src/utils/codex-path.js')), false);
  assert.equal(getHudHome({ HOME: home }), join(home, '.hud'));
  assert.equal(
    getHudHome({ HOME: home, HUD_HOME: join(home, 'custom'), CODEX_HOME: '/ignored' }),
    join(home, 'custom')
  );
});
test('HUD JSON maps paths and non-location defaults; runtime TOML is ignored', (t) => {
  const home = workspace(t),
    state = join(home, 'state');
  const cfg = loadJevConfig({
    home,
    configJson: { jev: config(state, { chrome: '~/chrome', profile: '~', model: 'From-Json', cdpTimeoutMs: 1500 }) },
    tomlText: '[jev]\nmodel="MUST NOT READ"',
  });
  assert.equal(cfg.model, 'From-Json');
  assert.equal(cfg.chrome, join(home, 'chrome'));
  assert.equal(cfg.profile, home);
  assert.equal(cfg.stateDir, state);
  assert.equal(cfg.cdpTimeoutMs, 1500);
  assert.equal(cfg.cdpUrl, 'http://127.0.0.1:9333');
  assert.equal(existsSync(state), false);
  const defaults = loadJevConfig({ configJson: { jev: config(state) }, capturedEnv: {} });
  assert.equal(defaults.model, DEFAULT_MODEL);
  assert.equal(defaults.effortWord, DEFAULT_EFFORT_WORD);
  assert.equal(defaults.providerRoot, DEFAULT_PROVIDER_ROOT);
  assert.equal(defaults.geminiRoot, DEFAULT_GEMINI_ROOT);
  assert.equal(defaults.userAgent, DEFAULT_USER_AGENT);
  assert.equal(defaults.geminiEffortLabel, DEFAULT_GEMINI_EFFORT_LABEL);
  assert.equal(defaults.cdpTimeoutMs, DEFAULT_CDP_TIMEOUT_MS);
  assert.equal(defaults.ask.maxWaitMs, ASK_MAX_WAIT_MS);
  assert.equal(loadJevConfig({ configJson: config(state), configJsonIsJev: true }).stateDir, state);
  assert.throws(
    () => loadJevConfig({ configJson: {}, tomlText: `[jev]\nstate_dir=${JSON.stringify(state)}` }),
    /jev.cdpUrl.*hud import/
  );
});
test('every location is required, including when legacy TOML names it', (t) => {
  const state = workspace(t);
  for (const key of ['cdpUrl', 'chrome', 'profile', 'stateDir']) {
    const json: Record<string, unknown> = config(state);
    delete json[key];
    assert.throws(
      () => loadJevConfig({ configJson: { jev: json }, tomlText: '[jev]\ncdp_url="http://127.0.0.1:9"' }),
      (e: unknown) =>
        e instanceof JevFailure &&
        e.code === 'pre_send' &&
        e.message.includes(`jev.${key}`) &&
        e.message.includes('hud import')
    );
  }
});
test('proxy uses HUD JSON then captured environment; no process-env injection', (t) => {
  const state = workspace(t);
  const ignored = loadJevConfig({ configJson: { jev: config(state) }, capturedEnv: {} });
  assert.equal(ignored.proxy.server, undefined);
  const cfg = loadJevConfig({
    configJson: { jev: config(state, { proxy: { server: 'http://127.0.0.1:8', bypass: '' } }) },
    capturedEnv: { https_proxy: 'http://127.0.0.1:9', no_proxy: 'example.invalid' },
  });
  assert.equal(cfg.proxy.server, 'http://127.0.0.1:8');
  assert.equal(cfg.proxy.bypass, 'example.invalid');
  const env = hostProxyEnv(cfg);
  assert.equal(env.HTTPS_PROXY, cfg.proxy.server);
  assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,example.invalid');
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal('HTTP_PROXY' in env, false);
  assert.deepEqual(chromeProxyFlags(cfg.proxy), [
    '--proxy-server=http://127.0.0.1:8',
    '--proxy-bypass-list=example.invalid',
  ]);
  assert.deepEqual(chromeProxyFlags({ server: 'http://127.0.0.1:9', bypass: 'example.invalid, localhost' }), [
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=example.invalid;localhost',
  ]);
  assert.deepEqual(chromeProxyFlags({}), []);
});
test('ask wait is capped and invalid limits fail', (t) => {
  const state = workspace(t);
  const cfg = loadJevConfig({
    configJson: { jev: config(state, { ask: { maxWaitMs: ASK_MAX_WAIT_CAP_MS + 60000 } }) },
  });
  assert.equal(cfg.ask.maxWaitMs, ASK_MAX_WAIT_CAP_MS);
  assert.throws(() => loadJevConfig({ configJson: { jev: config(state, { ask: { queueLimit: -1 } }) } }), /queueLimit/);
});
test('explicit credential reads are fresh, private, bounded and never report values', (t) => {
  const root = workspace(t),
    file = join(root, 'credentials.env');
  const cfg = loadJevConfig({ configJson: { jev: config(root) }, capturedEnv: {} });
  assert.deepEqual(readJevEnv(file), { textModel: {} });
  assert.deepEqual(credentialsForJob(file, cfg), {
    ok: false,
    error: 'jev_credentials_missing',
    provider: 'typesafe',
    variable: 'TYPESAFE_API_KEY',
  });
  const explicit = { ...cfg, decisions: { ...cfg.decisions, primary: 'openai' as const } };
  writeFileSync(
    file,
    'OPENAI_API_KEY=synthetic-unit-key\nOPENAI_BASE_URL=https://example.invalid/v1\nTEXT_MODEL_FOO=bar\nOTHER=skip\n',
    { mode: 0o600 }
  );
  const choice = credentialsForJob(file, explicit);
  assert.ok(choice.ok && choice.provider === 'openai');
  if (choice.ok && choice.provider === 'openai') {
    assert.equal(choice.apiKey, 'synthetic-unit-key');
    assert.equal(choice.model, OPENAI_DECISION_MODEL);
    assert.equal(choice.baseUrl, 'https://example.invalid/v1');
  }
  writeFileSync(file, 'TYPESAFE_API_KEY=synthetic-typesafe\nTYPESAFE_MODEL=custom-jev\n');
  const changed = credentialsForJob(file, cfg);
  assert.ok(changed.ok && changed.provider === 'typesafe' && changed.model === 'custom-jev');
  writeFileSync(join(root, 'loose.env'), 'OPENAI_API_KEY=synthetic-unit-key', { mode: 0o644 });
  symlinkSync(file, join(root, 'link.env'));
  mkdirSync(join(root, 'dir.env'));
  for (const name of ['loose.env', 'link.env', 'dir.env'])
    assert.throws(
      () => readJevEnv(join(root, name)),
      (e: unknown) => e instanceof JevFailure && e.code === 'jev_env_perms' && !e.message.includes('synthetic-unit-key')
    );
});
test('credential FIFO is refused without waiting for a writer', (t) => {
  if (process.platform === 'win32') return t.skip('FIFOs are POSIX only');
  const root = workspace(t),
    fifo = join(root, 'fifo.env');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const module = new URL('../../src/jev/ask/config.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {readJevEnv} from ${JSON.stringify(module)}; try {readJevEnv(${JSON.stringify(fifo)});process.exit(2)} catch(e){process.exit(e.code==='jev_env_perms'?0:3)}`,
    ],
    { timeout: 5000 }
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
});
test('missing config parents are not created', (t) => {
  const parent = join(workspace(t), 'absent');
  assert.throws(
    () => loadJevConfig({ configJsonPath: join(parent, 'config.json'), capturedEnv: {} }),
    /pre_send|Missing jev.cdpUrl/
  );
  assert.equal(existsSync(parent), false);
});

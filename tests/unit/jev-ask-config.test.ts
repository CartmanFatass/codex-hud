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
  DEFAULT_CDP_URL,
  DEFAULT_EFFORT_WORD,
  DEFAULT_GEMINI_EFFORT_LABEL,
  DEFAULT_GEMINI_ROOT,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ROOT,
  DEFAULT_USER_AGENT,
  defaultHudConfigPath,
  defaultJevEnvPath,
  defaultJevTomlPath,
  hostProxyEnv,
  loadJevConfig,
  OPENAI_DECISION_MODEL,
  readJevEnv,
} from '../../src/jev/ask/config.js';
import { JevFailure } from '../../src/jev/ask/error.js';

const FILE_KEY = 'synthetic-unit-key';
const ENV_SENTINEL = 'process-env-sentinel';

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-jev-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function toml(stateDir: string, extra = ''): string {
  return `[jev]\nstate_dir = ${JSON.stringify(stateDir)}\n${extra}`;
}

function writeEnv(file: string, text: string, mode = 0o600): void {
  writeFileSync(file, text, { mode });
}

test('paths are joined under the given home', () => {
  const home = '/var/empty/jev-home';
  assert.equal(defaultJevTomlPath(home), join(home, '.config', 'jev-ask', 'config.toml'));
  assert.equal(defaultJevEnvPath(home), join(home, '.hud', 'jev.env'));
  assert.equal(defaultHudConfigPath(home), join(home, '.hud', 'config.json'));
});

test('TOML maps onto defaults and config.json overrides field by field', (t) => {
  const root = workspace(t);
  const state = join(root, 'state');
  const home = join(root, 'home');
  const cfg = loadJevConfig({
    home,
    tomlText: toml(
      state,
      [
        'cdp_url = "http://127.0.0.1:9333"',
        'model = "From-Toml"',
        'effort_label = "5.6 Pro"',
        'fallback_effort_label = "retired"',
        'chrome = "~/browsers/chrome"',
        'profile = "~"',
        'proxy_server = "http://127.0.0.1:9"',
        'proxy_bypass = "example.invalid"',
        'jev_cdp_seconds = 12',
        'user_agent = "TomlAgent/1"',
      ].join('\n')
    ),
    configJson: {
      jev: {
        model: 'From-Json',
        cdpTimeoutMs: 1500,
        proxy: { server: 'http://127.0.0.1:8' },
        stateDir: join(home, 'state'),
      },
    },
  });
  assert.equal(cfg.model, 'From-Json');
  assert.equal(cfg.effortWord, DEFAULT_EFFORT_WORD);
  assert.equal(cfg.model.includes('5.6'), false);
  assert.equal(cfg.cdpUrl, 'http://127.0.0.1:9333');
  assert.equal(cfg.cdpTimeoutMs, 1500);
  assert.equal(cfg.userAgent, 'TomlAgent/1');
  assert.equal(cfg.chrome, join(home, 'browsers', 'chrome'));
  assert.equal(cfg.profile, home);
  assert.equal(cfg.stateDir, join(home, 'state'));
  assert.equal(cfg.proxy.server, 'http://127.0.0.1:8');
  assert.equal(cfg.proxy.bypass, 'example.invalid');
  assert.equal(existsSync(cfg.stateDir), false);
  assert.equal(cfg.geminiEffortLabel, DEFAULT_GEMINI_EFFORT_LABEL);
});

test('defaults, blank state dir, and a HUD file without jev', (t) => {
  const root = workspace(t);
  const state = join(root, 'state');
  const cfg = loadJevConfig({ tomlText: toml(state) });
  assert.equal(cfg.cdpUrl, DEFAULT_CDP_URL);
  assert.equal(cfg.model, DEFAULT_MODEL);
  assert.equal(cfg.effortWord, DEFAULT_EFFORT_WORD);
  assert.equal(cfg.providerRoot, DEFAULT_PROVIDER_ROOT);
  assert.equal(cfg.geminiRoot, DEFAULT_GEMINI_ROOT);
  assert.equal(cfg.userAgent, DEFAULT_USER_AGENT);
  assert.equal(cfg.cdpTimeoutMs, DEFAULT_CDP_TIMEOUT_MS);
  const seconds = loadJevConfig({ tomlText: toml(state, 'jev_cdp_seconds = 12\n') });
  assert.equal(seconds.cdpTimeoutMs, 12_000);
  assert.equal(cfg.ask.maxWaitMs, ASK_MAX_WAIT_MS);
  assert.equal(existsSync(state), false);

  assert.throws(
    () => loadJevConfig({}),
    (error: unknown) => error instanceof JevFailure && error.message === 'configuration not found'
  );
  assert.throws(
    () =>
      loadJevConfig({
        tomlText: toml(state),
        configJson: { jev: { stateDir: '   ' } },
      }),
    (error: unknown) =>
      error instanceof JevFailure &&
      error.message === '[jev] state_dir must explicitly name the existing shared operation directory'
  );

  const jsonPath = join(root, 'config.json');
  writeFileSync(jsonPath, JSON.stringify({ theme: 'dark' }));
  const fromFile = loadJevConfig({ configJsonPath: jsonPath, tomlText: toml(state, 'model = "From-Toml"\n') });
  assert.equal(fromFile.stateDir, state);
  assert.equal(fromFile.model, 'From-Toml');

  const bare = loadJevConfig({ configJson: { stateDir: state, model: 'Bare' }, configJsonIsJev: true });
  assert.equal(bare.model, 'Bare');
  assert.equal(bare.stateDir, state);

  const ignoredBare = loadJevConfig({
    tomlText: toml(state, 'model = "From-Toml"\n'),
    configJson: { stateDir: join(root, 'other'), model: 'Bare' },
  });
  assert.equal(ignoredBare.model, 'From-Toml');
  assert.equal(ignoredBare.stateDir, state);
});

test('proxy falls through json, toml, then the captured environment', (t) => {
  const root = workspace(t);
  const state = join(root, 'state');
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  t.after(() => {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  });
  const ignored = loadJevConfig({ tomlText: toml(state) });
  assert.equal(ignored.proxy.server, undefined);

  const fromEnv = loadJevConfig({
    tomlText: toml(state),
    capturedEnv: { https_proxy: 'http://127.0.0.1:9', no_proxy: 'example.invalid' },
  });
  assert.equal(fromEnv.proxy.server, 'http://127.0.0.1:9');
  assert.equal(fromEnv.proxy.bypass, 'example.invalid');

  const host = hostProxyEnv(fromEnv);
  assert.equal(host.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.equal(host.https_proxy, 'http://127.0.0.1:9');
  assert.equal(host.NO_PROXY, '127.0.0.1,localhost,example.invalid');
  assert.equal(host.no_proxy, host.NO_PROXY);
  assert.equal('HTTP_PROXY' in host, false);

  const direct = hostProxyEnv(ignored);
  assert.equal('HTTPS_PROXY' in direct, false);
  assert.equal(direct.NO_PROXY.startsWith('127.0.0.1,localhost'), true);

  assert.deepEqual(chromeProxyFlags(fromEnv.proxy), [
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=example.invalid',
  ]);
  assert.deepEqual(chromeProxyFlags({ server: 'http://127.0.0.1:9', bypass: 'example.invalid, localhost' }), [
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=example.invalid;localhost',
  ]);

  const emptyBypass = loadJevConfig({
    tomlText: toml(state, 'proxy_server = "http://127.0.0.1:9"\nproxy_bypass = ""\n'),
    capturedEnv: { no_proxy: 'example.invalid' },
  });
  assert.equal(emptyBypass.proxy.server, 'http://127.0.0.1:9');
  assert.equal(emptyBypass.proxy.bypass, 'example.invalid');
  const emptyJson = loadJevConfig({
    tomlText: toml(state, 'proxy_bypass = "from-toml"\n'),
    configJson: { jev: { proxy: { bypass: '' } } },
    capturedEnv: { no_proxy: 'from-env' },
  });
  assert.equal(emptyJson.proxy.bypass, 'from-toml');
  const bothEmpty = loadJevConfig({
    tomlText: toml(state, 'proxy_bypass = ""\n'),
    configJson: { jev: { proxy: { bypass: '   ' } } },
    capturedEnv: { NO_PROXY: 'from-env' },
  });
  assert.equal(bothEmpty.proxy.bypass, 'from-env');
});

test('ask max wait is clamped', (t) => {
  const root = workspace(t);
  const cfg = loadJevConfig({
    tomlText: toml(join(root, 'state')),
    configJson: { jev: { ask: { maxWaitMs: ASK_MAX_WAIT_CAP_MS + 60_000 } } },
  });
  assert.equal(cfg.ask.maxWaitMs, ASK_MAX_WAIT_CAP_MS);
  assert.throws(
    () => loadJevConfig({ tomlText: toml(join(root, 'state')), configJson: { jev: { ask: { queueLimit: -1 } } } }),
    (error: unknown) => error instanceof JevFailure && error.code === 'config'
  );
});

test('credentials are re-read and errors omit key material', (t) => {
  const root = workspace(t);
  const envFile = join(root, 'jev.env');
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = ENV_SENTINEL;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const config = loadJevConfig({ tomlText: toml(join(root, 'state')) });
  assert.deepEqual(readJevEnv(join(root, 'missing.env')), { textModel: {} });
  const missing = credentialsForJob(join(root, 'missing.env'), config);
  assert.deepEqual(missing, {
    ok: false,
    error: 'jev_credentials_missing',
    provider: 'typesafe',
    variable: 'TYPESAFE_API_KEY',
  });
  assert.equal(JSON.stringify(missing).includes(ENV_SENTINEL), false);

  writeEnv(
    envFile,
    `export OPENAI_API_KEY='${FILE_KEY}'\nOPENAI_BASE_URL="https://example.invalid/v1"\nTEXT_MODEL_FOO=bar\n# OPENAI_API_KEY=nope\nOTHER=skip\n`
  );
  const openai = credentialsForJob(envFile, config);
  assert.equal(openai.ok, true);
  if (openai.ok && openai.provider === 'openai') {
    assert.equal(openai.apiKey, FILE_KEY);
    assert.equal(openai.model, OPENAI_DECISION_MODEL);
    assert.equal(openai.baseUrl, 'https://example.invalid/v1');
  }
  writeEnv(envFile, `OPENAI_API_KEY=${FILE_KEY}\nTYPESAFE_API_KEY=synthetic-typesafe\nTYPESAFE_MODEL=custom-jev\n`);
  const both = credentialsForJob(envFile, config);
  assert.equal(both.ok && both.provider, 'typesafe');
  if (both.ok && both.provider === 'typesafe') assert.equal(both.model, 'custom-jev');
  const typesafeConfig = loadJevConfig({
    tomlText: toml(join(root, 'state')),
    configJson: { jev: { decisions: { provider: 'typesafe', typesafe: { model: 'from-config' } } } },
  });
  const typesafe = credentialsForJob(envFile, typesafeConfig);
  assert.equal(typesafe.ok && typesafe.provider === 'typesafe' && typesafe.model, 'from-config');

  const onlyFile = join(root, 'typesafe.env');
  writeEnv(onlyFile, 'TYPESAFE_API_KEY=synthetic-typesafe\n');
  const forced = credentialsForJob(onlyFile, {
    ...config,
    decisions: { provider: 'openai', openai: {}, typesafe: {} },
  });
  assert.equal(forced.ok, false);
  assert.equal(JSON.stringify(forced).includes('synthetic-typesafe'), false);
  if (!forced.ok) assert.equal(forced.variable, 'OPENAI_API_KEY');

  writeEnv(join(root, 'loose.env'), `OPENAI_API_KEY=${FILE_KEY}\n`, 0o644);
  assert.throws(
    () => readJevEnv(join(root, 'loose.env')),
    (error: unknown) => error instanceof JevFailure && error.code === 'jev_env_perms'
  );
  const real = join(root, 'real.env');
  writeEnv(real, `OPENAI_API_KEY=${FILE_KEY}\n`);
  symlinkSync(real, join(root, 'link.env'));
  assert.throws(
    () => readJevEnv(join(root, 'link.env')),
    (error: unknown) => error instanceof JevFailure && error.code === 'jev_env_perms'
  );
  mkdirSync(join(root, 'dir.env'));
  assert.throws(
    () => readJevEnv(join(root, 'dir.env')),
    (error: unknown) => error instanceof JevFailure && error.code === 'jev_env_perms'
  );
});

test('a credential FIFO is refused without waiting for a writer', (t) => {
  if (process.platform === 'win32') return t.skip('FIFOs are POSIX only');
  const root = workspace(t);
  const fifo = join(root, 'jev.env');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip(`mkfifo unavailable: ${made.error?.message ?? made.stderr}`);
  const module = new URL('../../src/jev/ask/config.js', import.meta.url).href;
  const script = `import { readJevEnv } from ${JSON.stringify(module)};
try {
  readJevEnv(${JSON.stringify(fifo)});
  process.stdout.write('opened');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'throw';
  process.stdout.write(code);
}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'jev_env_perms');
});

test('a missing config parent is not created', (t) => {
  const root = workspace(t);
  const parent = join(root, 'missing-parent');
  assert.throws(
    () => loadJevConfig({ tomlPath: join(parent, 'config.toml'), configJsonPath: join(parent, 'config.json') }),
    (error: unknown) => error instanceof JevFailure && error.message === 'configuration not found'
  );
  assert.equal(existsSync(parent), false);
});

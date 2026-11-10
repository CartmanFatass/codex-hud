import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import {
  readCredentialsEnv,
  readHudCredentials,
  loadJevConfig,
  readHudCredentialName,
} from '../../src/jev/ask/config.js';
import { JevFailure } from '../../src/jev/ask/error.js';
import { loadRuntimeConfig } from '../../src/jev/runtime/executor.js';
import { loadStudioConfig } from '../../src/jev/runtime/aistudio-state.js';
import {
  modelHttpRequest,
  completionText,
  REASONING_TOKEN_ALLOWANCE,
  type ApiEffort,
} from '../../src/collectors/small-model.js';
import { ModelProbe, apiSettings, probeFingerprint } from '../../src/collectors/model-probe.js';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import { SETTING_ROWS, withRowValue, renderSettingsPage } from '../../src/render/settings-page.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi } from '../../src/render/colors.js';
function workspace(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-keys-')),
    hudHome = path.join(home, '.hud');
  fs.mkdirSync(hudHome);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hudHome, env: { HOME: home, HUD_HOME: hudHome } };
}
function privateFile(file: string, body: string) {
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function scopedEnv(t: TestContext, values: Record<string, string | undefined>) {
  const old = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of old) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
const question = {
  feature: 'labels',
  system: 'synthetic instructions',
  prompt: 'synthetic prompt',
  maxOutputTokens: 256,
};
const api = { base: 'https://api.mistral.ai/v1', model: '' };
function built(base: string, env: NodeJS.ProcessEnv) {
  const request = modelHttpRequest({ ...api, base }, question, env);
  assert.ok(!('error' in request));
  return request;
}
function locations(stateDir: string) {
  return { stateDir, cdpUrl: 'http://127.0.0.1:9333', chrome: '/synthetic/chrome', profile: '/synthetic/profile' };
}
test('credentials are private regular bounded files; unsafe modes, symlinks and FIFO are refused', (t) => {
  const { hudHome } = workspace(t),
    file = path.join(hudHome, 'credentials.env');
  privateFile(
    file,
    'MISTRAL_API_KEY="synthetic-mistral"\nMISTRAL_BASE_URL=https://example.invalid\nTEXT_MODEL_KEY=${LITERAL}\n'
  );
  assert.deepEqual(readCredentialsEnv(file), {
    mistralApiKey: 'synthetic-mistral',
    mistralBaseUrl: 'https://example.invalid',
    textModel: { TEXT_MODEL_KEY: '${LITERAL}' },
  });
  for (const mode of [0o644, 0o400, 0o700]) {
    fs.chmodSync(file, mode);
    assert.throws(
      () => readCredentialsEnv(file),
      (e: unknown) => e instanceof JevFailure && e.code === 'jev_env_perms'
    );
  }
  fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, path.join(hudHome, 'link.env'));
  assert.throws(() => readCredentialsEnv(path.join(hudHome, 'link.env')), /regular file/);
  const fifo = path.join(hudHome, 'fifo.env');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const module = new URL('../../src/jev/ask/config.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {readCredentialsEnv} from ${JSON.stringify(module)};try{readCredentialsEnv(${JSON.stringify(fifo)});process.exit(2)}catch(e){process.exit(e.code==='jev_env_perms'?0:3)}`,
    ],
    { timeout: 5000 }
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  privateFile(file, 'x'.repeat(65537));
  assert.throws(() => readCredentialsEnv(file), /maximum 64 KiB/);
});
test('per-name precedence is environment > credentials.env only, never jev.env; captured HOME is hermetic', (t) => {
  const { hudHome, env, home } = workspace(t);
  assert.deepEqual(readHudCredentials(env), { textModel: {} });
  privateFile(
    path.join(hudHome, 'jev.env'),
    'OPENAI_API_KEY=synthetic-legacy\nTYPESAFE_API_KEY=synthetic-legacy-typesafe\nTEXT_MODEL_B=legacy\n'
  );
  assert.deepEqual(readHudCredentials(env), { textModel: {} });
  privateFile(
    path.join(hudHome, 'credentials.env'),
    'OPENAI_API_KEY=synthetic-current\nMISTRAL_API_KEY=synthetic-mistral\nTEXT_MODEL_A=current\nCUSTOM_SOURCE_KEY=synthetic-custom\n'
  );
  const current = readHudCredentials(env);
  assert.equal(current.openaiApiKey, 'synthetic-current');
  assert.equal(current.typesafeApiKey, undefined);
  assert.deepEqual(current.textModel, { TEXT_MODEL_A: 'current' });
  assert.equal(readHudCredentials({ ...env, OPENAI_API_KEY: 'synthetic-env' }).openaiApiKey, 'synthetic-env');
  assert.equal(readHudCredentials({ HOME: home }).mistralApiKey, 'synthetic-mistral');
  assert.equal(readHudCredentials({ ...env, OPENAI_API_KEY: '' }).openaiApiKey, '');
  assert.equal(readHudCredentialName('CUSTOM_SOURCE_KEY', env), 'synthetic-custom');
  assert.equal(readHudCredentialName('CUSTOM_SOURCE_KEY', { ...env, CUSTOM_SOURCE_KEY: 'override' }), 'override');
  const other = path.join(home, 'other');
  fs.mkdirSync(other);
  assert.deepEqual(readHudCredentials({ HOME: other }), { textModel: {} });
});
test('panel key selection is exact HTTPS host from environment or own credentials only; custom/no-key path is off', async (t) => {
  const { hudHome, env } = workspace(t);
  privateFile(
    path.join(hudHome, 'credentials.env'),
    'MISTRAL_API_KEY=synthetic-mistral\nOPENAI_API_KEY=synthetic-openai\n'
  );
  assert.equal(built(api.base, env).headers.authorization, 'Bearer synthetic-mistral');
  assert.equal(built('https://api.openai.com/v1', env).headers.authorization, 'Bearer synthetic-openai');
  assert.equal(
    built(api.base, { ...env, MISTRAL_API_KEY: 'synthetic-env' }).headers.authorization,
    'Bearer synthetic-env'
  );
  for (const base of [
    'http://127.0.0.1:4000/v1',
    'https://custom.invalid/v1',
    'https://api.mistral.ai.evil/v1',
    'https://api.mistral.ai:8443/v1',
    'http://api.mistral.ai/v1',
    'https://api.openai.com.evil/v1',
    'http://api.openai.com/v1',
    'https://api.openai.com:8443/v1',
  ]) {
    assert.ok(
      'error' in
        modelHttpRequest({ ...api, base, key: 'ignored-explicit' }, question, {
          ...env,
          CODEX_HUD_BRIEF_API_KEY: 'ignored-legacy',
        }),
      base
    );
  }
  for (const base of ['https://user@api.mistral.ai/v1', 'https://api.mistral.ai@evil.invalid/v1'])
    assert.ok('error' in modelHttpRequest({ ...api, base }, question, env));
  assert.equal(
    Object.hasOwn(apiSettings(defaultSettings()), 'sourceCredential'),
    false,
    'settings cannot populate the source-scoped seam'
  );
  let calls = 0;
  const probe = new ModelProbe({
    env,
    fetch: (async () => {
      calls++;
      throw new Error('must not call');
    }) as typeof fetch,
  });
  await probe.run({ ...defaultSettings(), briefing: 'api', briefingApiBase: 'https://custom.invalid/v1' });
  assert.equal(calls, 0);
  assert.ok(probe.current().rows.every((row) => row.status === 'failed'));
  fs.unlinkSync(path.join(hudHome, 'credentials.env'));
  await probe.run({ ...defaultSettings(), briefing: 'api' });
  assert.equal(calls, 0);
  assert.ok(probe.current().rows.every((row) => row.failure));
});
test('each tier sends configured efforts and bounded headroom; multipart thinking is ignored', (t) => {
  const { env } = workspace(t);
  for (const [tier, feature] of [
    ['lite', 'labels'],
    ['low', 'progress'],
    ['medium', 'recap'],
  ] as const)
    for (const effort of ['off', 'none', 'low', 'high', 'xhigh', 'max', 'minimal', 'medium'] as ApiEffort[]) {
      const request = modelHttpRequest(
        { ...api, efforts: { [tier]: effort } },
        { ...question, feature, thinking: 'medium' },
        { ...env, MISTRAL_API_KEY: 'synthetic-key' }
      );
      assert.ok(!('error' in request));
      const body = JSON.parse(request.body);
      assert.equal(body.reasoning_effort, effort === 'off' ? undefined : effort);
      assert.equal(body.max_tokens, 256 + (effort === 'off' || effort === 'none' ? 0 : REASONING_TOKEN_ALLOWANCE));
    }
  assert.equal(
    completionText({
      choices: [
        {
          message: {
            content: [
              { type: 'thinking', thinking: [{ type: 'text', text: 'private thought' }] },
              { type: 'text', text: 'answer' },
            ],
          },
        },
      ],
    }),
    'answer'
  );
});
test('removed keys load without migration and are dropped on save, other settings survive', (t) => {
  const { env, hudHome } = workspace(t),
    file = path.join(hudHome, 'hud-settings.json');
  scopedEnv(t, { ...env, HUD_SETTINGS_PATH: undefined, CODEX_HUD_SETTINGS_PATH: undefined });
  for (const enabled of [false, true]) {
    privateFile(
      file,
      JSON.stringify({
        briefingApiKey: 'synthetic-removed',
        briefingApiReasoning: enabled,
        theme: 'mocha',
        briefingApiLowEffort: 'max',
      })
    );
    const loaded = loadSettings();
    assert.deepEqual(apiSettings(loaded).efforts, { lite: 'none', low: 'max', medium: 'high' });
    assert.equal(loaded.theme, 'mocha');
    saveSettings({ language: 'en' });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.theme, 'mocha');
    assert.equal(saved.language, 'en');
    assert.equal(Object.hasOwn(saved, 'briefingApiKey'), false);
    assert.equal(Object.hasOwn(saved, 'briefingApiReasoning'), false);
  }
});
test('real ModelProbe uses product defaults and file credentials; key rotation invalidates probe', async (t) => {
  const { env, hudHome } = workspace(t),
    file = path.join(hudHome, 'credentials.env');
  privateFile(file, 'MISTRAL_API_KEY=synthetic-mistral\n');
  const settings = { ...defaultSettings(), briefing: 'api' as const };
  const recorded: Array<{ auth: string | undefined; body: Record<string, any> }> = [];
  const probe = new ModelProbe({
    env,
    fetch: (async (_url, init) => {
      recorded.push({
        auth: (init?.headers as Record<string, string>).authorization,
        body: JSON.parse(String(init?.body)),
      });
      assert.equal(init?.redirect, 'error');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: 'thinking', thinking: [{ type: 'text', text: 'not answer' }] },
                  { type: 'text', text: 'OK' },
                ],
              },
            },
          ],
        })
      );
    }) as typeof fetch,
  });
  await probe.run(settings);
  assert.deepEqual(
    recorded.map((r) => r.auth),
    Array(3).fill('Bearer synthetic-mistral')
  );
  assert.deepEqual(
    recorded.map((r) => r.body.model),
    Array(3).fill('deepseek-v4-1-flash-1017')
  );
  assert.deepEqual(
    recorded.map((r) => r.body.reasoning_effort),
    ['none', 'low', 'high']
  );
  assert.deepEqual(
    recorded.map((r) => r.body.max_tokens),
    [256, 768, 768]
  );
  assert.ok(probe.current().rows.every((r) => r.status === 'ok'));
  const old = probeFingerprint(settings, env);
  privateFile(file, 'MISTRAL_API_KEY=synthetic-rotated\n');
  assert.notEqual(probeFingerprint(settings, env), old);
});
test('runtime ignores JEV_ASK_CONFIG even when valid; locations come only from HUD JSON', (t) => {
  const { env, hudHome, home } = workspace(t),
    foreign = path.join(home, 'explicit.toml');
  scopedEnv(t, { ...env, JEV_ASK_CONFIG: foreign });
  privateFile(
    foreign,
    '[jev]\nstate_dir="/synthetic/state"\ncdp_url="http://127.0.0.1:9"\nchrome="/synthetic/chrome"\nprofile="/synthetic/profile"\n'
  );
  assert.throws(() => loadRuntimeConfig(hudHome), /jev.cdpUrl.*hud import/);
  const file = path.join(hudHome, 'config.json');
  privateFile(file, JSON.stringify({ jev: locations(path.join(home, 'state')) }));
  assert.equal(loadRuntimeConfig(hudHome).stateDir, path.join(home, 'state'));
  assert.equal(loadJevConfig({ capturedEnv: env }).cdpUrl, 'http://127.0.0.1:9333');
  assert.throws(
    () => loadStudioConfig({ capturedEnv: env, tomlText: '[aistudio]\nstate_dir="/synthetic/studio"' }),
    /aistudio.stateDir.*hud import/
  );
  const state = path.join(home, 'studio');
  fs.mkdirSync(state);
  privateFile(
    file,
    JSON.stringify({
      jev: locations(path.join(home, 'state')),
      aistudio: {
        stateDir: state,
        models: ['synthetic-a', 'synthetic-b'],
        model: 'synthetic-b',
        thinking: 'Low',
        cdpUrl: 'http://127.0.0.1:9444',
      },
    })
  );
  assert.deepEqual(loadStudioConfig({ capturedEnv: env }), {
    stateDir: state,
    models: ['synthetic-a', 'synthetic-b'],
    model: 'synthetic-b',
    thinking: 'Low',
    cdpUrl: 'http://127.0.0.1:9444',
  });
  for (const invalid of [null, [], 'invalid', { stateDir: state, models: [] }]) {
    privateFile(file, JSON.stringify({ aistudio: invalid }));
    assert.throws(
      () => loadStudioConfig({ capturedEnv: env }),
      (e: unknown) => e instanceof JevFailure && e.code === 'aistudio_config'
    );
  }
});
test('settings exposes EN/ZH tier efforts without offering endpoint-unsupported levels', () => {
  for (const lang of ['en', 'zh'] as const) {
    const old = setLanguage(lang);
    try {
      for (const key of ['briefingApiLiteEffort', 'briefingApiLowEffort', 'briefingApiMediumEffort'] as const) {
        const index = SETTING_ROWS.findIndex((r) => r.key === key);
        assert.ok(index >= 0);
        const row = SETTING_ROWS[index];
        assert.deepEqual(row.values, ['off', 'none', 'low', 'high', 'xhigh', 'max']);
        const draft = withRowValue(defaultSettings(), row, 'high');
        assert.equal(draft[key], 'high');
        const text = renderSettingsPage({ draft, selected: index, offset: 0, message: '' }, 60, 28)
          .lines.map(stripAnsi)
          .join('\n');
        assert.match(text, lang === 'zh' ? /推理/ : /effort/);
      }
    } finally {
      setLanguage(old);
    }
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { readCredentialsEnv, readHudCredentials, loadJevConfig } from '../../src/jev/ask/config.js';
import { JevFailure } from '../../src/jev/ask/error.js';
import { selectDecisionProvider } from '../../src/jev/decide.js';
import { JevRuntime, loadRuntimeConfig } from '../../src/jev/runtime/executor.js';
import { loadStudioConfig } from '../../src/jev/runtime/aistudio-state.js';
import type { OracleTarget } from '../../src/jev/runtime/oracle.js';
import { fakeProvider } from '../../src/jev/runtime/fake.js';
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-keys-'));
  const hudHome = path.join(home, '.hud');
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
const api = { base: 'https://api.mistral.ai/v1', model: '', key: '' };
function built(base: string, env: NodeJS.ProcessEnv, key = '') {
  const request = modelHttpRequest({ ...api, base, key }, question, env);
  assert.ok(!('error' in request));
  return request;
}

test('credentials are private regular files; unsafe modes, symlinks and FIFO are refused', (t) => {
  const { hudHome } = workspace(t);
  const file = path.join(hudHome, 'credentials.env');
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
      (error: unknown) => error instanceof JevFailure && error.code === 'jev_env_perms'
    );
  }
  fs.chmodSync(file, 0o600);
  const link = path.join(hudHome, 'link.env');
  fs.symlinkSync(file, link);
  assert.throws(
    () => readCredentialsEnv(link),
    (error: unknown) => error instanceof JevFailure && error.code === 'jev_env_perms'
  );
  const fifo = path.join(hudHome, 'fifo.env');
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0);
  // Child deadline makes a blocking-open regression fail instead of hanging this suite.
  const module = new URL('../../src/jev/ask/config.js', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readCredentialsEnv } from ${JSON.stringify(module)}; try { readCredentialsEnv(${JSON.stringify(fifo)}); process.exit(2); } catch (e) { process.exit(e.code === 'jev_env_perms' ? 0 : 3); }`,
    ],
    { timeout: 5000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

test('per-name precedence is environment > credentials.env > jev.env, with no missing-file keys', (t) => {
  const { hudHome, env, home } = workspace(t);
  assert.deepEqual(readHudCredentials(env), { textModel: {} });
  privateFile(
    path.join(hudHome, 'jev.env'),
    'OPENAI_API_KEY=synthetic-legacy-openai\nTYPESAFE_API_KEY=synthetic-legacy-typesafe\nTEXT_MODEL_A=legacy\nTEXT_MODEL_B=kept\n'
  );
  assert.equal(readHudCredentials(env).openaiApiKey, 'synthetic-legacy-openai');
  privateFile(
    path.join(hudHome, 'credentials.env'),
    'OPENAI_API_KEY=synthetic-current\nMISTRAL_API_KEY=synthetic-mistral\nTEXT_MODEL_A=current\n'
  );
  const current = readHudCredentials(env);
  assert.equal(current.openaiApiKey, 'synthetic-current');
  assert.equal(current.typesafeApiKey, 'synthetic-legacy-typesafe');
  assert.deepEqual(current.textModel, { TEXT_MODEL_A: 'current', TEXT_MODEL_B: 'kept' });
  assert.equal(readHudCredentials({ ...env, OPENAI_API_KEY: 'synthetic-env' }).openaiApiKey, 'synthetic-env');
  assert.equal(readHudCredentials({ HOME: home }).mistralApiKey, 'synthetic-mistral');
  assert.equal(readHudCredentials({ ...env, OPENAI_API_KEY: '' }).openaiApiKey, '');
  assert.equal(readHudCredentials({ ...env, TEXT_MODEL_A: 'env' }).textModel.TEXT_MODEL_A, 'env');
});

test('request builder binds file/provider environment keys to exact official HTTPS origins only', (t) => {
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
    assert.equal(
      built(base, { ...env, MISTRAL_API_KEY: 'synthetic-env', OPENAI_API_KEY: 'synthetic-env-openai' }).headers
        .authorization,
      undefined,
      base
    );
    assert.equal(
      built(base, { ...env, CODEX_HUD_BRIEF_API_KEY: 'synthetic-hud' }).headers.authorization,
      'Bearer synthetic-hud'
    );
    assert.equal(
      built(base, { ...env, CODEX_HUD_BRIEF_API_KEY: 'synthetic-hud' }, 'synthetic-explicit').headers.authorization,
      'Bearer synthetic-explicit'
    );
  }
  for (const base of ['https://user@api.mistral.ai/v1', 'https://api.mistral.ai@evil.invalid/v1']) {
    assert.ok('error' in modelHttpRequest({ ...api, base }, question, env));
  }
});

test('each tier sends only its configured effort; headroom is added only for actual reasoning', (t) => {
  const { env } = workspace(t);
  for (const [tier, feature] of [
    ['lite', 'labels'],
    ['low', 'progress'],
    ['medium', 'recap'],
  ] as const) {
    for (const effort of ['off', 'none', 'low', 'high', 'xhigh', 'max', 'minimal', 'medium'] as ApiEffort[]) {
      const request = modelHttpRequest(
        { ...api, efforts: { [tier]: effort } },
        { ...question, feature, thinking: 'medium' },
        env
      );
      assert.ok(!('error' in request));
      const body = JSON.parse(request.body);
      assert.equal(body.reasoning_effort, effort === 'off' ? undefined : effort);
      assert.equal(body.max_tokens, 256 + (effort === 'off' || effort === 'none' ? 0 : REASONING_TOKEN_ALLOWANCE));
    }
  }
  const content = [
    { type: 'thinking', thinking: [{ type: 'text', text: 'private thought' }] },
    { type: 'text', text: 'answer' },
  ];
  assert.equal(completionText({ choices: [{ message: { content } }] }), 'answer');
});

test('legacy true/false files migrate conservatively and explicit per-tier typed values persist', (t) => {
  const { env, hudHome } = workspace(t);
  const file = path.join(hudHome, 'settings.json');
  scopedEnv(t, { ...env, HUD_SETTINGS_PATH: file });
  for (const enabled of [false, true]) {
    privateFile(file, JSON.stringify({ briefingApiReasoning: enabled }));
    const resolved = apiSettings(loadSettings());
    assert.deepEqual(
      resolved.efforts,
      enabled ? { lite: 'none', low: 'low', medium: 'low' } : { lite: 'off', low: 'off', medium: 'off' }
    );
    for (const feature of ['labels', 'progress', 'recap']) {
      const request = modelHttpRequest(resolved, { ...question, feature, thinking: 'medium' }, env);
      assert.ok(!('error' in request));
      assert.ok(!['minimal', 'medium'].includes(JSON.parse(request.body).reasoning_effort));
    }
  }
  privateFile(
    file,
    JSON.stringify({
      briefingApiReasoning: true,
      briefingApiLiteEffort: 'off',
      briefingApiLowEffort: 'minimal',
      briefingApiMediumEffort: 'medium',
    })
  );
  assert.deepEqual(apiSettings(loadSettings()).efforts, { lite: 'off', low: 'minimal', medium: 'medium' });
  saveSettings({ briefingApiLowEffort: 'max' });
  assert.deepEqual(apiSettings(loadSettings()).efforts, { lite: 'off', low: 'max', medium: 'medium' });
});

test('real ModelProbe requests use credentials and configured tier efforts, parsing Mistral thinking parts', async (t) => {
  const { env, hudHome } = workspace(t);
  const file = path.join(hudHome, 'credentials.env');
  privateFile(file, 'MISTRAL_API_KEY=synthetic-mistral\n');
  const settings = {
    ...defaultSettings(),
    briefing: 'api' as const,
    briefingApiBase: api.base,
    briefingApiLiteEffort: 'none' as const,
    briefingApiLowEffort: 'low' as const,
    briefingApiMediumEffort: 'high' as const,
  };
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
                  { type: 'thinking', thinking: [{ type: 'text', text: 'not an answer' }] },
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
    recorded.map((row) => row.auth),
    Array(3).fill('Bearer synthetic-mistral')
  );
  assert.deepEqual(
    recorded.map((row) => row.body.reasoning_effort),
    ['none', 'low', 'high']
  );
  assert.deepEqual(
    recorded.map((row) => row.body.max_tokens),
    [256, 768, 768]
  );
  assert.ok(probe.current().rows.every((row) => row.status === 'ok'));
  const old = probeFingerprint(settings, env);
  privateFile(file, 'MISTRAL_API_KEY=synthetic-rotated\n');
  assert.notEqual(probeFingerprint(settings, env), old);
});

test('Jev uses HUD config only; poisoned implicit TOML is never read, explicit TOML still works', (t) => {
  const { env, hudHome, home } = workspace(t);
  scopedEnv(t, { ...env, JEV_ASK_CONFIG: undefined });
  const foreign = path.join(home, '.config', 'jev-ask', 'config.toml');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  privateFile(foreign, 'POISON: invalid TOML MUST NOT BE READ');
  const configFile = path.join(hudHome, 'config.json');
  assert.throws(
    () => loadRuntimeConfig(hudHome),
    (error: unknown) => error instanceof JevFailure && error.message === `configuration not found: ${configFile}`
  );
  privateFile(
    configFile,
    JSON.stringify({ jev: { stateDir: path.join(home, 'shared-state'), model: 'synthetic-model' } })
  );
  assert.equal(loadRuntimeConfig(hudHome).model, 'synthetic-model');
  assert.equal(loadJevConfig({ capturedEnv: env, home }).stateDir, path.join(home, 'shared-state'));
  privateFile(
    foreign,
    `[jev]\nstate_dir = ${JSON.stringify(path.join(home, 'legacy-state'))}\nmodel = "synthetic-toml"\n`
  );
  fs.unlinkSync(configFile);
  process.env.JEV_ASK_CONFIG = foreign;
  assert.equal(loadRuntimeConfig(hudHome).model, 'synthetic-toml');
});

test('active AI Studio jobs use runtime HUD JSON, ignore foreign TOML, and preserve shared state', async (t) => {
  const { env, hudHome, home } = workspace(t);
  scopedEnv(t, { ...env, JEV_ASK_CONFIG: undefined, TYPESAFE_API_KEY: undefined, OPENAI_API_KEY: undefined });
  const foreign = path.join(home, '.config', 'jev-ask', 'config.toml');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  privateFile(foreign, 'POISON invalid TOML MUST NOT BE READ');
  const sharedState = path.join(home, 'deliberately-shared-studio-state');
  const jevState = path.join(home, 'deliberately-shared-jev-state');
  fs.mkdirSync(sharedState);
  fs.mkdirSync(jevState);
  const configFile = path.join(hudHome, 'config.json');
  assert.throws(
    () => loadStudioConfig({ configJsonPath: configFile }),
    (error: unknown) => error instanceof JevFailure && error.message === `configuration not found: ${configFile}`
  );
  privateFile(
    configFile,
    JSON.stringify({
      jev: { stateDir: jevState },
      aistudio: {
        state_dir: sharedState,
        models: ['synthetic-studio-model'],
        default_model: 'synthetic-studio-model',
        default_thinking: 'Low',
        cdp_url: 'http://127.0.0.1:9333',
      },
    })
  );
  privateFile(path.join(hudHome, 'credentials.env'), 'TYPESAFE_API_KEY=synthetic-studio-key\n');
  assert.deepEqual(loadStudioConfig({ configJsonPath: configFile }), {
    stateDir: sharedState,
    models: ['synthetic-studio-model'],
    model: 'synthetic-studio-model',
    thinking: 'Low',
    cdpUrl: 'http://127.0.0.1:9333',
  });
  // Runtime HUD home must win even if the process default HUD config is different.
  process.env.HUD_HOME = path.join(home, 'wrong-hud-home');
  let browserOpens = 0;
  const noBrowser = async (): Promise<never> => {
    browserOpens++;
    throw new Error('synthetic_config_test_stops_before_browser');
  };
  const target: OracleTarget = {
    provider: 'aistudio',
    root: 'https://example.invalid/',
    settled: (url): url is string => typeof url === 'string',
    open: noBrowser,
    attach: noBrowser,
    targets: async () => [],
    prepare: noBrowser,
    click: noBrowser,
    binding: () => ({ found: false, answer: '', final: false }),
    matchesDraft: () => false,
  };
  const runtime = new JevRuntime({ hudHome, fake: true, graceMs: 60_000, oracleTargets: { aistudio: target } });
  await runtime.start();
  try {
    const job = await runtime.createJob({
      requestKey: 'studio-owned-config',
      session: { namespace: 'hud', sessionId: 'synthetic-studio-session' },
      input: { tag: 'ask', target: 'aistudio', label: 'synthetic-studio', prompt: 'synthetic prompt' },
    });
    const stored = JSON.parse(fs.readFileSync(path.join(hudHome, 'jev-runtime', 'jobs', `${job.id}.json`), 'utf8'));
    assert.equal(stored.input.model, 'synthetic-studio-model');
    assert.equal(stored.input.thinking, 'Low');
    assert.equal(stored.askStateDir, sharedState);
    assert.equal(runtime.stateDir, jevState);
  } finally {
    await runtime.stop();
  }
  assert.ok(browserOpens <= 1, 'no real browser access; synthetic target stops the execution');
});

test('AI Studio JSON overlays only explicit TOML field by field and validates its section', (t) => {
  const { env, hudHome, home } = workspace(t);
  const sharedState = path.join(home, 'shared-studio');
  fs.mkdirSync(sharedState);
  const configFile = path.join(hudHome, 'config.json');
  const explicit = path.join(home, 'explicit.toml');
  privateFile(
    explicit,
    `[aistudio]\nstate_dir=${JSON.stringify(sharedState)}\nmodels=["synthetic-a", "synthetic-b"]\ndefault_model="synthetic-a"\ndefault_thinking="High"\n`
  );
  privateFile(configFile, JSON.stringify({ aistudio: { default_model: 'synthetic-b', default_thinking: 'Low' } }));
  assert.deepEqual(loadStudioConfig({ home, capturedEnv: { ...env, JEV_ASK_CONFIG: explicit } }), {
    stateDir: sharedState,
    models: ['synthetic-a', 'synthetic-b'],
    model: 'synthetic-b',
    thinking: 'Low',
  });
  fs.unlinkSync(configFile);
  assert.equal(loadStudioConfig({ home, capturedEnv: { ...env, JEV_ASK_CONFIG: explicit } }).model, 'synthetic-a');
  for (const invalid of [null, [], 'invalid', { models: [] }]) {
    privateFile(configFile, JSON.stringify({ aistudio: invalid }));
    assert.throws(
      () => loadStudioConfig({ home, capturedEnv: { ...env, JEV_ASK_CONFIG: explicit } }),
      (error: unknown) => error instanceof JevFailure && error.code === 'aistudio_config'
    );
  }
});

test('Jev decision selection keeps the same rule using HUD credentials and environment overrides', async (t) => {
  const { env, hudHome, home } = workspace(t);
  scopedEnv(t, {
    ...env,
    TYPESAFE_API_KEY: undefined,
    TYPESAFE_MODEL: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
  });
  privateFile(
    path.join(hudHome, 'credentials.env'),
    'TYPESAFE_API_KEY=synthetic-typesafe\nOPENAI_API_KEY=synthetic-openai\nTYPESAFE_MODEL=synthetic-model\n'
  );
  assert.equal((await selectDecisionProvider(undefined, env)).id, 'typesafe');
  assert.equal((await selectDecisionProvider('openai', env)).id, 'openai');
  assert.equal(
    (await selectDecisionProvider('typesafe', { ...env, TYPESAFE_MODEL: 'synthetic-override' })).model,
    'synthetic-override'
  );
  const stateDir = path.join(home, 'shared-state');
  fs.mkdirSync(stateDir);
  const resolved: Array<{ id: string; apiKey: string }> = [];
  const runtime = new JevRuntime({
    hudHome,
    stateDir,
    fake: true,
    graceMs: 60_000,
    providerFactory: (choice) => {
      resolved.push(choice);
      return fakeProvider();
    },
  });
  await runtime.start();
  try {
    for (const [index, provider] of [undefined, 'openai'].entries()) {
      await runtime.createJob({
        requestKey: `keys-${index}`,
        session: { namespace: 'hud', sessionId: 'synthetic-session' },
        input: { tag: 'browse', goal: 'read fixture', url: 'https://example.invalid' },
        ...(provider ? { jevDecisions: { provider: provider as 'openai' } } : {}),
      });
    }
    assert.deepEqual(
      resolved.map((value) => [value.id, value.apiKey]),
      [
        ['typesafe', 'synthetic-typesafe'],
        ['openai', 'synthetic-openai'],
      ]
    );
  } finally {
    await runtime.stop();
  }
});

test('settings exposes EN/ZH tier effort rows without offering typed-only unsupported levels', (t) => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    t.after(() => setLanguage(previous));
    for (const key of ['briefingApiLiteEffort', 'briefingApiLowEffort', 'briefingApiMediumEffort'] as const) {
      const index = SETTING_ROWS.findIndex((row) => row.key === key);
      assert.ok(index >= 0);
      const row = SETTING_ROWS[index];
      assert.deepEqual(row.values, ['off', 'none', 'low', 'high', 'xhigh', 'max']);
      const draft = withRowValue(defaultSettings(), row, 'high');
      assert.equal(draft[key], 'high');
      const rendered = renderSettingsPage({ draft, selected: index, offset: 0, message: '' }, 60, 28)
        .lines.map(stripAnsi)
        .join('\n');
      assert.match(rendered, lang === 'zh' ? /推理/ : /effort/);
    }
    setLanguage(previous);
  }
});

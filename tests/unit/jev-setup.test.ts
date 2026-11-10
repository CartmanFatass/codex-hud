// Explicit import CLI, synthetic files only. Values must never reach either output stream.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { readCredentialsEnv } from '../../src/jev/ask/config.js';
import { loadStudioConfig } from '../../src/jev/runtime/aistudio-state.js';
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-import-')),
    home = join(root, 'home'),
    hud = join(home, '.hud');
  fs.mkdirSync(hud, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let stdout = '',
    stderr = '';
  const io = {
    env: { HOME: home, HUD_HOME: hud },
    stdout: (s: string) => {
      stdout += s;
    },
    stderr: (s: string) => {
      stderr += s;
    },
  };
  return {
    root,
    home,
    hud,
    io,
    output: () => stdout + stderr,
    reset: () => {
      stdout = '';
      stderr = '';
    },
  };
}
function tree(root: string): string {
  const parts: string[] = [];
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = join(dir, name),
        s = fs.lstatSync(file);
      parts.push(file, String(s.mode), String(s.mtimeMs));
      if (s.isDirectory()) walk(file);
      else if (s.isSymbolicLink()) parts.push(fs.readlinkSync(file));
      else parts.push(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
  }
  walk(root);
  return parts.join('\n');
}
test('import help and retired setup do not write or inspect another tools config', async (t) => {
  const f = fixture(t),
    before = tree(f.root);
  assert.equal(await main(['import', '--help'], f.io), 0);
  assert.match(f.output(), /preview\|apply/);
  assert.equal(await main(['setup', '--import-jev-env'], f.io), 2);
  assert.match(f.output(), /hud import/);
  assert.equal(tree(f.root), before);
});
test('preview is byte/tree read-only; apply imports settings, env and TOML existing-wins with backups and idempotence', async (t) => {
  const f = fixture(t),
    settings = join(f.root, 'hud-settings.json'),
    toml = join(f.root, 'source.toml');
  const secrets = ['unique-env-secret-517', 'unique-old-settings-secret-518', 'unique-toml-value-519'];
  fs.writeFileSync(
    settings,
    JSON.stringify({ theme: 'mocha', language: 'en', briefingApiKey: secrets[1], briefingApiReasoning: true })
  );
  fs.writeFileSync(join(f.hud, 'hud-settings.json'), JSON.stringify({ theme: 'latte' }));
  fs.writeFileSync(
    join(f.hud, 'jev.env'),
    `OPENAI_API_KEY=${secrets[0]}\nTYPESAFE_API_KEY=unique-typesafe-520\nMISTRAL_API_KEY=unique-mistral-521\nTEXT_MODEL_FOO=literal-522\nOTHER_SECRET=hidden-523\n`
  );
  fs.writeFileSync(
    join(f.hud, 'credentials.env'),
    'OPENAI_API_KEY=existing-wins-524\nCUSTOM=" literal ${UNEXPANDED} "\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(
    toml,
    `[jev]\ncdp_url="http://127.0.0.1:9333"\nchrome="/synthetic/chrome"\nprofile="/synthetic/profile"\nstate_dir="/synthetic/state"\nuser_agent="${secrets[2]}"\nprovider_root="https://example.invalid/"\ngemini_root="https://gemini.invalid/"\nmodel="Synthetic"\neffort_word="Pro"\ngemini_effort_label="High"\n[aistudio]\nstate_dir="/synthetic/studio"\ncdp_url="http://127.0.0.1:9444"\nmodels=["gemini-test"]\ndefault_model="gemini-test"\ndefault_thinking="High"\n`
  );
  fs.writeFileSync(
    join(f.hud, 'config.json'),
    JSON.stringify({ jev: { profile: '/existing/profile' }, decisions: { primary: 'openai' } })
  );
  const args = ['--from', settings, '--from', toml];
  const before = tree(f.root);
  assert.equal(await main(['import', 'preview', ...args], f.io), 0, f.output());
  assert.equal(tree(f.root), before);
  for (const secret of [
    ...secrets,
    'unique-typesafe-520',
    'unique-mistral-521',
    'literal-522',
    'hidden-523',
    'existing-wins-524',
  ])
    assert.ok(!f.output().includes(secret), 'preview leaked a value');
  for (const name of [
    'OPENAI_API_KEY',
    'TYPESAFE_API_KEY',
    'jev.cdpUrl',
    'aistudio.stateDir',
    'skip existing: theme',
    'skip existing: jev.profile',
  ])
    assert.ok(f.output().includes(name), name);
  f.reset();
  assert.equal(await main(['import', 'apply', ...args], f.io), 0, f.output());
  for (const secret of secrets) assert.ok(!f.output().includes(secret), 'apply leaked a value');
  const saved = JSON.parse(fs.readFileSync(join(f.hud, 'hud-settings.json'), 'utf8'));
  assert.deepEqual(saved, { theme: 'latte', language: 'en' });
  const creds = readCredentialsEnv(join(f.hud, 'credentials.env'));
  assert.equal(creds.openaiApiKey, 'existing-wins-524');
  assert.equal(creds.typesafeApiKey, 'unique-typesafe-520');
  assert.equal(creds.mistralApiKey, 'unique-mistral-521');
  assert.equal(creds.textModel.TEXT_MODEL_FOO, 'literal-522');
  assert.match(fs.readFileSync(join(f.hud, 'credentials.env'), 'utf8'), /CUSTOM=" literal \$\{UNEXPANDED\} "/);
  const config = JSON.parse(fs.readFileSync(join(f.hud, 'config.json'), 'utf8'));
  assert.equal(config.jev.cdpUrl, 'http://127.0.0.1:9333');
  assert.equal(config.jev.profile, '/existing/profile');
  assert.equal(config.jev.userAgent, secrets[2]);
  assert.equal(config.aistudio.model, 'gemini-test');
  assert.deepEqual(config.decisions, { primary: 'openai' });
  const backups = fs.readdirSync(f.hud).filter((n) => n.includes('.bak.'));
  assert.equal(backups.length, 3);
  for (const name of backups) assert.equal(fs.statSync(join(f.hud, name)).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(
      join(
        f.hud,
        backups.find((n) => n.startsWith('credentials.env'))!
      ),
      'utf8'
    ),
    'OPENAI_API_KEY=existing-wins-524\nCUSTOM=" literal ${UNEXPANDED} "\n'
  );
  const after = tree(f.root);
  f.reset();
  assert.equal(await main(['import', 'apply', ...args], f.io), 0);
  assert.equal(tree(f.root), after);
  assert.match(f.output(), /applied 0/);
});
test('no --from never guesses among Codex homes or reads JEV_ASK_CONFIG', async (t) => {
  const f = fixture(t);
  for (const name of ['.codex', '.codex_alt']) {
    fs.mkdirSync(join(f.home, name));
    fs.writeFileSync(join(f.home, name, 'hud-settings.json'), '{"theme":"mocha"}');
  }
  const before = tree(f.root);
  assert.equal(
    await main(['import', 'apply'], {
      ...f.io,
      env: { ...f.io.env, JEV_ASK_CONFIG: '/nonexistent-synthetic/config.toml' },
    }),
    0
  );
  assert.equal(tree(f.root), before);
  assert.match(f.output(), /No Codex settings source guessed/);
});
for (const kind of ['symlink', 'directory', 'fifo', 'oversized', 'unreadable', 'invalid'] as const)
  test(`import refuses ${kind} sources without writes or value output`, async (t) => {
    const f = fixture(t),
      source = join(f.root, 'source.env');
    if (kind === 'symlink') {
      fs.writeFileSync(join(f.root, 'real.env'), 'OPENAI_API_KEY=secret-source-value');
      fs.symlinkSync(join(f.root, 'real.env'), source);
    }
    if (kind === 'directory') fs.mkdirSync(source);
    if (kind === 'fifo') {
      const { spawnSync } = await import('node:child_process');
      assert.equal(spawnSync('mkfifo', [source]).status, 0);
    }
    if (kind === 'oversized') fs.writeFileSync(source, 'x'.repeat(65537));
    if (kind === 'unreadable') fs.writeFileSync(source, 'OPENAI_API_KEY=secret-source-value', { mode: 0 });
    if (kind === 'invalid') fs.writeFileSync(join(f.root, 'source.toml'), 'secret-source-value INVALID TOML');
    assert.equal(
      await main(['import', 'apply', '--from', kind === 'invalid' ? join(f.root, 'source.toml') : source], f.io),
      1
    );
    assert.match(f.output(), /import_refused/);
    assert.ok(!f.output().includes('secret-source-value'));
    assert.deepEqual(fs.readdirSync(f.hud), []);
  });
test('unsafe existing credential destination is never replaced; explicit .env merges through the same importer', async (t) => {
  const f = fixture(t),
    source = join(f.root, 'source.env'),
    dest = join(f.hud, 'credentials.env');
  fs.writeFileSync(source, 'OPENAI_API_KEY=synthetic-import\n');
  fs.writeFileSync(dest, 'MISTRAL_API_KEY=synthetic-existing\n', { mode: 0o644 });
  assert.equal(await main(['import', 'apply', '--from', source], f.io), 1);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'MISTRAL_API_KEY=synthetic-existing\n');
  fs.chmodSync(dest, 0o600);
  assert.equal(await main(['import', 'apply', '--from', source], f.io), 0);
  assert.equal(readCredentialsEnv(dest).openaiApiKey, 'synthetic-import');
});

for (const spelling of ['snake', 'both'] as const)
  test(`import preserves effective existing Studio ${spelling} values and operation records`, async (t) => {
    const f = fixture(t);
    const existing = join(f.root, 'existing-state'),
      incoming = join(f.root, 'incoming-state');
    fs.mkdirSync(existing);
    fs.mkdirSync(incoming);
    fs.writeFileSync(join(existing, 'aistudio_chat_state.json'), '{"keys":{"sent-once":{"attempted_at":"synthetic"}}}');
    const file = join(f.hud, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        aistudio: {
          state_dir: existing,
          default_model: 'gemini-existing',
          default_thinking: 'Low',
          cdp_url: 'http://127.0.0.1:9333',
          models: ['gemini-existing', 'gemini-imported'],
          ...(spelling === 'both'
            ? { stateDir: existing, model: 'gemini-existing', thinking: 'Medium', cdpUrl: 'http://127.0.0.1:9555' }
            : {}),
        },
      })
    );
    const source = join(f.root, 'studio.toml');
    fs.writeFileSync(
      source,
      `[aistudio]\nstate_dir="${incoming}"\ndefault_model="gemini-imported"\ndefault_thinking="High"\ncdp_url="http://127.0.0.1:9444"\nmodels=["gemini-imported"]\n`
    );
    const options = { configJsonPath: file, home: f.home, capturedEnv: f.io.env };
    const resolved = loadStudioConfig(options),
      before = tree(f.root);
    for (const mode of ['preview', 'apply', 'apply']) {
      f.reset();
      assert.equal(await main(['import', mode, '--from', source], f.io), 0, f.output());
      for (const name of ['stateDir', 'model', 'thinking', 'cdpUrl'])
        assert.ok(f.output().includes(`skip existing: aistudio.${name}`), name);
      assert.deepEqual(
        loadStudioConfig(options),
        resolved,
        'aliases cannot change the effective runtime state/model/endpoint'
      );
      assert.equal(tree(f.root), before, 'no canonical override, backup, or operation-record change');
    }
  });

for (const kind of [
  'aggregate-existing-env',
  'aggregate-multiple-env',
  'settings-json-expansion',
  'toml-json-expansion',
] as const)
  test(`import refuses ${kind} before any staged destination is published`, async (t) => {
    const f = fixture(t);
    const credentials = join(f.hud, 'credentials.env');
    fs.writeFileSync(credentials, 'MISTRAL_API_KEY=synthetic-existing-mistral\n', { mode: 0o600 });
    const validEnv = join(f.root, 'valid.env'),
      validSettings = join(f.root, 'valid-settings.json');
    fs.writeFileSync(validEnv, 'OPENAI_API_KEY=synthetic-new-openai\n');
    fs.writeFileSync(validSettings, '{"language":"zh"}');
    const sources = [validEnv, validSettings];
    if (kind === 'aggregate-existing-env' || kind === 'aggregate-multiple-env') {
      const first = `TEXT_MODEL_EXISTING=${'a'.repeat(40000)}\n`;
      if (kind === 'aggregate-existing-env') fs.appendFileSync(credentials, first);
      else {
        const source = join(f.root, 'first.env');
        fs.writeFileSync(source, first);
        sources.push(source);
      }
      const source = join(f.root, 'second.env');
      fs.writeFileSync(source, `TEXT_MODEL_NEW=${'b'.repeat(40000)}\n`);
      sources.push(source);
    } else if (kind === 'settings-json-expansion') {
      const existing = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 0]));
      assert.ok(Buffer.byteLength(JSON.stringify(existing)) < 65536);
      assert.ok(
        Buffer.byteLength(JSON.stringify(existing, null, 2)) > 65536,
        'valid compact JSON expands beyond the reader limit'
      );
      fs.writeFileSync(join(f.hud, 'hud-settings.json'), JSON.stringify(existing));
    } else {
      const source = join(f.root, 'expanded.toml');
      const text = `[jev]\nuser_agent='${'\t'.repeat(40000)}'\n`;
      const { parse } = await import('@iarna/toml');
      assert.equal(
        (parse(text).jev as { user_agent: string }).user_agent.length,
        40000,
        'valid TOML, not a parser-error refusal'
      );
      assert.ok(Buffer.byteLength(text) < 65536);
      fs.writeFileSync(source, text);
      sources.push(source);
    }
    for (const source of sources) assert.ok(fs.statSync(source).size < 65536);
    const before = tree(f.root);
    for (const mode of ['preview', 'apply', 'apply']) {
      f.reset();
      assert.equal(
        await main(['import', mode, ...sources.flatMap((source) => ['--from', source])], f.io),
        1,
        f.output()
      );
      assert.match(f.output(), /import_refused/);
      assert.equal(
        tree(f.root),
        before,
        'all destinations and backups remain untouched, including earlier valid plans'
      );
      assert.equal(readCredentialsEnv(credentials).mistralApiKey, 'synthetic-existing-mistral');
      assert.ok(!f.output().includes('synthetic-existing-mistral'));
      assert.ok(!f.output().includes('synthetic-new-openai'));
    }
  });

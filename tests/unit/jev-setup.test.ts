// Explicit import CLI, synthetic files only. Values must never reach either output stream.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { readCredentialsEnv } from '../../src/jev/ask/config.js';
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
test('preview is byte/tree read-only; apply imports settings and env existing-wins with backups and idempotence', async (t) => {
  const f = fixture(t),
    settings = join(f.root, 'hud-settings.json'),
    toml = join(f.root, 'source.toml');
  const secrets = ['unique-env-secret-517', 'unique-old-settings-secret-518'];
  fs.writeFileSync(
    settings,
    JSON.stringify({ theme: 'mocha', language: 'en', briefingApiKey: secrets[1], briefingApiReasoning: true })
  );
  fs.writeFileSync(join(f.hud, 'hud-settings.json'), JSON.stringify({ theme: 'latte' }));
  fs.writeFileSync(
    join(f.hud, 'jev.env'),
    `OPENAI_API_KEY=${secrets[0]}\nGEMINI_API_KEY=unique-gemini-525\nTYPESAFE_API_KEY=unique-typesafe-520\nMISTRAL_API_KEY=unique-mistral-521\nTEXT_MODEL_FOO=literal-522\nOTHER_SECRET=hidden-523\n`
  );
  fs.writeFileSync(
    join(f.hud, 'credentials.env'),
    'OPENAI_API_KEY=existing-wins-524\nCUSTOM=" literal ${UNEXPANDED} "\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(
    toml,
    `[jev]\ncdp_url="http://127.0.0.1:9333"\nchrome="/synthetic/chrome"\nprofile="/synthetic/profile"\nstate_dir="/synthetic/state"\nuser_agent="unique-toml-value-519"\nprovider_root="https://example.invalid/"\ngemini_root="https://gemini.invalid/"\nmodel="Synthetic"\neffort_word="Pro"\ngemini_effort_label="High"\n[aistudio]\nstate_dir="/synthetic/studio"\ncdp_url="http://127.0.0.1:9444"\nmodels=["gemini-test"]\ndefault_model="gemini-test"\ndefault_thinking="High"\n`
  );
  fs.writeFileSync(
    join(f.hud, 'config.json'),
    JSON.stringify({ jev: { profile: '/existing/profile' }, decisions: { primary: 'openai' } })
  );
  const args = ['--from', settings];
  const before = tree(f.root);
  // Old jev-ask TOML is no longer an import source: refused, nothing written, no value echoed.
  assert.equal(await main(['import', 'apply', ...args, '--from', toml], f.io), 1);
  assert.equal(tree(f.root), before);
  assert.ok(!f.output().includes('unique-toml-value-519'));
  f.reset();
  assert.equal(await main(['import', 'preview', ...args], f.io), 0, f.output());
  assert.equal(tree(f.root), before);
  for (const secret of [
    ...secrets,
    'unique-gemini-525',
    'unique-typesafe-520',
    'unique-mistral-521',
    'literal-522',
    'hidden-523',
    'existing-wins-524',
  ])
    assert.ok(!f.output().includes(secret), 'preview leaked a value');
  for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'skip existing: theme'])
    assert.ok(f.output().includes(name), name);
  f.reset();
  assert.equal(await main(['import', 'apply', ...args], f.io), 0, f.output());
  for (const secret of secrets) assert.ok(!f.output().includes(secret), 'apply leaked a value');
  const saved = JSON.parse(fs.readFileSync(join(f.hud, 'hud-settings.json'), 'utf8'));
  assert.deepEqual(saved, { theme: 'latte', language: 'en' });
  const creds = readCredentialsEnv(join(f.hud, 'credentials.env'));
  assert.equal(creds.openaiApiKey, 'existing-wins-524');
  assert.equal(creds.geminiApiKey, 'unique-gemini-525');
  assert.equal(creds.typesafeApiKey, 'unique-typesafe-520');
  assert.equal(creds.mistralApiKey, 'unique-mistral-521');
  assert.equal(creds.textModel.TEXT_MODEL_FOO, 'literal-522');
  assert.match(fs.readFileSync(join(f.hud, 'credentials.env'), 'utf8'), /CUSTOM=" literal \$\{UNEXPANDED\} "/);
  const config = JSON.parse(fs.readFileSync(join(f.hud, 'config.json'), 'utf8'));
  assert.deepEqual(config, { jev: { profile: '/existing/profile' }, decisions: { primary: 'openai' } });
  const backups = fs.readdirSync(f.hud).filter((n) => n.includes('.bak.'));
  assert.equal(backups.length, 2);
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

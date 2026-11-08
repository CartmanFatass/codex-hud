// hud setup --import-jev-env. The source is synthetic. Values must not reach stdout.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';

const VALUE = 'synthetic-setup-value';

function home(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-setup-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('setup help does not read HUD_HOME', async () => {
  let stdout = '';
  let stderr = '';
  const code = await main(['setup', '--help'], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.equal(code, 0);
  assert.match(stdout, /import-jev-env/);
  assert.equal(stderr, '');
  assert.equal(stdout.includes(VALUE), false);
});

test('import copies known names from a synthetic file and is idempotent', async (t) => {
  const hudHome = home(t);
  const source = join(hudHome, 'source.env');
  writeFileSync(
    source,
    [
      `OPENAI_API_KEY=${VALUE}-openai`,
      'OPENAI_BASE_URL=https://synthetic.example/v1',
      `TYPESAFE_API_KEY=${VALUE}-typesafe`,
      'TYPESAFE_MODEL=synthetic-model',
      `TEXT_MODEL_API_KEY=${VALUE}-text`,
      'OTHER_SECRET=synthetic-other',
      'UNRELATED=skip',
    ].join('\n') + '\n',
    { mode: 0o644 }
  );
  assert.equal(statSync(source).mode & 0o777, 0o644);
  let stdout = '';
  let stderr = '';
  const io = {
    env: { HUD_HOME: hudHome },
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };
  const code = await main(['setup', '--import-jev-env', '--from', source], io);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  assert.match(stdout, /OPENAI_API_KEY/);
  assert.match(stdout, /TEXT_MODEL_API_KEY/);
  assert.equal(stdout.includes(VALUE), false);
  assert.equal(stdout.includes('synthetic-other'), false);
  assert.equal(stdout.includes('UNRELATED'), false);
  const file = join(hudHome, 'jev.env');
  const first = readFileSync(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = first.toString('utf8');
  assert.equal(text.includes(`${VALUE}-openai`), true);
  assert.equal(text.includes('OTHER_SECRET'), false);
  assert.equal(text.includes('UNRELATED'), false);
  stdout = '';
  const again = await main(['setup', '--import-jev-env', '--from', source], io);
  assert.equal(again, 0);
  assert.equal(readFileSync(file).equals(first), true);

  const link = join(hudHome, 'source.link');
  symlinkSync(source, link);
  stdout = '';
  stderr = '';
  const refused = await main(['setup', '--import-jev-env', '--from', link], io);
  assert.equal(refused, 1);
  assert.equal(stderr, 'jev_env_perms\n');
  assert.equal(stdout.includes(VALUE), false);
});

test('an import with no known names leaves the existing jev.env untouched', async (t) => {
  const hudHome = home(t);
  const file = join(hudHome, 'jev.env');
  const body = 'OPENAI_API_KEY=synthetic-kept\n';
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  const source = join(hudHome, 'source.env');
  writeFileSync(source, 'UNRELATED=synthetic-skip\nOTHER=nope\n', { mode: 0o644 });
  let stdout = '';
  let stderr = '';
  const code = await main(['setup', '--import-jev-env', '--from', source], {
    env: { HUD_HOME: hudHome },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.equal(code, 1);
  assert.equal(stderr, 'jev_env_empty\n');
  assert.equal(stdout, '');
  assert.equal(readFileSync(file, 'utf8'), body);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

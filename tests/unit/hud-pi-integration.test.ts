import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../../src/cli/hud.js';
import { PI_HELP } from '../../src/cli/pi.js';
import { PANEL_HELP } from '../../src/cli/panel.js';
import { CLAUDE_HELP } from '../../src/cli/launcher.js';
import { RUN_HELP } from '../../src/cli/run.js';
import { CACHE_HELP } from '../../src/cli/cache.js';
import { EXPORT_HELP } from '../../src/cli/link-export.js';

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      // Help and explicit pi sources must not require a valid private home.
      env: { HUD_HOME: 'relative-not-a-home' },
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hud-pi-dispatch-'));
  const file = join(root, 'synthetic.jsonl');
  const header =
    JSON.stringify({
      type: 'session',
      id: 'synthetic-dispatch',
      version: 3,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/synthetic/project',
    }) + '\n';
  writeFileSync(file, header);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file, header, args: ['pi', 'inspect', '--source', root, '--session', file, '--json'] };
}

test('hud dispatches pi help and preserves existing command help without HUD_HOME', async () => {
  for (const [args, expected] of [
    [['pi', '--help'], PI_HELP],
    [['pi', 'inspect', '--help'], PI_HELP],
    [['panel', '--help'], PANEL_HELP],
    [['claude', '--help'], CLAUDE_HELP],
    [['run', '--help'], RUN_HELP],
    [['cache', '--help'], CACHE_HELP],
    [
      ['link', 'export', '--help'],
      EXPORT_HELP + '\n  hud uninstall [--with names]  Remove commands and extensions; keep HUD data.\n',
    ],
    [['--help'], EXPORT_HELP + '\n  hud uninstall [--with names]  Remove commands and extensions; keep HUD data.\n'],
  ] as const) {
    const capture = output();
    assert.equal(await main(args, capture.io), 0);
    assert.deepEqual(capture.read(), { stdout: expected, stderr: '' });
  }
  assert.match(EXPORT_HELP, /hud pi --help/);
  assert.match(EXPORT_HELP, /hud panel \[--help\]/);
});

test('hud pi inspect routes complete and partial JSON observations without writes', async (t) => {
  const f = fixture(t);
  for (const [tail, expectedCode] of [
    ['', 0],
    ['{"type":', 6],
  ] as const) {
    writeFileSync(f.file, f.header + tail);
    const before = readFileSync(f.file);
    const capture = output();
    assert.equal(await main(f.args, capture.io), expectedCode);
    assert.equal(capture.read().stderr, '');
    const result = JSON.parse(capture.read().stdout);
    assert.equal(result.format, 'hud.pi.inspect');
    assert.equal(result.ref.sessionId, 'synthetic-dispatch');
    assert.equal(result.incomplete, expectedCode === 6);
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(readdirSync(f.root), ['synthetic.jsonl']);
  }
});

test('hud pi errors preserve reason codes and keep stdout empty', async (t) => {
  const f = fixture(t);
  for (const [args, code, reason] of [
    [['pi', 'unknown-command'], 2, 'invalid_pi_command'],
    [['pi', 'inspect'], 2, 'invalid_arguments'],
    [['pi', 'inspect', '--source', join(f.root, 'missing'), '--session', f.file], 4, 'invalid_pi_source'],
    [['pi', 'inspect', '--source', f.root, '--session', join(f.root, 'missing')], 4, 'pi_transcript_unavailable'],
    [['panel', 'unexpected'], 2, 'invalid_arguments'],
  ] as const) {
    const capture = output();
    assert.equal(await main(args, capture.io), code);
    assert.deepEqual(capture.read(), { stdout: '', stderr: `${reason}\n` });
  }
});

test('hud reports a pi output failure once through its shared error boundary', async (t) => {
  const f = fixture(t);
  const capture = output();
  let writes = 0;
  assert.equal(
    await main(f.args, {
      ...capture.io,
      stdout: () => {
        writes++;
        throw new Error('synthetic_output_failure');
      },
    }),
    1
  );
  assert.equal(writes, 1);
  assert.deepEqual(capture.read(), { stdout: '', stderr: 'internal_or_output_failure\n' });
});

test('built bin/hud exposes pi help and inspection alongside panel help', (t) => {
  const f = fixture(t);
  for (const args of [['pi', 'inspect', '--help'], ['panel', '--help'], f.args]) {
    const result = spawnSync(process.execPath, [resolve('bin/hud'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.root, HUD_HOME: 'relative-not-a-home' },
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    if (args === f.args) assert.equal(JSON.parse(result.stdout).format, 'hud.pi.inspect');
    else assert.equal(result.stdout, args[0] === 'pi' ? PI_HELP : PANEL_HELP);
  }
});

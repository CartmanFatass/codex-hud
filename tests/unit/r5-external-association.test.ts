import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, readFileSync, symlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/hud.js';
import { spawn } from 'node:child_process';
import { REPO_ROOT } from '../fixtures/paths.js';
import {
  externalAssociationPath,
  registerExternal,
  removeExternal,
  EXTERNAL_MAX_BYTES,
} from '../../src/roles/external-association.js';

test('R5 external registration CLI is private, explicit, idempotent and never calls Herdr', async () => {
  const home = mkdtempSync(join(tmpdir(), 'r5-external-'));
  const output: string[] = [];
  const io = {
    env: { HUD_HOME: home, HOME: home, PATH: '' },
    stdout: (v: string) => {
      output.push(v);
    },
    stderr: (v: string) => {
      output.push(v);
    },
  };
  const args = [
    'observe-herdr',
    '--root',
    'synthetic/main',
    '--id',
    'build',
    '--agent',
    'agent-a',
    '--pane',
    'pane-a',
    '--tab',
    'tab-a',
    '--label',
    'Synthetic build',
  ];
  try {
    assert.equal(await main(args, io), 0);
    const file = externalAssociationPath(home, 'synthetic/main', 'build');
    const original = readFileSync(file, 'utf8');
    assert.equal(await main(args, io), 0);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, 'assoc-external')).mode & 0o777, 0o700);
    assert.ok(Buffer.byteLength(original) <= EXTERNAL_MAX_BYTES);
    assert.equal(
      await main(
        args.map((v) => (v === 'pane-a' ? 'pane-b' : v)),
        io
      ),
      2
    );
    assert.equal(readFileSync(file, 'utf8'), original);
    for (const bad of [
      args.filter((_, i) => i !== 1 && i !== 2),
      args.map((v) => (v === 'synthetic/main' ? '../main' : v)),
      args.map((v) => (v === 'build' ? '../build' : v)),
    ])
      assert.equal(await main(bad, io), 2);
    assert.equal(await main(['observe-herdr', '--root', 'synthetic/main', '--id', 'build', '--remove'], io), 0);
    assert.throws(() => statSync(file), { code: 'ENOENT' });
    removeExternal(home, 'synthetic/main', 'build');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('R5 concurrent conflicting CLI registrations publish exactly one target without temp leftovers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'r5-external-concurrent-'));
  const run = (pane: string) =>
    new Promise<{ code: number | null; error: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(REPO_ROOT, 'bin', 'hud'),
          'observe-herdr',
          '--root',
          'synthetic/main',
          '--id',
          'concurrent',
          '--agent',
          'synthetic-agent',
          '--pane',
          pane,
          '--tab',
          'tab',
          '--label',
          'Synthetic concurrent',
        ],
        { env: { HOME: home, HUD_HOME: home, PATH: '' }, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let error = '';
      child.stderr.on('data', (data) => {
        error += String(data);
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, error }));
    });
  try {
    const results = await Promise.all([run('pane-a'), run('pane-b')]);
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 2]);
    assert.equal(results.find((r) => r.code === 2)!.error, 'registration_conflict\n');
    const file = externalAssociationPath(home, 'synthetic/main', 'concurrent');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(stored.pane, results[0]!.code === 0 ? 'pane-a' : 'pane-b');
    assert.deepEqual(readdirSync(join(file, '..')), ['concurrent.json']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('R5 external storage refuses symlinked ancestors and oversized registration', () => {
  const home = mkdtempSync(join(tmpdir(), 'r5-external-link-'));
  const input = {
    root: 'synthetic/main',
    id: 'one',
    agent: 'a',
    pane: 'p',
    tab: 't',
    workspace: null,
    label: 'Synthetic',
  };
  try {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(home, 'assoc-external'));
    assert.throws(() => registerExternal(home, input), /unsafe_path/);
    assert.throws(
      () => registerExternal(home, { ...input, label: 'x'.repeat(5000) }),
      /invalid_registration|registration_too_large/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

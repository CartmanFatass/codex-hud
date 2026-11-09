import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILD_STEPS, runtime } from '../../scripts/check-cloud.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('cloud preview self-test follows real cloud builds in a checkout with no emitted outputs', (t) => {
  try {
    runtime();
  } catch (error) {
    t.skip(error.message);
    return;
  }
  const workflow = readFileSync(join(ROOT, '.github/workflows/cloud-development.yml'), 'utf8');
  const builds = workflow.indexOf('run: node scripts/check-cloud.mjs\n');
  const inventory = workflow.indexOf('run: node scripts/pack-cloud-preview.mjs --self-test\n');
  const archive = workflow.indexOf('run: node scripts/pack-cloud-preview.mjs\n');
  assert.ok(builds >= 0 && inventory > builds && archive > inventory, 'CI must build before checking real outputs');
  const instructions = readFileSync(join(ROOT, 'docs/cloud-development/checks-and-preview.md'), 'utf8');
  const documentedBuild = instructions.indexOf('node scripts/check-cloud.mjs\n');
  const documentedCheck = instructions.indexOf('node scripts/pack-cloud-preview.mjs --self-test\n');
  assert.ok(documentedBuild >= 0 && documentedCheck > documentedBuild, 'documented clean-checkout order must match CI');

  const root = mkdtempSync(join(tmpdir(), 'hud-cloud-clean-build-'));
  try {
    // Source-only snapshot, not another git worktree or a copy of stale dist/.
    for (const source of [
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'src',
      'scripts',
      'tests',
      'packages/hud-mcp/package.json',
      'packages/hud-mcp/tsconfig.json',
      'packages/hud-mcp/src',
    ])
      cpSync(join(ROOT, source), join(root, source), { recursive: true });
    // Read existing compiler/library dependencies; never install or mutate them.
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    const home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const env = { HOME: home, HUD_HOME: join(home, '.hud'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const run = (args, timeout = 180000) => {
      const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout });
      assert.ifError(result.error);
      return result;
    };
    assert.equal(existsSync(join(root, 'dist')), false);
    assert.equal(existsSync(join(root, 'packages/hud-mcp/dist')), false);
    const prebuild = run(['scripts/pack-cloud-preview.mjs', '--self-test']);
    assert.equal(prebuild.status, 1);
    assert.match(prebuild.stderr, /ENOENT.*dist\/cli\/statusline\.js/);
    for (const step of BUILD_STEPS) {
      const result = run(step.args, step.timeoutMs);
      assert.equal(result.status, 0, `${step.name}: ${result.stdout}\n${result.stderr}`);
    }
    const checked = run(['scripts/pack-cloud-preview.mjs', '--self-test']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /PASS: tracked-source mapping/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Codex extension registers the roles MCP and skill, reruns, and uninstalls', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-codex-'));
  try {
    const repo = path.join(temp, 'checkout with spaces');
    const home = path.join(temp, 'home');
    const codexHome = path.join(temp, 'codex home');
    const fakeBin = path.join(temp, 'fake-bin');
    const log = path.join(temp, 'codex-argv.jsonl');
    const target = path.join(repo, 'integrations/skills/hud-delegate');
    const skill = path.join(codexHome, 'skills/hud-delegate');
    fs.mkdirSync(path.join(repo, 'install.d'), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(fakeBin);
    fs.copyFileSync(path.join(root, 'install'), path.join(repo, 'install'));
    fs.copyFileSync(path.join(root, 'install.d/codex.sh'), path.join(repo, 'install.d/codex.sh'));
    fs.writeFileSync(
      path.join(fakeBin, 'codex'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CODEX_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[3] === 'remove') {
  console.error('MCP server hud not found');
  process.exitCode = 1;
}
`,
      { mode: 0o755 }
    );
    const env = {
      ...process.env,
      HOME: home,
      HUD_HOME: path.join(temp, 'hud-home'),
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: path.join(temp, 'claude-config'),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      CODEX_ARGV_LOG: log,
    };
    const run = (...args) => {
      const result = spawnSync('./install', args, { cwd: repo, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    };
    const add = ['mcp', 'add', 'hud', '--env', 'HUD_MCP_SURFACE=roles', '--', path.join(home, '.local/bin/hud-mcp')];
    const remove = ['mcp', 'remove', 'hud'];
    const prompt = path.join(codexHome, 'prompts/hud.md');
    const promptLine = 'Run `hud panel` with Bash and report the pane id it prints.\n';
    for (let i = 0; i < 2; i++) {
      run('--skip-build', '--with', 'codex');
      assert.equal(fs.readlinkSync(skill), target);
      assert.equal(fs.readFileSync(prompt, 'utf8'), promptLine);
    }
    run('--uninstall', '--with', 'codex');
    assert.throws(() => fs.lstatSync(skill), { code: 'ENOENT' });
    assert.throws(() => fs.lstatSync(prompt), { code: 'ENOENT' });
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [
      remove,
      add,
      remove,
      add,
      remove,
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Codex registers roles, backs up config before rewrites, warns on comment loss, and uninstalls', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-codex-'));
  try {
    const repo = path.join(temp, 'checkout with spaces');
    const home = path.join(temp, 'home');
    const codexHome = path.join(temp, 'codex home');
    const fakeBin = path.join(temp, 'fake-bin');
    const log = path.join(temp, 'codex-argv.jsonl');
    const target = path.join(repo, 'integrations/skills/hud-delegate');
    const setupTarget = path.join(repo, 'integrations/skills/hud-setup');
    const skill = path.join(codexHome, 'skills/hud-delegate');
    const setupSkill = path.join(codexHome, 'skills/hud-setup');
    fs.mkdirSync(path.join(repo, 'install.d'), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(setupTarget, { recursive: true });
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(codexHome);
    const config = path.join(codexHome, 'config.toml');
    const configTarget = path.join(temp, 'dotfiles-config.toml');
    const backup = configTarget + '.hud-backup';
    const original = '# Owner comment\n  # Indented comment\nmodel = "synthetic"\n';
    fs.writeFileSync(configTarget, original);
    fs.symlinkSync(configTarget, config);
    fs.copyFileSync(path.join(root, 'install'), path.join(repo, 'install'));
    fs.copyFileSync(path.join(root, 'install.d/codex.sh'), path.join(repo, 'install.d/codex.sh'));
    fs.writeFileSync(
      path.join(fakeBin, 'codex'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CODEX_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const config = require('node:path').join(process.env.CODEX_HOME, 'config.toml');
if (!fs.existsSync(fs.realpathSync(config) + '.hud-backup')) throw Error('backup must precede MCP edits');
fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/^\\s*#.*\\n/gm, ''));
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
      PI_CODING_AGENT_DIR: path.join(temp, 'pi-agent'),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      CODEX_ARGV_LOG: log,
    };
    const run = (...args) => {
      const result = spawnSync('./install', args, { cwd: repo, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stdout, /claudeH|piH/);
      return result;
    };
    const add = ['mcp', 'add', 'hud', '--env', 'HUD_MCP_SURFACE=roles', '--', path.join(home, '.local/bin/hud-mcp')];
    const remove = ['mcp', 'remove', 'hud'];
    const prompt = path.join(codexHome, 'prompts/hud.md');
    const promptLine = 'Run `hud panel` with Bash and report the pane id it prints.\n';
    for (const content of [null, promptLine, 'Owner prompt.\n']) {
      if (content !== null) {
        fs.mkdirSync(path.dirname(prompt), { recursive: true });
        fs.writeFileSync(prompt, content);
      }
      const result = run('--skip-build', '--with', 'codex');
      assert.ok(result.stdout.includes('codexH() { hud codex "$@"; }'));
      assert.equal((result.stderr.match(/Warning: Codex/g) ?? []).length, content === null ? 1 : 0);
      if (content === null) assert.ok(result.stderr.includes(backup));
      assert.equal(fs.readFileSync(backup, 'utf8'), original);
      assert.equal(fs.readFileSync(config, 'utf8'), 'model = "synthetic"\n');
      assert.equal(fs.readlinkSync(skill), target);
      assert.equal(fs.readlinkSync(setupSkill), setupTarget);
      if (content === 'Owner prompt.\n') assert.equal(fs.readFileSync(prompt, 'utf8'), content);
      else assert.equal(fs.existsSync(prompt), false);
    }
    fs.appendFileSync(config, '# Later owner comment\n');
    const removed = run('--uninstall', '--with', 'codex');
    assert.equal((removed.stderr.match(/Warning: Codex/g) ?? []).length, 1);
    assert.ok(removed.stderr.includes(backup));
    assert.equal(fs.readFileSync(backup, 'utf8'), original);
    assert.throws(() => fs.lstatSync(skill), { code: 'ENOENT' });
    assert.throws(() => fs.lstatSync(setupSkill), { code: 'ENOENT' });
    assert.equal(fs.readFileSync(prompt, 'utf8'), 'Owner prompt.\n');
    fs.writeFileSync(prompt, promptLine);
    run('--uninstall', '--with', 'codex');
    assert.throws(() => fs.lstatSync(prompt), { code: 'ENOENT' });
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [
      ...Array(3).fill([remove, add]).flat(),
      remove,
      remove,
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

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
    const skills = ['hud', 'hud-delegate', 'hud-setup', 'hud-handoff', 'to-tickets'];
    const skillPaths = skills.map((name) => [path.join(repo, 'integrations/skills', name), path.join(codexHome, 'skills', name)]);
    fs.mkdirSync(path.join(repo, 'install.d'), { recursive: true });
    for (const [target] of skillPaths) fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(codexHome);
    const config = path.join(codexHome, 'config.toml');
    const configTarget = path.join(temp, 'dotfiles-config.toml');
    const backup = configTarget + '.hud-backup';
    const unrelated = 'model = "synthetic"\n[mcp_servers.other]\ncommand = "other"\nenv_vars = ["HERDR_PANE_ID"]\n';
    const oldEnv = ['HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID'];
    const hudEntry = '[mcp_servers.hud]\ncommand = "synthetic-hud-mcp"\n';
    const original = '# Owner comment\n  # Indented comment\n' + unrelated + hudEntry + `env_vars = ${JSON.stringify(oldEnv)}\n`;
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
const sections = fs.readFileSync(config, 'utf8').replace(/^\\s*#.*\\n/gm, '').split(/(?=^\\[)/m);
if (process.argv[3] === 'remove') {
  const hud = sections.findIndex((part) => part.startsWith('[mcp_servers.hud]\\n'));
  if (hud >= 0) sections.splice(hud, 1);
  else {
    console.error('MCP server hud not found');
    process.exitCode = 1;
  }
} else {
  sections.push(${JSON.stringify(hudEntry)});
}
fs.writeFileSync(config, sections.join(''));
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
      assert.equal(fs.readlinkSync(config), configTarget);
      const envVars = `env_vars = [${[...oldEnv, 'HUD_JOB_DIR'].map((name) => JSON.stringify(name)).join(', ')}]\n`;
      assert.equal(fs.readFileSync(config, 'utf8'), unrelated + hudEntry.replace('\n', '\n' + envVars));
      for (const [target, link] of skillPaths) assert.equal(fs.readlinkSync(link), target);
      if (content === 'Owner prompt.\n') assert.equal(fs.readFileSync(prompt, 'utf8'), content);
      else assert.equal(fs.existsSync(prompt), false);
    }
    fs.appendFileSync(config, '# Later owner comment\n');
    const removed = run('--uninstall', '--with', 'codex');
    assert.equal((removed.stderr.match(/Warning: Codex/g) ?? []).length, 1);
    assert.ok(removed.stderr.includes(backup));
    assert.equal(fs.readFileSync(backup, 'utf8'), original);
    assert.equal(fs.readFileSync(config, 'utf8'), unrelated);
    for (const [, link] of skillPaths) assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
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

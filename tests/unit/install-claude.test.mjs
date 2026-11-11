import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commandLine = 'Run `hud panel` with Bash and report the pane id it prints.\n';

test('Claude install opts the statusline out of settings.json, writes claude.json, and reverses only its changes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-claude-'));
  try {
    const home = path.join(temp, 'home');
    const config = path.join(temp, 'claude-config');
    const hudHome = path.join(temp, 'hud-home');
    const bin = path.join(home, '.local/bin');
    const fakeBin = path.join(temp, 'fake-bin');
    const log = path.join(temp, 'claude-argv.jsonl');
    const settings = path.join(config, 'settings.json');
    const backup = settings + '.hud-backup';
    const pluginConfig = path.join(config, 'plugins/claude-hud/config.json');
    fs.mkdirSync(path.dirname(pluginConfig), { recursive: true });
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, 'claude'),
      `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CLAUDE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(process.argv[3] === 'remove' ? 1 : 0);
`,
      { mode: 0o700 }
    );
    const original = {
      statusLine: {
        type: 'command',
        command: fs.readFileSync(path.join(root, 'tests/fixtures/claude-hud-parity/wrapper.txt'), 'utf8').trim(),
      },
      unrelated: { keep: true },
    };
    const originalBytes = JSON.stringify(original, null, 2) + '\n';
    fs.writeFileSync(settings, originalBytes);
    fs.writeFileSync(pluginConfig, JSON.stringify({ showSeparators: true, display: { showAgents: true } }));
    const env = {
      ...process.env,
      HOME: home,
      HUD_HOME: hudHome,
      CODEX_HOME: path.join(temp, 'codex-home'),
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_ARGV_LOG: log,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    const run = (...args) => {
      const result = spawnSync('./install', [...args, '--with', 'claude'], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    };
    const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    run('--skip-build');
    // An owner's own statusLine is kept; the HUD statusline lives only in claude.json.
    assert.deepEqual(json(settings), original, 'the owner statusLine stays; no HUD statusLine is written');
    assert.equal(fs.readFileSync(backup, 'utf8'), originalBytes);
    assert.deepEqual(json(path.join(hudHome, 'claude.json')), {
      statusLine: { type: 'command', command: path.join(bin, 'hud-statusline'), refreshInterval: 5 },
    });
    assert.deepEqual(calls(), [
      ['mcp', 'remove', '-s', 'user', 'hud'],
      ['mcp', 'add', '-s', 'user', 'hud', '-e', 'HUD_MCP_SURFACE=roles', '--', path.join(bin, 'hud-mcp')],
    ]);
    const skill = path.join(config, 'skills/hud-delegate');
    assert.equal(fs.readlinkSync(skill), path.join(root, 'integrations/skills/hud-delegate'));
    assert.equal(fs.readlinkSync(path.join(bin, 'hud-statusline')), path.join(root, 'bin/hud-statusline'));
    assert.equal(fs.readFileSync(path.join(config, 'commands/hud.md'), 'utf8'), commandLine);
    const imported = json(path.join(hudHome, 'config.json')).statusline;
    assert.equal(imported.showSeparators, true);
    assert.equal(imported.display.showAgents, true);
    assert.equal(imported.widthMargin, 4);
    assert.deepEqual(imported.forward, [path.join(home, '.cargo/bin/toktrack'), 'quota', 'record-claude']);

    // An earlier install's HUD statusLine in settings.json is removed; the backup is kept.
    const earlier = {
      statusLine: { type: 'command', command: '/synthetic/earlier/bin/hud-statusline', refreshInterval: 5 },
      unrelated: { changed: true },
      added: 42,
    };
    fs.writeFileSync(settings, JSON.stringify(earlier, null, 2) + '\n');
    run('--skip-build');
    assert.deepEqual(
      json(settings),
      { unrelated: { changed: true }, added: 42 },
      'the earlier HUD statusLine is removed'
    );
    assert.equal(fs.readFileSync(backup, 'utf8'), originalBytes, 'reinstall keeps the original backup');

    // Uninstall removes its own files, never restores statusLine, and never loses the
    // owner statusLine that only the backup still holds.
    run('--uninstall');
    assert.deepEqual(json(settings), { unrelated: { changed: true }, added: 42 });
    assert.equal(fs.existsSync(backup), true, 'the backup holding the owner statusLine is kept');
    assert.deepEqual(calls().at(-1), ['mcp', 'remove', '-s', 'user', 'hud']);
    for (const file of [
      skill,
      path.join(bin, 'hud-statusline'),
      path.join(config, 'commands/hud.md'),
      path.join(hudHome, 'claude.json'),
    ]) {
      assert.throws(() => fs.lstatSync(file), { code: 'ENOENT' });
    }
    assert.equal(fs.existsSync(pluginConfig), true, 'claude-hud stays installed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

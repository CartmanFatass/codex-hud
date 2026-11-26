import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commandLine = 'Run `hud panel` once with Bash to toggle the HUD dock. Report whether it opened or closed, or report the error without retrying.\n';
const legacyCommandLine = 'Run `hud panel` with Bash and report the pane id it prints.\n';

test('Claude install maintains the global statusline and reverses only its changes', (t) => {
  const inheritedMask = process.umask(0o022);
  t.after(() => process.umask(inheritedMask));
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
    const target = path.join(temp, 'dotfiles-settings.json');
    fs.writeFileSync(target, originalBytes, { mode: 0o640 });
    fs.symlinkSync(target, settings);
    fs.writeFileSync(pluginConfig, JSON.stringify({ showSeparators: true, display: { showAgents: true } }));
    const env = {
      ...process.env,
      HOME: home,
      HUD_HOME: hudHome,
      CODEX_HOME: path.join(temp, 'codex-home'),
      CLAUDE_CONFIG_DIR: config,
      PI_CODING_AGENT_DIR: path.join(temp, 'pi-agent'),
      CLAUDE_ARGV_LOG: log,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    const run = (...args) => {
      const result = spawnSync('./install', [...args, '--with', 'claude'], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stdout, /claudeH|piH/);
      return result;
    };
    const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const retired = path.join(config, 'skills/to-tickets');
    fs.mkdirSync(path.dirname(retired));
    fs.symlinkSync(path.join(root, 'integrations/skills/to-tickets'), retired);
    run('--skip-build');
    assert.throws(() => fs.lstatSync(retired), { code: 'ENOENT' });
    // An owner's own statusLine is kept rather than replaced.
    assert.deepEqual(json(settings), original, 'the owner statusLine stays');
    assert.equal(fs.readFileSync(backup, 'utf8'), originalBytes);
    const hudLine = { type: 'command', command: path.join(bin, 'hud-statusline'), refreshInterval: 5 };
    const legacy = path.join(hudHome, 'claude.json');
    assert.equal(fs.existsSync(legacy), false);
    assert.deepEqual(calls(), [
      ['mcp', 'remove', '-s', 'user', 'hud'],
      ['mcp', 'add', '-s', 'user', 'hud', '-e', 'HUD_MCP_SURFACE=roles', '--', path.join(bin, 'hud-mcp')],
    ]);
    const skills = ['hud-delegate', 'hud-setup', 'hud-handoff'];
    for (const name of skills) {
      assert.equal(fs.readlinkSync(path.join(config, 'skills', name)), path.join(root, 'integrations/skills', name));
    }
    assert.equal(fs.readlinkSync(path.join(bin, 'hud-statusline')), path.join(root, 'bin/hud-statusline'));
    assert.equal(fs.readFileSync(path.join(config, 'commands/hud.md'), 'utf8'), commandLine);
    const imported = json(path.join(hudHome, 'config.json')).statusline;
    assert.equal(imported.showSeparators, true);
    assert.equal(imported.display.showAgents, true);
    assert.equal(imported.widthMargin, 4);
    assert.deepEqual(imported.forward, [path.join(home, '.cargo/bin/toktrack'), 'quota', 'record-claude']);

    // An earlier HUD entry is refreshed globally; the original backup is kept.
    const earlier = {
      statusLine: { type: 'command', command: '/synthetic/earlier/bin/hud-statusline', refreshInterval: 5 },
      unrelated: { changed: true },
      added: 42,
    };
    fs.writeFileSync(settings, JSON.stringify(earlier, null, 2) + '\n');
    const commandFile = path.join(config, 'commands/hud.md');
    fs.writeFileSync(commandFile, legacyCommandLine);
    fs.mkdirSync(retired);
    process.umask(0o077); // The installer must retain the existing mode, not its own creation mode.
    assert.match(run('--skip-build').stderr, /keeping existing skill not owned by HUD: .*to-tickets/);
    assert.ok(fs.statSync(retired).isDirectory());
    assert.deepEqual(
      json(settings),
      { statusLine: hudLine, unrelated: { changed: true }, added: 42 },
      'the global HUD statusLine is refreshed'
    );
    assert.equal(fs.readFileSync(backup, 'utf8'), originalBytes, 'reinstall keeps the original backup');
    assert.equal(fs.readFileSync(commandFile, 'utf8'), commandLine, 'reinstall upgrades only the known legacy command');

    fs.writeFileSync(legacy, JSON.stringify({ statusLine: hudLine }));
    assert.match(run('--uninstall').stderr, /keeping existing skill not owned by HUD: .*to-tickets/);
    assert.ok(fs.statSync(retired).isDirectory());
    assert.deepEqual(json(settings), { statusLine: original.statusLine, unrelated: { changed: true }, added: 42 });
    assert.equal(fs.existsSync(backup), false, 'the backed-up owner statusLine was restored');
    assert.equal(fs.readlinkSync(settings), target);
    assert.equal(fs.statSync(settings).mode & 0o777, 0o640);
    assert.deepEqual(calls().at(-1), ['mcp', 'remove', '-s', 'user', 'hud']);
    for (const file of [
      ...skills.map((name) => path.join(config, 'skills', name)),
      path.join(bin, 'hud-statusline'),
      path.join(config, 'commands/hud.md'),
      path.join(hudHome, 'claude.json'),
    ]) {
      assert.throws(() => fs.lstatSync(file), { code: 'ENOENT' });
    }
    assert.equal(fs.existsSync(pluginConfig), true, 'claude-hud stays installed');
    fs.renameSync(pluginConfig, pluginConfig + '.saved'); // Next scenario has no old plugin to import.
    fs.writeFileSync(settings, JSON.stringify({ unrelated: true }));
    fs.writeFileSync(commandFile, 'Synthetic owner command.\n');
    assert.match(run('--skip-build').stderr, /keeping existing command file/);
    assert.deepEqual(json(settings), { unrelated: true, statusLine: hudLine });
    fs.writeFileSync(legacy, JSON.stringify({ statusLine: { command: 'owner-command' } }));
    run('--uninstall');
    assert.deepEqual(json(settings), { unrelated: true });
    assert.deepEqual(json(legacy), { statusLine: { command: 'owner-command' } });
    assert.equal(fs.readFileSync(commandFile, 'utf8'), 'Synthetic owner command.\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

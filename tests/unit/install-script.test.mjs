import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Breaks if install removes the explicit "Command already exists" refusal, even if ln itself still fails safely.
test('core installer refuses an existing regular hud command without changing its content', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-existing-'));
  try {
    const repo = path.join(temp, 'checkout');
    const home = path.join(temp, 'home');
    const bin = path.join(home, '.local/bin');
    fs.mkdirSync(repo);
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(path.join(root, 'install'), path.join(repo, 'install'));
    const command = path.join(bin, 'hud');
    fs.writeFileSync(command, 'Synthetic owner command.\n');
    const result = spawnSync('./install', ['--skip-build'], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        HUD_HOME: path.join(home, '.hud'),
        CODEX_HOME: path.join(home, '.codex'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes(`Command already exists: ${command}`), result.stderr);
    assert.equal(fs.lstatSync(command).isFile(), true);
    assert.equal(fs.readFileSync(command, 'utf8'), 'Synthetic owner command.\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('core installer links commands, runs extension hooks, and uninstalls without deleting data', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-'));
  try {
    const repo = path.join(temp, 'checkout with spaces');
    const home = path.join(temp, 'home');
    const hudHome = path.join(home, '.hud');
    const bin = path.join(home, '.local/bin');
    fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'install.d'));
    fs.copyFileSync(path.join(root, 'install'), path.join(repo, 'install'));
    fs.copyFileSync(path.join(root, 'bin/hud'), path.join(repo, 'bin/hud'));
    const env = {
      ...process.env,
      HOME: home,
      HUD_HOME: hudHome,
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    };
    const run = (command, args, status = 0) => {
      const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8' });
      assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
      return result;
    };
    run('./install', ['--skip-build', '--with', 'missing'], 1);
    assert.equal(fs.existsSync(home), false, 'missing extension fails before any change');
    run('./install', ['--skip-build']);
    for (const [name, target] of [
      ['hud', 'bin/hud'],
      ['hud-mcp', 'packages/hud-mcp/bin/hud-mcp.mjs'],
    ]) {
      assert.equal(fs.readlinkSync(path.join(bin, name)), path.join(repo, target));
    }
    assert.equal(fs.statSync(hudHome).mode & 0o777, 0o700);
    fs.writeFileSync(path.join(hudHome, 'keep.txt'), 'owner data');
    fs.writeFileSync(
      path.join(repo, 'install.d/x.sh'),
      `hud_ext_install() { printf '%s\\n' "$REPO" "$HUD_HOME" "$BIN_DIR" > "$HUD_HOME/installed"; }
hud_ext_uninstall() { printf 'removed' > "$HUD_HOME/uninstalled"; }
`
    );
    run('./install', ['--skip-build', '--with', 'x']);
    run('./install', ['--skip-build', '--with', 'x']);
    assert.equal(fs.readFileSync(path.join(hudHome, 'installed'), 'utf8'), `${repo}\n${hudHome}\n${bin}\n`);
    const removed = run('./install', ['--uninstall', '--skip-build']);
    assert.match(removed.stdout, /data kept/);
    assert.equal(fs.readFileSync(path.join(hudHome, 'uninstalled'), 'utf8'), 'removed');
    for (const name of ['hud', 'hud-mcp']) {
      assert.throws(() => fs.lstatSync(path.join(bin, name)), { code: 'ENOENT' });
    }
    run('./install', ['--skip-build']);
    fs.unlinkSync(path.join(hudHome, 'uninstalled'));
    fs.unlinkSync(path.join(bin, 'hud-mcp'));
    const foreign = path.join(temp, 'other-command');
    fs.symlinkSync(foreign, path.join(bin, 'hud-mcp'));
    run(path.join(bin, 'hud'), ['uninstall', '--with', 'x', '--skip-build']);
    assert.throws(() => fs.lstatSync(path.join(bin, 'hud')), { code: 'ENOENT' });
    assert.equal(fs.readlinkSync(path.join(bin, 'hud-mcp')), foreign);
    assert.equal(fs.readFileSync(path.join(hudHome, 'uninstalled'), 'utf8'), 'removed');
    assert.equal(fs.readFileSync(path.join(hudHome, 'keep.txt'), 'utf8'), 'owner data');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

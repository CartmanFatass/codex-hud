import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Node floor is checked before extension hooks, builds or filesystem changes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-node-'));
  try {
    const repo = path.join(temp, 'checkout');
    const tools = path.join(temp, 'tools');
    fs.mkdirSync(path.join(repo, 'install.d'), { recursive: true });
    fs.mkdirSync(tools);
    fs.copyFileSync(path.join(root, 'install'), path.join(repo, 'install'));
    for (const name of ['bash', 'dirname', 'readlink', 'mkdir', 'ln', 'rm'])
      fs.symlinkSync(`/usr/bin/${name}`, path.join(tools, name));
    // Run the installer's real JS predicate, changing only its observed Node version.
    const preload = path.join(temp, 'version.cjs');
    fs.writeFileSync(
      preload,
      "Object.defineProperty(process.versions, 'node', { value: process.env.SYNTHETIC_NODE });\n"
    );
    fs.writeFileSync(
      path.join(tools, 'node'),
      `#!/bin/bash\nexec '${process.execPath}' --require '${preload}' "$@"\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(repo, 'install.d/probe.sh'),
      'hud_ext_check() { mkdir -p "$HUD_HOME"; printf checked > "$HUD_HOME/hook"; }\n' + 'hud_ext_install() { :; }\n'
    );
    fs.writeFileSync(path.join(tools, 'npm'), '#!/bin/bash\nprintf called > "$HOME/npm-called"\n', { mode: 0o755 });
    for (const version of ['18.20.0', '20.19.0', '22.12.0', '23.11.0', '22.13.0', '22.15.0', '24.0.0', '26.0.0']) {
      const home = path.join(temp, version);
      const hudHome = path.join(home, '.hud');
      const supported = ['24.0.0', '26.0.0'].includes(version);
      const result = spawnSync('./install', [supported ? '--skip-build' : '--with', ...(supported ? [] : ['probe'])], {
        cwd: repo,
        env: {
          ...process.env,
          HOME: home,
          HUD_HOME: hudHome,
          PATH: tools,
          SYNTHETIC_NODE: version,
          CODEX_HOME: path.join(home, '.codex'),
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          PI_CODING_AGENT_DIR: path.join(home, '.pi'),
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, supported ? 0 : 1, `${version}: ${result.stdout}\n${result.stderr}`);
      if (supported) {
        assert.equal(fs.readlinkSync(path.join(home, '.local/bin/hud')), path.join(repo, 'bin/hud'));
      } else {
        assert.equal(fs.existsSync(home), false, `${version}: no extension hook, npm, home, config or symlink changes`);
        assert.equal(result.stdout, '', `${version}: only the refusal line should print`);
        assert.equal(result.stderr, 'Error: Node >=24.0.0 required\n');
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('public launchers refuse Node below 24 before imports, uninstall or Codex launch', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-launcher-node-'));
  try {
    const preload = path.join(temp, 'version.cjs');
    fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: process.env.SYNTHETIC_NODE });\n");
    for (const version of ['18.20.0', '22.13.0', '22.15.0', '23.11.0']) {
      for (const [entry, args, code, message] of [
        ['bin/hud', ['--help'], 5, 'runtime_unavailable: Node >=24.0.0 required\n'],
        ['bin/hud', ['uninstall'], 5, 'runtime_unavailable: Node >=24.0.0 required\n'],
        ['bin/hud', ['codex'], 5, 'runtime_unavailable: Node >=24.0.0 required\n'],
        ['packages/hud-mcp/bin/hud-mcp.mjs', [], 1, `hud-mcp requires Node >=24.0.0 (running ${version}).\n`],
      ]) {
        const result = spawnSync(process.execPath, ['--require', preload, path.join(root, entry), ...args], {
          env: { HOME: temp, HUD_HOME: path.join(temp, 'unused-hud'), SYNTHETIC_NODE: version }, encoding: 'utf8',
        });
        assert.equal(result.status, code, `${entry} (${version}): ${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, message);
        assert.equal(fs.existsSync(path.join(temp, 'unused-hud')), false);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('installer runs npm ci only when dependency state does not match the lockfile', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-deps-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'checkout');
  const tools = path.join(temp, 'tools');
  const home = path.join(temp, 'home');
  const log = path.join(temp, 'npm.log');
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.mkdirSync(tools);
  fs.copyFileSync(path.join(root, 'install'), path.join(repo, 'install'));
  fs.writeFileSync(path.join(tools, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
if [[ "$*" == ci && "$FAIL_CI" == 1 ]]; then exit 23; fi
`, { mode: 0o755 });
  const lockfile = path.join(repo, 'package-lock.json');
  const run = (args = [], status = 0) => {
    const result = spawnSync('./install', args, {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        HUD_HOME: path.join(temp, 'hud'),
        PATH: `${tools}:${process.env.PATH}`,
        NPM_LOG: log,
        FAIL_CI: status === 23 ? '1' : '0',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  };
  fs.writeFileSync(lockfile, '{"name":"synthetic-v1"}\n');
  run(); // Existing node_modules without a hash must be refreshed once.
  run();
  fs.writeFileSync(lockfile, '{"name":"synthetic-v2"}\n');
  run(['--skip-build']);
  run([], 23);
  run();
  run();
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
    'ci', 'run build', 'run build', 'ci', 'ci', 'run build', 'run build',
  ]);
});

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

test('installer refreshes only remembered extensions and selective uninstall keeps shared commands', () => {
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
    const worker = path.join(hudHome, 'pi-worker', 'hud-worker.mjs');
    const workerUi = path.join(hudHome, 'pi-worker', 'hud-worker-ui.mjs');
    assert.equal(fs.readlinkSync(worker), path.join(repo, 'integrations/pi/worker/hud-worker.mjs'));
    assert.equal(fs.readlinkSync(workerUi), path.join(repo, 'integrations/pi/worker/hud-worker-ui.mjs'));
    assert.equal(fs.statSync(hudHome).mode & 0o777, 0o700);
    fs.writeFileSync(path.join(hudHome, 'keep.txt'), 'owner data');
    fs.writeFileSync(
      path.join(repo, 'install.d/x.sh'),
      `hud_ext_install() { printf '%s\\n' "$REPO" "$HUD_HOME" "$BIN_DIR" > "$HUD_HOME/x"; }
hud_ext_uninstall() { rm -f -- "$HUD_HOME/x"; }
`
    );
    const writeY = (version) => fs.writeFileSync(
      path.join(repo, 'install.d/y.sh'),
      `hud_ext_install() { printf '%s' '${version}' > "$HUD_HOME/y"; }
hud_ext_uninstall() { rm -f -- "$HUD_HOME/y"; }
`
    );
    writeY('v1');
    run('./install', ['--skip-build', '--with', 'x']);
    run('./install', ['--skip-build', '--with', 'y']);
    const x = path.join(hudHome, 'x'), y = path.join(hudHome, 'y');
    assert.equal(fs.readFileSync(x, 'utf8'), `${repo}\n${hudHome}\n${bin}\n`);
    assert.equal(fs.readFileSync(y, 'utf8'), 'v1');
    assert.equal(fs.statSync(path.join(hudHome, 'installed-extensions')).mode & 0o777, 0o600);
    writeY('v2');
    fs.unlinkSync(x);
    run('./install', ['--skip-build']);
    assert.equal(fs.readFileSync(x, 'utf8'), `${repo}\n${hudHome}\n${bin}\n`, 'installing y did not forget x');
    assert.equal(fs.readFileSync(y, 'utf8'), 'v2', 'bare install used the new hook');

    run(path.join(bin, 'hud'), ['uninstall', '--with', 'x', '--skip-build']);
    assert.equal(fs.existsSync(x), false);
    assert.equal(fs.readFileSync(y, 'utf8'), 'v2');
    assert.equal(fs.readlinkSync(path.join(bin, 'hud')), path.join(repo, 'bin/hud'));
    assert.equal(fs.readlinkSync(path.join(bin, 'hud-mcp')), path.join(repo, 'packages/hud-mcp/bin/hud-mcp.mjs'));
    writeY('v3');
    run('./install', ['--skip-build']);
    assert.equal(fs.existsSync(x), false, 'bare install does not reinstall an uninstalled extension');
    assert.equal(fs.readFileSync(y, 'utf8'), 'v3');

    fs.unlinkSync(path.join(bin, 'hud-mcp'));
    const foreign = path.join(temp, 'other-command');
    fs.symlinkSync(foreign, path.join(bin, 'hud-mcp'));
    assert.match(run(path.join(bin, 'hud'), ['uninstall', '--skip-build']).stdout, /data kept/);
    assert.throws(() => fs.lstatSync(path.join(bin, 'hud')), { code: 'ENOENT' });
    assert.throws(() => fs.lstatSync(worker), { code: 'ENOENT' });
    assert.throws(() => fs.lstatSync(workerUi), { code: 'ENOENT' });
    assert.equal(fs.readlinkSync(path.join(bin, 'hud-mcp')), foreign);
    assert.equal(fs.existsSync(y), false);
    assert.equal(fs.readFileSync(path.join(hudHome, 'keep.txt'), 'utf8'), 'owner data');
    fs.unlinkSync(path.join(bin, 'hud-mcp'));
    run('./install', ['--skip-build']);
    assert.equal(fs.existsSync(y), false, 'full uninstall also forgets extensions');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

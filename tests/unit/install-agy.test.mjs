import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const exists = (file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
const originals = {
  settings: '{\n\t"permissions": { "allow": [ "command(synthetic)" ] },\n\t"other": {"keep":true}\n}\n',
  hooks: '{ "herdr" : {"PreInvocation":[{"type":"command","command":"echo synthetic-herdr"}]} }\n',
  mcp: '{\r\n "mcpServers": { "foreign": { "url": "https://example.invalid/mcp", "headers":{"X-Synthetic":"keep"} } }\r\n}\r\n',
};

function fixture(t, seed = originals) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-agy-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const hud = path.join(temp, "HUD's home");
  const bin = path.join(home, '.local/bin');
  const tools = path.join(temp, 'tools');
  fs.mkdirSync(tools);
  for (const name of ['bash', 'dirname', 'readlink', 'mkdir', 'ln', 'rm']) {
    fs.symlinkSync(`/usr/bin/${name}`, path.join(tools, name));
  }
  fs.symlinkSync(process.execPath, path.join(tools, 'node'));
  const fake = path.join(tools, 'agy');
  fs.copyFileSync(path.join(root, 'tests/fakes/agy'), fake);
  fs.chmodSync(fake, 0o700);
  const log = path.join(temp, 'argv.jsonl');
  const env = { ...process.env, HOME: home, HUD_HOME: hud, PATH: `${bin}:${tools}`, AGY_ARGV_LOG: log };
  const files = {
    settings: path.join(home, '.gemini/antigravity-cli/settings.json'),
    hooks: path.join(home, '.gemini/config/hooks.json'),
    mcp: path.join(home, '.gemini/config/mcp_config.json'),
  };
  for (const [key, text] of Object.entries(seed)) {
    fs.mkdirSync(path.dirname(files[key]), { recursive: true });
    fs.writeFileSync(files[key], text, { mode: 0o640 });
  }
  const run = (args = [], status = 0, override = {}) => {
    const result = spawnSync('./install', ['--skip-build', '--with', 'agy', ...args], {
      cwd: root, env: { ...env, ...override }, encoding: 'utf8',
    });
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return result.stderr;
  };
  const calls = () => read(log).trim().split('\n').map(JSON.parse);
  return { temp, home, hud, bin, files, fake, run, calls };
}

for (const foreignEdits of [false, true]) {
  test(`agy install, reinstall and byte-exact uninstall${foreignEdits ? ' with intervening owner edits' : ''}`, (t) => {
    const { temp, home, hud, bin, files, fake, run, calls } = fixture(t);
    const dotfile = path.join(temp, 'owner settings.json');
    fs.renameSync(files.settings, dotfile);
    fs.symlinkSync(dotfile, files.settings);
    run();
    const settings = json(files.settings);
    assert.deepEqual(settings.permissions.allow, ['command(synthetic)', 'mcp(hud/*)']);
    assert.deepEqual(settings.statusLine, { type: 'command', command: path.join(bin, 'hud-statusline') });
    assert.deepEqual(settings.other, { keep: true });
    assert.equal(fs.readlinkSync(path.join(bin, 'hud-statusline')), path.join(root, 'bin/hud-statusline'));

    const hooks = json(files.hooks);
    assert.deepEqual(hooks.herdr, JSON.parse(originals.hooks).herdr);
    const [handler] = hooks.hud.PreInvocation;
    assert.equal(handler.type, 'command');
    const stub = spawnSync('/bin/sh', ['-c', handler.command], { input: '{"hookEventName":"PreInvocation"}', encoding: 'utf8' });
    assert.equal(stub.status, 0, stub.stderr);
    assert.equal(stub.stdout, '{}\n');
    assert.equal(fs.readlinkSync(path.join(hud, 'integrations/agy/pre-invocation.sh')), path.join(root, 'integrations/agy/pre-invocation.sh'));

    const command = path.join(bin, 'hud-mcp');
    assert.deepEqual(json(files.mcp).mcpServers, {
      ...JSON.parse(originals.mcp).mcpServers, hud: { command, disabled: false, env: { HUD_MCP_SURFACE: 'roles' } },
    });
    const installed = Object.values(files).map(read);
    run();
    assert.deepEqual(Object.values(files).map(read), installed);
    const invocations = calls();
    assert.deepEqual(invocations.map(({ args }) => args), [
      ['mcp', 'remove', 'hud'], ['mcp', 'add', '--env', 'HUD_MCP_SURFACE=roles', 'hud', command],
      ['mcp', 'remove', 'hud'], ['mcp', 'add', '--env', 'HUD_MCP_SURFACE=roles', 'hud', command],
    ]);
    assert.equal(invocations[0].home, invocations[1].home);
    assert.notEqual(invocations[0].home, invocations[2].home);
    for (const call of invocations) {
      assert.notEqual(call.home, home);
      assert.equal(exists(call.home), false, 'staged HOME cleaned up');
    }

    const expected = { ...originals };
    if (foreignEdits) {
      const edits = {
        settings: [' ] },', ', "command(owner-edit)" ] },'], // add an item after HUD's rule
        hooks: ['echo synthetic-herdr', 'echo owner-edit'],
        mcp: ['"X-Synthetic":"keep"', '"X-Synthetic" : "owner-edit"'],
      };
      for (const [key, [from, to]] of Object.entries(edits)) {
        const before = read(files[key]);
        const changed = before.replace(from, to);
        assert.notEqual(changed, before);
        fs.writeFileSync(files[key], changed);
        expected[key] = originals[key].replace(from, to);
      }
    }
    fs.unlinkSync(fake); // Uninstall does not need agy on PATH.
    run(['--uninstall']);
    run(['--uninstall']);
    for (const [key, file] of Object.entries(files)) {
      assert.equal(read(file), expected[key], key);
      assert.equal(fs.statSync(file).mode & 0o777, 0o640, key);
      assert.equal(exists(file + '.hud-agy-backup'), false);
    }
    assert.equal(fs.readlinkSync(files.settings), dotfile);
    assert.equal(exists(path.join(bin, 'hud-statusline')), false);
    assert.equal(exists(path.join(hud, 'integrations/agy/pre-invocation.sh')), false);
  });
}

test('agy keeps an owner statusLine, restores it if set aside, and keeps a preexisting allow rule', (t) => {
  const settingsOriginal = '{ "statusLine" : {"type":"command", "command":"owner-status"}, "extra":1 }\n';
  const { files, run } = fixture(t, { settings: settingsOriginal });
  run();
  assert.equal(json(files.settings).statusLine.command, 'owner-status');
  // Model an earlier HUD line replacing the owner command after the first install.
  fs.writeFileSync(files.settings, read(files.settings).replace('owner-status', '/synthetic/earlier/hud-statusline'));
  run();
  run(['--uninstall']);
  assert.equal(read(files.settings), settingsOriginal);
  assert.equal(exists(files.hooks), false);
  assert.equal(exists(files.mcp), false);

  const preexisting = '{ "permissions" : { "allow" : [ "mcp(hud/*)" ] }, "other":true }\n';
  fs.writeFileSync(files.settings, preexisting);
  run();
  run(['--uninstall']);
  assert.equal(read(files.settings), preexisting);
});

test('agy preflight refuses a missing CLI and install rejects an unexpected staged result', (t) => {
  const { fake, hud, bin, files, run } = fixture(t);
  assert.match(run([], 1, { AGY_BAD_REGISTRATION: 'yes' }), /unexpected hud registration/);
  for (const [key, file] of Object.entries(files)) {
    assert.equal(read(file), originals[key]);
    assert.equal(exists(file + '.hud-agy-backup'), false);
  }
  assert.equal(exists(path.join(bin, 'hud-statusline')), false);
  assert.equal(exists(path.join(hud, 'integrations/agy/pre-invocation.sh')), false);
  run(['--uninstall']);
  fs.unlinkSync(fake);
  assert.match(run([], 1), /agy is required/);
  assert.equal(exists(path.join(bin, 'hud')), false);
});

test('agy reads an empty config file as an empty object and leaves it on uninstall', (t) => {
  // agy creates mcp_config.json empty when it has no servers; hooks can be empty too.
  const { files, bin, run } = fixture(t, { settings: '{}\n', hooks: '', mcp: '' });
  run();
  const settings = json(files.settings);
  assert.deepEqual(settings.permissions.allow, ['mcp(hud/*)']);
  assert.deepEqual(settings.statusLine, { type: 'command', command: path.join(bin, 'hud-statusline') });
  assert.equal(json(files.hooks).hud.PreInvocation[0].type, 'command');
  assert.deepEqual(json(files.mcp).mcpServers, {
    hud: { command: path.join(bin, 'hud-mcp'), disabled: false, env: { HUD_MCP_SURFACE: 'roles' } },
  });
  run(['--uninstall']);
  for (const key of ['hooks', 'mcp']) {
    assert.equal(exists(files[key]), true, `${key} existed before the install`);
    assert.equal(read(files[key]), '{}\n', key);
    assert.equal(fs.statSync(files[key]).mode & 0o777, 0o640, key);
  }
  assert.equal(read(files.settings), '{}\n');
});

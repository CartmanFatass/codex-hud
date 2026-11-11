import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const repo = path.resolve('.');
const filter = '-extensions/p10k-footer.ts';

test('pi install/uninstall registers a checkout package and replaces only the p10k selection', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-pi-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home'),
    hudHome = path.join(temp, 'hud with spaces'),
    agent = path.join(temp, 'custom-agent'),
    fakeBin = path.join(temp, 'bin'),
    privateExtensions = path.join(temp, 'private-extensions'),
    log = path.join(temp, 'pi-argv.jsonl');
  for (const dir of [home, hudHome, agent, fakeBin, privateExtensions]) fs.mkdirSync(dir, { mode: 0o700 });
  const settingsFile = path.join(agent, 'settings.json'),
    backup = settingsFile + '.hud-backup',
    pkg = path.join(hudHome, 'pi-package'),
    display = path.join(hudHome, 'pi-display');
  const original = {
    extensions: ['-builtin:mcp', 'extensions/other.ts'],
    theme: 'synthetic',
    unrelated: { keep: true },
  };
  const before = JSON.stringify(original) + '\n';
  fs.writeFileSync(settingsFile, before);
  fs.symlinkSync(privateExtensions, path.join(agent, 'extensions'));
  const footerFile = path.join(privateExtensions, 'p10k-footer.ts');
  fs.writeFileSync(footerFile, '// synthetic private footer\n');
  const footerStat = fs.statSync(footerFile);
  const imported = { footer: { lens: false }, band: { cost: false } };
  fs.writeFileSync(path.join(agent, 'p10k-footer.json'), JSON.stringify(imported), { mode: 0o600 });
  // Only pi's registration is synthetic. Installer, binding and footer import run real code.
  fs.writeFileSync(
    path.join(fakeBin, 'pi'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [command, source] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify([command, source]) + '\\n');
const file = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
const packages = settings.packages ?? [];
if (command === 'install') settings.packages = [...new Set([...packages, source])];
else if (command === 'remove') {
  if (!packages.includes(source)) process.exit(1);
  settings.packages = packages.filter(p => p !== source);
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(settings));
`,
    { mode: 0o700 }
  );
  const env = {
    PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    HUD_HOME: hudHome,
    CODEX_HOME: path.join(temp, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
    PI_CODING_AGENT_DIR: agent,
    FAKE_PI_LOG: log,
  };
  const run = (...args) => {
    const result = spawnSync('./install', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  run('--skip-build', '--with', 'pi');
  assert.equal(fs.readFileSync(backup, 'utf8'), before, 'backup precedes even pi registration');
  // Workers run plain: only the delegation package is registered; pi-display is loaded by `pi -e` alone.
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)), {
    ...original,
    extensions: [...original.extensions, filter],
    packages: [pkg],
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json')));
  assert.deepEqual(manifest.pi, { extensions: ['./extensions/hud.mjs'], skills: ['./skills/hud-delegate/SKILL.md'] });
  assert.ok(fs.statSync(path.join(pkg, 'extensions/hud.mjs')).isFile());
  assert.equal(
    fs.readlinkSync(path.join(pkg, 'skills/hud-delegate')),
    path.join(repo, 'integrations/skills/hud-delegate')
  );
  assert.ok(fs.statSync(path.join(pkg, 'skills/hud-delegate/SKILL.md')).isFile());
  const { loadBinding } = await import(pathToFileURL(path.join(pkg, 'binding.mjs')));
  assert.deepEqual(loadBinding(pathToFileURL(path.join(pkg, 'binding.json'))), {
    release: repo,
    hudHome,
    node: process.execPath,
  });
  const displayManifest = JSON.parse(fs.readFileSync(path.join(display, 'package.json')));
  assert.deepEqual(displayManifest.pi, { extensions: ['./extensions/hud-display.mjs'] });
  assert.ok(fs.statSync(path.join(display, 'extensions/hud-display.mjs')).isFile());
  assert.deepEqual(loadBinding(pathToFileURL(path.join(display, 'binding.json'))), {
    release: repo,
    hudHome,
    node: process.execPath,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hudHome, 'config.json'))).piFooter, imported);
  run('--skip-build', '--with', 'pi');
  assert.equal(fs.readFileSync(backup, 'utf8'), before, 'reinstall never overwrites the backup');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)).extensions, [...original.extensions, filter]);
  const changed = JSON.parse(fs.readFileSync(settingsFile));
  changed.laterKey = 'keep too';
  changed.extensions.push('extensions/later.ts');
  fs.writeFileSync(settingsFile, JSON.stringify(changed));
  run('--uninstall', '--with', 'pi');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)), {
    ...original,
    extensions: [...original.extensions, 'extensions/later.ts'],
    packages: [],
    laterKey: 'keep too',
  });
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(pkg), false);
  assert.equal(fs.existsSync(display), false);
  run('--uninstall', '--with', 'pi'); // not-installed pi remove is harmless
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [
    ['install', pkg],
    ['install', pkg],
    ['remove', pkg],
    ['remove', pkg],
  ]);
  assert.equal(fs.readlinkSync(path.join(agent, 'extensions')), privateExtensions);
  assert.deepEqual(fs.readdirSync(privateExtensions), ['p10k-footer.ts']);
  assert.equal(fs.readFileSync(footerFile, 'utf8'), '// synthetic private footer\n');
  assert.equal(fs.statSync(footerFile).ino, footerStat.ino);
  assert.equal(fs.statSync(footerFile).mtimeMs, footerStat.mtimeMs);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hudHome, 'config.json'))).piFooter, imported);
});

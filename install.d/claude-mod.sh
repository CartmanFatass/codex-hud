#!/usr/bin/env bash
hud_ext_check() { command -v claude >/dev/null || fail 'claude is required for the claude-mod extension'; }
hud_ext_install() { hud_mod_configure install; }
hud_ext_uninstall() { hud_mod_configure uninstall; }

hud_mod_configure() {
  node - "$1" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$REPO" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [action, config, repo] = process.argv.slice(2);
const market = 'myhud-local', plugin = `hud-mod@${market}`;
const file = path.join(config, 'settings.json');
const backup = path.join(config, '.hud-claude-mod-backup');
const known = 'plugins/known_marketplaces.json', installed = 'plugins/installed_plugins.json';
const files = [file, path.join(config, '.claude.json'), path.join(config, known), path.join(config, installed)];
const saved = (file) => path.join(backup, path.basename(file));
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const owns = fs.existsSync(backup);
if (action === 'uninstall' && !owns) process.exit(0);
const current = read(file);
const source = (current.extraKnownMarketplaces?.[market] ?? read(path.join(config, known))[market])?.source;
if (source && (!owns || source.source !== 'directory' || source.path !== repo)) {
  throw new Error(`Claude marketplace ${market} is not owned by this HUD install`);
}
const claude = (...args) => execFileSync('claude', ['plugin', ...args, '--scope', 'user'], { cwd: repo, stdio: 'inherit' });
if (action === 'install') {
  if (!owns) {
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const source of files.filter(fs.existsSync)) {
      fs.writeFileSync(saved(source), fs.readFileSync(source), { mode: 0o600, flag: 'wx' });
    }
  }
  claude('marketplace', 'add', repo);
  claude('install', plugin);
} else {
  const entries = read(path.join(config, installed)).plugins?.[plugin] ?? [];
  if (entries.some((item) => item.scope === 'user') || Object.hasOwn(current.enabledPlugins ?? {}, plugin)) {
    claude('uninstall', '--keep-data', plugin);
  }
  if (source) claude('marketplace', 'remove', market);
  // Claude leaves empty maps behind, even when it created them on install.
  const original = saved(file);
  const before = read(original), after = read(file), unchanged = JSON.stringify(after);
  for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) {
    if (!Object.hasOwn(before, key) && after[key] && !Object.keys(after[key]).length) delete after[key];
  }
  if (fs.existsSync(file) && !fs.existsSync(original) && !Object.keys(after).length && !fs.lstatSync(file).isSymbolicLink()) {
    fs.unlinkSync(file);
  } else if (JSON.stringify(after) !== unchanged) {
    const target = fs.realpathSync(file), tmp = `${target}.hud-claude-mod-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(after, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, fs.statSync(target).mode & 0o777);
    fs.renameSync(tmp, target);
  }
  for (const source of files) fs.rmSync(saved(source), { force: true });
  fs.rmdirSync(backup);
}
NODE
}

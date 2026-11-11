# Pi's local package registration; personal extension files are never changed.
hud_pi_settings() {
  node --input-type=module - "$1" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const install = process.argv[2] === 'install';
const agent = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME, '.pi/agent'));
const file = path.join(agent, 'settings.json');
const backup = file + '.hud-backup';
if (!install && !fs.existsSync(backup)) process.exit(0);
const exists = fs.existsSync(file);
const settings = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
    (settings.extensions !== undefined && !Array.isArray(settings.extensions)))
  throw Error('Invalid pi settings or extensions array');
if (install) {
  fs.mkdirSync(agent, { recursive: true });
  try {
    if (exists) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    else fs.writeFileSync(backup, '{}\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const filter = '-extensions/p10k-footer.ts';
const entries = settings.extensions ?? [];
const original = install ? {} : JSON.parse(fs.readFileSync(backup, 'utf8'));
if (install ? !entries.includes(filter) : entries.includes(filter) && !original.extensions?.includes(filter)) {
  settings.extensions = install ? [...entries, filter] : entries.filter(entry => entry !== filter);
  fs.mkdirSync(agent, { recursive: true });
  // Write through a symlink (e.g. into a dotfiles repo); keep the target's mode.
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  fs.writeFileSync(target + '.hud-tmp', JSON.stringify(settings, null, 2) + '\n', { mode });
  fs.renameSync(target + '.hud-tmp', target);
}
if (!install) fs.rmSync(backup, { force: true });
NODE
}

hud_ext_install() {
  local package="$HUD_HOME/pi-package" display="$HUD_HOME/pi-display"
  mkdir -p -- "$package/extensions" "$package/skills" "$display/extensions"
  cp -- "$REPO/integrations/pi/package/package.template.json" "$package/package.json"
  cp -- "$REPO/integrations/pi/package/binding.mjs" "$package/binding.mjs"
  cp -- "$REPO/integrations/pi/package/extensions/hud.mjs" "$package/extensions/hud.mjs"
  ln -sfn -- "$REPO/integrations/skills/hud-delegate" "$package/skills/hud-delegate"
  cp -- "$REPO/integrations/pi/package/display.template.json" "$display/package.json"
  cp -- "$REPO/integrations/pi/package/binding.mjs" "$display/binding.mjs"
  cp -- "$REPO/integrations/pi/package/extensions/hud-display.mjs" "$display/extensions/hud-display.mjs"
  node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
for (const name of ['pi-package', 'pi-display'])
  fs.writeFileSync(path.join(process.env.HUD_HOME, name, 'binding.json'), JSON.stringify({
    release: process.env.REPO,
    hudHome: path.resolve(process.env.HUD_HOME),
    node: process.execPath,
  }, null, 2) + '\n');
NODE
  hud_pi_settings install
  local agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  if [[ -f "$agent/p10k-footer.json" ]]; then
    "$REPO/bin/hud" import apply --pi-footer --from "$(readlink -f "$agent/p10k-footer.json")"
  fi
  if command -v pi >/dev/null; then
    pi install "$package"
    pi install "$display"
  else
    printf 'Warning: pi is not on PATH; skipping pi package registration.\n' >&2
  fi
}

hud_ext_uninstall() {
  if command -v pi >/dev/null; then
    pi remove "$HUD_HOME/pi-package" || true
    pi remove "$HUD_HOME/pi-display" || true
  else
    printf 'Warning: pi is not on PATH; skipping pi package removal.\n' >&2
  fi
  hud_pi_settings uninstall
  rm -rf -- "$HUD_HOME/pi-package" "$HUD_HOME/pi-display"
}

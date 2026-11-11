#!/usr/bin/env bash
# Sourced by ./install; REPO, HUD_HOME and BIN_DIR are exported by core.
hud_claude_settings() {
  node - "$1" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" "$BIN_DIR/hud-statusline" <<'NODE'
const fs = require('node:fs');
const [action, file, command] = process.argv.slice(2);
const backup = file + '.hud-backup';
if (action === 'uninstall' && !fs.existsSync(backup)) process.exit(0);
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (action === 'install') {
  if (!fs.existsSync(backup)) {
    if (fs.existsSync(file)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    else fs.writeFileSync(backup, '{}\n', { flag: 'wx', mode: 0o600 });
  }
  settings.statusLine = { type: 'command', command, refreshInterval: 5 };
} else {
  const original = JSON.parse(fs.readFileSync(backup, 'utf8'));
  if (Object.hasOwn(original, 'statusLine')) settings.statusLine = original.statusLine;
  else delete settings.statusLine;
}
// Write through a symlink (e.g. into a dotfiles repo); keep the target's mode.
const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
fs.writeFileSync(target + '.hud-tmp', JSON.stringify(settings, null, 2) + '\n', { mode });
fs.renameSync(target + '.hud-tmp', target);
if (action === 'uninstall') fs.unlinkSync(backup);
NODE
}

hud_ext_install() {
  local config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" skill link source_settings
  if command -v claude >/dev/null; then
    claude mcp remove -s user hud 2>/dev/null || true
    claude mcp add -s user hud -e HUD_MCP_SURFACE=roles -- "$BIN_DIR/hud-mcp"
  else
    printf 'Warning: claude is not on PATH; skipping MCP registration.\n' >&2
  fi

  skill="$config/skills/hud-delegate"
  mkdir -p -- "$config/skills" "$BIN_DIR"
  if [[ -L "$skill" || ! -e "$skill" ]]; then
    ln -sfn -- "$REPO/integrations/skills/hud-delegate" "$skill"
  else
    printf 'Warning: keeping existing non-symlink skill: %s\n' "$skill" >&2
  fi
  link="$BIN_DIR/hud-statusline"
  if [[ ! -L "$link" && -e "$link" ]]; then
    printf 'Error: command already exists: %s\n' "$link" >&2
    return 1
  fi
  ln -sfn -- "$REPO/bin/hud-statusline" "$link"
  if [[ -f "$config/plugins/claude-hud/config.json" ]]; then
    # On a re-run, import the original wrapper rather than our replacement command.
    source_settings="$config/settings.json"
    [[ ! -f "$source_settings.hud-backup" ]] || source_settings+=".hud-backup"
    "$BIN_DIR/hud" statusline import --from "$config/plugins/claude-hud/config.json" --settings "$source_settings" --apply
  fi
  hud_claude_settings install
}

hud_ext_uninstall() {
  local link
  if command -v claude >/dev/null; then
    claude mcp remove -s user hud 2>/dev/null || true
  fi
  hud_claude_settings uninstall
  for link in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/hud-delegate" "$BIN_DIR/hud-statusline"; do
    if [[ -L "$link" && "$(readlink -m "$link")" == "$REPO/"* ]]; then
      rm -- "$link"
    fi
  done
}

#!/usr/bin/env bash
# Sourced by ./install; REPO, HUD_HOME and BIN_DIR are exported by core.

hud_ext_check() {
  command -v agy >/dev/null || fail 'agy is required for the agy extension (not on PATH)'
}

hud_ext_install() {
  local hook="$HUD_HOME/integrations/agy/pre-invocation.sh"
  local status="$BIN_DIR/hud-statusline"
  local hook_source="$REPO/integrations/agy/pre-invocation.sh" status_source="$REPO/bin/hud-statusline"
  if [[ -e "$hook" || -L "$hook" ]]; then
    [[ -L "$hook" && "$(readlink "$hook")" == "$hook_source" ]] || fail "Hook already exists: $hook"
  fi
  if [[ -e "$status" || -L "$status" ]]; then
    [[ -L "$status" && "$(readlink "$status")" == "$status_source" ]] || fail "Command already exists: $status"
  fi

  # The helper stages the official MCP commands: agy 1.5.14 reformats other keys
  # and can widen mode 0640 to 0644 (MCP config may contain auth headers).
  node "$REPO/install.d/agy-config.mjs" install
  mkdir -p -- "${hook%/*}"
  [[ -L "$hook" ]] || ln -s -- "$hook_source" "$hook"
  [[ -L "$status" ]] || ln -s -- "$status_source" "$status"
}

hud_ext_uninstall() {
  local hook="$HUD_HOME/integrations/agy/pre-invocation.sh" status="$BIN_DIR/hud-statusline"
  node "$REPO/install.d/agy-config.mjs" uninstall
  if [[ -L "$hook" && "$(readlink "$hook")" == "$REPO/integrations/agy/pre-invocation.sh" ]]; then
    rm -- "$hook"
    if [[ -L "$status" && "$(readlink "$status")" == "$REPO/bin/hud-statusline" ]]; then
      rm -- "$status"
    fi
  fi
}

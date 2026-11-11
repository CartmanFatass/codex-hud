#!/usr/bin/env bash

hud_codex_prompt_line='Run `hud panel` with Bash and report the pane id it prints.'

hud_codex_mcp() {
  local config="${CODEX_HOME:-$HOME/.codex}/config.toml" backup before=0 after=0 status=0
  if [[ -f "$config" ]]; then
    backup="$(readlink -f -- "$config").hud-backup"
    [[ -e "$backup" ]] || cp -- "$config" "$backup"
    before="$(grep -c '^[[:space:]]*#' "$config" || true)"
  fi
  codex mcp remove hud 2>/dev/null || true
  if [[ "$1" == install ]]; then
    codex mcp add hud --env HUD_MCP_SURFACE=roles -- "$BIN_DIR/hud-mcp" || status=$?
  fi
  if [[ -f "$config" ]]; then
    after="$(grep -c '^[[:space:]]*#' "$config" || true)"
  fi
  if ((after < before)); then
    printf 'Warning: Codex removed config.toml comments; original saved at %s\n' "$backup" >&2
  fi
  return "$status"
}

hud_ext_install() {
  local prompt="${CODEX_HOME:-$HOME/.codex}/prompts/hud.md"
  # Codex opens the panel with F12; remove only the legacy prompt we wrote.
  if [[ -f "$prompt" && "$(cat -- "$prompt")" == "$hud_codex_prompt_line" ]]; then
    rm -- "$prompt"
  fi
  if command -v codex >/dev/null 2>&1; then
    hud_codex_mcp install
    # Codex starts MCP servers with a trimmed environment; hud_create needs herdr's variables.
    local config="${CODEX_HOME:-$HOME/.codex}/config.toml"
    if [[ -f "$config" ]] && ! grep -q '^env_vars = \["HERDR_PANE_ID"' "$config"; then
      sed -i --follow-symlinks '/^\[mcp_servers\.hud\]$/a env_vars = ["HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_BIN_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]' "$config"
    fi
  else
    printf 'Warning: codex is not on PATH; skipping Codex MCP registration.\n' >&2
  fi

  local skill="${CODEX_HOME:-$HOME/.codex}/skills/hud-delegate"
  if [[ -L "$skill" ]]; then
    if [[ "$(readlink -m "$skill")" != "$REPO/"* ]]; then
      printf 'Warning: %s is a foreign symlink; skipping Codex skill.\n' "$skill" >&2
      return 0
    fi
    rm -- "$skill"
  elif [[ -e "$skill" ]]; then
    printf 'Warning: %s is not a symlink; skipping Codex skill.\n' "$skill" >&2
    return 0
  fi
  mkdir -p -- "$(dirname "$skill")"
  ln -s -- "$REPO/integrations/skills/hud-delegate" "$skill"
}

hud_ext_uninstall() {
  if command -v codex >/dev/null 2>&1; then
    hud_codex_mcp uninstall
  else
    printf 'Warning: codex is not on PATH; skipping Codex MCP removal.\n' >&2
  fi

  local skill="${CODEX_HOME:-$HOME/.codex}/skills/hud-delegate"
  if [[ -L "$skill" && "$(readlink -m "$skill")" == "$REPO/"* ]]; then
    rm -- "$skill"
  fi
  local prompt="${CODEX_HOME:-$HOME/.codex}/prompts/hud.md"
  if [[ -f "$prompt" && "$(cat -- "$prompt")" == "$hud_codex_prompt_line" ]]; then
    rm -- "$prompt"
  fi
}

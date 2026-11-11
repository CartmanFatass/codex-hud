#!/usr/bin/env bash

hud_codex_prompt_line='Run `hud panel` with Bash and report the pane id it prints.'

hud_ext_install() {
  local prompt="${CODEX_HOME:-$HOME/.codex}/prompts/hud.md"
  mkdir -p -- "$(dirname -- "$prompt")"
  if [[ -f "$prompt" && "$(cat -- "$prompt")" != "$hud_codex_prompt_line" ]]; then
    printf 'Warning: keeping existing prompt file: %s\n' "$prompt" >&2
  else
    printf '%s\n' "$hud_codex_prompt_line" > "$prompt"
  fi
  if command -v codex >/dev/null 2>&1; then
    codex mcp remove hud 2>/dev/null || true
    codex mcp add hud --env HUD_MCP_SURFACE=roles -- "$BIN_DIR/hud-mcp"
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
    codex mcp remove hud 2>/dev/null || true
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

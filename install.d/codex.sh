#!/usr/bin/env bash

hud_ext_install() {
  if command -v codex >/dev/null 2>&1; then
    codex mcp remove hud 2>/dev/null || true
    codex mcp add hud --env HUD_MCP_SURFACE=roles -- "$BIN_DIR/hud-mcp"
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
}

#!/usr/bin/env bash

hud_herdr_plugin_id='hud.select-send'

hud_ext_check() {
  local name found missing=false
  for name in herdr pi; do
    if found="$(command -v "$name")"; then
      printf 'Present: %s (%s)' "$name" "$found"
    else
      printf 'Missing: %s' "$name"
      [[ "$name" != herdr ]] || missing=true
    fi
    case "$name" in
      herdr) printf ' — from herdr; install it separately.\n' ;;
      pi) printf ' — from the pi coding-agent CLI; install it separately.\n' ;;
    esac
  done
  if $missing; then printf 'Error: herdr is required for the herdr extension.\n' >&2; return 1; fi
}

hud_ext_install() {
  local plugin_dir="$REPO/integrations/herdr/plugin"
  if [[ ! -f "$plugin_dir/herdr-plugin.toml" ]]; then
    printf 'Error: missing herdr plugin manifest: %s/herdr-plugin.toml\n' "$plugin_dir" >&2
    return 1
  fi
  herdr plugin link "$plugin_dir"
  printf 'Linked herdr plugin %s (%s).\n' "$hud_herdr_plugin_id" "$plugin_dir"
  printf 'Optional ~/.config/herdr/config.toml keybind (reload with: herdr server reload-config):\n'
  printf '[[keys.command]]\nkey = "prefix+s"\ntype = "plugin_action"\ncommand = "%s.send"\ndescription = "send selection to HUD main session"\n' "$hud_herdr_plugin_id"
}

hud_ext_uninstall() {
  if ! command -v herdr >/dev/null 2>&1; then
    printf 'herdr extension: herdr not on PATH; skipping plugin unlink.\n'
    return 0
  fi
  local out status=0
  out="$(herdr plugin uninstall "$hud_herdr_plugin_id" 2>&1)" || status=$?
  if ((status == 0)); then
    printf 'Uninstalled herdr plugin %s.\n' "$hud_herdr_plugin_id"
    return 0
  fi
  if [[ "$out" == *"not installed"* || "$out" == *"not found"* ]]; then
    printf 'herdr extension: plugin %s not installed.\n' "$hud_herdr_plugin_id"
    return 0
  fi
  printf '%s\n' "$out" >&2
  return "$status"
}

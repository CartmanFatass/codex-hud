#!/usr/bin/env bash

hud_ext_check() {
  local name found missing=false
  for name in google-chrome jev-ask jev-aistudio jev-flow; do
    if found="$(command -v "$name")" && [[ -x "$found" ]]; then
      printf 'Present: %s (%s)' "$name" "$found"
    else
      printf 'Missing: %s' "$name"
      [[ "$name" != google-chrome && "$name" != jev-ask ]] || missing=true
    fi
    case "$name" in
      google-chrome) printf ' — from Google Chrome; install it separately.\n' ;;
      *) printf ' — from the external Jev CLIs; install separately.\n' ;;
    esac
  done
  if $missing; then printf 'Error: Chrome (google-chrome) and jev-ask are required for the browser extension.\n' >&2; return 1; fi
}
hud_ext_install() { printf 'browser extension: checks only; configure Chrome and Jev CLIs separately.\n'; }
hud_ext_uninstall() { printf 'browser extension: no-op; nothing to uninstall.\n'; }

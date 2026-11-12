#!/usr/bin/env bash

hud_ext_check() {
  local name found missing=false
  for name in herdr pi-role pi-role-reap pi-dispatch pi; do
    if found="$(command -v "$name")"; then
      printf 'Present: %s (%s)' "$name" "$found"
    else
      printf 'Missing: %s' "$name"
      [[ "$name" != herdr ]] || missing=true
    fi
    case "$name" in
      herdr) printf ' — from herdr; install it separately.\n' ;;
      pi) printf ' — from the pi coding-agent CLI; install it separately.\n' ;;
      *) printf ' — from the locally installed pi-roles bundle; install it separately.\n' ;;
    esac
  done
  if $missing; then printf 'Error: herdr is required for the herdr extension.\n' >&2; return 1; fi
}
hud_ext_install() { printf 'herdr extension: checks only; nothing installed.\n'; }
hud_ext_uninstall() { printf 'herdr extension: no-op; nothing to uninstall.\n'; }

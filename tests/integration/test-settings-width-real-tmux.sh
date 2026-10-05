#!/usr/bin/env bash
# Exercise Settings -> Save -> the actual pane size, rather than only startup presets.
set -euo pipefail
command -v tmux >/dev/null || { echo 'SKIP: tmux unavailable'; exit 0; }
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dir=$(mktemp -d /tmp/hud-settings-width.XXXXXX)
socket="$dir/tmux.sock"
t() { tmux -S "$socket" "$@"; }
cleanup() { t kill-server 2>/dev/null || true; rm -rf "$dir"; }
trap cleanup EXIT
main=$(t new-session -d -s width -x 188 -y 40 -P -F '#{pane_id}' 'sleep 120')
open_tree() {
  panel=$(t split-window -h -l 30 -t "$main" -d -P -F '#{pane_id}' \
    "env LC_ALL=C.UTF-8 CODEX_HOME='$dir' CODEX_HUD_SETTINGS_PATH='$dir/settings.json' CODEX_HUD_CWD='$repo' CODEX_HUD_MAIN_PANE='$main' node '$repo/dist/tree-page.js'")
}
# A panel command as the prefix table delivers it (bin/codex-hud-command).
panel_command() {
  # shellcheck disable=SC2046 # one word per byte
  t send-keys -t "$panel" -H $(printf '%s' $'\e_codex-hud:'"$1"$'\e\\' | od -An -v -tx1)
}
wait_text() {
  for ((n=0;n<200;n++)); do
    if [[ "$(t capture-pane -p -t "$panel")" == *"$1"* ]]; then return; fi
    sleep 0.05
  done
  t capture-pane -p -t "$panel"
  echo "FAIL: missing $1"; exit 1
}
wait_width() {
  for ((n=0;n<200;n++)); do
    actual=$(t display-message -p -t "$panel" '#{pane_width}')
    if [[ "$actual" == "$1" ]]; then echo "PASS: width $1"; return; fi
    sleep 0.05
  done
  t capture-pane -p -t "$panel"
  echo "FAIL: expected width $1, got $actual"; exit 1
}
open_tree
# Opened at 30, the panel takes the default width at once.
wait_width 32
panel_command settings
wait_text Settings
# The page is a modal and its keys are its own. Width is the fifth row from
# the end, and the line under the list names the selected row.
t send-keys -t "$panel" End Up Up Up Up
wait_text 'Panel columns'
t send-keys -t "$panel" Right
t send-keys -t "$panel" -l s
wait_width 34
# Down from the narrowest width comes round to the widest.
t send-keys -t "$panel" Left Left Left Left Left Left
t send-keys -t "$panel" -l s
wait_width 80
t kill-pane -t "$panel"
open_tree
wait_width 80
echo 'Settings save and reopen width: PASS'

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
    "env CODEX_HOME='$dir' CODEX_HUD_SETTINGS_PATH='$dir/settings.json' CODEX_HUD_CWD='$repo' CODEX_HUD_MAIN_PANE='$main' node '$repo/dist/tree-page.js'")
}
wait_text() {
  for ((n=0;n<100;n++)); do
    if [[ "$(t capture-pane -p -t "$panel")" == *"$1"* ]]; then return; fi
    sleep 0.05
  done
  t capture-pane -p -t "$panel"
  echo "FAIL: missing $1"; exit 1
}
wait_width() {
  for ((n=0;n<100;n++)); do
    actual=$(t display-message -p -t "$panel" '#{pane_width}')
    if [[ "$actual" == "$1" ]]; then echo "PASS: width $1"; return; fi
    sleep 0.05
  done
  t capture-pane -p -t "$panel"
  echo "FAIL: expected width $1, got $actual"; exit 1
}
open_tree
wait_text Settings
t send-keys -t "$panel" -l ','
wait_text 'Panel width'
t send-keys -t "$panel" -l 'Gl'
wait_text 'wide'
t send-keys -t "$panel" -l 's'
wait_width 45
t send-keys -t "$panel" -l 'ls'
wait_width 70
t send-keys -t "$panel" -l 'ls'
wait_width 16
t send-keys -t "$panel" -l 'ls'
wait_width 30
t send-keys -t "$panel" -l 'ls'
wait_width 45
t kill-pane -t "$panel"
open_tree
wait_width 45
echo 'Settings save and reopen width: PASS'

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
wait_width 48
panel_command settings
wait_text '[Back]'
# The page is a modal and its keys are its own. Find Width by its selected
# help text, not a positional offset that breaks when settings are regrouped.
t send-keys -t "$panel" Home
for ((n=0;n<80;n++)); do
  if [[ "$(t capture-pane -p -t "$panel")" == *'Panel columns'* ]]; then break; fi
  t send-keys -t "$panel" Down
  sleep 0.05
done
wait_text 'Panel columns'
value_x() {
  t capture-pane -p -t "$panel" > "$dir/capture.txt"
  node --input-type=module - "$dir/capture.txt" <<'NODE'
import fs from 'node:fs';
const row = fs.readFileSync(process.argv[2], 'utf8').split('\n').find(line => /^›.*Width.*‹/.test(line));
if (!row) throw new Error('Selected Width row is missing');
console.log(row.indexOf('‹'));
NODE
}
x48=$(value_x)
t send-keys -t "$panel" Right
t send-keys -t "$panel" -l s
wait_width 56
# The actual resize must reflow the menu too, not only pad a left-packed row.
for ((n=0;n<200;n++)); do
  x56=$(value_x)
  if ((x56 > x48 && x56 >= 28)); then break; fi
  sleep 0.05
done
((x56 > x48 && x56 >= 28)) || { echo "FAIL: values stayed left-packed ($x48 -> $x56)"; exit 1; }
echo "PASS: settings values reflow right ($x48 -> $x56)"
# Two steps down from the default lands on 40.
t send-keys -t "$panel" Left Left
t send-keys -t "$panel" -l s
wait_width 40
t kill-pane -t "$panel"
open_tree
wait_width 40
echo 'Settings save and reopen width: PASS'

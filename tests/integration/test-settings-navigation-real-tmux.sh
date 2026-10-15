#!/usr/bin/env bash
# Main Settings tab, retained drafts on its active tab, and return-to-pane navigation.
set -euo pipefail
command -v tmux >/dev/null || { echo 'SKIP: tmux unavailable'; exit 77; }
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dir=$(mktemp -d /tmp/hud-settings-navigation.XXXXXX)
socket="$dir/tmux.sock"
t() { tmux -S "$socket" "$@"; }
cleanup() { t kill-server 2>/dev/null || true; rm -rf "$dir"; }
trap cleanup EXIT
main=$(t new-session -d -s navigation -x 180 -y 40 -P -F '#{pane_id}' 'sleep 120')
panel=$(t split-window -h -l 48 -t "$main" -d -P -F '#{pane_id}' \
  "env LC_ALL=C.UTF-8 CODEX_HOME='$dir' CODEX_HUD_SETTINGS_PATH='$dir/settings.json' CODEX_HUD_CWD='$dir' CODEX_HUD_MAIN_PANE='$main' node '$repo/dist/tree-page.js'")
command_panel() {
  # shellcheck disable=SC2046 # one word per byte
  t send-keys -t "$panel" -H $(printf '%s' $'\e_codex-hud:'"$1"$'\e\\' | od -An -v -tx1)
}
wait_text() {
  for ((n=0;n<200;n++)); do
    [[ "$(t capture-pane -p -t "$panel")" == *"$1"* ]] && return
    sleep 0.05
  done
  t capture-pane -p -t "$panel"; echo "FAIL: missing $1"; exit 1
}
click_tab() {
  t capture-pane -p -t "$panel" > "$dir/capture.txt"
  x=$(node --input-type=module - "$repo" "$dir/capture.txt" "$1" <<'NODE'
import fs from 'node:fs';
const {visualLength} = await import(`${process.argv[2]}/dist/render/colors.js`);
const line = fs.readFileSync(process.argv[3], 'utf8').split('\n')[0];
const start = line.indexOf(process.argv[4]);
if (start < 0) throw new Error(`Missing named tab ${process.argv[4]}: ${line}`);
console.log(visualLength(line.slice(0, start)) + 1);
NODE
)
  # shellcheck disable=SC2046 # one word per byte
  t send-keys -t "$panel" -H $(printf '\033[<0;%s;1M' "$x" | od -An -v -tx1)
}
selected_theme() { t capture-pane -p -t "$panel" | grep '^›.*Theme'; }
wait_text Settings
click_tab Settings
wait_text '[Back]'
baseline=$(selected_theme)
t send-keys -t "$panel" Right
for ((n=0;n<100;n++)); do
  draft=$(selected_theme)
  [[ "$draft" != "$baseline" ]] && break
  sleep 0.05
done
[[ "$draft" != "$baseline" ]] || { echo 'FAIL: theme draft did not change'; exit 1; }
click_tab Settings
sleep 0.15
[[ "$(selected_theme)" == "$draft" ]] || { echo 'FAIL: active Settings tab lost the draft/cursor'; exit 1; }
click_tab Agents
wait_text 'Unsaved settings'
t send-keys -t "$panel" Escape
wait_text '[Back]'
[[ "$(selected_theme)" == "$draft" ]] || { echo 'FAIL: cancelling leave lost the draft'; exit 1; }
click_tab Agents
wait_text 'Unsaved settings'
# Safe default is Continue editing; one Left chooses Discard changes.
t send-keys -t "$panel" Left Enter
for ((n=0;n<200;n++)); do
  capture=$(t capture-pane -p -t "$panel")
  [[ "$capture" != *'[Back]'* && "$capture" != *'Unsaved settings'* ]] && break
  sleep 0.05
done
capture=$(t capture-pane -p -t "$panel")
[[ "$capture" != *'[Back]'* && "$capture" == *'Agents'* ]] || { echo 'FAIL: Agents tab did not leave settings and keep Agents open'; exit 1; }
click_tab Settings
wait_text '[Back]'
[[ "$(selected_theme)" == "$baseline" ]] || { echo 'FAIL: leaving without Save did not discard the draft'; exit 1; }
# The explicit count switch persists independently of the child list and sentence switches.
for ((n=0;n<80;n++)); do
  if t capture-pane -p -t "$panel" | grep -q '^›.*Child role counts'; then break; fi
  t send-keys -t "$panel" Down
  sleep 0.05
done
t capture-pane -p -t "$panel" | grep -q '^›.*Child role counts' || { echo 'FAIL: count switch missing'; exit 1; }
t send-keys -t "$panel" Right
t send-keys -t "$panel" -l s
wait_text Saved
node --input-type=module - "$dir/settings.json" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(s.cardRoleCounts, false);
assert.equal(s.cardSubagents, true);
assert.equal(s.cardSubagentSummary, true);
NODE
echo 'Settings confirmation, navigation and independent child-count switch: PASS'

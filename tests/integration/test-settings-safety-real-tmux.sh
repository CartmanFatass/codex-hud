#!/usr/bin/env bash
# Synthetic settings only: presets, save-on-leave, failed saves, and safe group reset.
set -euo pipefail
command -v tmux >/dev/null || { echo 'SKIP: tmux unavailable'; exit 77; }
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dir=$(mktemp -d /tmp/hud-settings-safety.XXXXXX)
socket="$dir/tmux.sock"
t() { tmux -S "$socket" "$@"; }
cleanup() { chmod 700 "$dir" 2>/dev/null || true; t kill-server 2>/dev/null || true; rm -rf "$dir"; }
trap cleanup EXIT
printf '%s\n' '{"language":"en","briefing":"off","briefingApiBase":"http://synthetic.invalid/v1","briefingApiKey":"synthetic-only","modelCallsPerHour":240}' > "$dir/settings.json"
chmod 600 "$dir/settings.json"
main=$(t new-session -d -s safety -x 188 -y 40 -P -F '#{pane_id}' 'sleep 120')
panel=$(t split-window -h -l 48 -t "$main" -d -P -F '#{pane_id}' \
  "env LC_ALL=C.UTF-8 CODEX_HOME='$dir' CODEX_HUD_SETTINGS_PATH='$dir/settings.json' CODEX_HUD_CWD='$dir' CODEX_HUD_MAIN_PANE='$main' node '$repo/dist/tree-page.js'")
command_panel() {
  # shellcheck disable=SC2046 # one word per byte
  t send-keys -t "$panel" -H $(printf '%s' $'\e_codex-hud:'"$1"$'\e\\' | od -An -v -tx1)
}
capture() { t capture-pane -p -t "$panel"; }
wait_text() {
  for ((n=0;n<200;n++)); do [[ "$(capture)" == *"$1"* ]] && return; sleep 0.05; done
  capture; echo "FAIL: missing $1"; exit 1
}
select_row() {
  t send-keys -t "$panel" Home
  for ((n=0;n<90;n++)); do
    if capture | grep -q "^›.*$1"; then return; fi
    t send-keys -t "$panel" Down; sleep 0.04
  done
  capture; echo "FAIL: no selected row $1"; exit 1
}
wait_left() {
  for ((n=0;n<200;n++)); do
    text=$(capture)
    [[ "$text" != *'[Back]'* && "$text" != *'Unsaved settings'* ]] && return
    sleep 0.05
  done
  capture; echo 'FAIL: did not leave settings'; exit 1
}
click_changes() {
  capture > "$dir/capture.txt"
  x=$(node --input-type=module - "$repo" "$dir/capture.txt" <<'NODE'
import fs from 'node:fs';
const {visualLength}=await import(`${process.argv[2]}/dist/render/colors.js`);
const line=fs.readFileSync(process.argv[3],'utf8').split('\n')[0],at=line.indexOf('±');
if(at<0)throw new Error('Changes control missing');
console.log(visualLength(line.slice(0,at))+1);
NODE
)
  # shellcheck disable=SC2046 # one word per byte
  t send-keys -t "$panel" -H $(printf '\033[<0;%s;1M' "$x" | od -An -v -tx1)
}
command_panel settings; wait_text '[Back]'
select_row 'Card preset'
t send-keys -t "$panel" Right; wait_text 'minimal'
t send-keys -t "$panel" Escape; wait_text 'Unsaved settings'
# Enter on the safe default keeps the draft.
t send-keys -t "$panel" Enter; wait_text '[Back]'; wait_text 'minimal'
select_row Width
t send-keys -t "$panel" Right
click_changes; wait_text 'Unsaved settings'
t send-keys -t "$panel" -l s
wait_left
for ((n=0;n<200;n++)); do
  [[ "$(t display-message -p -t "$panel" '#{pane_width}')" == 56 ]] && break
  sleep 0.05
done
[[ "$(t display-message -p -t "$panel" '#{pane_width}')" == 56 ]] || { echo 'FAIL: saved width did not apply'; exit 1; }
capture | grep -q '^ ± Changes' || { capture; echo 'FAIL: saved navigation lost the destination'; exit 1; }
node --input-type=module - "$dir/settings.json" <<'NODE'
import fs from 'node:fs';import assert from 'node:assert/strict';
const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(s.treeWidth,56);assert.equal(s.cardSubagents,false);assert.equal(s.cardSummary,true);
assert.equal(s.modelCallsPerHour,240);assert.equal(s.briefingApiKey,'synthetic-only');assert.equal('cardPreset' in s,false);
NODE
# A failed save keeps both the pending decision and the draft.
command_panel settings; wait_text '[Back]'; select_row 'Card preset'
t send-keys -t "$panel" Right; wait_text 'progress'
t send-keys -t "$panel" Escape; wait_text 'Unsaved settings'
# A directory at the file path fails even on a root-run CI container.
mv "$dir/settings.json" "$dir/settings-backup.json"
mkdir "$dir/settings.json"
t send-keys -t "$panel" -l s
wait_text 'Save failed:'
t send-keys -t "$panel" Escape; wait_text '[Back]'; wait_text 'progress'
rmdir "$dir/settings.json"
mv "$dir/settings-backup.json" "$dir/settings.json"
node --input-type=module - "$dir/settings.json" <<'NODE'
import fs from 'node:fs';import assert from 'node:assert/strict';
assert.equal(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).cardSubagents,false);
NODE
# Save succeeds after path recovery, then LLM group reset must preserve connection/cap.
t send-keys -t "$panel" -l s; wait_text Saved
select_row Backend
t send-keys -t "$panel" -l r
t send-keys -t "$panel" -l s; wait_text Saved
node --input-type=module - "$dir/settings.json" <<'NODE'
import fs from 'node:fs';import assert from 'node:assert/strict';
const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(s.briefing,'off');assert.equal(s.briefingApiBase,'http://synthetic.invalid/v1');
assert.equal(s.briefingApiKey,'synthetic-only');assert.equal(s.modelCallsPerHour,240);
assert.equal(s.briefingPaused,true);assert.equal(s.agentProgress,false);
assert.equal(s.cardSubagents,true);assert.equal(s.cardSubagentSummary,true);assert.equal(s.treeWidth,56);
NODE
echo 'Settings safe leave, preset save, width destination and reset privacy: PASS'

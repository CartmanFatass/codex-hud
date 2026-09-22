#!/usr/bin/env bash
# Real-tmux integration test for clicking the status bar.
#
# The bar is a row of separate fields, so a click on it is not one gesture.
# What this pins down, against a real tmux server and a real state file:
#   - the alert / agents / hint columns open the panel AND focus it
#   - the meter columns open the panel and leave the cursor in Codex
#   - a meter click on an already-open panel changes nothing
#   - padding between fields still toggles, as the whole bar used to
#   - a missing, empty or malformed state file falls back to toggling
#
# Requires a real tmux and a build (dist/utils/click-map.js); SKIPs otherwise.

set -uo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux not available"
  exit 77
fi
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not available"
  exit 77
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOGGLE="$REPO_DIR/bin/codex-hud-toggle"
if [[ ! -r "$REPO_DIR/dist/utils/click-map.js" ]]; then
  echo "SKIP: dist/utils/click-map.js missing; run npm run build"
  exit 77
fi

SOCKET="codex-hud-bar-click-test"
t() { tmux -L "$SOCKET" "$@"; }

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok  - $1"; }
bad() { FAIL=$((FAIL+1)); echo "BAD - $1"; }
assert_eq() {
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected [$3], got [$2])"; fi
}

FAKE_HOME=""
cleanup() {
  t kill-server 2>/dev/null || true
  [[ -n "$FAKE_HOME" ]] && rm -rf "$FAKE_HOME"
}
trap cleanup EXIT
t kill-server 2>/dev/null || true

FAKE_HOME=$(mktemp -d)
get_opt() { t show-option -t "$1" -qv "$2" 2>/dev/null || true; }
session_id() { t display-message -p -t "$1" '#{session_id}' 2>/dev/null | tr -d '\r\n'; }
active_pane() { t display-message -p -t "$1" '#{pane_id}' 2>/dev/null | tr -d '\r\n'; }

t new-session -d -s bar -x 200 -y 40 'sleep 300' || { echo "BAD - cannot start tmux server"; exit 1; }
export TMUX="$(t display-message -p '#{socket_path}'),$$,%0"

MAIN=$(t list-panes -t bar -F '#{pane_id}' | head -1)
t set-option -t bar @codex_hud_cwd "$REPO_DIR"
t set-option -t bar @codex_hud_main_pane "$MAIN"
t set-option -t bar @codex_hud_height 1
t set-option -t bar @codex_hud_mode "single"
t set-option -t bar @codex_hud_session_start "1234567890"
t set-option -t bar @codex_hud_codex_home "$FAKE_HOME"
t set-option -t bar @codex_hud_statusline "0"
SID=$(session_id bar)

# The state file the HUD would have written for this session, named the way
# src/snapshot.ts names it.
STATE_DIR="$FAKE_HOME/hud/state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/bar.json"
write_state() {
  cat > "$STATE_FILE" <<'JSON'
{
  "version": 1,
  "updatedAt": "2026-03-01T12:00:00.000Z",
  "bar": {
    "width": 80,
    "segments": [
      { "id": "attention", "level": "short", "x": 0, "width": 10 },
      { "id": "identity", "level": "full", "x": 13, "width": 8 },
      { "id": "context", "level": "short", "x": 24, "width": 12 },
      { "id": "agents", "level": "min", "x": 40, "width": 9 },
      { "id": "hint", "level": "short", "x": 56, "width": 3 }
    ]
  }
}
JSON
}
write_state

click() { bash "$TOGGLE" "$SID" --click "$1"; }
close_panel() {
  if [[ "$(get_opt bar @codex_hud_mode)" == "tree" ]]; then
    bash "$TOGGLE" "$SID"
  fi
}

# --------------------------------------------- C1: the alert opens and focuses
close_panel
click 3
assert_eq "C1 alert column opens the panel" "$(get_opt bar @codex_hud_mode)" "tree"
assert_eq "C1 alert column focuses the panel" "$(active_pane bar)" "$(get_opt bar @codex_hud_tree_pane)"

# --------------------------------------------- C2: agents and hint do the same
close_panel
t select-pane -t "$MAIN"
click 44
assert_eq "C2 agents column opens the panel" "$(get_opt bar @codex_hud_mode)" "tree"
assert_eq "C2 agents column focuses the panel" "$(active_pane bar)" "$(get_opt bar @codex_hud_tree_pane)"

close_panel
t select-pane -t "$MAIN"
click 57
assert_eq "C2 hint column focuses the panel" "$(active_pane bar)" "$(get_opt bar @codex_hud_tree_pane)"

# --------------------------------------------- C3: a meter opens without focus
close_panel
t select-pane -t "$MAIN"
click 26
assert_eq "C3 context column opens the panel" "$(get_opt bar @codex_hud_mode)" "tree"
assert_eq "C3 context column leaves the cursor in Codex" "$(active_pane bar)" "$MAIN"

# --------------------------------------------- C4: clicking it again is a no-op
TREE_PANE=$(get_opt bar @codex_hud_tree_pane)
click 26
assert_eq "C4 a second meter click keeps the panel open" "$(get_opt bar @codex_hud_mode)" "tree"
assert_eq "C4 a second meter click reuses the pane" "$(get_opt bar @codex_hud_tree_pane)" "$TREE_PANE"
assert_eq "C4 a second meter click still leaves Codex focused" "$(active_pane bar)" "$MAIN"

# --------------------------------------------- C5: padding toggles, as before
click 11
assert_eq "C5 a click between fields closes the panel" "$(get_opt bar @codex_hud_mode)" "single"
click 11
assert_eq "C5 and opens it again" "$(get_opt bar @codex_hud_mode)" "tree"
assert_eq "C5 a toggle leaves the cursor in Codex" "$(active_pane bar)" "$MAIN"

# --------------------------------------------- C6: an unnamed field toggles too
close_panel
click 15
assert_eq "C6 a field with no panel behind it toggles" "$(get_opt bar @codex_hud_mode)" "tree"
assert_eq "C6 and does not take the keyboard" "$(active_pane bar)" "$MAIN"

# --------------------------------------------- C7: no usable state, old meaning
for broken in "missing" "" "not json" '{"bar":{"segments":[]}}'; do
  close_panel
  if [[ "$broken" == "missing" ]]; then rm -f "$STATE_FILE"; else printf '%s' "$broken" > "$STATE_FILE"; fi
  click 3   # would be open-focus with a good snapshot
  assert_eq "C7 [$broken] still opens" "$(get_opt bar @codex_hud_mode)" "tree"
  assert_eq "C7 [$broken] does not take the keyboard" "$(active_pane bar)" "$MAIN"
  click 3
  assert_eq "C7 [$broken] still closes" "$(get_opt bar @codex_hud_mode)" "single"
done
write_state

# --------------------------------------------- C8: a non-numeric column toggles
close_panel
bash "$TOGGLE" "$SID" --click 'not-a-column'
assert_eq "C8 a column that is not a number toggles" "$(get_opt bar @codex_hud_mode)" "tree"
assert_eq "C8 and does not take the keyboard" "$(active_pane bar)" "$MAIN"

echo "----------------------------------------"
echo "pass=$PASS fail=$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
echo "test-bar-click: PASS"

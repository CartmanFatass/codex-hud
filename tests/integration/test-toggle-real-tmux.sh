#!/usr/bin/env bash
# Real-tmux integration test for the HUD layout toggle and the in-pane HUD.
#
# Covers the parts of the review checklist that can be scripted:
#   - single <-> tree round trip (compact HUD stays while the panel is up)
#   - toggle-back restores the persisted launch context (session start etc.)
#   - concurrent double-press stays consistent (no orphan panes)
#   - stale pane references self-heal (panel or bottom killed externally)
#   - a dead main-pane reference is a graceful no-op
#   - two sessions do not interfere with each other
#   - the real HUD process renders the active subagent tree in a pane and
#     auto-resizes its pane to fit the levels
#
# Requires a real tmux binary; SKIPS (exit 0) when tmux is unavailable, so the
# Windows-side suite stays green. Run it where tmux exists, e.g.:
#   wsl.exe -d Ubuntu-24.04 -- bash -lc \
#     'cd /mnt/c/.../codex-hud && bash tests/integration/test-toggle-real-tmux.sh'

set -uo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux not available"
  exit 0
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOGGLE="$REPO_DIR/bin/codex-hud-toggle"
SOCKET="codex-hud-toggle-test"
t() { tmux -L "$SOCKET" "$@"; }

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok  - $1"; }
bad() { FAIL=$((FAIL+1)); echo "BAD - $1"; }
assert_eq() {
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected [$3], got [$2])"; fi
}
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 (missing [$3] in [$2])"; fi
}
assert_not_contains() {
  if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1 (unexpected [$3])"; fi
}

cleanup() { t kill-server 2>/dev/null || true; }
trap cleanup EXIT
cleanup

get_opt() { t show-option -t "$1" -qv "$2" 2>/dev/null || true; }
pane_count() { t list-panes -t "$1" 2>/dev/null | wc -l | tr -d ' '; }
session_id() { t display-message -p -t "$1" '#{session_id}' 2>/dev/null | tr -d '\r\n'; }
pane_alive() {
  [[ -n "${1:-}" ]] || return 1
  local got
  got=$(t display-message -p -t "$1" '#{pane_id}' 2>/dev/null || true)
  [[ "$got" == "$1" ]]
}

# ---------------------------------------------------------------- test setup
t new-session -d -s s1 -x 200 -y 40 'sleep 300' || { echo "BAD - cannot start tmux server"; exit 1; }
t new-session -d -s s2 -x 200 -y 40 'sleep 300'
# The toggle script talks to the server that owns the session. Inside a real
# pane tmux provides TMUX automatically; standalone runs must point it at the
# test server explicitly.
export TMUX="$(t display-message -p '#{socket_path}'),$$,%0"

setup_session() {
  local sid="$1"
  local main
  main=$(t list-panes -t "$sid" -F '#{pane_id}' | head -1)
  local envfile="/tmp/codex-hud-test-env-${sid//\$/pct}.txt"
  rm -f "$envfile"
  t set-option -t "$sid" @codex_hud_cwd "$REPO_DIR"
  t set-option -t "$sid" @codex_hud_main_pane "$main"
  t set-option -t "$sid" @codex_hud_height 2
  t set-option -t "$sid" @codex_hud_mode "single"
  t set-option -t "$sid" @codex_hud_session_start "1234567890"
  t set-option -t "$sid" @codex_hud_codex_home "/tmp/codex-hud-test-home"
  local hud
  hud=$(t split-window -v -l 2 -t "$main" -d -P -F '#{pane_id}' "sleep 300")
  t set-option -t "$sid" @codex_hud_pane "$hud"
  # Mimic the persisted launch command exactly as bin/codex-hud stores it:
  # the launch context is embedded in the command itself, so recreating the
  # pane from it restores the environment verbatim.
  t set-option -t "$sid" @codex_hud_hud_cmd \
    "env CODEX_HUD_CWD='$REPO_DIR' CODEX_HUD_SESSION_START=1234567890 CODEX_HUD_MAIN_PANE='$main' sh -c 'env > \"$envfile\"; exec sleep 300'"
  echo "$envfile"
}

ENVS1=$(setup_session s1)
ENVS2=$(setup_session s2)

toggle() { bash "$TOGGLE" "$(session_id "$1")"; }

# ------------------------------------------------- T1: single -> tree
S1_HUD=$(get_opt s1 @codex_hud_pane)
toggle s1
assert_eq "T1 mode becomes tree" "$(get_opt s1 @codex_hud_mode)" "tree"
assert_eq "T1 pane count (main + HUD + panel)" "$(pane_count s1)" "3"
if pane_alive "$(get_opt s1 @codex_hud_tree_pane)"; then ok "T1 tree pane reference is alive"; else bad "T1 tree pane reference is alive"; fi
if pane_alive "$(get_opt s1 @codex_hud_pane)"; then ok "T1 compact HUD stays"; else bad "T1 compact HUD stays"; fi
assert_eq "T1 compact HUD pane is reused" "$(get_opt s1 @codex_hud_pane)" "$S1_HUD"

# ------------------------------------------------- T2: tree -> single
toggle s1
assert_eq "T2 mode becomes single" "$(get_opt s1 @codex_hud_mode)" "single"
assert_eq "T2 pane count (main + bottom)" "$(pane_count s1)" "2"
if pane_alive "$(get_opt s1 @codex_hud_pane)"; then ok "T2 compact HUD still alive"; else bad "T2 compact HUD still alive"; fi
assert_eq "T2 compact HUD pane is reused" "$(get_opt s1 @codex_hud_pane)" "$S1_HUD"
# Compact HUD is reused on a clean round-trip, so the persisted launch
# command is not re-execed here. Recreate-from-hud_cmd is covered in T5.

# ------------------------------------------------- T3: concurrent double-press
( toggle s1 ) & ( toggle s1 ) & wait
mode_after_double=$(get_opt s1 @codex_hud_mode)
assert_eq "T3 mode stays consistent after double-press" "$mode_after_double" "single"
assert_eq "T3 no orphan panes after double-press" "$(pane_count s1)" "2"
if [[ "$mode_after_double" == "tree" ]]; then
  if pane_alive "$(get_opt s1 @codex_hud_tree_pane)"; then ok "T3 tree reference alive in tree mode"; else bad "T3 tree reference alive in tree mode"; fi
else
  if pane_alive "$(get_opt s1 @codex_hud_pane)"; then ok "T3 bottom reference alive in single mode"; else bad "T3 bottom reference alive in single mode"; fi
fi

# ------------------------------------------------- T4: stale panel reference
toggle s1                       # -> tree
t kill-pane -t "$(get_opt s1 @codex_hud_tree_pane)" 2>/dev/null || true
toggle s1                       # should self-heal: recreate bottom, clear ref
assert_eq "T4 mode returns to single with stale panel ref" "$(get_opt s1 @codex_hud_mode)" "single"
assert_eq "T4 pane count after self-heal" "$(pane_count s1)" "2"
if pane_alive "$(get_opt s1 @codex_hud_pane)"; then ok "T4 bottom HUD alive after self-heal"; else bad "T4 bottom HUD alive after self-heal"; fi

# ------------------------------------------------- T5: stale bottom reference
t kill-pane -t "$(get_opt s1 @codex_hud_pane)" 2>/dev/null || true
rm -f "$ENVS1"
toggle s1                       # should recreate compact HUD and open the panel
assert_eq "T5 mode becomes tree with stale bottom ref" "$(get_opt s1 @codex_hud_mode)" "tree"
assert_eq "T5 pane count with stale bottom ref" "$(pane_count s1)" "3"
if pane_alive "$(get_opt s1 @codex_hud_pane)"; then ok "T5 compact HUD recreated"; else bad "T5 compact HUD recreated"; fi
for _ in $(seq 1 20); do
  [[ -s "$ENVS1" ]] && break
  sleep 0.3
done
RECREATED_ENV=$(cat "$ENVS1" 2>/dev/null || true)
assert_contains "T5 recreated env keeps CODEX_HUD_SESSION_START" "$RECREATED_ENV" "CODEX_HUD_SESSION_START=1234567890"
assert_contains "T5 recreated env keeps CODEX_HUD_CWD" "$RECREATED_ENV" "CODEX_HUD_CWD=$REPO_DIR"
assert_contains "T5 recreated env keeps CODEX_HUD_MAIN_PANE" "$RECREATED_ENV" "CODEX_HUD_MAIN_PANE=%"
toggle s1                       # and back
assert_eq "T5 back to single" "$(get_opt s1 @codex_hud_mode)" "single"

# ------------------------------------------------- T6: dead main pane = no-op
REAL_MAIN_S1=$(get_opt s1 @codex_hud_main_pane)
t set-option -t s1 @codex_hud_main_pane "%999999"
toggle s1
assert_eq "T6 dead main pane leaves mode untouched" "$(get_opt s1 @codex_hud_mode)" "single"
assert_eq "T6 dead main pane leaves panes untouched" "$(pane_count s1)" "2"
t set-option -t s1 @codex_hud_main_pane "$REAL_MAIN_S1"

# ------------------------------------------------- T7: dual-session isolation
toggle s2
assert_eq "T7 s2 in tree mode" "$(get_opt s2 @codex_hud_mode)" "tree"
assert_eq "T7 s1 untouched (still single)" "$(get_opt s1 @codex_hud_mode)" "single"
assert_eq "T7 s2 pane count" "$(pane_count s2)" "3"
assert_eq "T7 s1 pane count" "$(pane_count s1)" "2"
toggle s2
assert_eq "T7 s2 back to single" "$(get_opt s2 @codex_hud_mode)" "single"

# ------------------------------------------------- T8: compact HUD stays one line
# Uses a fresh session so leftover state from T1-T7 cannot mask regressions.
t new-session -d -s s3 -x 200 -y 40 'sleep 300'
FAKE_HOME=$(mktemp -d)
FAKE_CWD=$(mktemp -d)
DATE_DIR="$FAKE_HOME/sessions/$(date +%Y)/$(date +%m)/$(date +%d)"
mkdir -p "$DATE_DIR"
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
STAMP=$(date +%Y-%m-%dT%H-%M-%S)
R1="aaaaaaaa-0000-4000-8000-000000000001"
R2="aaaaaaaa-0000-4000-8000-000000000002"
printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","timestamp":"%s","cwd":"%s","originator":"codex-tui","source":"cli","thread_source":"user"}}\n' \
  "$NOW_ISO" "$R1" "$NOW_ISO" "$FAKE_CWD" > "$DATE_DIR/rollout-$STAMP-$R1.jsonl"
printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","parent_thread_id":"%s","agent_nickname":"TmuxChild","timestamp":"%s","cwd":"%s","source":"cli","thread_source":"subagent"}}\n' \
  "$NOW_ISO" "$R2" "$R1" "$NOW_ISO" "$FAKE_CWD" > "$DATE_DIR/rollout-$STAMP-$R2.jsonl"

S3_MAIN=$(t list-panes -t s3 -F '#{pane_id}' | head -1)
T8_ENVFILE=$(mktemp)
HUD_PANE=$(t split-window -v -l 1 -t "$S3_MAIN" -d -P -F '#{pane_id}' \
  "sh -c 'env > \"$T8_ENVFILE\"; exec env CODEX_HOME=$FAKE_HOME CODEX_HUD_CWD=$FAKE_CWD node $REPO_DIR/dist/index.js'")
HEIGHT_OK=0
HEADER_OK=0
for _ in $(seq 1 30); do
  CAPTURE=$(t capture-pane -p -t "$HUD_PANE" 2>/dev/null || true)
  if [[ "$(t display-message -p -t "$HUD_PANE" '#{pane_height}')" == "1" ]]; then
    HEIGHT_OK=1
  fi
  if [[ -n "$CAPTURE" && "$CAPTURE" != *"TmuxChild"* ]]; then
    HEADER_OK=1
  fi
  [[ "$HEIGHT_OK" == 1 && "$HEADER_OK" == 1 ]] && break
  sleep 0.5
done
assert_eq "T8 compact HUD stays 1 row" "$HEIGHT_OK" "1"
assert_eq "T8 compact HUD hides subagent names" "$HEADER_OK" "1"
CAPTURE=$(t capture-pane -p -t "$HUD_PANE" 2>/dev/null || true)
assert_not_contains "T8 does not render subagents on the compact line" "$CAPTURE" "TmuxChild"

# ------------------------------------------------- T9: F12 keeps compact content; tree shows model/effort glyphs
printf '{"timestamp":"%s","type":"turn_context","payload":{"model":"gpt-5.6-luna","effort":"medium","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-luna","reasoning_effort":"medium"}}}}\n' \
  "$NOW_ISO" >> "$DATE_DIR/rollout-$STAMP-$R2.jsonl"
t set-option -t s3 @codex_hud_cwd "$FAKE_CWD"
t set-option -t s3 @codex_hud_main_pane "$S3_MAIN"
t set-option -t s3 @codex_hud_height 1
t set-option -t s3 @codex_hud_mode "single"
t set-option -t s3 @codex_hud_session_start "$(date +%s)"
t set-option -t s3 @codex_hud_codex_home "$FAKE_HOME"
t set-option -t s3 @codex_hud_pane "$HUD_PANE"
t set-option -t s3 @codex_hud_hud_cmd \
  "env CODEX_HOME=$FAKE_HOME CODEX_HUD_CWD=$FAKE_CWD node $REPO_DIR/dist/index.js"
toggle s3
assert_eq "T9 mode becomes tree" "$(get_opt s3 @codex_hud_mode)" "tree"
assert_eq "T9 pane count (main + HUD + panel)" "$(pane_count s3)" "3"
if pane_alive "$(get_opt s3 @codex_hud_pane)"; then ok "T9 compact HUD stays after F12"; else bad "T9 compact HUD stays after F12"; fi
assert_eq "T9 compact HUD pane is reused" "$(get_opt s3 @codex_hud_pane)" "$HUD_PANE"
COMPACT_OK=0
TREE_OK=0
TREE_PANE=$(get_opt s3 @codex_hud_tree_pane)
for _ in $(seq 1 30); do
  HUD_CAPTURE=$(t capture-pane -p -t "$HUD_PANE" 2>/dev/null || true)
  TREE_CAPTURE=$(t capture-pane -p -t "$TREE_PANE" 2>/dev/null || true)
  if [[ "$HUD_CAPTURE" == *"Ctx"* || "$HUD_CAPTURE" == *"Plan"* || "$HUD_CAPTURE" == *"mode:"* ]]; then
    COMPACT_OK=1
  fi
  if [[ "$TREE_CAPTURE" == *"TmuxChild"* && "$TREE_CAPTURE" == *"☽"* && "$TREE_CAPTURE" == *"◐"* ]]; then
    TREE_OK=1
  fi
  [[ "$COMPACT_OK" == 1 && "$TREE_OK" == 1 ]] && break
  sleep 0.5
done
HUD_CAPTURE=$(t capture-pane -p -t "$HUD_PANE" 2>/dev/null || true)
TREE_CAPTURE=$(t capture-pane -p -t "$TREE_PANE" 2>/dev/null || true)
assert_eq "T9 compact HUD still shows status after F12" "$COMPACT_OK" "1"
assert_not_contains "T9 compact HUD still hides subagent names" "$HUD_CAPTURE" "TmuxChild"
assert_eq "T9 tree shows subagent with model/effort glyphs" "$TREE_OK" "1"
assert_contains "T9 tree lists the subagent" "$TREE_CAPTURE" "TmuxChild"

echo "----------------------------------------"
echo "pass=$PASS fail=$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
echo "test-toggle-real-tmux: PASS"

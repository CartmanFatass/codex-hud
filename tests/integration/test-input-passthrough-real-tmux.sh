#!/usr/bin/env bash
# Real-tmux checks that HUD mouse/key routing leaves Codex in control of its
# own input: compact-bar clicks never keep focus, wheel is forwarded, and a
# key that lands on the 1-line HUD is replayed into the Codex pane.
set -uo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux not available"
  exit 0
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOCKET="codex-hud-input-passthrough-test"
t() { tmux -L "$SOCKET" "$@"; }

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok  - $1"; }
bad() { FAIL=$((FAIL+1)); echo "BAD - $1"; }

cleanup() { t kill-server 2>/dev/null || true; }
trap cleanup EXIT
cleanup

t new-session -d -s s -x 120 -y 40 'sleep 300' || { echo "BAD - cannot start tmux server"; exit 1; }
MAIN=$(t list-panes -t s -F '#{pane_id}' | head -1)
HUD=$(t split-window -v -l 1 -t "$MAIN" -d -P -F '#{pane_id}' 'sleep 300')
t set-option -t s @codex_hud_main_pane "$MAIN"
t set-option -t s @codex_hud_pane "$HUD"
t set-option -t s mouse on
TOGGLE="$REPO_DIR/bin/codex-hud-toggle"

# Exercise the actual wrapper policy instead of maintaining a second copy.
export TMUX="$(t display-message -p '#{socket_path}'),$$,%0"
PASTE="$REPO_DIR/bin/codex-hud-paste"
source <(sed -n '/^install_session_input_policy() {/,/^}/p' "$REPO_DIR/bin/codex-hud")
install_session_input_policy s "$TOGGLE"

DOWN1=$(t list-keys -T codex-hud MouseDown1Pane)
WHEEL=$(t list-keys -T codex-hud WheelUpPane)
RIGHT=$(t list-keys -T codex-hud MouseDown3Pane)
DRAG=$(t list-keys -T codex-hud MouseDrag1Pane)
# A click on the compact bar carries the column it landed on, because which
# field was under the cursor decides what happens. Focus is then the toggle
# script's job in every branch: the binding must not pull the cursor back to
# Codex, or a click meant to hand the panel the keyboard would lose it again.
if [[ "$DOWN1" == *"@codex_hud_pane"* && "$DOWN1" == *'--click #{mouse_x}'* &&
      "$DOWN1" != *"select-pane -t '#{@codex_hud_main_pane}'"* ]]; then
  ok "MouseDown1Pane hands the clicked column to the toggle script"
else
  bad "MouseDown1Pane hands the clicked column to the toggle script ($DOWN1)"
fi
# The compact bar itself is still never a focus target.
if [[ "$DOWN1" != *"select-pane -t '#{@codex_hud_pane}'"* && "$DOWN1" != *"select-pane -t #{@codex_hud_pane}"* ]]; then
  ok "MouseDown1Pane never focuses the compact bar itself"
else
  bad "MouseDown1Pane never focuses the compact bar itself ($DOWN1)"
fi
if [[ "$WHEEL" == *"send-keys -t= -M"* || "$WHEEL" == *"send-keys -t = -M"* ]]; then
  ok "WheelUpPane forwards to the pane under the cursor"
else
  bad "WheelUpPane forwards to the pane under the cursor ($WHEEL)"
fi
if [[ "$RIGHT" == *"codex-hud-paste"* && "$RIGHT" != *"display-menu"* ]]; then
  ok "right-click pastes instead of opening the tmux pane menu"
else
  bad "right-click pastes instead of opening the tmux pane menu ($RIGHT)"
fi
if [[ "$DRAG" == *"copy-mode -M"* && "$DRAG" != *"-Mt="* ]]; then
  ok "drag selects text when the pane is not capturing mouse"
else
  bad "drag selects text when the pane is not capturing mouse ($DRAG)"
fi

ERR=$(mktemp)
t select-pane -t "$HUD"
t run-shell "tmux select-pane -t #{@codex_hud_main_pane}" 2>"$ERR"
FOCUS_ACTIVE=$(t display-message -p -t s '#{pane_id}')
FOCUS_ERR=$(cat "$ERR" 2>/dev/null || true)
if [[ "$FOCUS_ACTIVE" == "$MAIN" && "$FOCUS_ERR" != *"can't find pane"* && "$FOCUS_ERR" != *"syntax error"* ]]; then
  ok "run-shell can focus the Codex pane id without tmux errors"
else
  bad "run-shell can focus the Codex pane id without tmux errors (active=$FOCUS_ACTIVE err=[$FOCUS_ERR])"
fi
rm -f "$ERR"

export TMUX="$(t display-message -p '#{socket_path}'),$$,%0"
PASTE_OUT="$(mktemp)"
PASTE_READER="$(mktemp)"
cat > "$PASTE_READER" <<PY
import sys, tty
tty.setcbreak(sys.stdin.fileno())
out = open("$PASTE_OUT", "wb", buffering=0)
while True:
    byte = sys.stdin.buffer.read(1)
    if not byte:
        break
    out.write(byte)
PY
PASTE_PANE=$(t split-window -h -t "$MAIN" -P -F '#{pane_id}' "python3 '$PASTE_READER'")
t set-buffer 'paste-ok'
sleep 0.2
bash "$PASTE" "$PASTE_PANE"
pasted=""
for _ in $(seq 1 20); do
  pasted=$(cat "$PASTE_OUT" 2>/dev/null || true)
  [[ -n "$pasted" ]] && break
  sleep 0.1
done
if [[ "$pasted" == *paste-ok* ]]; then
  ok "codex-hud-paste injects the tmux buffer into the target pane"
else
  bad "codex-hud-paste injects the tmux buffer into the target pane (got [$pasted])"
fi
t kill-pane -t "$PASTE_PANE" 2>/dev/null || true
rm -f "$PASTE_OUT" "$PASTE_READER"

# Compact HUD process must replay keys into Codex instead of swallowing them.
if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
  echo "SKIP key-forward: dist/index.js is not built"
else
  KEYS_FILE="$(mktemp)"
  KEYS_READER="$(mktemp)"
  cat > "$KEYS_READER" <<PY
import sys, tty
tty.setcbreak(sys.stdin.fileno())
out = open("$KEYS_FILE", "wb", buffering=0)
while True:
    byte = sys.stdin.buffer.read(1)
    if not byte:
        break
    out.write(byte)
PY
  t kill-pane -t "$MAIN" 2>/dev/null || true
  MAIN=$(t split-window -v -l 20 -t "$HUD" -b -P -F '#{pane_id}' "python3 '$KEYS_READER'")
  t set-option -t s @codex_hud_main_pane "$MAIN"
  t kill-pane -t "$HUD" 2>/dev/null || true
  HUD=$(t split-window -v -l 1 -t "$MAIN" -P -F '#{pane_id}' \
    "CODEX_HUD_CWD='$REPO_DIR' CODEX_HUD_MAIN_PANE='$MAIN' node '$REPO_DIR/dist/index.js'")
  t select-pane -t "$HUD"
  # Give the HUD process time to enter raw mode and attach its stdin listener.
  for _ in $(seq 1 20); do
    if t list-panes -t s -F '#{pane_id} #{pane_current_command}' | grep -q "node"; then
      break
    fi
    sleep 0.1
  done
  t send-keys -t "$HUD" -l 'hello'
  forwarded=""
  for _ in $(seq 1 20); do
    forwarded=$(cat "$KEYS_FILE" 2>/dev/null || true)
    [[ -n "$forwarded" ]] && break
    sleep 0.1
  done
  if [[ "$forwarded" == *hello* ]]; then
    ok "compact HUD replays keys into the Codex pane"
  else
    bad "compact HUD replays keys into the Codex pane (got [$forwarded])"
  fi
  ACTIVE=$(t display-message -p -t s '#{pane_id}')
  if [[ "$ACTIVE" == "$MAIN" ]]; then
    ok "compact HUD returns focus to Codex after a keypress"
  else
    bad "compact HUD returns focus to Codex after a keypress (active=$ACTIVE main=$MAIN)"
  fi
  rm -f "$KEYS_FILE" "$KEYS_READER"
fi

echo "passed=$PASS failed=$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
echo "test-input-passthrough-real-tmux: PASS"

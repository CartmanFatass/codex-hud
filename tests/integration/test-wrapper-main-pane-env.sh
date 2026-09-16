#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
FAKE_BIN_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$FAKE_BIN_DIR"
}
trap cleanup EXIT

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.0.0"
  exit 0
fi
exit 0
FAKE

cat > "$FAKE_BIN_DIR/npm" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/tput" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "lines" ]]; then
  echo "24"
  exit 0
fi
if [[ "${1:-}" == "cols" ]]; then
  echo "80"
  exit 0
fi
echo "0"
FAKE

chmod +x "$FAKE_BIN_DIR/codex" "$FAKE_BIN_DIR/node" "$FAKE_BIN_DIR/npm" "$FAKE_BIN_DIR/tput"

export PATH="$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
export CODEX_HUD_HEIGHT="5"
export CODEX_HUD_HEIGHT_AUTO="0"

log_file="$(mktemp)"
export TMUX_LOG_FILE="$log_file"
export TMUX_MAIN_PANE_ID="%1"
export TMUX_PANE_ID="%2"
export TMUX_PANES=$'%1\n%2'
export TMUX_SPLIT_PANE_ID="%2"
export TMUX_BASE_HEIGHT="5"
export TMUX_HEIGHT="5"
export TMUX_HEIGHT_MIN="5"
export TMUX_HEIGHT_MAX="12"
export TMUX_AUTO="0"
export TMUX_PANE_WIDTH="120"
export TMUX_PANE_HEIGHT="5"
export TMUX_MAIN_PANE_IN_MODE="0"
export TMUX_REJECT_TARGET_0="1"

"$ROOT_DIR/bin/codex-hud" >/tmp/codex-hud-main-pane-test.log 2>&1

if ! grep -q '^split-window ' "$log_file"; then
  echo "expected split-window command in fake tmux log" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "CODEX_HUD_MAIN_PANE='%1'" "$log_file"; then
  echo "expected HUD command to include CODEX_HUD_MAIN_PANE for pane-bound session resolution" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "CODEX_HOME=" "$log_file"; then
  echo "expected Codex and HUD launch commands to set CODEX_HOME" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "send-keys .*CODEX_HOME=" "$log_file"; then
  echo "expected Linux main pane command to prefix CODEX_HOME" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "bind-key -T root F12 if-shell" "$log_file"; then
  echo "expected F12 to be gated on HUD sessions instead of an unconditional root bind" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "bind-key -T root MouseDown1Pane if-shell" "$log_file"; then
  echo "expected HUD mouse clicks to be gated so they do not steal Codex input" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "bind-key -T root WheelUpPane if-shell" "$log_file"; then
  echo "expected HUD wheel events to be forwarded to the pane under the cursor" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "bind-key -T root MouseDown3Pane if-shell" "$log_file"; then
  echo "expected right-click to paste instead of opening the tmux pane menu" >&2
  cat "$log_file" >&2
  exit 1
fi

if grep -qF "select-pane -t '#{@codex_hud_main_pane}'" "$log_file"; then
  echo "pane ids must not be used as bind-key -t '#{@codex_hud_main_pane}' (tmux cannot find that pane)" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -qF 'tmux select-pane -t #{@codex_hud_main_pane}' "$log_file"; then
  echo "expected Codex focus to go through run-shell so % pane ids survive" >&2
  cat "$log_file" >&2
  exit 1
fi

if grep -q "display-menu" "$log_file"; then
  echo "HUD mouse binds must not open the tmux pane menu" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "extended-keys=on" "$log_file"; then
  echo "expected HUD sessions to enable tmux extended-keys for Codex shortcuts" >&2
  cat "$log_file" >&2
  exit 1
fi

if ! grep -q "set-option -t .* status off" "$log_file"; then
  echo "expected HUD sessions to disable the tmux status bar" >&2
  cat "$log_file" >&2
  exit 1
fi

echo "test-wrapper-main-pane-env: PASS"

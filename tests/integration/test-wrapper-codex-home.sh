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
[[ "${1:-}" == "--version" ]] && { echo "v20.0.0"; exit 0; }
exit 0
FAKE
cat > "$FAKE_BIN_DIR/npm" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
cat > "$FAKE_BIN_DIR/tput" <<'FAKE'
#!/usr/bin/env bash
[[ "${1:-}" == "lines" ]] && { echo 24; exit 0; }
[[ "${1:-}" == "cols" ]] && { echo 80; exit 0; }
echo 0
FAKE
chmod +x "$FAKE_BIN_DIR"/*

export PATH="$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
export CODEX_HUD_HEIGHT="5"
export CODEX_HUD_HEIGHT_AUTO="0"
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

run_with_home() {
  local home="$1"
  local log
  log="$(mktemp)"
  export TMUX_LOG_FILE="$log"
  export CODEX_HOME="$home"
  "$ROOT_DIR/bin/codex-hud" >/tmp/codex-hud-codex-home-test.log 2>&1 || true
  printf '%s\n' "$log"
}

home_a="$(mktemp -d)"
home_b="$(mktemp -d)"
log_a=$(run_with_home "$home_a")
log_b=$(run_with_home "$home_b")

if ! grep -q "CODEX_HOME=$(printf '%q' "$(realpath -m "$home_a")")" "$log_a" \
  && ! grep -Fq "CODEX_HOME=$home_a" "$log_a"; then
  echo "expected account A CODEX_HOME in launch commands" >&2
  cat "$log_a" >&2
  exit 1
fi
if ! grep -q "CODEX_HOME=$(printf '%q' "$(realpath -m "$home_b")")" "$log_b" \
  && ! grep -Fq "CODEX_HOME=$home_b" "$log_b"; then
  echo "expected account B CODEX_HOME in launch commands" >&2
  cat "$log_b" >&2
  exit 1
fi

name_a=$(awk '/^new-session / { for (i = 1; i <= NF; i++) if ($i == "-s") { print $(i + 1); exit } }' "$log_a")
name_b=$(awk '/^new-session / { for (i = 1; i <= NF; i++) if ($i == "-s") { print $(i + 1); exit } }' "$log_b")
# names are codex-hud-HASH-TIMESTAMP-PID — compare HASH
hash_a=$(printf '%s\n' "$name_a" | cut -d- -f3)
hash_b=$(printf '%s\n' "$name_b" | cut -d- -f3)
if [[ -z "$hash_a" || "$hash_a" == "$hash_b" ]]; then
  echo "expected different session hashes for different CODEX_HOME (got $name_a vs $name_b)" >&2
  exit 1
fi

echo "test-wrapper-codex-home: PASS"

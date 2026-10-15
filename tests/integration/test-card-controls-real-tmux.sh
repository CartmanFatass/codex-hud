#!/usr/bin/env bash
# Restarted panels refresh old card bindings without touching the root key table.
set -euo pipefail
command -v tmux >/dev/null || { echo 'SKIP: tmux unavailable'; exit 77; }
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dir=$(mktemp -d /tmp/hud-card-controls.XXXXXX)
socket="$dir/tmux.sock"
t() { tmux -S "$socket" "$@"; }
cleanup() { t kill-server 2>/dev/null || true; rm -rf "$dir"; }
trap cleanup EXIT
main=$(t new-session -d -s cards -x 160 -y 40 -P -F '#{pane_id}' 'sleep 120')
t bind-key -T root F12 display-message KEEP_ROOT_BINDING
root_before=$(t list-keys -T root F12)
t bind-key -T codex-hud-prefix e display-message LEGACY_EXPAND
t bind-key -T codex-hud-prefix Space display-message LEGACY_OPEN
panel=$(t split-window -h -l 48 -t "$main" -d -P -F '#{pane_id}' \
  "env LC_ALL=C.UTF-8 CODEX_HOME='$dir' CODEX_HUD_SETTINGS_PATH='$dir/settings.json' CODEX_HUD_CWD='$dir' CODEX_HUD_MAIN_PANE='$main' CODEX_HUD_TMUX_SESSION=cards CODEX_HUD_TOGGLE_CMD='$repo/bin/codex-hud-toggle' node '$repo/dist/tree-page.js'")
for ((n=0;n<200;n++)); do
  if [[ "$(t list-keys -T codex-hud-prefix Space 2>/dev/null || true)" == *' inspect'* ]]; then break; fi
  sleep 0.05
done
space=$(t list-keys -T codex-hud-prefix Space)
[[ "$space" == *' inspect'* ]] || { echo 'FAIL: Space was not migrated to Inspector'; exit 1; }
if t list-keys -T codex-hud-prefix e >/dev/null 2>&1; then
  echo 'FAIL: obsolete card expansion binding remains'; exit 1
fi
[[ "$(t list-keys -T root F12)" == "$root_before" ]] || { echo 'FAIL: root key table changed'; exit 1; }
[[ "$(t display-message -p -t "$panel" '#{pane_dead}')" == 0 ]] || { echo 'FAIL: panel exited'; exit 1; }
echo 'Card controls refresh: PASS (no expand, Space inspects, root keys preserved)'

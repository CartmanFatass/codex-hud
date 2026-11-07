#!/usr/bin/env bash
# One Pi session. --session-dir is first so the source root is explicit.
# --no-extensions still loads the two -e files, each once. Wake is not inside hud-delegate.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
hud=${HUD_HOME:-$root/tmp/lv-home}
node "$here/setup-home.mjs" "$hud"
hud=$(realpath "$hud")
for arg in "$@"; do
  case $arg in
    --session-dir | --session-dir=* | -e | --extension | --extension=* | --no-extensions | --no-mcp)
      echo "pi.sh already sets --session-dir, --no-extensions, --no-mcp and both -e files" >&2
      exit 1
      ;;
  esac
done
export HUD_HOME=$hud
export HUD_MCP_PROFILE=pi
exec pi \
  --session-dir "$hud/pi-sessions" \
  --no-extensions \
  --no-mcp \
  -e "$root/extensions/pi/hud-delegate.ts" \
  -e "$root/integrations/pi/hud-wake.ts" \
  "$@"

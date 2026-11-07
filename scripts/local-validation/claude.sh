#!/usr/bin/env bash
# One Claude session. MCP config, hook settings and HUD_HOME stay under the kit home.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
hud=${HUD_HOME:-$root/tmp/lv-home}
node "$here/setup-home.mjs" "$hud"
hud=$(realpath "$hud")
model=${LV_CLAUDE_MODEL:-claude-haiku-5-5}
if [[ ! $model =~ ^[A-Za-z0-9._:-]+$ ]]; then
  echo "claude.sh: LV_CLAUDE_MODEL must be a single token" >&2
  exit 1
fi
export HUD_HOME=$hud
export HUD_MCP_PROFILE=claude
export HUD_CLAUDE_HOOK_CONFIG=$hud/launch/claude.hook.json
exec claude \
  --mcp-config "$hud/launch/claude.mcp.json" \
  --strict-mcp-config \
  --settings "$hud/launch/claude.settings.json" \
  --model "$model" \
  "$@"

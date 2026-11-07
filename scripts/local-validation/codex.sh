#!/usr/bin/env bash
# Parent Codex for one session, using the zsh `codex` function's semantics:
# CODEX_HOME=$HOME/.codex-account2, then the Herdr context wrapper and the
# installed binary. Session -c flags attach hud-mcp; they do not edit config.toml.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
hud=${HUD_HOME:-$root/tmp/lv-home}
node "$here/setup-home.mjs" "$hud"
hud=$(realpath "$hud")
wrapper=$HOME/codex/codex-hud/bin/codex-with-herdr-context
binary=$HOME/.local/bin/codex
if [[ ! -x $wrapper || ! -x $binary ]]; then
  echo "codex.sh: missing \$HOME/codex/codex-hud/bin/codex-with-herdr-context or \$HOME/.local/bin/codex" >&2
  exit 1
fi
toml() {
  LV_Q=$1 node -e 'process.stdout.write(JSON.stringify(process.env.LV_Q ?? ""))'
}
node_bin=$(realpath "$(command -v node)")
mcp=$root/packages/hud-mcp/bin/hud-mcp.mjs
CODEX_HOME=$HOME/.codex-account2 exec "$wrapper" "$binary" \
  -m gpt-6-luna \
  -c "model_reasoning_effort=$(toml medium)" \
  -c "mcp_servers.hud.command=$(toml "$node_bin")" \
  -c "mcp_servers.hud.args=[$(toml "$mcp")]" \
  -c "mcp_servers.hud.env.HUD_HOME=$(toml "$hud")" \
  -c 'mcp_servers.hud.env.HUD_MCP_PROFILE="codex"' \
  "$@"

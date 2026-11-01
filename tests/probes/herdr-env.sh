#!/usr/bin/env bash
# P3: how far does `herdr tab create --env` / `pane split --env` reach?
#
#   (a) the pane's shell
#   (b) an agent process started in the pane: Codex via `pane run`, pi via
#       `herdr agent start --kind pi`
#   (c) that agent's MCP server (the probe server)
#
# No model calls: the Codex TUI and pi both start MCP servers at startup, so the
# probe server's start record is enough.
# Evidence: tmp/tasks/A3/evidence/herdr-env/.
set -u

if [ -z "${PROBE_UNDER_TIMEOUT:-}" ]; then
  PROBE_UNDER_TIMEOUT=1 exec timeout --kill-after=15 300 bash "$0" "$@"
fi

source "$(dirname "$0")/lib/common.sh"
probe_begin herdr-env

MODEL="${PROBE_CODEX_MODEL:-gpt-6-luna}"
EFFORT="${PROBE_CODEX_EFFORT:-low}"
CWD="$PROBE_WORK/cwd"
PI_SESSIONS="$PROBE_WORK/pi-sessions"
PI_MCP="$PROBE_WORK/pi-mcp.json"
mkdir -p "$CWD" "$PI_SESSIONS"

cat >"$PI_MCP" <<EOF
{
  "mcpServers": {
    "probe": {
      "command": "node",
      "args": ["$PROBE_SERVER", "run-$PROBE_WORK"],
      "exposure": "direct"
    }
  }
}
EOF

tui_command() {
  # tui_command <out.jsonl> ; no prompt, so this costs no model call
  local out="$1" args=()
  args+=(codex)
  args+=(-c 'mcp_servers.probe.command="node"')
  args+=(-c "mcp_servers.probe.args=[\"$PROBE_SERVER\"]")
  args+=(-c "mcp_servers.probe.env={PROBE_OUT=\"$out\"}")
  args+=(-m "$MODEL" -c "model_reasoning_effort=\"$EFFORT\"" -s danger-full-access -a never)
  cmd_join "${args[@]}"
}

probe_ps "$PROBE_EVID/ps-before.txt"

# --- tab with --env ---------------------------------------------------------
# Synthetic values carry the `probe-` sentinel prefix so the probe server's env
# allowlist records the value (not just the key name) in the evidence.
probe_tab_create p3-tab "$CWD" --env PROBE_ENV_TAG=probe-tab-env --env HUD_LINK=probe-env-tab
TAB="$PROBE_LAST_TAB"
PANE="$PROBE_LAST_PANE"

# (a) the pane's shell
probe_pane_run "$PANE" "env | grep -E '^(PROBE_ENV_TAG|HUD_LINK)=' > '$PROBE_EVID/shell-env.txt'"
probe_wait_file "$PROBE_EVID/shell-env.txt" 15 || probe_fail "the pane shell did not write shell-env.txt"

# (b) Codex via pane run, (c) its MCP server
probe_pane_run "$PANE" "$(tui_command "$PROBE_EVID/codex.jsonl")"
if ! probe_wait_kind "$PROBE_EVID/codex.jsonl" start 1 120; then
  probe_pane_read "$PANE" 60 "$PROBE_EVID/codex-pane.txt"
  probe_fail "the Codex TUI did not start the probe MCP server"
fi
CODEX_PID="$(probe_field "$PROBE_EVID/codex.jsonl" ppid | cut -d, -f1)"
probe_proc_env "$CODEX_PID" "$PROBE_EVID/codex-proc-env.txt" PROBE_ENV_TAG HUD_LINK HUD_HOME HERDR_ENV HERDR_PANE_ID CODEX_HOME
probe_ps "$PROBE_EVID/ps-codex.txt"
probe_pane_read "$PANE" 40 "$PROBE_EVID/codex-pane.txt"
probe_pane_send_text "$PANE" '/quit'
sleep 2
probe_pane_send_keys "$PANE" enter
probe_wait_pid_gone "$CODEX_PID" 20 || {
  probe_pane_send_keys "$PANE" ctrl+c
  probe_wait_pid_gone "$CODEX_PID" 10 || probe_note "Codex TUI did not exit; tab close will kill it"
}

# --- split with --env -------------------------------------------------------
herdr pane split "$PANE" --direction down --no-focus \
  --env PROBE_ENV_TAG=probe-split-env --env HUD_LINK=probe-env-split --env HUD_HOME="$HUD_HOME" \
  --env PROBE_OUT="$PROBE_EVID/pi.jsonl" \
  >"$PROBE_EVID/herdr-split.json" 2>>"$PROBE_EVID/herdr-errors.txt" || probe_fail "herdr pane split failed"
SPLIT="$(json_field result.pane.pane_id <"$PROBE_EVID/herdr-split.json")"
[ -n "$SPLIT" ] || probe_fail "herdr pane split returned no pane id"
probe_note "split pane: $SPLIT"

# (a) the split pane's shell
probe_pane_run "$SPLIT" "env | grep -E '^(PROBE_ENV_TAG|HUD_LINK)=' > '$PROBE_EVID/split-env.txt'"
probe_wait_file "$PROBE_EVID/split-env.txt" 15 || probe_fail "the split pane shell did not write split-env.txt"

# (b) pi via herdr agent start, (c) its MCP server
herdr agent start probe-pi-env --kind pi --pane "$SPLIT" --timeout 60000 -- \
  pi --mcp-config "$PI_MCP" --session-dir "$PI_SESSIONS" --model anthropic/claude-haiku-4-5 --thinking off --approve \
  >"$PROBE_EVID/herdr-agent-start.json" 2>>"$PROBE_EVID/herdr-errors.txt" || probe_fail "herdr agent start failed"
if ! probe_wait_kind "$PROBE_EVID/pi.jsonl" start 1 120; then
  probe_pane_read "$SPLIT" 60 "$PROBE_EVID/pi-pane.txt"
  probe_fail "pi did not start the probe MCP server"
fi
PI_PID="$(probe_field "$PROBE_EVID/pi.jsonl" ppid | cut -d, -f1)"
probe_proc_env "$PI_PID" "$PROBE_EVID/pi-proc-env.txt" PROBE_ENV_TAG HUD_LINK HUD_HOME PROBE_OUT HERDR_ENV HERDR_PANE_ID PI_CODING_AGENT
probe_ps "$PROBE_EVID/ps-pi.txt"
herdr agent list >"$PROBE_EVID/agent-list.json" 2>&1 || true
herdr agent get probe-pi-env >"$PROBE_EVID/agent-get.json" 2>&1 || true
probe_pane_read "$SPLIT" 40 "$PROBE_EVID/pi-pane.txt"

probe_pane_send_text "$SPLIT" '/quit'
sleep 2
probe_pane_send_keys "$SPLIT" enter
probe_wait_pid_gone "$PI_PID" 20 || {
  herdr agent send-keys probe-pi-env ctrl+c >/dev/null 2>&1 || true
  probe_wait_pid_gone "$PI_PID" 10 || probe_note "pi did not exit; tab close will kill it"
}

probe_tab_close "$TAB"
probe_ps "$PROBE_EVID/ps-after.txt"
probe_herdr_tabs "$PROBE_EVID/tabs-final.json"

probe_server_summary "$PROBE_EVID/codex.jsonl" "$PROBE_EVID/pi.jsonl"

# --- short summary ----------------------------------------------------------
probe_log "shell env: $(tr '\n' ' ' <"$PROBE_EVID/shell-env.txt")"
probe_log "split env: $(tr '\n' ' ' <"$PROBE_EVID/split-env.txt")"
probe_log "codex process env: $(tr '\n' ' ' <"$PROBE_EVID/codex-proc-env.txt")"
probe_log "codex MCP server env: $(probe_env_summary "$PROBE_EVID/codex.jsonl")"
probe_log "pi process env: $(tr '\n' ' ' <"$PROBE_EVID/pi-proc-env.txt")"
probe_log "pi MCP server env: $(probe_env_summary "$PROBE_EVID/pi.jsonl")"
probe_log "evidence: $PROBE_EVID"
exit 0

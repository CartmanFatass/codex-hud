#!/usr/bin/env bash
# P5: Claude Code MCP server env and parent.
#
# Runs one headless `claude -p` with the probe MCP server (strict MCP config),
# then records: the server's parent chain, the env keys it sees, the
# ~/.claude/sessions/<ppid>.json registry entry (pid / procStart match) and the
# per-call _meta.
# Evidence: tmp/tasks/A3/evidence/cc-mcp-env/.
set -u

if [ -z "${PROBE_UNDER_TIMEOUT:-}" ]; then
  PROBE_UNDER_TIMEOUT=1 exec timeout --kill-after=15 300 bash "$0" "$@"
fi

source "$(dirname "$0")/lib/common.sh"
probe_begin cc-mcp-env

PROMPT="Call the probe_whoami tool exactly once, then reply OK."
MCP_JSON="$PROBE_WORK/mcp.json"
OUT="$PROBE_EVID/cc.jsonl"
SHARED="$PROBE_EVID/shared.jsonl"

cat >"$MCP_JSON" <<EOF
{
  "mcpServers": {
    "probe": {
      "command": "node",
      "args": ["$PROBE_SERVER", "run-$PROBE_WORK"],
      "env": {
        "PROBE_OUT": "$OUT",
        "PROBE_OUT_SHARED": "$SHARED"
      }
    }
  }
}
EOF

probe_proc_start() {
  # probe_proc_start <pid> ; field 22 (starttime ticks) of /proc/<pid>/stat
  sed -e 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'
}

probe_ps "$PROBE_EVID/ps-before.txt"

(
  PROBE_SHELL_TAG=cc-shell HUD_LINK=probe-cc \
    timeout 200 claude -p \
      --mcp-config "$MCP_JSON" \
      --strict-mcp-config \
      --model haiku \
      --effort low \
      --allowedTools "mcp__probe__probe_whoami" \
      --output-format json \
      "$PROMPT" \
      >"$PROBE_EVID/claude-stdout.json" 2>"$PROBE_EVID/claude-stderr.txt"
) &
BG=$!

if ! probe_wait_kind "$OUT" start 1 120; then
  wait "$BG" || true
  probe_fail "claude did not start the probe MCP server (see claude-stderr.txt)"
fi

CC_PID="$(probe_field "$OUT" ppid | cut -d, -f1)"
probe_note "probe server parent pid: $CC_PID"
probe_proc_start "$CC_PID" >"$PROBE_EVID/cc-proc-start.txt"
probe_proc_env "$CC_PID" "$PROBE_EVID/cc-proc-env.txt" PROBE_SHELL_TAG HUD_LINK
tr '\0' '\n' <"/proc/$CC_PID/environ" 2>/dev/null | cut -d= -f1 | grep '^CLAUDE' | sort \
  >"$PROBE_EVID/cc-parent-claude-keys.txt" 2>/dev/null || true
probe_ps "$PROBE_EVID/ps-claude.txt"

# The registry entry exists while the session is alive; copy it before exit.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$HOME/.claude/sessions/$CC_PID.json" ]; then
    cp "$HOME/.claude/sessions/$CC_PID.json" "$PROBE_EVID/sessions-$CC_PID.json"
    break
  fi
  sleep 1
done
[ -f "$PROBE_EVID/sessions-$CC_PID.json" ] || probe_note "no ~/.claude/sessions/$CC_PID.json while running"

wait "$BG"
STATUS=$?
probe_note "claude exit status: $STATUS"
probe_ps "$PROBE_EVID/ps-after.txt"

probe_server_summary "$OUT" "$SHARED"
probe_jsonl_meta "$OUT" >"$PROBE_EVID/call-meta.jsonl" 2>&1 || true

# A failed or timed-out harness run, an error result, or a missing tools/call
# record is an infrastructure failure, not a measured negative answer.
if [ "$STATUS" -ne 0 ]; then
  probe_fail "claude -p failed (exit $STATUS); see $PROBE_EVID/claude-stderr.txt"
fi
if jq -e '.is_error == true' "$PROBE_EVID/claude-stdout.json" >/dev/null 2>&1; then
  probe_fail "claude -p reported an error result; see $PROBE_EVID/claude-stdout.json"
fi
if ! probe_wait_calls "$OUT" 1 30; then
  probe_fail "claude did not call probe_whoami; see $PROBE_EVID/claude-stdout.json"
fi

# --- short summary ----------------------------------------------------------
probe_log "probe server chain: $(head -1 "$OUT" | jq -r '[.chain[] | "\(.comm)(\(.pid))"] | join(" <- ")' 2>/dev/null)"
probe_log "probe server env names: $(head -1 "$OUT" | jq -c '.envNames' 2>/dev/null)"
probe_log "probe server CLAUDE* keys: $(head -1 "$OUT" | jq -c '.claudeKeys' 2>/dev/null)"
probe_log "claude session id: $(jq -r '.session_id // empty' "$PROBE_EVID/claude-stdout.json" 2>/dev/null)"
probe_log "evidence: $PROBE_EVID"
exit 0

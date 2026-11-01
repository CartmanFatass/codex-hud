#!/usr/bin/env bash
# P2: two Codex homes, same cwd.
#
# Runs one `codex exec` per home (the zsh functions `codex` -> ~/.codex-account2
# and `codex2` -> ~/.codex) in the same temporary cwd, each with the probe MCP
# server, then compares rollouts, daemons, MCP servers and logs_2.sqlite rows.
# Evidence: tmp/tasks/A3/evidence/codex-dual-home/.
set -u

if [ -z "${PROBE_UNDER_TIMEOUT:-}" ]; then
  PROBE_UNDER_TIMEOUT=1 exec timeout --kill-after=15 300 bash "$0" "$@"
fi

source "$(dirname "$0")/lib/common.sh"
probe_begin codex-dual-home

MODEL="${PROBE_CODEX_MODEL:-gpt-6-luna}"
EFFORT="${PROBE_CODEX_EFFORT:-low}"
PROMPT="Call the probe_whoami tool exactly once, then reply OK."
SHARED="$PROBE_EVID/shared.jsonl"
CWD="$PROBE_WORK/cwd"
MARKER="$PROBE_WORK/marker"
mkdir -p "$CWD"
touch "$MARKER"
MARKER_EPOCH="$(date +%s)"

HOME_A="$HOME/.codex-account2"
HOME_B="$HOME/.codex"

exec_command() {
  # exec_command <fn> <out.jsonl>
  local fn="$1" out="$2" args=()
  args+=("$fn" exec)
  args+=(-c 'mcp_servers.probe.command="node"')
  args+=(-c "mcp_servers.probe.args=[\"$PROBE_SERVER\"]")
  args+=(-c "mcp_servers.probe.env={PROBE_OUT=\"$out\", PROBE_OUT_SHARED=\"$SHARED\"}")
  args+=(-m "$MODEL" -c "model_reasoning_effort=\"$EFFORT\"" -s danger-full-access)
  args+=(--skip-git-repo-check -o "$PROBE_EVID/$fn-last-message.txt" "$PROMPT")
  cmd_join "${args[@]}"
}

tui_command() {
  # tui_command <fn> <out.jsonl> ; no prompt, so this costs no model call
  local fn="$1" out="$2" args=()
  args+=("$fn")
  args+=(-c 'mcp_servers.probe.command="node"')
  args+=(-c "mcp_servers.probe.args=[\"$PROBE_SERVER\"]")
  args+=(-c "mcp_servers.probe.env={PROBE_OUT=\"$out\", PROBE_OUT_SHARED=\"$SHARED\"}")
  args+=(-m "$MODEL" -c "model_reasoning_effort=\"$EFFORT\"" -s danger-full-access -a never)
  cmd_join "${args[@]}"
}

run_tui_home() {
  # run_tui_home <fn> <out.jsonl> ; starts an idle TUI, records it, quits it
  local fn="$1" out="$2" tab pane pid
  probe_tab_create "p2-$fn-tui" "$CWD" --env HUD_LINK="probe-$fn-tui"
  tab="$PROBE_LAST_TAB"
  pane="$PROBE_LAST_PANE"
  probe_pane_run "$pane" "$(tui_command "$fn" "$out")"
  if ! probe_wait_kind "$out" start 1 120; then
    probe_pane_read "$pane" 40 "$PROBE_EVID/$fn-tui-pane.txt"
    probe_fail "$fn TUI did not start the probe MCP server"
  fi
  pid="$(herdr pane process-info --pane "$pane" 2>/dev/null | json_field result.process_info.foreground_processes.0.pid)"
  probe_proc_env "$pid" "$PROBE_EVID/$fn-tui-env.txt" CODEX_HOME HUD_LINK
  probe_ps "$PROBE_EVID/ps-$fn-tui.txt"
  probe_pane_read "$pane" 30 "$PROBE_EVID/$fn-tui-pane.txt"
  probe_pane_send_text "$pane" '/quit'
  sleep 2
  probe_pane_send_keys "$pane" enter
  probe_wait_pid_gone "$pid" 20 || {
    probe_pane_send_keys "$pane" ctrl+c
    probe_wait_pid_gone "$pid" 10 || probe_note "$fn TUI did not exit; tab close will kill it"
  }
  probe_tab_close "$tab"
}

run_home() {
  # run_home <fn> <out.jsonl> <stdout.txt>
  local fn="$1" out="$2" stdout="$3" bg pid ppid
  (
    cd "$CWD" || exit 1
    PROBE_OUT="$out" PROBE_OUT_SHARED="$SHARED" HUD_LINK="probe-$fn" \
      timeout 180 zsh -ic "$(exec_command "$fn" "$out")" >"$stdout" 2>&1
  ) &
  bg=$!
  if ! probe_wait_kind "$out" start 1 120; then
    wait "$bg" || true
    probe_fail "$fn did not start the probe MCP server (see $stdout)"
  fi
  pid="$(probe_field "$out" pid | cut -d, -f1)"
  ppid="$(probe_field "$out" ppid | cut -d, -f1)"
  probe_proc_env "$ppid" "$PROBE_EVID/$fn-exec-env.txt" CODEX_HOME HUD_LINK PROBE_OUT
  probe_ps "$PROBE_EVID/ps-$fn.txt"
  wait "$bg"
  local status=$?
  probe_note "$fn exec exit status: $status (server pid $pid, parent $ppid)"
  # A failed or timed-out harness run is an infrastructure failure, not a
  # measured negative answer.
  if [ "$status" -ne 0 ]; then
    probe_fail "$fn exec failed (exit $status); see $stdout"
  fi
  if ! probe_wait_calls "$out" 1 30; then
    probe_fail "$fn exec produced no tools/call record; see $stdout"
  fi
  return 0
}

rollout_meta() {
  # rollout_meta <home> <expected-cwd> <out.jsonl>
  # Only rollouts whose session_meta.cwd is the probe cwd; other sessions in the
  # same home may be touched concurrently by the user.
  local home="$1" expected="$2" out="$3" file meta
  : >"$out"
  while IFS= read -r file; do
    meta="$(head -1 "$file" | node -e '
      const fs = require("node:fs");
      let record;
      try {
        record = JSON.parse(fs.readFileSync(0, "utf8"));
      } catch {
        process.exit(0);
      }
      const payload = record.payload || {};
      process.stdout.write(
        JSON.stringify({
          type: record.type,
          id: payload.id,
          cwd: payload.cwd,
          source: payload.source,
          thread_source: payload.thread_source,
        })
      );
    ' 2>/dev/null)"
    [ -n "$meta" ] || continue
    case "$meta" in
      *"\"cwd\":\"$expected\""*)
        printf '%s\n%s\n' "$file" "$meta" >>"$out"
        ;;
    esac
  done < <(find "$home/sessions" -type f -name '*.jsonl' -newer "$MARKER" 2>/dev/null | sort)
}

probe_ps "$PROBE_EVID/ps-before.txt"
probe_herdr_tabs "$PROBE_EVID/tabs-before.json"
for home in "$HOME_A" "$HOME_B"; do
  tag="$(basename "$home")"
  ls -la "$home/app-server-daemon" >"$PROBE_EVID/daemon-dir-$tag.txt" 2>&1 || true
  ls -d "$home/hud" "$home/sessions" >"$PROBE_EVID/home-dirs-$tag.txt" 2>&1 || true
  # Presence is decided by the recorded pid plus the process name only; the
  # probe never greps host-wide command lines for a daemon.
  daemon_pid="$(jq -r '.pid // empty' "$home/app-server-daemon/daemon.pid" 2>/dev/null)"
  daemon_state="dead"
  if [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null; then
    daemon_comm="$(probe_proc_comm "$daemon_pid")"
    case "$daemon_comm" in
      codex*) daemon_state="alive (comm=$daemon_comm)" ;;
      *) daemon_state="pid alive but comm=${daemon_comm:-unknown}, not a codex process" ;;
    esac
  fi
  printf '%s daemon pid %s: %s\n' "$tag" "${daemon_pid:-none}" "$daemon_state" >>"$PROBE_EVID/daemon-liveness.txt"
done

run_home codex "$PROBE_EVID/home-a.jsonl" "$PROBE_EVID/home-a-stdout.txt"
run_home codex2 "$PROBE_EVID/home-b.jsonl" "$PROBE_EVID/home-b-stdout.txt"

# Idle TUIs (no model call) so each home's logs_2.sqlite gets TUI rows too.
run_tui_home codex "$PROBE_EVID/home-a-tui.jsonl"
run_tui_home codex2 "$PROBE_EVID/home-b-tui.jsonl"

probe_ps "$PROBE_EVID/ps-after.txt"
probe_herdr_tabs "$PROBE_EVID/tabs-final.json"

# --- rollouts and logs per home --------------------------------------------
sleep 2
rollout_meta "$HOME_A" "$CWD" "$PROBE_EVID/rollouts-home-a.txt"
rollout_meta "$HOME_B" "$CWD" "$PROBE_EVID/rollouts-home-b.txt"

SESSION_A="$(grep tools/call "$PROBE_EVID/home-a.jsonl" | head -1 | jq -r '.params._meta.sessionId // empty')"
SESSION_B="$(grep tools/call "$PROBE_EVID/home-b.jsonl" | head -1 | jq -r '.params._meta.sessionId // empty')"
TUI_PID_A="$(probe_field "$PROBE_EVID/home-a-tui.jsonl" ppid | cut -d, -f1)"
TUI_PID_B="$(probe_field "$PROBE_EVID/home-b-tui.jsonl" ppid | cut -d, -f1)"
probe_note "home A exec session id: $SESSION_A (TUI pid $TUI_PID_A)"
probe_note "home B exec session id: $SESSION_B (TUI pid $TUI_PID_B)"

NEEDLES="$SESSION_A,$SESSION_B,pid:$TUI_PID_A:,pid:$TUI_PID_B:"
node "$PROBE_LIB_DIR/logs-query.mjs" "$HOME_A/logs_2.sqlite" "$MARKER_EPOCH" "$NEEDLES" \
  >"$PROBE_EVID/logs-home-a.json" 2>&1 || probe_note "logs-query failed for home A"
node "$PROBE_LIB_DIR/logs-query.mjs" "$HOME_B/logs_2.sqlite" "$MARKER_EPOCH" "$NEEDLES" \
  >"$PROBE_EVID/logs-home-b.json" 2>&1 || probe_note "logs-query failed for home B"
ls -la "$HOME_A/logs_2.sqlite" "$HOME_B/logs_2.sqlite" >"$PROBE_EVID/logs-files.txt" 2>&1 || true

probe_server_summary "$PROBE_EVID/home-a.jsonl" "$PROBE_EVID/home-b.jsonl" "$SHARED"
probe_jsonl_meta "$SHARED" >"$PROBE_EVID/call-meta.jsonl" 2>&1 || true

# --- short summary ----------------------------------------------------------
probe_log "home A server pids: $(probe_field "$PROBE_EVID/home-a.jsonl" pid)"
probe_log "home B server pids: $(probe_field "$PROBE_EVID/home-b.jsonl" pid)"
probe_log "home A rollouts: $(grep -c '^/' "$PROBE_EVID/rollouts-home-a.txt" 2>/dev/null || echo 0)"
probe_log "home B rollouts: $(grep -c '^/' "$PROBE_EVID/rollouts-home-b.txt" 2>/dev/null || echo 0)"
probe_log "evidence: $PROBE_EVID"
exit 0

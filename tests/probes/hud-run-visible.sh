#!/usr/bin/env bash
# A8 probe: how hud-run supervises a visible run inside a Herdr pane.
#
# Two candidates are measured against the same checklist:
#   方案甲 (wrapper): the supervisor is typed into the pane; it creates its own
#     process group, runs the harness through `$SHELL -ic "<text>"`, passes the
#     TTY through, and writes heartbeat + exit receipt.
#   方案乙 (sidecar): the harness is launched exactly as today (`herdr pane run
#     "codex ..."`); a sidecar outside the pane watches the pane's foreground
#     process and records only the exit moment. Herdr exposes no exit code, so
#     the sidecar writes no receipt.
#
# The script is re-runnable: every scenario uses a fresh Herdr tab and a fresh
# HUD home under a mktemp work dir. Raw evidence goes to
# tmp/tasks/A8/evidence/hud-run-visible/.
set -u
if [ -z "${PROBE_UNDER_TIMEOUT:-}" ]; then
  PROBE_UNDER_TIMEOUT=1 exec timeout --kill-after=20 600 bash "$0" "$@"
fi
source "$(dirname "$0")/lib/common.sh"
PROBE_EVIDENCE_ROOT="$PROBE_ROOT/tmp/tasks/A8/evidence"

ONLY=""
CANDIDATES="jia yi"
A8_ONLY="${A8_ONLY:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      ONLY="$2"
      shift 2
      ;;
    --candidate)
      CANDIDATES="$2"
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

a8_selected() {
  # a8_selected <candidate> <scenario> ; honors --only and A8_ONLY.
  # A8_ONLY is a comma-separated list of `scenario`, `candidate-scenario` or
  # `candidate:scenario` tokens; empty means every scenario.
  local cand="$1" scen="$2" token
  if [ -n "$ONLY" ]; then
    [ "$ONLY" = "$scen" ] && return 0
  fi
  if [ -z "$A8_ONLY" ]; then
    [ -z "$ONLY" ] && return 0
    return 1
  fi
  local IFS=','
  for token in $A8_ONLY; do
    [ -n "$token" ] || continue
    [ "$token" = "$scen" ] && return 0
    [ "$token" = "$cand-$scen" ] && return 0
    [ "$token" = "$cand:$scen" ] && return 0
  done
  return 1
}

# A partial re-measurement must not delete the rows it does not run. Keep the
# previous evidence tree beside the live one and restore the unselected
# scenario directories after probe_begin has recreated the live tree.
A8_EVID_NAME="hud-run-visible"
A8_PREV="$PROBE_EVIDENCE_ROOT/$A8_EVID_NAME-previous"
if [ -n "$A8_ONLY" ] && [ -d "$PROBE_EVIDENCE_ROOT/$A8_EVID_NAME" ]; then
  rm -rf "$A8_PREV"
  cp -a "$PROBE_EVIDENCE_ROOT/$A8_EVID_NAME" "$A8_PREV"
fi
probe_begin "$A8_EVID_NAME"
if [ -n "$A8_ONLY" ] && [ -d "$A8_PREV" ]; then
  for cand in jia yi; do
    for scen in normal normal-exec ctrlc kill pane-close cancel context parent-exit parent-exit-bg supervisor-death; do
      a8_selected "$cand" "$scen" && continue
      if [ -d "$A8_PREV/$cand/$scen" ]; then
        mkdir -p "$PROBE_EVID/$cand"
        cp -a "$A8_PREV/$cand/$scen" "$PROBE_EVID/$cand/"
      fi
    done
  done
fi

HUD_HOME="$PROBE_WORK/hud-home"
mkdir -p "$HUD_HOME"
MINI_RUN="$PROBE_LIB_DIR/mini-hud-run.mjs"
MINI_SIDECAR="$PROBE_LIB_DIR/mini-sidecar.mjs"
# MCP servers are cleared with a -c override so the TUI starts in a few seconds.
# This does not affect the supervision rows; the Herdr context wrapper still
# adds its own -c shell_environment_policy.set.HERDR_* overrides.
CODEX_TEXT='codex -m gpt-6-luna -c model_reasoning_effort="low" -c mcp_servers={} -s danger-full-access -a never'
PROMPT='Reply with exactly OK.'
A8_PIDS=()
A8_CLEANED=0
A8_EXIT_CLEANED=0
A8_LOOP_PID=""

a8_stop_pid() {
  # a8_stop_pid <pid> ; stop, reap and unregister one A8-owned background pid.
  local pid="$1" kept=() p waited=0
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  for p in "${A8_PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    [ "$p" = "$pid" ] || kept+=("$p")
  done
  A8_PIDS=()
  for p in "${kept[@]:-}"; do
    [ -n "$p" ] || continue
    A8_PIDS+=("$p")
  done
}

a8_cleanup() {
  # Idempotent: only the pids this run registered, each stopped and reaped once.
  local pid pids
  [ "$A8_CLEANED" = 1 ] && return 0
  A8_CLEANED=1
  pids=("${A8_PIDS[@]:-}")
  A8_PIDS=()
  for pid in "${pids[@]}"; do
    [ -n "$pid" ] || continue
    a8_stop_pid "$pid"
  done
}

# Trap block start: the cleanup/interrupt test extracts these lines verbatim.
a8_on_exit() {
  # Cleanup runs exactly once, whether it is reached from EXIT or a signal.
  # INT/TERM are ignored from here on, so a signal that arrives once cleanup
  # has started cannot abort the remaining cleanup or re-enter this function.
  trap '' INT TERM
  [ "$A8_EXIT_CLEANED" = 1 ] && return 0
  A8_EXIT_CLEANED=1
  a8_cleanup
  probe_cleanup
}

a8_on_signal() {
  # a8_on_signal <exit-status> ; clean up once, then leave so no later scenario
  # starts after an interrupt or the timeout's TERM.
  local status="$1"
  trap - EXIT
  trap '' INT TERM
  a8_on_exit
  exit "$status"
}
trap a8_on_exit EXIT
trap 'a8_on_signal 130' INT
trap 'a8_on_signal 143' TERM
# Trap block end.

a8_ev() {
  # a8_ev <relative dir> ; creates it and prints the absolute path.
  mkdir -p "$PROBE_EVID/$1"
  printf '%s\n' "$PROBE_EVID/$1"
}

a8_run_dir() {
  # a8_run_dir <candidate> <run> ; 方案乙 keeps its files under sidecar/.
  if [ "$1" = "jia" ]; then
    printf '%s\n' "$HUD_HOME/runs/$2"
  else
    printf '%s\n' "$HUD_HOME/runs/$2/sidecar"
  fi
}

a8_tab() {
  probe_tab_create "$1" /tmp
}

a8_wait_tui() {
  # a8_wait_tui <pane> <timeout-seconds>
  local pane="$1" limit="$2" started now
  started="$(date +%s)"
  while :; do
    if herdr pane read "$pane" --lines 40 --source visible 2>/dev/null |
      grep -qE 'Ask Codex to do anything|permissions: YOLO mode'; then
      return 0
    fi
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

a8_wait_agent() {
  # a8_wait_agent <pane> <timeout-seconds>
  local pane="$1" limit="$2" started now agent
  started="$(date +%s)"
  while :; do
    agent="$(herdr pane get "$pane" 2>/dev/null | jq -r '.result.pane.agent // empty')"
    [ "$agent" = "codex" ] && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

a8_status_loop() {
  # a8_status_loop <pane> <out> ; starts the poller in this shell and sets
  # A8_LOOP_PID, which is also registered in A8_PIDS for the cleanup path.
  # The subshell's stdout/stderr are redirected so the caller is not held open
  # by the long-running loop.
  local pane="$1" out="$2"
  (
    while :; do
      herdr pane get "$pane" 2>/dev/null |
        jq -c --arg at "$(date -Is)" \
          '{at:$at, agent:.result.pane.agent, status:.result.pane.agent_status, title:.result.pane.terminal_title}' \
          >>"$out" 2>/dev/null || true
      sleep 0.5
    done
  ) >/dev/null 2>&1 &
  A8_LOOP_PID="$!"
  A8_PIDS+=("$A8_LOOP_PID")
}

a8_agent_snapshot() {
  # a8_agent_snapshot <pane> <out> ; one allowlisted `agent list` projection.
  # The session value is never recorded; only presence, kind and source.
  local pane="$1" out="$2"
  herdr agent list 2>/dev/null |
    jq -c --arg pane "$pane" '
      [.result.agents[] | select(.pane_id == $pane)] as $a |
      if ($a | length) == 0 then
        {present:false, agent:null, agent_status:null, agent_session_present:false}
      else
        $a[0] | {
          present:true,
          agent:.agent,
          agent_status:.agent_status,
          agent_session_present:(.agent_session != null),
          agent_session_kind:(.agent_session.kind // null),
          agent_session_source:(.agent_session.source // null),
          focused:(.focused // null),
          interactive_ready:(.interactive_ready // null),
          pane_id:.pane_id,
          tab_id:.tab_id,
          name:.name
        }
      end' >"$out" 2>/dev/null || true
}

a8_agent_loop() {
  # a8_agent_loop <pane> <out> ; append the same projection every 0.5 s.
  local pane="$1" out="$2"
  (
    while :; do
      herdr agent list 2>/dev/null |
        jq -c --arg at "$(date -Is)" --arg pane "$pane" '
          [.result.agents[] | select(.pane_id == $pane)] as $a |
          if ($a | length) == 0 then
            {at:$at,present:false,agent:null,agent_status:null,agent_session_present:false}
          else
            $a[0] | {
              at:$at,present:true,agent:.agent,agent_status:.agent_status,
              agent_session_present:(.agent_session != null),
              agent_session_kind:(.agent_session.kind // null),
              agent_session_source:(.agent_session.source // null),
              focused:(.focused // null),interactive_ready:(.interactive_ready // null),
              pane_id:.pane_id,tab_id:.tab_id,name:.name
            }
          end' >>"$out" 2>/dev/null || true
      sleep 0.5
    done
  ) >/dev/null 2>&1 &
  A8_LOOP_PID="$!"
  A8_PIDS+=("$A8_LOOP_PID")
}

a8_wait_agent_status() {
  # a8_wait_agent_status <pane> <status> <timeout-seconds>
  local pane="$1" want="$2" limit="$3" started now got
  started="$(date +%s)"
  while :; do
    got="$(herdr agent list 2>/dev/null |
      jq -r --arg pane "$pane" '[.result.agents[] | select(.pane_id == $pane)][0].agent_status // empty')"
    [ "$got" = "$want" ] && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 0.5
  done
}

a8_context_probe_script() {
  # a8_context_probe_script <path> ; writes the synthetic context probe helper.
  # It prints only presence/equality booleans, a key count and a marker; it
  # never prints a Herdr context value.
  local path="$1"
  cat >"$path" <<'PROBE_EOF'
#!/usr/bin/env bash
set -u
expected_workspace="${1-}"
expected_tab="${2-}"
expected_pane="${3-}"
marker="${4-}"
present() {
  if [ -n "${!1+x}" ]; then printf '%s_present=true\n' "$2"; else printf '%s_present=false\n' "$2"; fi
}
matches() {
  if [ "${!1-}" = "$2" ]; then printf '%s_matches=true\n' "$3"; else printf '%s_matches=false\n' "$3"; fi
}
printf 'probe=herdr-context-v1\n'
printf 'run=%s\n' "$marker"
printf 'herdr_key_count=%s\n' "$(env | grep -c '^HERDR_')"
present HERDR_ENV env
present HERDR_WORKSPACE_ID workspace
present HERDR_TAB_ID tab
present HERDR_PANE_ID pane
present HERDR_SESSION session
present HERDR_SOCKET socket
present HERDR_SOCKET_PATH socket_path
present HERDR_CONFIG_PATH config_path
matches HERDR_WORKSPACE_ID "$expected_workspace" workspace
matches HERDR_TAB_ID "$expected_tab" tab
matches HERDR_PANE_ID "$expected_pane" pane
ancestor_codex=false
p="${PPID:-0}"
i=0
while [ "$i" -lt 6 ] && [ "$p" -gt 1 ]; do
  c="$(ps -o comm= -p "$p" 2>/dev/null | tr -d '[:space:]')"
  case "$c" in
    codex*) ancestor_codex=true; break ;;
  esac
  p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$p" ] || break
  i=$((i + 1))
done
printf 'ancestor_codex=%s\n' "$ancestor_codex"
PROBE_EOF
  chmod +x "$path"
}

a8_harness_pid() {
  herdr pane process-info --pane "$1" 2>/dev/null |
    jq -r '.result.process_info.foreground_processes[0].pid // empty'
}

a8_snapshot() {
  # a8_snapshot <pid> <dir> <prefix>
  local pid="$1" dir="$2" prefix="$3"
  [ -n "$pid" ] || return 0
  ps -p "$pid" -o pid,ppid,pgid,sid,etimes,comm,args >"$dir/$prefix.ps.txt" 2>&1 || true
  if [ -r "/proc/$pid/stat" ]; then
    awk '{print "pid="$1" comm="$2" state="$3" ppid="$4" pgrp="$5" session="$6" tty_nr="$7" tpgid="$8" starttime="$22}' \
      "/proc/$pid/stat" >"$dir/$prefix.stat.txt" 2>/dev/null || true
  fi
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' '\n' <"/proc/$pid/cmdline" >"$dir/$prefix.argv.txt" 2>/dev/null || true
  fi
  probe_proc_env "$pid" "$dir/$prefix.env.txt" \
    HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID CODEX_HOME SHELL TERM 2>/dev/null || true
}

a8_kill_session() {
  # a8_kill_session <stat-file> ; kill every process in the pane's session.
  local sid
  sid="$(sed -n 's/.*session=\([0-9]*\).*/\1/p' "$1" 2>/dev/null)"
  [ -n "$sid" ] && pkill -9 -s "$sid" 2>/dev/null || true
}

a8_zsh_function() {
  # a8_zsh_function <pane> <out> ; run before the TUI starts, while the pane is a shell.
  local pane="$1" out="$2"
  rm -f "$out"
  herdr pane run "$pane" "zsh -ic 'type codex' > $(printf '%q' "$out") 2>&1" >/dev/null 2>&1 || true
  probe_wait_file "$out" 15 || true
}

a8_wait_receipt() {
  local run="$1" limit="$2" started now
  started="$(date +%s)"
  while :; do
    [ -s "$HUD_HOME/runs/$run/exit.json" ] && return 0
    [ -s "$HUD_HOME/runs/$run/no-receipt.json" ] && return 1
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

a8_wait_observed() {
  local run="$1" limit="$2" started now
  started="$(date +%s)"
  while :; do
    [ -s "$HUD_HOME/runs/$run/sidecar/observed-exit.json" ] && return 0
    [ -s "$HUD_HOME/runs/$run/sidecar/observed-pane-gone.json" ] && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

a8_quit() {
  local pane="$1"
  herdr pane send-text "$pane" '/quit' >/dev/null 2>&1 || true
  sleep 2
  herdr pane send-keys "$pane" enter >/dev/null 2>&1 || true
}

a8_copy_run() {
  # a8_copy_run <run> <dest>
  local run="$1" dest="$2"
  mkdir -p "$dest"
  cp -a "$HUD_HOME/runs/$run/." "$dest/" 2>/dev/null || true
}

a8_open() {
  # a8_open <label> ; creates a fresh tab and sets A8_PANE / A8_TAB.
  a8_tab "$1"
  A8_TAB="$PROBE_LAST_TAB"
  A8_PANE="$PROBE_LAST_PANE"
}

a8_launch() {
  # a8_launch <candidate> <run> <dir> [exec] ; starts the candidate on A8_PANE.
  local cand="$1" run="$2" dir="$3" variant="${4:-}"
  local cmd text
  if [ "$cand" = "jia" ]; then
    text="$CODEX_TEXT"
    [ "$variant" = "exec" ] && text="exec $CODEX_TEXT"
    cmd="$(cmd_join node "$MINI_RUN" --run "$run" --hud-home "$HUD_HOME" --shell "$text")"
    probe_pane_run "$A8_PANE" "$cmd"
  else
    cmd="$(cmd_join node "$MINI_SIDECAR" --run "$run" --hud-home "$HUD_HOME" --pane "$A8_PANE" --interval 300)"
    nohup bash -c "$cmd" >"$dir/sidecar.log" 2>&1 &
    A8_PIDS+=("$!")
    probe_pane_run "$A8_PANE" "$CODEX_TEXT"
  fi
  printf '%s\n' "$cmd" >>"$PROBE_EVID/commands.txt"
}

a8_prompt() {
  # a8_prompt <pane> <out> ; one cheap model call, waits for the turn to settle.
  local pane="$1" out="$2"
  a8_prompt_text "$pane" "$out" "$PROMPT"
}

a8_prompt_text() {
  # a8_prompt_text <pane> <out> <text> ; the context row needs a longer turn.
  local pane="$1" out="$2" text="$3"
  herdr agent prompt "$pane" "$text" --wait --until done --timeout 120000 >"$out" 2>&1 || true
}

a8_normal() {
  local cand="$1" variant="${2:-}" run dir loop_pid split hpid sub label
  if [ "$variant" = "exec" ]; then
    run="normal-exec-$cand"
    sub="normal-exec"
    label="a8-$cand-normal-exec"
  else
    run="normal-$cand"
    sub="normal"
    label="a8-$cand-normal"
  fi
  dir="$(a8_ev "$cand/$sub")"
  a8_open "$label"
  local pane="$A8_PANE" tab="$A8_TAB"
  sleep 1
  a8_zsh_function "$pane" "$dir/zsh-function.txt"
  a8_status_loop "$pane" "$dir/status-timeline.jsonl"
  loop_pid="$A8_LOOP_PID"
  a8_launch "$cand" "$run" "$dir" "$variant"
  a8_wait_tui "$pane" 60 || probe_note "$cand normal: TUI prompt not seen"
  a8_wait_agent "$pane" 60 || probe_note "$cand normal: agent not detected"
  sleep 2
  herdr pane process-info --pane "$pane" >"$dir/process-info.json" 2>&1 || true
  jq -c '{paneForegroundPid:(.result.process_info.foreground_processes[0].pid // null),paneForegroundPgid:(.result.process_info.foreground_process_group_id // null)}' \
    "$dir/process-info.json" >"$dir/scope-pane.json" 2>/dev/null || true
  hpid="$(a8_harness_pid "$pane")"
  printf '%s\n' "$hpid" >"$dir/harness-pid.txt"
  a8_snapshot "$hpid" "$dir" "harness"
  a8_prompt "$pane" "$dir/prompt.json"
  sleep 2
  herdr pane read "$pane" --lines 40 --source visible >"$dir/pane-after-prompt.txt" 2>&1 || true
  herdr pane get "$pane" >"$dir/pane-after-prompt.json" 2>&1 || true
  herdr pane get "$pane" >"$dir/pane-before-resize.json" 2>&1 || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-before-resize.txt" 2>&1 || true
  split="$(herdr pane split "$pane" --direction down --no-focus 2>/dev/null |
    jq -r '.result.pane.pane_id // empty')"
  printf '%s\n' "$split" >"$dir/split-pane.txt"
  sleep 3
  herdr pane get "$pane" >"$dir/pane-after-split.json" 2>&1 || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-split.txt" 2>&1 || true
  if [ -n "$split" ]; then herdr pane close "$split" >/dev/null 2>&1 || true; fi
  sleep 3
  herdr pane get "$pane" >"$dir/pane-after-unsplit.json" 2>&1 || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-unsplit.txt" 2>&1 || true
  a8_quit "$pane"
  if [ "$cand" = "jia" ]; then
    a8_wait_receipt "$run" 30 || probe_note "$cand normal: no receipt after /quit"
  else
    a8_wait_observed "$run" 30 || probe_note "$cand normal: no observed exit after /quit"
  fi
  sleep 1
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-quit.txt" 2>&1 || true
  a8_stop_pid "$loop_pid"
  a8_copy_run "$run" "$dir/run"
  jq -c '.scope' "$dir/run/meta.json" >"$dir/scope-supervisor.json" 2>/dev/null || true
  probe_tab_close "$tab"
}

a8_context() {
  # Rows 1 and 2 for 甲: the `agent list` lifecycle for one identified agent
  # and one Codex-executed command that checks the Herdr context. Two model
  # turns (the command turn and a cheap second turn from the idle state); the
  # command writes only allowlisted booleans to its output file.
  local cand="$1" run="context-$cand" dir pane tab loop_pid script out prompt focused_tab
  dir="$(a8_ev "$cand/context")"
  a8_open "a8-$cand-context"
  pane="$A8_PANE"
  tab="$A8_TAB"
  a8_launch "$cand" "$run" "$dir"
  a8_wait_tui "$pane" 60 || probe_note "$cand context: TUI prompt not seen"
  a8_wait_agent "$pane" 60 || probe_note "$cand context: agent not detected"
  a8_wait_agent_status "$pane" idle 20 || probe_note "$cand context: agent did not reach idle before the turn"
  a8_agent_snapshot "$pane" "$dir/agent-list-ready.json"
  a8_agent_loop "$pane" "$dir/agent-list-timeline.jsonl"
  loop_pid="$A8_LOOP_PID"
  script="$PROBE_WORK/context-probe.sh"
  out="$PROBE_WORK/context-probe.out"
  a8_context_probe_script "$script"
  rm -f "$out"
  prompt="Use the shell tool to run exactly this command, then reply with only DONE:

bash $script $PROBE_WORKSPACE $tab $pane $run > $out 2>&1"
  printf '%s\n' "$prompt" >"$dir/prompt-context.txt"
  a8_prompt_text "$pane" "$dir/prompt.json" "$prompt"
  # Stop the poller before reading the timeline so a partial append cannot make
  # jq stop early; the explicit snapshots below do not need it.
  a8_stop_pid "$loop_pid"
  loop_pid=""
  jq -R -c 'fromjson? | select(.agent_status == "working")' "$dir/agent-list-timeline.jsonl" 2>/dev/null |
    head -1 >"$dir/agent-list-working.json"
  jq -R -c 'fromjson? | select(.agent_status == "working" and .agent_session_present == true)' \
    "$dir/agent-list-timeline.jsonl" 2>/dev/null | head -1 >"$dir/agent-list-working-session.json"
  jq -R -c 'fromjson? | select(.agent_status == "done")' "$dir/agent-list-timeline.jsonl" 2>/dev/null |
    head -1 >"$dir/agent-list-done.json"
  a8_agent_snapshot "$pane" "$dir/agent-list-after.json"
  cp "$dir/agent-list-after.json" "$dir/agent-list-done.json" 2>/dev/null || true
  probe_wait_file "$out" 60 || probe_note "$cand context: Codex did not write the context probe output"
  if [ -s "$out" ]; then
    cp "$out" "$dir/context-probe.txt"
    grep -q '^probe=herdr-context-v1$' "$dir/context-probe.txt" ||
      probe_note "$cand context: context probe marker missing"
    grep -q "^run=$run$" "$dir/context-probe.txt" ||
      probe_note "$cand context: context probe run marker mismatch"
  fi
  herdr pane read "$pane" --lines 40 --source visible >"$dir/pane-after-context.txt" 2>&1 || true
  # A status API read does not acknowledge Herdr's unseen-completion `done`.
  a8_agent_snapshot "$pane" "$dir/agent-list-after-read.json"
  # Viewing the tab acknowledges completion; focus it briefly, capture the
  # resulting idle state, then restore the previously focused tab.
  focused_tab="$(herdr tab list --workspace "$PROBE_WORKSPACE" 2>/dev/null |
    jq -r '.result.tabs[] | select(.focused) | .tab_id' | head -1)"
  printf '%s\n' "$focused_tab" >"$dir/focus-before.txt"
  herdr tab focus "$tab" >"$dir/focus-probe.json" 2>&1 || true
  sleep 2
  a8_agent_snapshot "$pane" "$dir/agent-list-idle.json"
  if [ -n "$focused_tab" ]; then
    herdr tab focus "$focused_tab" >"$dir/focus-restore.json" 2>&1 || true
  fi
  # Second turn: start from the captured idle state and observe idle -> working
  # -> idle for the same identified agent/session. The tab was viewed, so this
  # completion projects as idle rather than the unseen-completion done.
  a8_agent_loop "$pane" "$dir/agent-list-timeline-2.jsonl"
  loop_pid="$A8_LOOP_PID"
  a8_prompt "$pane" "$dir/prompt-second.json"
  a8_stop_pid "$loop_pid"
  loop_pid=""
  jq -R -c 'fromjson? | select(.agent_status == "working")' "$dir/agent-list-timeline-2.jsonl" 2>/dev/null |
    head -1 >"$dir/agent-list-second-working.json"
  a8_agent_snapshot "$pane" "$dir/agent-list-second-after.json"
  a8_quit "$pane"
  a8_wait_receipt "$run" 30 || probe_note "$cand context: no receipt after /quit"
  sleep 1
  a8_agent_snapshot "$pane" "$dir/agent-list-after-quit.json"
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-quit.txt" 2>&1 || true
  [ -n "$loop_pid" ] && a8_stop_pid "$loop_pid"
  a8_copy_run "$run" "$dir/run"
  probe_tab_close "$tab"
}

a8_ctrlc() {
  local cand="$1" run="ctrlc-$cand" dir
  dir="$(a8_ev "$cand/ctrlc")"
  a8_open "a8-$cand-ctrlc"
  local pane="$A8_PANE" tab="$A8_TAB"
  a8_launch "$cand" "$run" "$dir"
  a8_wait_tui "$pane" 60 || probe_note "$cand ctrlc: TUI prompt not seen"
  a8_wait_agent "$pane" 60 || true
  herdr agent list 2>/dev/null |
    jq -c --arg pane "$pane" \
      '.result.agents[] | select(.pane_id==$pane) | {agent,agent_status,agent_session:{agent:.agent_session.agent,kind:.agent_session.kind},pane_id,tab_id,name}' \
      >"$dir/agent-list.json" 2>/dev/null || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-before.txt" 2>&1 || true
  herdr agent send-keys "$pane" ctrl+c >"$dir/send-keys.json" 2>&1 || true
  sleep 4
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after.txt" 2>&1 || true
  herdr pane get "$pane" >"$dir/pane-after.json" 2>&1 || true
  if [ "$cand" = "jia" ]; then
    a8_wait_receipt "$run" 20 || probe_note "$cand ctrlc: no receipt"
  else
    a8_wait_observed "$run" 20 || probe_note "$cand ctrlc: no observed exit"
  fi
  a8_copy_run "$run" "$dir/run"
  probe_tab_close "$tab"
}

a8_kill() {
  local cand="$1" run="kill-$cand" dir hpid
  dir="$(a8_ev "$cand/kill")"
  a8_open "a8-$cand-kill"
  local pane="$A8_PANE" tab="$A8_TAB"
  a8_launch "$cand" "$run" "$dir"
  a8_wait_tui "$pane" 60 || probe_note "$cand kill: TUI prompt not seen"
  a8_wait_agent "$pane" 60 || true
  sleep 1
  herdr pane process-info --pane "$pane" >"$dir/process-info.json" 2>&1 || true
  hpid="$(a8_harness_pid "$pane")"
  printf '%s\n' "$hpid" >"$dir/harness-pid.txt"
  a8_snapshot "$hpid" "$dir" "harness-before-kill"
  kill -9 "$hpid" 2>/dev/null || true
  if [ "$cand" = "jia" ]; then
    a8_wait_receipt "$run" 20 || probe_note "$cand kill: no receipt"
  else
    a8_wait_observed "$run" 20 || probe_note "$cand kill: no observed exit"
  fi
  sleep 1
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-kill.txt" 2>&1 || true
  a8_copy_run "$run" "$dir/run"
  a8_kill_session "$dir/harness-before-kill.stat.txt"
  probe_tab_close "$tab"
}

a8_pane_close() {
  local cand="$1" run="close-$cand" dir hpid
  dir="$(a8_ev "$cand/pane-close")"
  a8_open "a8-$cand-close"
  local pane="$A8_PANE" tab="$A8_TAB"
  a8_launch "$cand" "$run" "$dir"
  a8_wait_tui "$pane" 60 || probe_note "$cand pane-close: TUI prompt not seen"
  a8_wait_agent "$pane" 60 || true
  sleep 1
  cp "$(a8_run_dir "$cand" "$run")/heartbeat.json" "$dir/heartbeat-before.json" 2>/dev/null || true
  herdr pane process-info --pane "$pane" >"$dir/process-info-before.json" 2>&1 || true
  hpid="$(a8_harness_pid "$pane")"
  printf '%s\n' "$hpid" >"$dir/harness-pid.txt"
  a8_snapshot "$hpid" "$dir" "harness-before-close"
  herdr pane close "$pane" >"$dir/pane-close.json" 2>&1 || true
  sleep 5
  if [ "$cand" = "jia" ]; then
    a8_wait_receipt "$run" 10 || probe_note "$cand pane-close: no receipt"
  else
    a8_wait_observed "$run" 10 || probe_note "$cand pane-close: no observed exit"
  fi
  cp "$(a8_run_dir "$cand" "$run")/heartbeat.json" "$dir/heartbeat-after.json" 2>/dev/null || true
  cp "$(a8_run_dir "$cand" "$run")/signals.jsonl" "$dir/signals.jsonl" 2>/dev/null || true
  a8_copy_run "$run" "$dir/run"
  probe_tab_close "$tab"
}

a8_cancel() {
  # Supervisor-directed cancel: kill -INT <supervisor>; the supervisor must
  # forward the INT->grace->TERM->KILL sequence to the verified harness group
  # and write a receipt only after that group is empty.
  local cand="$1" run="cancel-$cand" dir sup hpid
  dir="$(a8_ev "$cand/cancel")"
  a8_open "a8-$cand-cancel"
  local pane="$A8_PANE" tab="$A8_TAB"
  a8_launch "$cand" "$run" "$dir"
  a8_wait_tui "$pane" 60 || probe_note "$cand cancel: TUI prompt not seen"
  a8_wait_agent "$pane" 60 || true
  sleep 1
  herdr pane process-info --pane "$pane" >"$dir/process-info.json" 2>&1 || true
  hpid="$(a8_harness_pid "$pane")"
  printf '%s\n' "$hpid" >"$dir/harness-pid.txt"
  a8_snapshot "$hpid" "$dir" "harness-before-cancel"
  sup="$(jq -r '.supervisorPid // empty' "$HUD_HOME/runs/$run/meta.json" 2>/dev/null)"
  printf '%s\n' "$sup" >"$dir/supervisor-pid.txt"
  kill -INT "$sup" 2>/dev/null || true
  a8_wait_receipt "$run" 40 || probe_note "$cand cancel: no receipt after SIGINT (see no-receipt.json)"
  sleep 1
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-cancel.txt" 2>&1 || true
  herdr pane process-info --pane "$pane" >"$dir/process-info-after.json" 2>&1 || true
  a8_copy_run "$run" "$dir/run"
  a8_kill_session "$dir/harness-before-cancel.stat.txt"
  probe_tab_close "$tab"
}

a8_parent_exit_jia_direct() {
  # The launcher shell starts the run through `herdr pane run` and exits; the
  # pane shell keeps hud-run as its foreground job. A TTY-reading stand-in must
  # receive input and the supervisor must write the receipt on its sentinel.
  local cand="$1" run="parent-tty-$cand" dir pane tab status launcher lpid lstatus cmd hpid
  dir="$(a8_ev "$cand/parent-exit")"
  a8_open "a8-$cand-parent-tty"
  pane="$A8_PANE"
  tab="$A8_TAB"
  status="$PROBE_WORK/parent-tty-$cand-status.json"
  rm -f "$status"
  cmd="$(cmd_join node "$MINI_RUN" --run "$run" --hud-home "$HUD_HOME" --shell "$(cmd_join node "$PROBE_LIB_DIR/tty-standin.mjs" --status "$status" --timeout-ms 30000)")"
  launcher="$PROBE_WORK/parent-tty-$cand-launch.sh"
  {
    printf '#!/bin/sh\n'
    printf 'herdr pane run %q %q\n' "$pane" "$cmd"
  } >"$launcher"
  chmod +x "$launcher"
  printf '%s\n' "$cmd" >"$dir/supervisor-command.txt"
  "$launcher" >"$dir/launcher.log" 2>&1 &
  lpid="$!"
  A8_PIDS+=("$lpid")
  wait "$lpid"
  lstatus="$?"
  printf '%s\n' "$lpid" >"$dir/launcher-pid.txt"
  printf '%s\n' "$lstatus" >"$dir/launcher-exit.txt"
  if kill -0 "$lpid" 2>/dev/null; then
    printf 'alive\n' >"$dir/launcher-gone.txt"
  else
    printf 'gone\n' >"$dir/launcher-gone.txt"
  fi
  probe_wait_file "$status" 30 || probe_note "$cand parent-exit: stand-in did not start"
  probe_wait_file "$HUD_HOME/runs/$run/meta.json" 30 || probe_note "$cand parent-exit: no supervisor meta"
  hpid="$(jq -r '.scope.harnessPid // empty' "$HUD_HOME/runs/$run/meta.json" 2>/dev/null)"
  printf '%s\n' "$hpid" >"$dir/harness-pid.txt"
  cp "$HUD_HOME/runs/$run/meta.json" "$dir/meta.json" 2>/dev/null || true
  cp "$status" "$dir/standin-status-before.json" 2>/dev/null || true
  a8_snapshot "$hpid" "$dir" "standin-before"
  herdr pane process-info --pane "$pane" >"$dir/process-info-before.json" 2>&1 || true
  jq -c '{paneForegroundPid:(.result.process_info.foreground_processes[0].pid // null),paneForegroundPgid:(.result.process_info.foreground_process_group_id // null)}' \
    "$dir/process-info-before.json" >"$dir/scope-pane.json" 2>/dev/null || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-before.txt" 2>&1 || true
  herdr pane send-text "$pane" 'hello' >/dev/null 2>&1 || true
  sleep 0.5
  herdr pane send-keys "$pane" enter >/dev/null 2>&1 || true
  sleep 2
  cp "$status" "$dir/standin-status-after-hello.json" 2>/dev/null || true
  a8_snapshot "$hpid" "$dir" "standin-after-hello"
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-hello.txt" 2>&1 || true
  herdr pane send-text "$pane" 'exit 5' >/dev/null 2>&1 || true
  sleep 0.5
  herdr pane send-keys "$pane" enter >/dev/null 2>&1 || true
  a8_wait_receipt "$run" 30 || probe_note "$cand parent-exit: no receipt after the stand-in sentinel"
  sleep 1
  cp "$status" "$dir/standin-status-final.json" 2>/dev/null || true
  a8_snapshot "$hpid" "$dir" "standin-after"
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after.txt" 2>&1 || true
  a8_copy_run "$run" "$dir/run"
  probe_tab_close "$tab"
}

a8_parent_exit_jia_background() {
  # Negative control for the old B1 model: the launcher shell backgrounds the
  # supervisor and exits, so the pane shell returns to its prompt. The stand-in
  # keeps its own tpgid but the pane input no longer reaches it.
  local cand="$1" run="parent-bg-$cand" dir pane tab status launcher cmd hpid
  dir="$(a8_ev "$cand/parent-exit-bg")"
  a8_open "a8-$cand-parent-bg"
  pane="$A8_PANE"
  tab="$A8_TAB"
  status="$PROBE_WORK/parent-bg-$cand-status.json"
  rm -f "$status"
  cmd="$(cmd_join node "$MINI_RUN" --run "$run" --hud-home "$HUD_HOME" --shell "$(cmd_join node "$PROBE_LIB_DIR/tty-standin.mjs" --status "$status" --timeout-ms 30000)")"
  launcher="$PROBE_WORK/parent-bg-$cand-launch.sh"
  {
    printf '#!/bin/sh\n'
    printf 'exec %s\n' "$cmd"
  } >"$launcher"
  chmod +x "$launcher"
  printf '%s\n' "$cmd" >"$dir/supervisor-command.txt"
  probe_pane_run "$pane" "sh -c '$launcher < /dev/tty &'"
  sleep 1
  printf 'sh -c ... & exited\n' >"$dir/launcher-exit.txt"
  probe_wait_file "$status" 30 || probe_note "$cand parent-exit-bg: stand-in did not start"
  probe_wait_file "$HUD_HOME/runs/$run/meta.json" 30 || probe_note "$cand parent-exit-bg: no supervisor meta"
  hpid="$(jq -r '.scope.harnessPid // empty' "$HUD_HOME/runs/$run/meta.json" 2>/dev/null)"
  printf '%s\n' "$hpid" >"$dir/harness-pid.txt"
  cp "$HUD_HOME/runs/$run/meta.json" "$dir/meta.json" 2>/dev/null || true
  cp "$status" "$dir/standin-status-before.json" 2>/dev/null || true
  a8_snapshot "$hpid" "$dir" "standin-before"
  herdr pane process-info --pane "$pane" >"$dir/process-info-before.json" 2>&1 || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-before.txt" 2>&1 || true
  herdr pane send-text "$pane" 'hello' >/dev/null 2>&1 || true
  sleep 0.5
  herdr pane send-keys "$pane" enter >/dev/null 2>&1 || true
  sleep 3
  cp "$status" "$dir/standin-status-after-hello.json" 2>/dev/null || true
  a8_snapshot "$hpid" "$dir" "standin-after-hello"
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-hello.txt" 2>&1 || true
  a8_wait_receipt "$run" 20 || probe_note "$cand parent-exit-bg: no receipt after the input"
  sleep 1
  cp "$status" "$dir/standin-status-final.json" 2>/dev/null || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after.txt" 2>&1 || true
  a8_copy_run "$run" "$dir/run"
  a8_kill_session "$dir/standin-before.stat.txt"
  probe_tab_close "$tab"
}

a8_parent_exit_yi() {
  # 乙: the sidecar's launcher shell exits; the sidecar keeps polling. The TUI
  # is launched directly in the pane, so it keeps the terminal and receives
  # input. The sidecar can only observe the exit moment, not the code.
  local cand="$1" run="parent-tty-$cand" dir pane tab status launcher lpid lstatus inner
  dir="$(a8_ev "$cand/parent-exit")"
  a8_open "a8-$cand-parent-tty"
  pane="$A8_PANE"
  tab="$A8_TAB"
  status="$PROBE_WORK/parent-tty-$cand-status.json"
  rm -f "$status"
  inner="$(cmd_join node "$MINI_SIDECAR" --run "$run" --hud-home "$HUD_HOME" --pane "$pane" --interval 300)"
  launcher="$PROBE_WORK/parent-tty-$cand-sidecar-launch.sh"
  {
    printf '#!/bin/sh\n'
    printf '%s &\n' "$inner"
  } >"$launcher"
  chmod +x "$launcher"
  printf '%s\n' "$inner" >"$dir/sidecar-command.txt"
  "$launcher" >"$dir/sidecar.log" 2>&1 &
  lpid="$!"
  A8_PIDS+=("$lpid")
  wait "$lpid"
  lstatus="$?"
  printf '%s\n' "$lpid" >"$dir/launcher-pid.txt"
  printf '%s\n' "$lstatus" >"$dir/launcher-exit.txt"
  if kill -0 "$lpid" 2>/dev/null; then
    printf 'alive\n' >"$dir/launcher-gone.txt"
  else
    printf 'gone\n' >"$dir/launcher-gone.txt"
  fi
  probe_pane_run "$pane" "$(cmd_join node "$PROBE_LIB_DIR/tty-standin.mjs" --status "$status" --timeout-ms 30000)"
  probe_wait_file "$status" 30 || probe_note "$cand parent-exit: stand-in did not start"
  cp "$status" "$dir/standin-status-before.json" 2>/dev/null || true
  herdr pane process-info --pane "$pane" >"$dir/process-info-before.json" 2>&1 || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-before.txt" 2>&1 || true
  herdr pane send-text "$pane" 'hello' >/dev/null 2>&1 || true
  sleep 0.5
  herdr pane send-keys "$pane" enter >/dev/null 2>&1 || true
  sleep 2
  cp "$status" "$dir/standin-status-after-hello.json" 2>/dev/null || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after-hello.txt" 2>&1 || true
  herdr pane send-text "$pane" 'exit 5' >/dev/null 2>&1 || true
  sleep 0.5
  herdr pane send-keys "$pane" enter >/dev/null 2>&1 || true
  a8_wait_observed "$run" 30 || probe_note "$cand parent-exit: no sidecar observation"
  sleep 1
  cp "$status" "$dir/standin-status-final.json" 2>/dev/null || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after.txt" 2>&1 || true
  a8_copy_run "$run" "$dir/run"
  probe_tab_close "$tab"
}

a8_parent_exit() {
  local cand="$1"
  if [ "$cand" = "jia" ]; then
    a8_parent_exit_jia_direct "$cand"
    a8_parent_exit_jia_background "$cand"
  else
    a8_parent_exit_yi "$cand"
  fi
}

a8_supervisor_death() {
  local cand="$1" run="death-$cand" dir sup hpid
  dir="$(a8_ev "$cand/supervisor-death")"
  a8_open "a8-$cand-death"
  local pane="$A8_PANE" tab="$A8_TAB"
  a8_launch "$cand" "$run" "$dir"
  a8_wait_tui "$pane" 60 || probe_note "$cand supervisor-death: TUI prompt not seen"
  a8_wait_agent "$pane" 60 || true
  sleep 1
  cp "$(a8_run_dir "$cand" "$run")/heartbeat.json" "$dir/heartbeat-before.json" 2>/dev/null || true
  herdr pane process-info --pane "$pane" >"$dir/process-info-before.json" 2>&1 || true
  hpid="$(a8_harness_pid "$pane")"
  printf '%s\n' "$hpid" >"$dir/harness-pid.txt"
  a8_snapshot "$hpid" "$dir" "harness"
  if [ "$cand" = "jia" ]; then
    sup="$(jq -r '.supervisorPid // empty' "$HUD_HOME/runs/$run/meta.json" 2>/dev/null)"
  else
    sup="$(jq -r '.sidecarPid // empty' "$HUD_HOME/runs/$run/sidecar/meta.json" 2>/dev/null)"
  fi
  printf '%s\n' "$sup" >"$dir/supervisor-pid.txt"
  kill -9 "$sup" 2>/dev/null || true
  sleep 3
  cp "$(a8_run_dir "$cand" "$run")/heartbeat.json" "$dir/heartbeat-after.json" 2>/dev/null || true
  herdr pane process-info --pane "$pane" >"$dir/process-info-after.json" 2>&1 || true
  herdr pane get "$pane" >"$dir/pane-after.json" 2>&1 || true
  if [ -n "$hpid" ] && kill -0 "$hpid" 2>/dev/null; then
    printf 'alive\n' >"$dir/harness-alive.txt"
  else
    printf 'gone\n' >"$dir/harness-alive.txt"
  fi
  # Post-death terminal ownership: the harness state/tpgid after the wrapper
  # died, and where one harmless synthetic keystroke lands. No model turn: the
  # character is never submitted.
  a8_snapshot "$hpid" "$dir" "harness-after"
  herdr pane send-text "$pane" 'x' >"$dir/input-send.json" 2>&1 || true
  sleep 2
  herdr pane read "$pane" --lines 20 --source visible >"$dir/input-echo.txt" 2>&1 || true
  herdr pane get "$pane" >"$dir/pane-after-input.json" 2>&1 || true
  herdr pane process-info --pane "$pane" >"$dir/process-info-after-input.json" 2>&1 || true
  a8_snapshot "$hpid" "$dir" "harness-after-input"
  herdr pane send-keys "$pane" backspace >/dev/null 2>&1 || true
  ls "$HUD_HOME/runs/$run/exit.json" >"$dir/receipt-exists.txt" 2>&1 || true
  herdr pane read "$pane" --lines 20 --source visible >"$dir/pane-after.txt" 2>&1 || true
  a8_copy_run "$run" "$dir/run"
  [ -n "$hpid" ] && kill -9 "$hpid" 2>/dev/null || true
  a8_kill_session "$dir/harness.stat.txt"
  probe_tab_close "$tab"
}

a8_summary() {
  local out="$PROBE_EVID/summary.txt" cand dir
  : >"$out"
  for cand in $CANDIDATES; do
    dir="$PROBE_EVID/$cand"
    [ -d "$dir" ] || continue
    printf '## %s\n' "$cand" >>"$out"
    for row in normal normal-exec kill pane-close cancel; do
      if [ -s "$dir/$row/run/exit.json" ]; then
        printf '%s receipt: %s\n' "$row" \
          "$(jq -c '{reason,shellStatus:(.shellStatus // .exitCode),shellSignal:(.shellSignal // .signal),harnessExitCode,harnessSignal,harnessPgid,supervisorSignal,groupEmpty:(.group.empty // null)}' "$dir/$row/run/exit.json")" >>"$out"
      elif [ -s "$dir/$row/run/no-receipt.json" ]; then
        printf '%s no-receipt: %s\n' "$row" \
          "$(jq -c '{reason,shellStatus,members:((.group.members // []) | map(.comm))}' "$dir/$row/run/no-receipt.json")" >>"$out"
      elif [ -s "$dir/$row/run/sidecar/observed-exit.json" ]; then
        printf '%s observed: %s\n' "$row" \
          "$(jq -c '{exitCode,receiptWritten}' "$dir/$row/run/sidecar/observed-exit.json")" >>"$out"
      elif [ -s "$dir/$row/run/sidecar/observed-pane-gone.json" ]; then
        printf '%s pane-gone: %s\n' "$row" \
          "$(jq -c '{receiptWritten,reason}' "$dir/$row/run/sidecar/observed-pane-gone.json")" >>"$out"
      fi
    done
    if [ -s "$dir/context/agent-list-ready.json" ]; then
      printf 'context agent ready: %s\n' "$(cat "$dir/context/agent-list-ready.json")" >>"$out"
      printf 'context agent working: %s\n' "$(cat "$dir/context/agent-list-working.json" 2>/dev/null)" >>"$out"
      printf 'context agent done: %s\n' "$(cat "$dir/context/agent-list-done.json" 2>/dev/null)" >>"$out"
      printf 'context agent after-read: %s\n' "$(cat "$dir/context/agent-list-after-read.json" 2>/dev/null)" >>"$out"
      printf 'context agent idle: %s\n' "$(cat "$dir/context/agent-list-idle.json" 2>/dev/null)" >>"$out"
      printf 'context agent working-session: %s\n' "$(cat "$dir/context/agent-list-working-session.json" 2>/dev/null)" >>"$out"
      printf 'context agent second-working: %s\n' "$(cat "$dir/context/agent-list-second-working.json" 2>/dev/null)" >>"$out"
      printf 'context agent second-after: %s\n' "$(cat "$dir/context/agent-list-second-after.json" 2>/dev/null)" >>"$out"
      printf 'context agent after-quit: %s\n' "$(cat "$dir/context/agent-list-after-quit.json" 2>/dev/null)" >>"$out"
    fi
    if [ -s "$dir/context/context-probe.txt" ]; then
      printf 'context probe: %s\n' "$(tr '\n' ' ' <"$dir/context/context-probe.txt")" >>"$out"
    fi
    if [ -s "$dir/parent-exit/run/exit.json" ]; then
      printf 'parent-exit receipt: %s\n' \
        "$(jq -c '{reason,shellStatus:(.shellStatus // .exitCode),shellSignal:(.shellSignal // .signal),groupEmpty:(.group.empty // null)}' "$dir/parent-exit/run/exit.json")" >>"$out"
    elif [ -s "$dir/parent-exit/run/sidecar/observed-exit.json" ]; then
      printf 'parent-exit observed: %s\n' \
        "$(jq -c '{exitCode,receiptWritten}' "$dir/parent-exit/run/sidecar/observed-exit.json")" >>"$out"
    fi
    if [ -s "$dir/parent-exit/standin-status-final.json" ]; then
      printf 'parent-exit standin: %s\n' \
        "$(jq -c '{lines,sentinelSeen,readError,timedOut,reason}' "$dir/parent-exit/standin-status-final.json")" >>"$out"
    fi
    if [ -s "$dir/parent-exit-bg/run/exit.json" ]; then
      printf 'parent-exit-bg receipt: %s\n' \
        "$(jq -c '{reason,shellStatus:(.shellStatus // .exitCode),shellSignal:(.shellSignal // .signal),groupEmpty:(.group.empty // null)}' "$dir/parent-exit-bg/run/exit.json")" >>"$out"
    fi
    if [ -s "$dir/parent-exit-bg/standin-status-after-hello.json" ]; then
      printf 'parent-exit-bg standin: %s\n' \
        "$(jq -c '{lines,sentinelSeen,readError,timedOut}' "$dir/parent-exit-bg/standin-status-after-hello.json")" >>"$out"
    fi
    printf 'supervisor-death harness: %s\n' "$(cat "$dir/supervisor-death/harness-alive.txt" 2>/dev/null)" >>"$out"
    printf 'supervisor-death receipt: %s\n' \
      "$(if [ -s "$dir/supervisor-death/run/exit.json" ]; then echo present; else echo absent; fi)" >>"$out"
  done
  probe_note "summary written to $out"
}

main() {
  local cand
  for cand in $CANDIDATES; do
    a8_selected "$cand" normal && a8_normal "$cand"
    a8_selected "$cand" normal-exec && a8_normal "$cand" exec
    a8_selected "$cand" ctrlc && a8_ctrlc "$cand"
    a8_selected "$cand" kill && a8_kill "$cand"
    a8_selected "$cand" pane-close && a8_pane_close "$cand"
    a8_selected "$cand" cancel && [ "$cand" = "jia" ] && a8_cancel "$cand"
    a8_selected "$cand" context && [ "$cand" = "jia" ] && a8_context "$cand"
    a8_selected "$cand" parent-exit && a8_parent_exit "$cand"
    a8_selected "$cand" supervisor-death && a8_supervisor_death "$cand"
  done
  a8_summary
}

main

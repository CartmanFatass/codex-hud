#!/usr/bin/env bash
# P4: does pi resume append to the same .jsonl or create a new one?
#
# Four headless runs in one temporary --session-dir:
#   initial      --session-id <uuid>   (does it create a file with that id?)
#   resume-id    --session <id>
#   resume-path  --session <path>
#   fork         --fork <path>
# Each run is one trivial model call. Evidence:
# tmp/tasks/A3/evidence/pi-resume/.
set -u

if [ -z "${PROBE_UNDER_TIMEOUT:-}" ]; then
  PROBE_UNDER_TIMEOUT=1 exec timeout --kill-after=15 300 bash "$0" "$@"
fi

source "$(dirname "$0")/lib/common.sh"
probe_begin pi-resume

MODEL="${PROBE_PI_MODEL:-anthropic/claude-haiku-4-5}"
PROMPT="Reply with exactly OK."
SESS="$PROBE_WORK/sessions"
UUID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
mkdir -p "$SESS"

snapshot() {
  # snapshot <step> ; one JSON line per session file
  node "$PROBE_LIB_DIR/session-snapshot.mjs" "$SESS" >"$PROBE_EVID/files-$1.jsonl"
}

run_pi() {
  # run_pi <step> [flag args...] ; a failed or timed-out run fails the probe
  local step="$1"
  shift
  local args=(pi -p --session-dir "$SESS" --model "$MODEL" --thinking off --no-tools)
  args+=("$@")
  args+=("$PROMPT")
  printf '== %s\n%s\n' "$step" "$(cmd_join "${args[@]}")" >>"$PROBE_EVID/commands.txt"
  timeout 150 "${args[@]}" >"$PROBE_EVID/stdout-$step.txt" 2>"$PROBE_EVID/stderr-$step.txt"
  local status=$?
  printf 'exit=%s\n\n' "$status" >>"$PROBE_EVID/commands.txt"
  snapshot "$step"
  probe_note "$step exit=$status"
  if [ "$status" -ne 0 ]; then
    probe_fail "$step run failed (exit $status); see $PROBE_EVID/stderr-$step.txt"
  fi
  # Every step must leave a session record; without one the resume/fork
  # question was not measured, even when the harness exit status was 0.
  if [ -z "$(jq -r 'select(.sessionId != null) | .sessionId' "$PROBE_EVID/files-$step.jsonl" | head -1)" ]; then
    probe_fail "$step run wrote no session record; see $PROBE_EVID/files-$step.jsonl"
  fi
  return 0
}

ls -la "$HOME/.pi/agent/sessions" >"$PROBE_EVID/user-sessions-before.txt" 2>&1 || true
snapshot before

run_pi initial --session-id "$UUID"
INITIAL_ID="$(jq -r 'select(.sessionId != null) | .sessionId' "$PROBE_EVID/files-initial.jsonl" | head -1)"
[ -n "$INITIAL_ID" ] || probe_fail "the initial run wrote no session record"
INITIAL_FILE="$(jq -r 'select(.sessionId != null) | .file' "$PROBE_EVID/files-initial.jsonl" | head -1)"
INITIAL_PATH="$SESS/$INITIAL_FILE"
probe_note "initial session id: $INITIAL_ID (requested $UUID)"
probe_note "initial session file: $INITIAL_FILE"

run_pi resume-id --session "$INITIAL_ID"
run_pi resume-path --session "$INITIAL_PATH"
run_pi fork --fork "$INITIAL_PATH"

ls -la "$HOME/.pi/agent/sessions" >"$PROBE_EVID/user-sessions-after.txt" 2>&1 || true

# --- short summary ----------------------------------------------------------
for step in initial resume-id resume-path fork; do
  probe_log "$step: $(jq -r '"\(.file) lines=\(.lines) id=\(.sessionId)"' "$PROBE_EVID/files-$step.jsonl" | tr '\n' ' ')"
done
probe_log "evidence: $PROBE_EVID"
exit 0

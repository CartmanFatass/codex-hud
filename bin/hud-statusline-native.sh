#!/bin/bash
# Sourced by the polyglot launcher. Only the one-shot compact path may read stdin here.
entry=$1; shift
native=${entry%/bin/*}/dist/native/hud-statusline
[[ -x $native ]] || native=${entry%/*}/hud-statusline-linux-x64

statusline_ts() {
  if command -v node >/dev/null; then exec node "$entry" "$@"; fi
  case ${1:-} in
    --help|import|settings) printf 'runtime_unavailable: Node >=24.0.0 required\n' >&2; exit 5 ;;
    *) printf 'HUD unavailable\n'; exit 0 ;;
  esac
}

# Only a verified agy process can share a cached frame. Its sh -c wrapper has a new PID each call.
agy_identity() {
  local pid=$PPID stat tail comm hop
  local -a fields
  for ((hop = 0; hop < 4; hop++)); do
    [[ $pid =~ ^[1-9][0-9]*$ ]] && IFS= read -r stat < "/proc/$pid/stat" || return 1
    tail=${stat##*) }; comm=${stat#* (}; comm=${comm%") $tail"}
    IFS=' ' read -r -a fields <<< "$tail"
    case $comm in
      agy|antigravity) [[ ${fields[19]} =~ ^[0-9]+$ ]] || return 1; caller=$pid:${fields[19]}; return 0 ;;
      sh|dash|bash|zsh|fish) pid=${fields[1]} ;;
      *) return 1 ;;
    esac
  done
  return 1
}
mode=(--launcher-v1 "$@")
if (( $# == 0 )) || [[ $# == 1 && $1 == --agy-render ]]; then
  caller=
  if agy_identity 2>/dev/null || [[ ${1-} == --agy-render ]]; then
    umask 077
    mode=(--agy-launcher-v1 "$entry" "$caller")
    set -- --agy-render # Even a missing binary must not send this caller's input to Claude's forwarder.
  fi
fi
if [[ ! -x $native || $OSTYPE != linux* || $HOSTTYPE != x86_64 || ! ${EPOCHREALTIME:-} || -t 0 ]] ||
   { (( $# )) && [[ ${mode[0]} != --agy-launcher-v1 ]] && [[ $# != 2 || $1 != --width || ! $2 =~ ^[1-9][0-9]{0,2}$ || $2 -gt 500 ]]; } ||
   { [[ -t 1 && ! ${COLUMNS:-} =~ ^[1-9][0-9]*$ ]] && (( $# == 0 )); }; then
  statusline_ts "$@"
fi

# Bash strings cannot contain NUL. Read byte chunks separated by NUL and reinsert the delimiters on each replay.
# LC_ALL=C makes the count byte-based even for invalid UTF-8. The subshells see only an anonymous stdin pipe.
statusline_buffer() {
  local LC_ALL=C remaining=65537 start=${EPOCHREALTIME/./} wait_time=1 count read_status clock left
  nul_chunks=()
  while :; do
    IFS= read -r -d '' -n "$remaining" -t "$wait_time" chunk
    read_status=$?
    count=${#chunk}
    if (( read_status == 1 || count >= remaining )); then break; fi
    if (( read_status > 128 )); then
      # A partial buffer (even a complete JSON object without EOF) must never be forwarded on a timeout.
      nul_chunks=(); chunk=; break
    fi
    nul_chunks+=("$chunk")
    (( remaining -= count + 1 ))
    if (( remaining <= 0 )); then chunk=; break; fi
    clock=${EPOCHREALTIME/./}
    (( left = 1000000 - (clock - start) ))
    if (( left <= 0 )); then nul_chunks=(); chunk=; break; fi
    if (( left < 1000000 )); then printf -v wait_time '0.%06d' "$left"; fi
  done
}
statusline_replay() {
  if ((${#nul_chunks[@]})); then printf '%s\0' "${nul_chunks[@]}"; fi
  printf '%s' "$chunk"
}
# A cache lookup does not need input. Keep the producer's pipe untouched until we have a complete frame.
end=$'\n:end-hud-statusline-v1'
if [[ ${mode[0]} == --agy-launcher-v1 && $caller ]] &&
   frame=$(exec "$native" --agy-lookup-v1 "$entry" "$caller" </dev/null 2>/dev/null) && [[ $frame == hud-statusline-v1:*$'\n'*"$end" ]]; then
  frame=${frame#hud-statusline-v1:}; action=${frame%%$'\n'*}; frame=${frame#*$'\n'}
  if [[ $action == fresh ]]; then
    printf '%s\n' "${frame%"$end"}"
    LC_ALL=C IFS= read -r -d '' -n 65537 -t 1 ignored 2>/dev/null
    exit 0
  elif [[ $action =~ ^[a-f0-9]{64}$ ]] && setsid -f "$native" --agy-refresh-v1 "$entry" "$caller" "$action" >/dev/null 2>&1; then
    printf '%s\n' "${frame%"$end"}"
    exit 0
  fi
fi
statusline_buffer
# A killed, missing-loader or wrong-version renderer cannot leak half a frame.
if frame=$(exec "$native" "${mode[@]}" 2>/dev/null < <(statusline_replay)) && [[ $frame == hud-statusline-v1:*"$end" ]]; then
  frame=${frame#hud-statusline-v1:}
  printf '%s\n' "${frame%"$end"}"
  exit 0
fi
statusline_replay | statusline_ts "$@"
exit $?

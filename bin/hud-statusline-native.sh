#!/bin/bash
# The polyglot launcher sources the POSIX fast path; only fallback needs Bash's byte replay.
if [ "$0" != "$helper" ]; then
  native=${entry%/bin/*}/dist/native/hud-statusline
  [ -x "$native" ] || native=${entry%/*}/hud-statusline-linux-x64

  # Walk shell wrappers without forking. Native verifies the agy PID and birth ticks.
  agy_parent() {
    pid=$PPID
    for hop in 1 2 3 4; do
      case $pid in ''|0*|*[!0-9]*) return 1 ;; esac
      IFS= read -r comm < "/proc/$pid/comm" || return 1
      case $comm in
        agy|antigravity) return 0 ;;
        sh|dash|bash|zsh|fish)
          IFS= read -r stat < "/proc/$pid/stat" || return 1
          tail=${stat##*) }; parent=${tail#* }; pid=${parent%% *} ;;
        *) return 1 ;;
      esac
    done
    return 1
  }
  agy_pid=
  if [ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = --agy-render ]; }; then
    if agy_parent 2>/dev/null; then agy_pid=$pid; fi
    if [ -n "$agy_pid" ] || [ "${1-}" = --agy-render ]; then
      umask 077
      if [ -n "$agy_pid" ] && [ -x "$native" ] && ! [ -t 0 ] &&
         "$native" --agy-lookup-v1 "$entry" "$agy_pid" 2>/dev/null; then
        exit 0
      fi
      set -- --agy-render # Even without native, never forward this caller's stdin as Claude.
    fi
  fi
  helper=$helper exec /bin/bash "$helper" "$entry" "$native" "$agy_pid" "$@"
fi
entry=$1 native=$2 agy_pid=$3; shift 3
unset helper

statusline_ts() {
  if command -v node >/dev/null; then exec node "$entry" "$@"; fi
  case ${1:-} in
    --help|import|settings) printf 'runtime_unavailable: Node >=24.0.0 required\n' >&2; exit 5 ;;
    *) printf 'HUD unavailable\n'; exit 0 ;;
  esac
}

mode=(--launcher-v1 "$@")
if [[ $# == 1 && $1 == --agy-render ]]; then
  mode=(--agy-launcher-v2 "$entry" "$agy_pid")
fi
if [[ ! -x $native || $OSTYPE != linux* || $HOSTTYPE != x86_64 || ! ${EPOCHREALTIME:-} || -t 0 ]] ||
   { (( $# )) && [[ ${mode[0]} != --agy-launcher-v2 ]] && [[ $# != 2 || $1 != --width || ! $2 =~ ^[1-9][0-9]{0,2}$ || $2 -gt 500 ]]; } ||
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
end=$'\n:end-hud-statusline-v1'
statusline_buffer
# A killed, missing-loader or wrong-version renderer cannot leak half a frame.
if frame=$(exec "$native" "${mode[@]}" 2>/dev/null < <(statusline_replay)) && [[ $frame == hud-statusline-v1:*"$end" ]]; then
  frame=${frame#hud-statusline-v1:}
  printf '%s\n' "${frame%"$end"}"
  exit 0
fi
statusline_replay | statusline_ts "$@"
exit $?

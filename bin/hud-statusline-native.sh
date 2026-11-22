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

if [[ ! -x $native || $OSTYPE != linux* || $HOSTTYPE != x86_64 || ! ${EPOCHREALTIME:-} || -t 0 ]] ||
   { (( $# )) && [[ $# != 2 || $1 != --width || ! $2 =~ ^[1-9][0-9]{0,2}$ || $2 -gt 500 ]]; } ||
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
statusline_buffer
# A killed, missing-loader or wrong-version renderer cannot leak half a frame.
end=$'\n:end-hud-statusline-v1'
if frame=$(exec "$native" --launcher-v1 "$@" 2>/dev/null < <(statusline_replay)) && [[ $frame == hud-statusline-v1:*"$end" ]]; then
  frame=${frame#hud-statusline-v1:}
  printf '%s\n' "${frame%"$end"}"
  exit 0
fi
statusline_replay | statusline_ts "$@"
exit $?

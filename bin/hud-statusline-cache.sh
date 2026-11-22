#!/usr/bin/env bash
# Sourced by hud-statusline. The launcher never parses or saves stdin.
set +x
cache_script=${BASH_SOURCE[0]}
unavailable() { printf 'HUD unavailable\n'; }
now_ms() { local epoch=${EPOCHREALTIME/./}; now=$((epoch / 1000)); }

agy_caller() {
  local pid=$PPID stat comm tail hop
  local -a fields
  # Agy may invoke the setting through `sh -c`; that shell has a new PID on each refresh.
  for ((hop = 0; hop < 4; hop++)); do
    [[ $pid =~ ^[1-9][0-9]*$ ]] && IFS= read -r stat < "/proc/$pid/stat" || return 1
    tail=${stat##*) }
    comm=${stat#* (}; comm=${comm%") $tail"}
    IFS=' ' read -r -a fields <<< "$tail"
    case $comm in
      agy|antigravity)
        [[ ${fields[19]} =~ ^[0-9]+$ ]] || return 1 # field 22: start time in clock ticks
        caller=$pid:${fields[19]}
        return 0 ;;
      sh|dash|bash|zsh|fish) pid=${fields[1]} ;;
      *) return 1 ;;
    esac
  done
  return 1
}

read_line() {
  local file=$slot.line meta k s checksum extra actual
  cached=
  [[ -f $file && -O $file && ! -L $file ]] || return 1
  meta=$(stat -c '%s %a' -- "$file" 2>/dev/null) || return 1
  [[ ${meta#* } == 600 ]] && (( ${meta% *} <= 16384 )) || return 1
  {
    IFS=' ' read -r k s born checksum extra &&
      [[ $k == "$key" && $s == "$stamp" && $born =~ ^[1-9][0-9]{12}$ && ! $extra ]] &&
      IFS= read -r -d '' -n 16384 cached
    [[ $? == 1 && $cached == $'\e[0m'?*$'\n' ]]
  } < "$file" || return 1
  now_ms
  (( now >= born && now - born < 3000 )) || return 1
  actual=$(printf '%s' "$cached" | sha256sum)
  [[ ${actual%% *} == "$checksum" ]]
}

# Called only with the slot locked. A refresh marker left by a killed worker forces a cold render.
render_line() {
  local fresh checksum
  rm -f -- "$slot.refresh"
  (set -C; : > "$slot.refresh") || { node "$entry" --agy-render 9>&-; return; }
  if fresh=$(timeout -k .2s 2s node "$entry" --agy-render 2>/dev/null) && [[ $fresh == $'\e[0m'?* ]]; then
    now_ms
    checksum=$(printf '%s\n' "$fresh" | sha256sum)
    rm -f -- "$slot.tmp"
    if (set -C; printf '%s %s %s %s\n%s\n' "$key" "$stamp" "$now" "${checksum%% *}" "$fresh" > "$slot.tmp"); then
      mv -fT -- "$slot.tmp" "$slot.line" || rm -f -- "$slot.line"
    else
      rm -f -- "$slot.line"
    fi
  else
    rm -f -- "$slot.line"
  fi
  rm -f -- "$slot.tmp" "$slot.refresh"
  [[ -n $fresh ]] && printf '%s\n' "$fresh" || unavailable
}

# A producer can still be writing when we return a cached frame. Drain the one-shot pipe, bounded like Node's reader.
drain() { local ignored; LC_ALL=C IFS= read -r -d '' -n 65537 -t 1 ignored 2>/dev/null; }
open_lock() {
  [[ ! -L $slot.lock && ( ! -e $slot.lock || -f $slot.lock ) ]] && exec 9>>"$slot.lock"
}

if [[ $1 == --refresh ]]; then
  umask 077
  entry=$2 slot=$3 key=$4 stamp=$5
  if ! open_lock || ! flock -n 9 || { [[ ! -e $slot.refresh ]] && read_line && (( now - born < 1000 )); }; then
    drain; exit 0
  fi
  render_line
  exit 0
fi

entry=$1; shift
if ! command -v node >/dev/null; then
  case ${1:-} in --help|import|settings) printf 'runtime_unavailable: Node >=24.0.0 required\n' >&2; exit 5 ;; esac
  unavailable; exit 0
fi
# Explicit CLI and other clients keep the native Node path. No platform tool is required to render.
if (( $# )) || [[ ! ${EPOCHREALTIME:-} ]] || ! agy_caller 2>/dev/null; then exec node "$entry" "$@"; fi
plain() { exec node "$entry" --agy-render; }
for helper in sha256sum flock setsid timeout; do
  command -v "$helper" >/dev/null || plain
done

umask 077
home=${HUD_HOME:-${HOME:+$HOME/.hud}}
dir=$home/display/statusline-agy-v1
if [[ $home != /* || -L $home || -L $home/display || -L $dir ]] ||
   { [[ ! -d $dir ]] && ! mkdir -p -m 700 -- "$dir" 2>/dev/null; } || [[ ! -O $dir ]]; then plain; fi
settings=${HUD_SETTINGS_PATH-${CODEX_HUD_SETTINGS_PATH-}}
meta=$(stat -Lc '%a %d:%i:%s:%y:%z %n' -- "$dir" "$home/config.json" \
  "${settings:-$home/hud-settings.json}" "${entry%/bin/*}/dist/cli/statusline.js" 2>/dev/null)
[[ ${meta%% *} == 700 ]] || plain
# Key the session on its process identity and the invocation's cwd, not on the payload or its email.
key=$(printf '%s\0' "$caller" "$PWD" | sha256sum); key=${key%% *}
stamp=$({
  printf '%s\0' "$entry" "$settings"
  for name in NO_COLOR COLORTERM HUD_THEME HUD_ICONS HUD_BAR_STYLE HUD_BAR_FIELDS \
              CODEX_HUD_THEME CODEX_HUD_ICONS CODEX_HUD_BAR_STYLE CODEX_HUD_BAR_FIELDS; do
    printf '%s\0' "${!name+x}" "${!name-}"
  done
  # The directory's own mtime changes with each refresh; only the following file stamps affect presentation.
  printf '%s' "${meta#*$'\n'}"
} | sha256sum); stamp=${stamp%% *}
[[ $key =~ ^[a-f0-9]{64}$ && $stamp =~ ^[a-f0-9]{64}$ ]] || plain
printf -v slot '%s/%02x' "$dir" "$((16#${key:0:2} % 64))" # Even crashed writers leave at most 64 slots.

if read_line && [[ ! -e $slot.refresh ]]; then
  printf '%s' "$cached"
  if (( now - born >= 1000 )); then
    # setsid duplicates stdin in the detached child. Do not use a shell here-string or save the payload.
    setsid -f bash "$cache_script" --refresh "$entry" "$slot" "$key" "$stamp" >/dev/null 2>&1
  else
    drain
  fi
  exit 0
fi

valid=0
read_line && valid=1
open_lock || plain
if ! flock -n 9; then
  if (( valid )); then printf '%s' "$cached"; drain; exit 0; fi
  flock -w 3 9 || { unavailable; exit 0; }
fi
if [[ ! -e $slot.refresh ]] && read_line && (( now - born < 1000 )); then
  printf '%s' "$cached"; drain
else
  find "$dir" -maxdepth 1 -type f -name '*.line' -mmin +1 -delete 2>/dev/null
  render_line
fi
exit 0

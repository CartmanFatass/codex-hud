# Wave 1 composite verification library (sourced). Adapted from followup-scripts/lib.sh; lives outside every worktree.
V=<VERIFY_ROOT>
RD=$V/wave1-composite-20261104T031916Z-680937
S=$RD/scripts
REPO=<REPO>
: "${SROOT:?SROOT (short temp root) must be set}"
N22=$V/runtimes/node-v22.23.4/bin
N24=<HOME>/.nvm/versions/node/v24.22.1/bin
T=$RD/manifest/results.tsv
declare -A WT=( [c3]=$V/wt/w1-c3 [u]=$V/wt/w1-u )
PROXY_NAMES="HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy"
PASSED_NAMES="PATH HOME HUD_HOME TMPDIR LANG TERM npm_config_cache npm_config_update_notifier npm_config_fund npm_config_audit $PROXY_NAMES NODE_USE_ENV_PROXY NODE_PROXY_EVIDENCE_DIR RUNZ1_KILL_EVIDENCE_DIR"
prof_rt() { case "$1" in node22-*) echo 22;; node24-*) echo 24;; esac; }
prof_envproxy() { case "$1" in *-envproxy) echo 1;; *) echo 0;; esac; }
nodebin() { case "$1" in 22) echo $N22;; 24) echo $N24;; esac; }
# Names (never values) of invoking-shell variables that env -i does not pass on.
dropped_names() { local n out=""; for n in $(compgen -e | LC_ALL=C sort); do case " $PASSED_NAMES " in *" $n "*) ;; *) out+="$n ";; esac; done; echo "$out"; }
# run <tree> <profile> <logdir-rel> <id> <timeout-s> <cmd...>
# Raw streams: <logdir>/stdout.raw, stderr.raw; result.json; meta.txt; ancestry.txt; monitor.txt.
run() {
  local tree=$1 prof=$2 rel=$3 id=$4 to=$5; shift 5
  local W=${WT[$tree]} rt nb h u tm L C s e ec sig mon names="" v reached
  rt=$(prof_rt $prof); nb=$(nodebin $rt)
  L=$RD/$rel; C=$RD/captures/$prof/$id; [ "${rel%%/*}" = benchmark ] && C=$RD/$rel/captures
  if [ -e $L ]; then echo "log dir $L exists: refusing to overwrite" >&2; return 99; fi
  mkdir -p $L $C/node-proxy $C/runz1-kill
  h=$(mktemp -d $SROOT/h.XXXXXX); u=$(mktemp -d $SROOT/u.XXXXXX); tm=$(mktemp -d $SROOT/t.XXXXXX)
  local -a envs=(PATH="$nb:/usr/bin:/bin" HOME="$h" HUD_HOME="$u" TMPDIR="$tm" LANG=C.UTF-8 TERM=xterm-256color
    npm_config_cache="$V/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false)
  for v in $PROXY_NAMES; do [ -n "${!v+x}" ] && { envs+=("$v=${!v}"); names+="$v=<set> "; }; done
  [ "$(prof_envproxy $prof)" = 1 ] && { envs+=(NODE_USE_ENV_PROXY=1); names+="NODE_USE_ENV_PROXY=1 "; }
  envs+=("NODE_PROXY_EVIDENCE_DIR=$C/node-proxy" "RUNZ1_KILL_EVIDENCE_DIR=$C/runz1-kill")
  names+="NODE_PROXY_EVIDENCE_DIR=<captures>/node-proxy RUNZ1_KILL_EVIDENCE_DIR=<captures>/runz1-kill"
  {
    echo "id: $id"; echo "tree: $tree"; echo "profile: $prof"
    echo "target: commit=$(git -C $W rev-parse HEAD) tree=$(git -C $W rev-parse 'HEAD^{tree}') cwd=<wt>/$(basename $W)"
    echo "runtime: $nb/node $($nb/node -v) sha256=$(sha256sum $nb/node | cut -d' ' -f1) npm $(env -i PATH=$nb:/usr/bin:/bin $nb/npm -v 2>/dev/null)"
    echo "wrapper: cd <wt>/$(basename $W); env -i PATH=$nb:/usr/bin:/bin HOME=<new> HUD_HOME=<new> TMPDIR=<new> LANG=C.UTF-8 TERM=xterm-256color npm_config_cache=<VERIFY_ROOT>/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false $names timeout -k 10 ${to}s bash $S/anc-exec.sh <ancestry.txt> $*"
    echo "removed by env -i (names only): $(dropped_names)"
    echo "absent in child: NODE_OPTIONS NODE_NO_WARNINGS NODE_REDIRECT_WARNINGS$( [ "$(prof_envproxy $prof)" = 0 ] && echo ' NODE_USE_ENV_PROXY')"
    echo "command: $*"; echo "timeout: ${to}s"
    echo "load before: $(cut -d' ' -f1-4 /proc/loadavg)"
  } > $L/meta.txt
  ( while :; do echo "$(date -u +%T) $(cut -d' ' -f1-4 /proc/loadavg)"; sleep 1; done ) > $L/monitor.txt &
  mon=$!
  s=$(date -u +%FT%T.%3NZ)
  ( cd $W && exec env -i "${envs[@]}" timeout -k 10 "${to}s" bash $S/anc-exec.sh "$L/ancestry.txt" "$@" ) > $L/stdout.raw 2> $L/stderr.raw
  ec=$?
  e=$(date -u +%FT%T.%3NZ); kill $mon 2>/dev/null; wait $mon 2>/dev/null
  sig=-; [ $ec -eq 124 ] && sig="TIMEOUT"; [ $ec -eq 137 ] && sig="SIGKILL"; [ $ec -gt 128 ] && [ $ec -ne 137 ] && sig="signal $((ec-128))"
  { echo "start: $s"; echo "end: $e"; echo "exit: $ec"; echo "signal/timeout: $sig"; echo "load after: $(cut -d' ' -f1-4 /proc/loadavg)"; } >> $L/meta.txt
  # Owned-child cleanup check (cwd links only, no environment read): the worktree and $SROOT exist only for this run,
  # and commands run serially, so any process whose cwd is inside either is left over from this command.
  local left c; left=$(for p in /proc/[0-9]*; do c=$(readlink $p/cwd 2>/dev/null) || continue; case "$c" in "$W"|"$W"/*|"$SROOT"/*) basename $p;; esac; done | tr '\n' ' ')
  left=${left% }
  echo "owned processes left after exit: ${left:-none}" >> $L/meta.txt
  find $C -type f | sed "s#^$C/##" | LC_ALL=C sort > $L/captures-list.txt
  /usr/bin/python3 -I -c 'import json,sys; a=sys.argv; json.dump(dict(tree=a[1],profile=a[2],id=a[3],exit=int(a[4]),signal_or_timeout=a[5],start=a[6],end=a[7],timeout_s=int(a[8]),command=a[9],owned_left=a[10] or "none",captures=a[11]),open(a[12],"w"),indent=1)' \
    "$tree" "$prof" "$id" "$ec" "$sig" "$s" "$e" "$to" "$*" "$left" "${C#$RD/}" "$L/result.json"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$tree" "$prof" "$rel" "$id" "$ec" "$sig" "$s" "$e" "$to" "$*" >> $T
  rm -rf "$h" "$u" "$tm"
  echo "$tree $prof $id exit=$ec $sig left=${left:-none}"
  [ -z "$left" ]
}
clean_gen() { local W=${WT[$1]}; ( cd $W; for d in dist dist-test packages/hud-mcp/dist; do [ -e $d ] && echo "removed $d ($(find $d -type f | wc -l) files)" || echo "$d absent"; rm -rf $d; done ); }
gen_manifest() { # gen_manifest <tree> <label>
  local W=${WT[$1]} out=$RD/manifest/generated-$1-$2.txt
  ( cd $W; find dist dist-test packages/hud-mcp/dist -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum ) > $out
  { echo "files: $(wc -l < $out) manifest-sha256: $(sha256sum < $out | cut -d' ' -f1)";
    for d in dist dist-test packages/hud-mcp/dist; do echo "$d: files=$(grep -cE "  $d/" $out) aggregate=$(grep -E "  $d/" $out | sha256sum | cut -d' ' -f1)"; done; } > ${out%.txt}.summary.txt
}
src_check() { # src_check <tree> <label>
  local W=${WT[$1]} out=$RD/manifest/source-check-$1-$2.txt
  { echo "utc: $(date -u +%FT%TZ)"; echo "HEAD: $(git -C $W rev-parse HEAD) tree: $(git -C $W rev-parse 'HEAD^{tree}')"
    echo "status:"; git -C $W status --porcelain
    echo "tracked-bytes sha256: $(cd $W; git ls-files -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
    echo "tracked-bytes sha256 excluding node_modules/: $(cd $W; git ls-files -z -- . ':!node_modules' | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"; } > $out
}

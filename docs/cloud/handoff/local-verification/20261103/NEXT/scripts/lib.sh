# NEXT verification library (sourced). Scripts live outside the worktree.
V=<VERIFY_ROOT>
S=$V/next/scripts
W=$V/wt/next
REPO=<REPO>
EXP_COMMIT=0cca9caa6ddf3249291c8ed85a41da1eed800ee4
EXP_TREE=4b66dca450ad717455321e2b103dc9b5d190716c
N22=$V/runtimes/node-v22.23.4/bin
N24=<HOME>/.nvm/versions/node/v24.22.1/bin
nodebin() { case "$1" in 22) echo $N22;; 24) echo $N24;; esac; }
# Session TMPDIR: short path under /tmp (AF_UNIX socket path limits), created once per run by setup.
: "${SESSION_TMP:?SESSION_TMP must be set}"
: "${R:?R (run dir) must be set}"
T=$R/manifest/results.tsv
# step <log> <rt> <timeout-s> <id> <env-extra (space-separated K=V or '-')> <cmd...>
# Fresh HOME and HUD_HOME per process (mktemp under SESSION_TMP); env -i so NO_COLOR, FORCE_COLOR,
# NODE_USE_ENV_PROXY, NODE_OPTIONS and every other inherited variable are absent; selected node dir first on PATH.
step() {
  local log=$1 rt=$2 to=$3 id=$4 extra=$5; shift 5
  local nb h u s e ec mon
  nb=$(nodebin "$rt")
  h=$(mktemp -d "$SESSION_TMP/home.XXXXXX"); u=$(mktemp -d "$SESSION_TMP/hud.XXXXXX")
  local -a xe=(); [ "$extra" != - ] && read -r -a xe <<< "$extra"
  mkdir -p "$(dirname "$log")"
  {
    echo "# id: $id"
    echo "# target: commit=$(git -C $W rev-parse HEAD) tree=$(git -C $W rev-parse 'HEAD^{tree}') cwd=<wt>/next"
    echo "# runtime: node$rt $nb/node $($nb/node -v) npm $(PATH=$nb:/usr/bin:/bin $nb/npm -v 2>/dev/null)"
    echo "# wrapper: cd <wt>/next; env -i PATH=$nb:/usr/bin:/bin HOME=$h HUD_HOME=$u TMPDIR=$SESSION_TMP LANG=C.UTF-8 TERM=xterm-256color npm_config_cache=<VERIFY_ROOT>/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false ${xe[*]} timeout -k 10 ${to}s bash $S/anc-exec.sh <anc-file> $*"
    echo "# command: $*"
    echo "# timeout: ${to}s"
    echo "# unset by env -i: NO_COLOR FORCE_COLOR NODE_USE_ENV_PROXY NODE_OPTIONS HUD_HOME(real) proxy vars CLAUDE*/HERDR*/CODEX* (all inherited vars)"
    echo "# load before: $(cut -d' ' -f1-4 /proc/loadavg)"
  } > "$log"
  ( while :; do echo "$(date -u +%T) $(cut -d' ' -f1-4 /proc/loadavg) | $(ps -eo comm,pcpu --sort=-pcpu --no-headers | head -6 | awk '{printf "%s:%s ",$1,$2}')"; sleep 1; done ) > "${log%.log}.monitor.txt" &
  mon=$!
  s=$(date -u +%FT%T.%3NZ); echo "# start: $s" >> "$log"
  ( cd $W && env -i PATH="$nb:/usr/bin:/bin" HOME="$h" HUD_HOME="$u" TMPDIR="$SESSION_TMP" LANG=C.UTF-8 TERM=xterm-256color \
      npm_config_cache="$V/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      "${xe[@]}" timeout -k 10 "${to}s" bash $S/anc-exec.sh "${log%.log}.ancestry.txt" "$@" ) >> "$log" 2>&1
  ec=$?
  e=$(date -u +%FT%T.%3NZ); kill $mon 2>/dev/null; wait $mon 2>/dev/null
  { echo "# end: $e"; echo "# exit: $ec$( [ $ec = 124 ] && echo ' (TIMEOUT)')"; echo "# load after: $(cut -d' ' -f1-4 /proc/loadavg)"; } >> "$log"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "node$rt" "$ec" "$s" "$e" "$to" "${xe[*]}" "$*" >> $T
  echo "$id node$rt exit=$ec"
  return 0
}
gen_manifest() { # gen_manifest <out>: sha256 of every generated file + aggregates
  local out=$1
  ( cd $W; find dist dist-test packages/hud-mcp/dist -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum ) > "$out"
  { echo "files: $(wc -l < "$out")"; echo "aggregate-sha256(of manifest): $(sha256sum < "$out" | cut -d' ' -f1)";
    for d in dist dist-test packages/hud-mcp/dist; do echo "$d aggregate: $(grep -E "  $d/" "$out" | sha256sum | cut -d' ' -f1) files=$(grep -cE "  $d/" "$out")"; done
    echo "compiled-benchmark: $(cd $W; sha256sum dist-test/tests/unit/b10b-s3-perf.test.js 2>&1)"; } > "${out%.txt}.summary.txt"
}

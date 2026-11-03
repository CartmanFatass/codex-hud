# Follow-up verification library (sourced). Scripts live outside every worktree.
V=<VERIFY_ROOT>
S=$V/followup-scripts
REPO=<REPO>
: "${FU:?FU (run dir) must be set}"; : "${SROOT:?SROOT (short temp root) must be set}"
N22=$V/runtimes/node-v22.23.4/bin
N24=<HOME>/.nvm/versions/node/v24.22.1/bin
T=$FU/manifest/results.tsv
declare -A WT=( [mcp]=$V/wt/fu-mcp [mcpbase]=$V/wt/fu-mcpbase [n22]=$V/wt/fu-n22 [rk]=$V/wt/fu-rk )
PROXY_NAMES="HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy"
# Proxy values are taken from the invoking shell (the owner's declared policy) and passed unchanged.
prof_rt() { case "$1" in node22-*) echo 22;; node24-*) echo 24;; esac; }
prof_envproxy() { case "$1" in *-envproxy) echo 1;; *) echo 0;; esac; }
nodebin() { case "$1" in 22) echo $N22;; 24) echo $N24;; esac; }
# run <pkg> <profile> <id> <timeout-s> <evidence-var|-> <cmd...>
run() {
  local pkg=$1 prof=$2 id=$3 to=$4 evar=$5; shift 5
  local W=${WT[$pkg]} rt nb h u tm ev L s e ec sig mon
  rt=$(prof_rt $prof); nb=$(nodebin $rt)
  L=$FU/logs/$pkg/$prof; mkdir -p $L
  h=$(mktemp -d $SROOT/h.XXXXXX); u=$(mktemp -d $SROOT/u.XXXXXX); tm=$(mktemp -d $SROOT/t.XXXXXX)
  local -a envs=(PATH="$nb:/usr/bin:/bin" HOME="$h" HUD_HOME="$u" TMPDIR="$tm" LANG=C.UTF-8 TERM=xterm-256color
    npm_config_cache="$V/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false)
  local names="" v
  for v in $PROXY_NAMES; do [ -n "${!v+x}" ] && { envs+=("$v=${!v}"); names+="$v=<set> "; }; done
  [ "$(prof_envproxy $prof)" = 1 ] && { envs+=(NODE_USE_ENV_PROXY=1); names+="NODE_USE_ENV_PROXY=1 "; }
  if [ "$evar" != - ]; then ev=$FU/captures/$pkg/$prof/$id; mkdir -p $ev; envs+=("$evar=$ev"); names+="$evar=<captures>/$pkg/$prof/$id "; fi
  {
    echo "id: $id"; echo "package: $pkg"; echo "profile: $prof"
    echo "target: commit=$(git -C $W rev-parse HEAD) tree=$(git -C $W rev-parse 'HEAD^{tree}') cwd=<wt>/$(basename $W)"
    echo "runtime: $nb/node $($nb/node -v) npm $(env -i PATH=$nb:/usr/bin:/bin $nb/npm -v 2>/dev/null)"
    echo "wrapper: cd <wt>/$(basename $W); env -i PATH=$nb:/usr/bin:/bin HOME=$h HUD_HOME=$u TMPDIR=$tm LANG=C.UTF-8 TERM=xterm-256color npm_config_cache=<VERIFY_ROOT>/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false $names timeout -k 10 ${to}s bash $S/anc-exec.sh $id.ancestry.txt $*"
    echo "absent (env -i): NODE_OPTIONS NODE_NO_WARNINGS NODE_REDIRECT_WARNINGS NO_COLOR FORCE_COLOR CI CLAUDE* HERDR* CODEX* and all other inherited variables$( [ "$(prof_envproxy $prof)" = 0 ] && echo ' NODE_USE_ENV_PROXY')"
    echo "command: $*"; echo "timeout: ${to}s"
    echo "stdout: $id.stdout"; echo "stderr: $id.stderr"
    echo "load before: $(cut -d' ' -f1-4 /proc/loadavg)"
  } > $L/$id.meta.txt
  ( while :; do echo "$(date -u +%T) $(cut -d' ' -f1-4 /proc/loadavg) | $(ps -eo comm,pcpu --sort=-pcpu --no-headers | head -6 | awk '{printf "%s:%s ",$1,$2}')"; sleep 1; done ) > $L/$id.monitor.txt &
  mon=$!
  s=$(date -u +%FT%T.%3NZ)
  ( cd $W && env -i "${envs[@]}" timeout -k 10 "${to}s" bash $S/anc-exec.sh "$L/$id.ancestry.txt" "$@" ) > $L/$id.stdout 2> $L/$id.stderr
  ec=$?
  e=$(date -u +%FT%T.%3NZ); kill $mon 2>/dev/null; wait $mon 2>/dev/null
  sig=-; [ $ec -eq 124 ] && sig="TIMEOUT(SIGTERM by timeout)"; [ $ec -eq 137 ] && sig="SIGKILL"; [ $ec -gt 128 ] && [ $ec -ne 137 ] && sig="signal $((ec-128))"
  { echo "start: $s"; echo "end: $e"; echo "exit: $ec"; echo "signal/timeout: $sig"; echo "load after: $(cut -d' ' -f1-4 /proc/loadavg)"; } >> $L/$id.meta.txt
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pkg" "$prof" "$id" "$ec" "$sig" "$s" "$e" "$to" "$*" >> $T
  echo "$pkg $prof $id exit=$ec $sig"
}
clean_gen() { local W=${WT[$1]}; ( cd $W; for d in dist dist-test packages/hud-mcp/dist; do [ -e $d ] && echo "removed $d ($(find $d -type f | wc -l) files)" || echo "$d absent"; rm -rf $d; done ); }
gen_manifest() { # gen_manifest <pkg> <label>
  local W=${WT[$1]} out=$FU/manifest/generated-$1-$2.txt
  ( cd $W; find dist dist-test packages/hud-mcp/dist -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum ) > $out
  { echo "files: $(wc -l < $out) manifest-sha256: $(sha256sum < $out | cut -d' ' -f1)";
    for d in dist dist-test packages/hud-mcp/dist; do echo "$d: files=$(grep -cE "  $d/" $out) aggregate=$(grep -E "  $d/" $out | sha256sum | cut -d' ' -f1)"; done; } > ${out%.txt}.summary.txt
}
src_check() { # src_check <pkg> <label>: HEAD, status, tracked-file bytes
  local W=${WT[$1]} out=$FU/manifest/source-check-$1-$2.txt
  { echo "utc: $(date -u +%FT%TZ)"; echo "HEAD: $(git -C $W rev-parse HEAD) tree: $(git -C $W rev-parse 'HEAD^{tree}')"
    echo "status:"; git -C $W status --porcelain
    echo "tracked-bytes sha256: $(cd $W; git ls-files -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"; } > $out
}
# full_set <pkg> <profile> <b> <npmtest> <mjs> <core> <visual> <hudmcp> <fmt> <fix> <diff> <evar>
full_set() {
  local pkg=$1 prof=$2 tb=$3 tt=$4 tm=$5 tc=$6 tv=$7 th=$8 tf=$9 tx=${10} td=${11} ev=${12}
  clean_gen $pkg > $FU/manifest/clean-$pkg-$prof.txt
  run $pkg $prof 01-build $tb $ev npm run build
  run $pkg $prof 02-build-test $tb $ev npm run build:test
  run $pkg $prof 03-build-hud-mcp $tb $ev npm run build:hud-mcp
  gen_manifest $pkg $prof
  run $pkg $prof 04-npm-test $tt $ev npm test
  if ! grep -qE '^> [^ ]+@[^ ]+ test:mjs$' $FU/logs/$pkg/$prof/04-npm-test.stdout; then
    run $pkg $prof 04b-test-mjs-separate $tm $ev npm run test:mjs
  else echo "npm test reached test:mjs; separate run not needed" > $FU/logs/$pkg/$prof/04b-test-mjs-separate.not-run.txt; fi
  run $pkg $prof 05-test-core $tc $ev npm run test:core
  run $pkg $prof 06-test-visual $tv $ev npm run test:visual
  run $pkg $prof 07-test-hud-mcp $th $ev npm run test:hud-mcp
  run $pkg $prof 08-format-check $tf $ev npm run format:check
  run $pkg $prof 09-check-fixtures $tx $ev npm run check:fixtures
  run $pkg $prof 10-git-diff-check $td $ev git diff --check
}

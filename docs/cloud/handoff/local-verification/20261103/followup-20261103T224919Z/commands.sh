#!/usr/bin/env bash
# Exact scripts used for this run, concatenated in execution order (also under scripts/).
# Run: FU=<run dir> SROOT=<short temp root> bash setup.sh; mcp.sh; mcpbench.sh; n22.sh; rk.sh; then the four isolated known-flake reruns:
#   run n22 node22-noenvproxy-control 04r1-known-flake-rerun-b11-cli 900 NODE_PROXY_EVIDENCE_DIR node --test dist-test/tests/unit/b11-cli.test.js
#   run n22 node22-noenvproxy-control 04r2-known-flake-rerun-b21-capacity 900 NODE_PROXY_EVIDENCE_DIR node --test dist-test/tests/unit/b21-capacity.test.js
#   run rk node24-envproxy 04r1-known-flake-rerun-b21-capacity 600 RUNZ1_KILL_EVIDENCE_DIR node --test dist-test/tests/unit/b21-capacity.test.js

##### scripts/lib.sh
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

##### scripts/setup.sh
#!/usr/bin/env bash
# setup.sh: refs, binding docs, pinned detached worktrees, identities, environment, capabilities, dependency installs.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
M=$FU/manifest; mkdir -p $M
declare -A C=( [mcp]=b2897a4f9769bca6305ff0e3ae3dc694a9320ffe [mcpbase]=26f6fba36948e6c96e2e109cb374c0d4dbb9ab22 [n22]=b4047320262f72f401a513db07236ff1473db933 [rk]=7ba567ee0c3cd12933d79a5029162d32770ee245 )
declare -A TR=( [mcp]=0d195bd47ff2b29581e1c394c2973d9479f8d928 [mcpbase]=03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9 [n22]=d9be29f28da496a880802c267a08e8bb4fcbee74 [rk]=ad4c596860b264d76d4060be90d70337046b92c5 )
declare -A BR=( [mcp]=dots/mcp-ancestor [n22]=dots/node22-proxy [rk]=dots/runz1-kill )
declare -A DH=( [mcp]=dc4b96b8b3e224736cf0aeee4062184a433a023e [n22]=65b26a914bc0f54d2a4318ebf461a52140238872 [rk]=fa024ffa30afc2398408d2c735da4351b7033c2b )
{
  echo "utc: $(date -u +%FT%TZ)"; echo "origin: $(git -C $REPO remote get-url origin)"
  git -C $REPO fetch origin universal-hud dots/mcp-ancestor dots/node22-proxy dots/runz1-kill local-verification/20261103 2>&1
  for b in universal-hud dots/mcp-ancestor dots/node22-proxy dots/runz1-kill local-verification/20261103; do echo "origin/$b: $(git -C $REPO rev-parse origin/$b)"; done
  for k in mcp n22 rk; do
    echo "== ${BR[$k]}: candidate ${C[$k]} expected doc head ${DH[$k]} current $(git -C $REPO rev-parse origin/${BR[$k]}) $( [ "$(git -C $REPO rev-parse origin/${BR[$k]})" = ${DH[$k]} ] && echo MATCH || echo DIFFERS)"
    echo "candidate ancestor of branch head: $(git -C $REPO merge-base --is-ancestor ${C[$k]} origin/${BR[$k]} && echo yes || echo no)"
    echo "diff --name-status candidate..branch head:"; git -C $REPO diff --name-status ${C[$k]} origin/${BR[$k]}
  done
  echo "== mcpbase 26f6fba ancestor of mcp candidate: $(git -C $REPO merge-base --is-ancestor ${C[mcpbase]} ${C[mcp]} && echo yes || echo no)"
  echo "== n22 parent: $(git -C $REPO rev-parse ${C[n22]}^) (expected ce5e6961a0e6de1304dcebb00fc1b8c805573ec6)"
  echo "== binding documents at origin/universal-hud $(git -C $REPO rev-parse origin/universal-hud):"
  for f in docs/cloud/README.md docs/handoff/STATE.md docs/cloud/MCP-ANCESTOR.md docs/cloud/NODE22-PROXY.md docs/cloud/RUNZ1-KILL.md docs/cloud/rulings/node22-proxy-profile.md docs/cloud/rulings/runz1-kill-fix-1.md; do echo "$f $(git -C $REPO rev-parse origin/universal-hud:$f)"; done
  echo "== latest reviews:"
  echo "docs/cloud/handoff/mcp-ancestor-review-2.md $(git -C $REPO rev-parse origin/dots/mcp-ancestor:docs/cloud/handoff/mcp-ancestor-review-2.md)"
  echo "docs/cloud/handoff/node22-proxy/review-1.md $(git -C $REPO rev-parse origin/dots/node22-proxy:docs/cloud/handoff/node22-proxy/review-1.md)"
  echo "docs/cloud/handoff/node22-proxy/node22-verification.md $(git -C $REPO rev-parse origin/dots/node22-proxy:docs/cloud/handoff/node22-proxy/node22-verification.md)"
  echo "docs/cloud/handoff/runz1-kill/review-2.md $(git -C $REPO rev-parse origin/dots/runz1-kill:docs/cloud/handoff/runz1-kill/review-2.md)"
} > $M/refs-and-docs.txt 2>&1
for k in mcp mcpbase n22 rk; do
  W=${WT[$k]}
  if [ -e $W ]; then echo "worktree $W already exists: STOP" >> $M/identity.txt; continue; fi
  git -C $REPO worktree add --detach $W ${C[$k]} > $M/worktree-add-$k.txt 2>&1
  c=$(git -C $W rev-parse HEAD); t=$(git -C $W rev-parse 'HEAD^{tree}')
  { echo "== $k: HEAD $c expected ${C[$k]} $( [ $c = ${C[$k]} ] && echo MATCH || echo MISMATCH); tree $t expected ${TR[$k]} $( [ $t = ${TR[$k]} ] && echo MATCH || echo MISMATCH)"
    echo "package-lock blob $(git -C $W rev-parse HEAD:package-lock.json) package.json blob $(git -C $W rev-parse HEAD:package.json)"
    echo "tests/hud-mcp/benchmark.mjs blob $(git -C $W rev-parse HEAD:tests/hud-mcp/benchmark.mjs 2>&1)"
    echo "fixtures blob-tree tests/fixtures $(git -C $W rev-parse HEAD:tests/fixtures 2>&1)"; } >> $M/identity.txt
  git -C $W ls-files -s > $M/source-ls-files-$k.txt
  ( cd $W; git ls-files -z | xargs -0 sha256sum ) > $M/source-sha256-$k.txt
  echo "$k source sha256 manifest: $(sha256sum < $M/source-sha256-$k.txt | cut -d' ' -f1) files=$(wc -l < $M/source-sha256-$k.txt)" >> $M/identity.txt
  src_check $k before-install
done
{
  echo "utc: $(date -u +%FT%TZ)"; uname -srmo; grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release
  echo "wsl: $(cat /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null | head -1)"; echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-) x $(nproc)"
  free -b | head -2; df -hT / /tmp | tail -n +2; echo "short temp root: $SROOT (same filesystem: $(stat -f -c %T $SROOT))"
  echo "kernel.yama.ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope)"
  for rt in 22 24; do nb=$(nodebin $rt); echo "node$rt: $nb/node $($nb/node -v) sha256 $(sha256sum $nb/node | cut -d' ' -f1); npm $(env -i PATH=$nb:/usr/bin:/bin $nb/npm -v) at $(readlink -f $nb/npm)"; done
  echo "invoking shell variables present (names only): $(for v in $PROXY_NAMES NODE_USE_ENV_PROXY NODE_OPTIONS NODE_NO_WARNINGS NODE_REDIRECT_WARNINGS NO_COLOR FORCE_COLOR CI HUD_HOME; do [ -n "${!v+x}" ] && printf '%s ' $v; done)"
  echo "NODE_OPTIONS in invoking shell: $([ -n "${NODE_OPTIONS+x}" ] && echo PRESENT-CONFLICT || echo absent)"
  echo "load: $(cat /proc/loadavg)"; echo "top processes (name, %cpu lifetime avg, elapsed):"; ps -eo comm,pcpu,etime --sort=-pcpu --no-headers | head -15
} > $M/environment.txt 2>&1
for p in node22-envproxy node24-envproxy; do run mcp $p 00-capability-probe 120 - node $S/capprobe.mjs; done
for k in mcp mcpbase n22 rk; do
  run $k node24-envproxy 00-npm-ci 900 - npm ci --ignore-scripts --prefer-offline
  ( cd ${WT[$k]}; sha256sum package-lock.json; find node_modules -type f | LC_ALL=C sort | xargs -r sha256sum ) > $M/dependency-sha256-$k.txt
  echo "$k dependency manifest: $(sha256sum < $M/dependency-sha256-$k.txt | cut -d' ' -f1) files=$(wc -l < $M/dependency-sha256-$k.txt)" >> $M/dependency-summary.txt
  src_check $k after-install
done
echo SETUP-DONE

##### scripts/mcp.sh
#!/usr/bin/env bash
# MCP-ANCESTOR: per profile full set (MCP brief limits) + three-file gate with ancestry probe before/after + package prettier.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
for p in node22-envproxy node24-envproxy; do
  full_set mcp $p 600 1800 600 900 600 900 300 300 60 -
  run mcp $p 11a-ancestry-probe-before 60 - /usr/bin/python3 -I $S/ancprobe.py
  run mcp $p 11-focused-ancestor-gate 300 - node --test packages/hud-mcp/dist/tests/hud-mcp/ancestor-discovery.test.js packages/hud-mcp/dist/tests/hud-mcp/skeleton.test.js packages/hud-mcp/dist/tests/hud-mcp/int-ledger-registry.test.js
  run mcp $p 11b-ancestry-probe-after 60 - /usr/bin/python3 -I $S/ancprobe.py
  run mcp $p 12-prettier-packages 300 - node node_modules/prettier/bin/prettier.cjs --check packages/hud-mcp/src/process.ts tests/hud-mcp/ancestor-discovery.test.ts tests/hud-mcp/skeleton.test.ts tests/hud-mcp/int-ledger-registry.test.ts
done
src_check mcp after-checks
echo MCP-DONE $(date -u +%FT%TZ)

##### scripts/mcpbench.sh
#!/usr/bin/env bash
# MCP benchmark window: fresh builds of baseline and candidate, then the pre-declared 12-run order.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
O=$FU/manifest/mcp-benchmark-order.txt
for k in mcpbase mcp; do
  clean_gen $k > $FU/manifest/clean-$k-bench.txt
  run $k node24-envproxy bench-build 600 - npm run build
  run $k node24-envproxy bench-build-test 600 - npm run build:test
  run $k node24-envproxy bench-build-hud-mcp 600 - npm run build:hud-mcp
  gen_manifest $k bench
  echo "$k benchmark.mjs: blob $(git -C ${WT[$k]} rev-parse HEAD:tests/hud-mcp/benchmark.mjs) worktree hash-object $(git -C ${WT[$k]} hash-object tests/hud-mcp/benchmark.mjs)" >> $FU/manifest/mcp-benchmark-identity.txt
done
while read -r n k p; do run $k $p bench-$n 600 - node tests/hud-mcp/benchmark.mjs; done < $O
src_check mcp after-bench; src_check mcpbase after-bench
echo MCPBENCH-DONE $(date -u +%FT%TZ)

##### scripts/n22.sh
#!/usr/bin/env bash
# NODE22-PROXY: three profiles, full set (brief limits) + four focused commands; NODE_PROXY_EVIDENCE_DIR fresh per command.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
E=NODE_PROXY_EVIDENCE_DIR
for p in node22-envproxy node22-noenvproxy-control node24-envproxy; do
  full_set n22 $p 600 1800 600 900 600 900 300 300 60 $E
  run n22 $p 11-node-proxy-profile 300 $E node --test --test-concurrency=1 dist-test/tests/unit/node-proxy-profile.test.js
  run n22 $p 12-three-file-serial 600 $E node --test --test-concurrency=1 dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
  run n22 $p 13-three-file-normal 600 $E node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
  run n22 $p 14-hyg2-six-suite 900 $E node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js dist-test/tests/unit/process-client.test.js
done
src_check n22 after-checks
echo N22-DONE $(date -u +%FT%TZ)

##### scripts/rk.sh
#!/usr/bin/env bash
# RUNZ1-KILL: Node 22 (envproxy) fresh builds + two focused commands; Node 24 (envproxy) full set + two focused commands.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
E=RUNZ1_KILL_EVIDENCE_DIR
p=node22-envproxy
clean_gen rk > $FU/manifest/clean-rk-$p.txt
run rk $p 01-build 180 $E npm run build
run rk $p 02-build-test 180 $E npm run build:test
run rk $p 03-build-hud-mcp 180 $E npm run build:hud-mcp
gen_manifest rk $p
run rk $p 11-kill-evidence-serial 600 $E node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js
run rk $p 12-runz1-three-file 600 $E node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js
p=node24-envproxy
full_set rk $p 180 1200 300 600 600 600 180 180 60 $E
run rk $p 11-kill-evidence-serial 600 $E node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js
run rk $p 12-runz1-three-file 600 $E node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js
src_check rk after-checks
echo RK-DONE $(date -u +%FT%TZ)

##### scripts/anc-exec.sh
# anc-exec.sh <file> <cmd...>: record process ancestry (pid, comm, uid; no arguments), then exec the command.
f=$1; shift
p=$$
while [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null; do
  c=$(cat /proc/$p/comm 2>/dev/null); u=$(awk '/^Uid:/{print $2}' /proc/$p/status 2>/dev/null)
  echo "$p $c uid=$u"
  p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null)
done > "$f"
exec "$@"

#!/usr/bin/env bash
# commands.sh: the exact scripts this run executed, concatenated in order (setup -> matrix -> bench prep -> bench window).
# Driver invocation: SROOT=$(mktemp -d <SROOT>); bash scripts/setup.sh; bash scripts/matrix.sh; bash scripts/bench.sh prep && bash scripts/bench.sh window

######## scripts/lib.sh
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

######## scripts/setup.sh
#!/usr/bin/env bash
# setup.sh: refs, binding docs at H, pinned detached worktrees (C3, U), identities, environment, capability probe,
# dependency installs only where actually missing.
set -u
source <VERIFY_ROOT>/wave1-composite-20261104T031916Z-680937/scripts/lib.sh
M=$RD/manifest
C3=36d3fd584bd403ed7ada95d1d863a8f63e96588b; C3T=0c8c67ede1f13122987802d9a0346cd6e6ecf73b
H=87ef8d1f59177badeebf8c863a5ad29abdc20ba1; HT=9aa8ee3afa2476f3588670f74c08814db737db15
U=f248f320d42528fd1eb97db9f1cd2ba97e6d3c86; UT=2a6491f7c0ca5262587d4ab15a8ae53cbf6901ce
declare -A C=( [c3]=$C3 [u]=$U ) TR=( [c3]=$C3T [u]=$UT )
{
  echo "utc: $(date -u +%FT%TZ)"; echo "origin: $(git -C $REPO remote get-url origin)"
  git -C $REPO fetch origin dots/wave1-compat-integration local-verification/20261103 universal-hud 2>&1
  for b in dots/wave1-compat-integration local-verification/20261103 universal-hud; do echo "origin/$b: $(git -C $REPO rev-parse origin/$b)"; done
  echo "C3 $C3 tree $(git -C $REPO rev-parse $C3^{tree}) expected $C3T"
  echo "H  $H tree $(git -C $REPO rev-parse $H^{tree}) expected $HT; parents: $(git -C $REPO rev-parse $H^@ | tr '\n' ' ')"
  echo "U  $U tree $(git -C $REPO rev-parse $U^{tree}) expected $UT"
  echo "H ancestor of origin/dots/wave1-compat-integration: $(git -C $REPO merge-base --is-ancestor $H origin/dots/wave1-compat-integration && echo yes || echo no)"
  echo "C3..H name-status:"; git -C $REPO diff --name-status $C3 $H
  echo "H..origin/dots/wave1-compat-integration name-status (later documentary commits, not test identity):"; git -C $REPO diff --name-status $H origin/dots/wave1-compat-integration
  echo "U..C3 leaf changes: $(git -C $REPO diff --name-only $U $C3 | wc -l)"
  echo "C3 leaf entries: $(git -C $REPO ls-tree -r --name-only $C3 | wc -l)"
  echo "C3 node_modules tree: $(git -C $REPO rev-parse $C3:node_modules) (expected 77829c47b2f75720a918a0dfef03e8671222cde9)"
  echo "C3 node_modules/.package-lock.json blob: $(git -C $REPO rev-parse $C3:node_modules/.package-lock.json) (expected 8c35e164d1c5752a7756ca390d91081afb494413)"
  echo "C3 tracked dist/dist-test/packages/hud-mcp/dist entries: $(git -C $REPO ls-tree -r --name-only $C3 | grep -cE '^(dist|dist-test|packages/hud-mcp/dist)/')"
  echo "== documents read at H $H (path blob):"
  for f in docs/cloud/rulings/wave1-compat-integration-20261103.md docs/cloud/rulings/wave1-compat-integration-connector-addendum-20261104.md \
    docs/cloud/handoff/wave1-compat-integration/implementation.md docs/cloud/handoff/wave1-compat-integration/composition-manifest.json \
    docs/cloud/handoff/wave1-compat-integration/candidate-tree.tsv docs/cloud/handoff/wave1-compat-integration/check-inventory.json \
    AGENTS.md docs/cloud/dots.md docs/cloud/README.md docs/handoff/STATE.md \
    docs/cloud/NODE22-PROXY.md docs/cloud/MCP-ANCESTOR.md docs/cloud/RUNZ1-KILL.md \
    docs/cloud/handoff/mcp-ancestor-implementation.md docs/cloud/handoff/mcp-ancestor-publication.md docs/cloud/handoff/mcp-ancestor-review-1.md \
    docs/cloud/handoff/node22-proxy-ownership.md docs/cloud/handoff/runz1-kill/diagnostic-plan.json docs/cloud/handoff/runz1-kill/implementation.md \
    docs/cloud/handoff/runz1-kill/review-1.md docs/cloud/rulings/mcp-ancestor-gate.md docs/cloud/rulings/node22-proxy-flake-closeout.md \
    docs/cloud/rulings/node22-proxy-profile.md docs/cloud/rulings/runz1-kill-diagnosis.md docs/cloud/rulings/runz1-kill-fix-1.md; do
    echo "$f $(git -C $REPO rev-parse $H:$f 2>&1)"; done
  echo "== later documentary file on the branch (read for context only):"
  f=docs/cloud/handoff/wave1-compat-integration/oracle-v0-composition-review-20261104.md
  echo "$f $(git -C $REPO rev-parse origin/dots/wave1-compat-integration:$f 2>&1) sha256 $(git -C $REPO show origin/dots/wave1-compat-integration:$f | sha256sum | cut -d' ' -f1)"
} > $M/refs-and-docs.txt 2>&1
for k in c3 u; do
  W=${WT[$k]}
  if [ -e $W ]; then echo "worktree $W already exists: STOP" >> $M/identity.txt; exit 3; fi
  git -C $REPO worktree add --detach $W ${C[$k]} > $M/worktree-add-$k.txt 2>&1
  c=$(git -C $W rev-parse HEAD); t=$(git -C $W rev-parse 'HEAD^{tree}')
  { echo "== $k: HEAD $c expected ${C[$k]} $( [ $c = ${C[$k]} ] && echo MATCH || echo MISMATCH); tree $t expected ${TR[$k]} $( [ $t = ${TR[$k]} ] && echo MATCH || echo MISMATCH)"
    echo "status clean at checkout: $( [ -z "$(git -C $W status --porcelain)" ] && echo yes || echo NO)"
    echo "package-lock blob $(git -C $W rev-parse HEAD:package-lock.json) package.json blob $(git -C $W rev-parse HEAD:package.json)"
    echo "tests/hud-mcp/benchmark.mjs blob $(git -C $W rev-parse HEAD:tests/hud-mcp/benchmark.mjs 2>&1) worktree hash-object $(git -C $W hash-object tests/hud-mcp/benchmark.mjs)"
    echo "tests/fixtures tree $(git -C $W rev-parse HEAD:tests/fixtures 2>&1)"
    echo "node_modules tree $(git -C $W rev-parse HEAD:node_modules 2>&1)"; } >> $M/identity.txt
  [ $c = ${C[$k]} ] && [ $t = ${TR[$k]} ] || { echo "IDENTITY MISMATCH $k: STOP" >> $M/identity.txt; exit 4; }
  git -C $W ls-files -s > $M/source-ls-files-$k.txt
  ( cd $W; git ls-files -z | xargs -0 sha256sum ) > $M/source-sha256-$k.txt
  echo "$k source sha256 manifest: $(sha256sum < $M/source-sha256-$k.txt | cut -d' ' -f1) files=$(wc -l < $M/source-sha256-$k.txt)" >> $M/identity.txt
  src_check $k after-checkout
done
{
  echo "utc: $(date -u +%FT%TZ)"; uname -srmo; grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release
  echo "wsl interop: $(head -1 /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null)"; echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-) x $(nproc)"
  free -b | head -2; echo "filesystems:"; df -hT / /tmp $V/wt | tail -n +2
  echo "short temp root: $SROOT ($(stat -f -c %T $SROOT); device $(stat -c %d $SROOT); worktree device $(stat -c %d $V/wt/w1-c3))"
  echo "uid/euid/gid: $(id -u)/$(id -u)/$(id -g) (bash EUID=$EUID)"
  echo "kernel.yama.ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope)"
  for rt in 22 24; do nb=$(nodebin $rt); echo "node$rt: $nb/node $($nb/node -v) sha256 $(sha256sum $nb/node | cut -d' ' -f1); npm $(env -i PATH=$nb:/usr/bin:/bin $nb/npm -v) at $(readlink -f $nb/npm) npm-cli sha256 $(sha256sum $(readlink -f $nb/npm) | cut -d' ' -f1)"; done
  echo "invoking shell variables present (names only): $(for v in $PROXY_NAMES NODE_USE_ENV_PROXY NODE_OPTIONS NODE_NO_WARNINGS NODE_REDIRECT_WARNINGS NO_COLOR FORCE_COLOR CI HUD_HOME; do [ -n "${!v+x}" ] && printf '%s ' $v; done)"
  echo "NODE_OPTIONS / NODE_NO_WARNINGS / NODE_REDIRECT_WARNINGS in invoking shell: $(for v in NODE_OPTIONS NODE_NO_WARNINGS NODE_REDIRECT_WARNINGS; do [ -n "${!v+x}" ] && printf '%s=PRESENT-CONFLICT ' $v || printf '%s=absent ' $v; done)"
  echo "proxy value relations (no values): HTTP_PROXY==http_proxy $([ "${HTTP_PROXY-}" = "${http_proxy-}" ] && echo yes || echo no); HTTPS_PROXY==https_proxy $([ "${HTTPS_PROXY-}" = "${https_proxy-}" ] && echo yes || echo no); ALL_PROXY==all_proxy $([ "${ALL_PROXY-}" = "${all_proxy-}" ] && echo yes || echo no); NO_PROXY==no_proxy $([ "${NO_PROXY-}" = "${no_proxy-}" ] && echo yes || echo no); HTTP_PROXY==HTTPS_PROXY $([ "${HTTP_PROXY-}" = "${HTTPS_PROXY-}" ] && echo yes || echo no)"
  echo "load: $(cat /proc/loadavg)"
} > $M/environment.txt 2>&1
for p in node22-envproxy node24-envproxy; do run c3 $p logs/$p/00-capability-probe 00-capability-probe 120 node $S/capprobe.mjs; done
for k in c3 u; do
  W=${WT[$k]}
  { echo "$k before install: tsc $([ -e $W/node_modules/.bin/tsc ] && echo present || echo MISSING); prettier $([ -e $W/node_modules/prettier/bin/prettier.cjs ] && echo present || echo MISSING); node_modules files $(find $W/node_modules -type f | wc -l)"; } >> $M/dependency-summary.txt
  if [ -e $W/node_modules/.bin/tsc ] && [ -e $W/node_modules/prettier/bin/prettier.cjs ]; then echo "$k: dependencies present, npm ci not run" >> $M/dependency-summary.txt
  else run $k node24-envproxy logs/install/$k-npm-ci install-$k-npm-ci 900 npm ci --ignore-scripts; fi
  ( cd $W; sha256sum package-lock.json; find node_modules -type f | LC_ALL=C sort | xargs -r sha256sum ) > $M/dependency-sha256-$k.txt
  echo "$k dependency manifest: $(sha256sum < $M/dependency-sha256-$k.txt | cut -d' ' -f1) files=$(wc -l < $M/dependency-sha256-$k.txt); native .node files: $(find $W/node_modules -name '*.node' | wc -l)" >> $M/dependency-summary.txt
  src_check $k after-install
done
echo SETUP-DONE $(date -u +%FT%TZ)

######## scripts/matrix.sh
#!/usr/bin/env bash
# matrix.sh: C3 only. Per profile: fresh builds, shared README matrix, focused commands. One command at a time.
set -u
source <VERIFY_ROOT>/wave1-composite-20261104T031916Z-680937/scripts/lib.sh
r() { run c3 "$P" "logs/$P/$1" "$1" "${@:2}"; }   # r <id> <timeout> <cmd...>
for P in node22-envproxy node22-noenvproxy-control node24-envproxy; do
  clean_gen c3 > $RD/manifest/clean-c3-$P.txt
  r 01-build 600 npm run build
  r 02-build-test 600 npm run build:test
  r 03-build-hud-mcp 600 npm run build:hud-mcp
  gen_manifest c3 $P
  r 04-npm-test 1800 npm test
  if ! grep -qE '^> [^ ]+@[^ ]+ test:mjs$' $RD/logs/$P/04-npm-test/stdout.raw; then
    r 04b-test-mjs-separate 600 npm run test:mjs
  else mkdir -p $RD/logs/$P/04b-test-mjs-separate; echo "npm test reached test:mjs; separate run not needed" > $RD/logs/$P/04b-test-mjs-separate/not-run.txt; fi
  r 05-test-core 900 npm run test:core
  r 06-test-visual 600 npm run test:visual
  r 07-test-hud-mcp 900 npm run test:hud-mcp
  r 08-format-check 300 npm run format:check
  r 09-check-fixtures 300 npm run check:fixtures
  r 10-git-diff-check 60 git diff --check
  r 11-node-proxy-profile 300 node --test --test-concurrency=1 dist-test/tests/unit/node-proxy-profile.test.js
  r 12-three-file-serial 600 node --test --test-concurrency=1 dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
  r 13-three-file-normal 600 node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
  r 14-hyg2-six-suite 900 node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js dist-test/tests/unit/process-client.test.js
  if [ "$(prof_envproxy $P)" = 1 ]; then
    r 15-kill-evidence-serial 600 node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js
    r 16-runz1-three-file 600 node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js
    run c3 $P ancestry/$P/17a-probe-before 17a-ancestry-probe-before 60 /usr/bin/python3 -I $S/ancprobe.py
    r 17-mcp-ancestor-gate 300 node --test packages/hud-mcp/dist/tests/hud-mcp/ancestor-discovery.test.js packages/hud-mcp/dist/tests/hud-mcp/skeleton.test.js packages/hud-mcp/dist/tests/hud-mcp/int-ledger-registry.test.js
    run c3 $P ancestry/$P/17b-probe-after 17b-ancestry-probe-after 60 /usr/bin/python3 -I $S/ancprobe.py
    r 18-mcp-prettier 300 node node_modules/prettier/bin/prettier.cjs --check packages/hud-mcp/src/process.ts tests/hud-mcp/ancestor-discovery.test.ts tests/hud-mcp/skeleton.test.ts tests/hud-mcp/int-ledger-registry.test.ts
  fi
  src_check c3 after-$P
done
echo MATRIX-DONE $(date -u +%FT%TZ)

######## scripts/bench.sh
#!/usr/bin/env bash
# bench.sh prep|window
#  prep:   fresh builds of U and C3 (same runtime and wrapper), generated manifests, driver identity. Before the window.
#  window: 60 s pre-observation under cpumon; if the pre-declared isolation criterion fails, stop with PENDING and run
#          nothing. Otherwise run the 12 processes in benchmark/order.txt, monitor continuing, nothing else in between.
set -u
source <VERIFY_ROOT>/wave1-composite-20261104T031916Z-680937/scripts/lib.sh
B=$RD/benchmark
case "$1" in
prep)
  for k in u c3; do
    clean_gen $k > $B/prep-clean-$k.txt
    run $k node24-envproxy benchmark/prep/$k-01-build prep-$k-build 600 npm run build
    run $k node24-envproxy benchmark/prep/$k-02-build-test prep-$k-build-test 600 npm run build:test
    run $k node24-envproxy benchmark/prep/$k-03-build-hud-mcp prep-$k-build-hud-mcp 600 npm run build:hud-mcp
    gen_manifest $k bench
    echo "$k: commit $(git -C ${WT[$k]} rev-parse HEAD) tree $(git -C ${WT[$k]} rev-parse 'HEAD^{tree}') benchmark.mjs blob $(git -C ${WT[$k]} rev-parse HEAD:tests/hud-mcp/benchmark.mjs) worktree hash-object $(git -C ${WT[$k]} hash-object tests/hud-mcp/benchmark.mjs) (required c36817dee4cf70c27a39a86b3965f4eb6701ceb0)" >> $B/identity.txt
    src_check $k before-bench
  done
  echo PREP-DONE $(date -u +%FT%TZ) ;;
window)
  rm -f $B/stop; /usr/bin/python3 -I $S/cpumon.py $$ $B/cpumon.tsv $B/stop & MP=$!
  echo "window start (pre-observation): $(date -u +%FT%T.%3NZ)" > $B/window.txt
  sleep 61
  /usr/bin/python3 -I $S/isolation.py $B/cpumon.tsv > $B/pre-observation-verdict.txt
  if ! grep -q '^QUALIFIES' $B/pre-observation-verdict.txt; then
    echo "pre-observation did not meet the criterion: PENDING (no benchmark process started) $(date -u +%FT%T.%3NZ)" >> $B/window.txt
    touch $B/stop; wait $MP; exit 0
  fi
  echo "benchmark processes start: $(date -u +%FT%T.%3NZ)" >> $B/window.txt
  while read -r n tree prof; do
    run $tree $prof benchmark/$n $n 600 node tests/hud-mcp/benchmark.mjs
  done < $B/order.txt
  echo "benchmark processes end: $(date -u +%FT%T.%3NZ)" >> $B/window.txt
  sleep 5; touch $B/stop; wait $MP
  /usr/bin/python3 -I $S/isolation.py $B/cpumon.tsv > $B/window-verdict.txt
  src_check c3 after-bench; src_check u after-bench
  echo WINDOW-DONE $(date -u +%FT%TZ) ;;
esac

######## scripts/anc-exec.sh
# anc-exec.sh <file> <cmd...>: record process ancestry (pid, comm, uid; no arguments), then exec the command.
f=$1; shift
p=$$
while [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null; do
  c=$(cat /proc/$p/comm 2>/dev/null); u=$(awk '/^Uid:/{print $2}' /proc/$p/status 2>/dev/null)
  echo "$p $c uid=$u"
  p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null)
done > "$f"
exec "$@"

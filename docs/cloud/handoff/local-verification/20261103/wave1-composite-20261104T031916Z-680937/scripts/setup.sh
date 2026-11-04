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

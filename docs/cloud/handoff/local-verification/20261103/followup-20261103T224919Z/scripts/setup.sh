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

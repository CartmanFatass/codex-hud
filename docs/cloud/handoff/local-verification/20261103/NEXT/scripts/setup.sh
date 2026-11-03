#!/usr/bin/env bash
# setup.sh: pinned worktree, identities, source manifest, environment, single dependency install.
set -u
source <VERIFY_ROOT>/next/scripts/lib.sh
M=$R/manifest; mkdir -p $M $R/logs/setup
{
  echo "utc: $(date -u +%FT%TZ)"
  git -C $REPO fetch origin dots/b10b-s3f-next universal-hud local-verification/20261103 2>&1
  echo "origin/dots/b10b-s3f-next: $(git -C $REPO rev-parse origin/dots/b10b-s3f-next)"
  echo "origin/universal-hud: $(git -C $REPO rev-parse origin/universal-hud)"
  echo "origin/local-verification/20261103: $(git -C $REPO rev-parse origin/local-verification/20261103)"
  echo "branches containing $EXP_COMMIT:"; git -C $REPO branch -r --contains $EXP_COMMIT
} > $M/refs.txt 2>&1
[ -e $W ] || git -C $REPO worktree add --detach $W $EXP_COMMIT > $R/logs/setup/worktree-add.log 2>&1
c=$(git -C $W rev-parse HEAD); t=$(git -C $W rev-parse 'HEAD^{tree}')
{
  echo "HEAD: $c (expected $EXP_COMMIT) $( [ $c = $EXP_COMMIT ] && echo MATCH || echo MISMATCH)"
  echo "tree: $t (expected $EXP_TREE) $( [ $t = $EXP_TREE ] && echo MATCH || echo MISMATCH)"
  echo "commit object:"; git -C $W cat-file -p HEAD | sed 's/<[^>]*@[^>]*>/<email>/'
  echo; echo "e5ccee3 is ancestor: $(git -C $W merge-base --is-ancestor e5ccee38165b30809bd537e7f31cfed7f227f152 HEAD && echo yes || echo no)"
  echo "diff --name-status e5ccee3..HEAD:"; git -C $W diff --name-status e5ccee38165b30809bd537e7f31cfed7f227f152 HEAD
  echo "log e5ccee3..HEAD:"; git -C $W log --format='%H %s' e5ccee38165b30809bd537e7f31cfed7f227f152..HEAD
  echo; echo "benchmark blob tests/unit/b10b-s3-perf.test.ts: $(git -C $W rev-parse HEAD:tests/unit/b10b-s3-perf.test.ts) (expected 371b8f784229636f66e88434c422484dd85251eb)"
  echo "hash-object worktree file: $(git -C $W hash-object tests/unit/b10b-s3-perf.test.ts)"
  echo "fixture blob tests/fixtures/b10b-big.ts: $(git -C $W rev-parse HEAD:tests/fixtures/b10b-big.ts) (expected a711705346161d155324c86564ab819e546d3fae)"
  echo "hash-object worktree file: $(git -C $W hash-object tests/fixtures/b10b-big.ts)"
  for f in src/render/delegation/facts.ts src/render/delegation/projection.ts tests/unit/b10b-s3-facts.test.ts tests/unit/b10b-s3-perf-regression.test.ts package-lock.json package.json; do echo "blob $f: $(git -C $W rev-parse HEAD:$f)"; done
  echo; echo "git status --short (before install):"; git -C $W status --short
} > $M/identity.txt 2>&1
git -C $W ls-files -s > $M/source-ls-files.txt
( cd $W; git ls-files -z | xargs -0 sha256sum ) > $M/source-sha256.txt
echo "source sha256 manifest aggregate: $(sha256sum < $M/source-sha256.txt | cut -d' ' -f1) files=$(wc -l < $M/source-sha256.txt)" >> $M/identity.txt
{
  echo "utc: $(date -u +%FT%TZ)"; uname -srmo; grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release
  echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-) x $(nproc)"
  free -b | head -2
  echo "wsl: $(cat /proc/sys/kernel/osrelease)"; df -hT / /tmp | tail -n +2
  echo "kernel.yama.ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope 2>&1)"
  for rt in 22 24; do nb=$(nodebin $rt); echo "node$rt: $nb/node $($nb/node -v); npm $(PATH=$nb:/usr/bin:/bin $nb/npm -v); node sha256 $(sha256sum $nb/node | cut -d' ' -f1)"; done
  echo "invoking shell had set (names only): $(for v in NO_COLOR FORCE_COLOR NODE_USE_ENV_PROXY NODE_OPTIONS HUD_HOME CI; do [ -n "${!v+x}" ] && printf '%s ' $v; done)"
  echo "SESSION_TMP: $SESSION_TMP"
  echo "load: $(cat /proc/loadavg)"; echo "top processes (name, %cpu, elapsed; no arguments):"; ps -eo comm,pcpu,etime --sort=-pcpu --no-headers | head -15
} > $M/environment.txt 2>&1
# Single dependency install (Node 24 / npm), used unchanged for both runtimes. Proxy vars passed to this step only.
px=""; for v in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do [ -n "${!v:-}" ] && px+="$v=${!v} "; done
step $R/logs/setup/npm-ci.log 24 600 setup-npm-ci "${px:--}" npm ci --ignore-scripts --prefer-offline
( cd $W; sha256sum package-lock.json; find node_modules -type f | LC_ALL=C sort | xargs -r sha256sum ) > $M/dependency-sha256.txt
echo "dependency manifest aggregate: $(sha256sum < $M/dependency-sha256.txt | cut -d' ' -f1) files=$(wc -l < $M/dependency-sha256.txt)" > $M/dependency-summary.txt
( cd $W; for p in node_modules/*/package.json node_modules/@*/*/package.json; do node=$(nodebin 24)/node; $node -e 'const p=require(process.argv[1]);console.log(p.name+"@"+p.version)' "$PWD/$p"; done ) >> $M/dependency-summary.txt 2>&1
git -C $W status --short > $M/git-status-after-install.txt
echo SETUP-DONE

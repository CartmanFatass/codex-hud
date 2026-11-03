#!/usr/bin/env bash
# checks.sh <name> <rt>: README check set + focused commands for one worktree on one runtime.
set -u
source <VERIFY_ROOT>/scripts/lib.sh
R=$1; n=$2; rt=$3; tag=${4:-}
W=$V/wt/$n; L=$R/logs/$n/node$rt$tag; mkdir -p $L
T=$R/manifest/results.tsv
cd $W
run() { # run <id> <cmd string>
  local id=$1 cmd=$2 s e ec
  s=$(date -u +%FT%TZ)
  { echo "# target=$n runtime=node$rt commit=$(git rev-parse HEAD) cwd=<wt>/$n"; echo "# command: $cmd"; echo "# start: $s"; } > $L/$id.log
  timeout -k 30 3600 bash -c "source $V/scripts/lib.sh; cd $W; iso $rt bash -c '$cmd'" >> $L/$id.log 2>&1; ec=$?
  e=$(date -u +%FT%TZ); { echo "# end: $e"; echo "# exit: $ec"; } >> $L/$id.log
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "node$rt$tag" "$id" "$ec" "$s" "$e" "$cmd" >> $T
  echo "$n node$rt$tag $id exit=$ec"
}
git status --porcelain > $L/git-status-before.txt
run 01-build 'npm run build'
run 02-build-test 'npm run build:test'
run 03-build-hud-mcp 'npm run build:hud-mcp'
run 04-npm-test 'npm test'
if ! grep -q -E '^> [^ ]+@[^ ]+ test:mjs$' $L/04-npm-test.log; then run 04b-test-mjs-separate 'npm run test:mjs'; fi
run 05-test-core 'npm run test:core'
run 06-test-visual 'npm run test:visual'
run 07-test-hud-mcp 'npm run test:hud-mcp'
run 08-format-check 'npm run format:check'
run 09-check-fixtures 'npm run check:fixtures'
run 10-git-diff-check 'git diff --check'
case $n in
  runz1) run 11-focused-runz1 'node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js' ;;
  hyg2) run 11-focused-hyg2 'node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/process-client.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js' ;;
  perf) run 11-focused-b10b 'node --test --test-concurrency=1 dist-test/tests/unit/b10b*.test.js' ;;
esac
git status --porcelain > $L/git-status-after.txt

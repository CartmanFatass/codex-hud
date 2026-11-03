#!/usr/bin/env bash
# Supplementary steps: separate test:mjs where npm test stopped at unit (node22), and the README known-flake rerun alone.
set -u
source <VERIFY_ROOT>/scripts/lib.sh
R=$1; T=$R/manifest/results.tsv
run() { local n=$1 rt=$2 id=$3 cmd=$4 W=$V/wt/$1 L=$R/logs/$1/node$2 s e ec
  s=$(date -u +%FT%TZ); { echo "# target=$n runtime=node$rt commit=$(git -C $W rev-parse HEAD) cwd=<wt>/$n"; echo "# command: $cmd"; echo "# start: $s"; } > $L/$id.log
  timeout -k 30 3600 bash -c "source $V/scripts/lib.sh; cd $W; iso $rt bash -c '$cmd'" >> $L/$id.log 2>&1; ec=$?
  e=$(date -u +%FT%TZ); { echo "# end: $e"; echo "# exit: $ec"; } >> $L/$id.log
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "node$rt" "$id" "$ec" "$s" "$e" "$cmd" >> $T; echo "$n node$rt $id exit=$ec"; }
for n in hyg2 runz1 perf; do run $n 22 04b-test-mjs-separate 'npm run test:mjs'; done
run runz1 22 07r1-flake-rerun-b20-advice 'node --test packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js'
run runz1 22 07r2-flake-rerun-delegation 'node --test packages/hud-mcp/dist/tests/hud-mcp/delegation.test.js'

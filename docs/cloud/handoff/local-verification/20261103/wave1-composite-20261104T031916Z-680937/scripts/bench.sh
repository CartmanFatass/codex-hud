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

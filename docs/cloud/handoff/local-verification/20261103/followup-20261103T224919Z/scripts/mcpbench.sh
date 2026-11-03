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

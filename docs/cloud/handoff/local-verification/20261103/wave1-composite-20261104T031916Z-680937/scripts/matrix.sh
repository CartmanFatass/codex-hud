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

#!/usr/bin/env bash
# main.sh: per runtime (22 then 24): clean generated outputs, three fresh builds, generated manifest,
# three strict B10B processes. Then the README check set (once, Node 24) plus NEXT §8 focused commands.
set -u
source <VERIFY_ROOT>/next/scripts/lib.sh
M=$R/manifest; L=$R/logs
for rt in 22 24; do
  git -C $W status --short > $M/git-status-before-node$rt.txt
  { echo "utc: $(date -u +%FT%TZ)"; echo "removed before fresh node$rt build:"; ( cd $W; for d in dist dist-test packages/hud-mcp/dist; do [ -e $d ] && echo "$d ($(find $d -type f | wc -l) files)" || echo "$d (absent)"; rm -rf $d; done ) } > $M/clean-node$rt.txt
  step $L/build-node$rt/01-build.log $rt 180 node$rt-build - npm run build
  step $L/build-node$rt/02-build-test.log $rt 180 node$rt-build-test - npm run build:test
  step $L/build-node$rt/03-build-hud-mcp.log $rt 180 node$rt-build-hud-mcp - npm run build:hud-mcp
  gen_manifest $M/generated-sha256-node$rt.txt
  for i in 1 2 3; do
    step $L/strict/b10b-strict-node$rt-run$i.log $rt 300 strict-node$rt-run$i B10B_PERF=1 node --test dist-test/tests/unit/b10b-s3-perf.test.js
  done
  git -C $W status --short > $M/git-status-after-node$rt.txt
done
# README check set, Node 24, on the fresh Node 24 build above (its three builds are the set's first line).
C=$L/checks-node24
step $C/04-npm-test.log 24 1200 check-npm-test - npm test
if ! grep -qE '^> [^ ]+@[^ ]+ test:mjs$' $C/04-npm-test.log; then
  step $C/04b-test-mjs-separate.log 24 300 check-test-mjs-separate - npm run test:mjs
fi
step $C/05-test-core.log 24 600 check-test-core - npm run test:core
step $C/06-test-visual.log 24 600 check-test-visual - npm run test:visual
step $C/07-test-hud-mcp.log 24 600 check-test-hud-mcp - npm run test:hud-mcp
step $C/08-format-check.log 24 180 check-format-check - npm run format:check
step $C/09-check-fixtures.log 24 180 check-check-fixtures - npm run check:fixtures
step $C/10-git-diff-check.log 24 60 check-git-diff-check - git diff --check
step $C/11-next-focused-facts-regression.log 24 180 next-focused-facts-regression - node --test --test-concurrency=1 dist-test/tests/unit/b10b-s3-facts.test.js dist-test/tests/unit/b10b-s3-perf-regression.test.js
step $C/12-next-focused-b10b-all.log 24 600 next-focused-b10b-all - bash -c 'node --test --test-concurrency=1 dist-test/tests/unit/b10b*.test.js'
git -C $W status --short > $M/git-status-after-checks.txt
git -C $W diff --stat > $M/git-diff-stat-after-checks.txt
echo MAIN-DONE $(date -u +%FT%TZ)

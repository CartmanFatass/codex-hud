#!/usr/bin/env bash
# RUNZ1-KILL: Node 22 (envproxy) fresh builds + two focused commands; Node 24 (envproxy) full set + two focused commands.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
E=RUNZ1_KILL_EVIDENCE_DIR
p=node22-envproxy
clean_gen rk > $FU/manifest/clean-rk-$p.txt
run rk $p 01-build 180 $E npm run build
run rk $p 02-build-test 180 $E npm run build:test
run rk $p 03-build-hud-mcp 180 $E npm run build:hud-mcp
gen_manifest rk $p
run rk $p 11-kill-evidence-serial 600 $E node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js
run rk $p 12-runz1-three-file 600 $E node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js
p=node24-envproxy
full_set rk $p 180 1200 300 600 600 600 180 180 60 $E
run rk $p 11-kill-evidence-serial 600 $E node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js
run rk $p 12-runz1-three-file 600 $E node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js
src_check rk after-checks
echo RK-DONE $(date -u +%FT%TZ)

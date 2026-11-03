#!/usr/bin/env bash
# NODE22-PROXY: three profiles, full set (brief limits) + four focused commands; NODE_PROXY_EVIDENCE_DIR fresh per command.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
E=NODE_PROXY_EVIDENCE_DIR
for p in node22-envproxy node22-noenvproxy-control node24-envproxy; do
  full_set n22 $p 600 1800 600 900 600 900 300 300 60 $E
  run n22 $p 11-node-proxy-profile 300 $E node --test --test-concurrency=1 dist-test/tests/unit/node-proxy-profile.test.js
  run n22 $p 12-three-file-serial 600 $E node --test --test-concurrency=1 dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
  run n22 $p 13-three-file-normal 600 $E node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
  run n22 $p 14-hyg2-six-suite 900 $E node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js dist-test/tests/unit/process-client.test.js
done
src_check n22 after-checks
echo N22-DONE $(date -u +%FT%TZ)

#!/usr/bin/env bash
# usage: sequence.sh <n24|n22>
v=$1; R="$(cd "$(dirname "$0")" && pwd)"; D="$R/run-docker.sh $v"
M=packages/hud-mcp/dist/tests/hud-mcp; U=dist-test/tests/unit
$D A1-build 180 -- npm run build
$D A2-build-test 180 -- npm run build:test
$D A3-build-hud-mcp 180 -- npm run build:hud-mcp
$D B1-check-cloud 1800 -- node scripts/check-cloud.mjs
$D C1-runtime-compose 300 -- node --test --test-concurrency=1 tests/unit/runtime-compose.test.mjs
$D C2-runtime-compose-build 300 -- node tests/fixtures/runtime-compose.mjs --check-runtime-build
$D C3-runtime-package-install 300 -- node --test --test-concurrency=1 tests/unit/runtime-package.test.mjs tests/unit/runtime-install.test.mjs
$D C4-runtime-build-managed 300 -- node --test --test-concurrency=1 $U/runtime-build.test.js $U/managed-runtime.test.js
$D C5-mcp-managed-runtime 300 -- node --test --test-concurrency=1 $M/managed-runtime.test.js
$D D1-headless-close 300 -- node --test --test-concurrency=1 $M/headless-close.test.js
$D D2-mcp-authz-etc 300 -- node --test --test-concurrency=1 $M/authorization.test.js $M/delegate-list.test.js $M/resume-expected-run.test.js $M/hook-source.test.js $M/skeleton.test.js
$D D3-run-control 300 -- node --test --test-concurrency=1 $U/run-control.test.js $U/run-control-kill-evidence.test.js $U/int-ledger-run.test.js
$D D4-relaxed-budget 300 -- node --test --test-concurrency=1 tests/unit/relaxed-delegation-budget.test.mjs
$D E1-hud-env-settings 300 -- node --test --test-concurrency=1 $U/hud-env.test.js $U/settings.test.js $U/b17-legacy.test.js $U/materials.test.js $U/small-model.test.js $U/product-cli-routing.test.js $U/migration.test.js
$D E2-e2-helper-mapping 300 -- node --test --test-name-pattern='E2 shared helper mapping' tests/unit/runtime-package.test.mjs
$D E3-test-visual 300 -- npm run test:visual
$D E4-panel-help-nohome 60 -- sh -c 'H=/work/tmp/panel-help-home; rm -rf "$H"; HOME="$H" HUD_HOME="$H/.hud" node bin/hud panel --help; rc=$?; if [ -e "$H" ]; then echo "HOME_CREATED"; find "$H"; exit 3; else echo "home_not_created"; fi; exit $rc'
$D F1-digest-suites 300 -- node --test --test-concurrency=1 $U/source-model-config.test.js $U/delegated-report-read.test.js $U/delegated-digest.test.js $U/digest-cli.test.js $U/materials.test.js $U/small-model.test.js $U/b17-legacy.test.js $U/product-cli-routing.test.js $U/hud-link-export.test.js
$D F2-digest-help 60 -- node bin/hud digest --help
$D G1-format-check 120 -- npm run format:check
$D G2-check-fixtures 60 -- npm run check:fixtures
$D G3-diff-check 10 -- git diff --check
$D G4-status 10 -- git status --porcelain=v1 --untracked-files=all
$D G5-head 10 -- sh -c "git rev-parse HEAD; git rev-parse 'HEAD^{tree}'"
echo SEQUENCE_DONE $v

#!/usr/bin/env bash
# Main-feature gate (native HUD v2.2 §7.1).
#
# Builds what main's `npm test` builds (`build`, `build:test`). It does not
# build hud-mcp: no mapped file imports packages/hud-mcp/dist, and main's
# `npm test` does not build it either.
#
# tests/run-main.mjs enforces tests/main-features.json (coverage, scene
# hashes, assert-statement hashes, entry shape), then lists the node --test
# files. After those tests, the TAP log must report every named node:test
# title as passed.
#
# RUN_MAIN_INTEGRATION=1 also runs the integration shell scripts marked
# "opt-in". Exit 77 is a skip. Scripts marked manual are listed with their
# reason and are not executed.
#
# Exits non-zero when the manifest is missing, a check fails, a mapped file
# does not exist, or any executed test fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MANIFEST="${MAIN_FEATURES_MANIFEST:-tests/main-features.json}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "run-main: manifest not found: $MANIFEST" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hud-run-main.XXXXXX")"
TAP_LOG="$WORK/node-test.tap"
FILE_LIST="$WORK/files.txt"
SKIPPED_LIST="$WORK/skipped.txt"

cleanup() {
  local status=$?
  trap - EXIT
  if (( status == 0 )); then
    rm -rf -- "$WORK"
  elif [[ -f "$TAP_LOG" ]]; then
    echo "run-main: full test output kept at $TAP_LOG" >&2
  else
    rm -rf -- "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

echo "run-main: building (build, build:test)"
npm run build
npm run build:test

if ! node tests/run-main.mjs --manifest "$MANIFEST" >"$FILE_LIST" 2>"$SKIPPED_LIST"; then
  echo "run-main: manifest check failed for $MANIFEST" >&2
  cat "$SKIPPED_LIST" >&2
  exit 1
fi

if [[ -s "$SKIPPED_LIST" ]]; then
  cat "$SKIPPED_LIST" >&2
fi

test_files=()
while IFS= read -r file; do
  [[ -n "$file" ]] && test_files+=("$file")
done <"$FILE_LIST"

if (( ${#test_files[@]} == 0 )); then
  echo "run-main: no test files resolved from $MANIFEST" >&2
  exit 1
fi

echo "run-main: running ${#test_files[@]} file(s) under node --test"
set +e
node --test --test-reporter=tap "${test_files[@]}" >"$TAP_LOG" 2>&1
status=$?
set -e

tests_count="$(awk '/^# tests [0-9]+$/ { n = $3 } END { print n }' "$TAP_LOG")"
pass_count="$(awk '/^# pass [0-9]+$/ { n = $3 } END { print n }' "$TAP_LOG")"
fail_count="$(awk '/^# fail [0-9]+$/ { n = $3 } END { print n }' "$TAP_LOG")"

if [[ -n "$tests_count" && -n "$pass_count" && -n "$fail_count" ]]; then
  echo "run-main summary: files=${#test_files[@]} tests=$tests_count pass=$pass_count fail=$fail_count"
fi

if (( status != 0 )); then
  echo "run-main: FAIL (node --test exit $status)" >&2
  grep -E '^not ok ' "$TAP_LOG" | sed -E 's/^not ok [0-9]+ - //' | head -50 >&2 || true
  exit 1
fi

if [[ -z "$tests_count" || -z "$pass_count" || -z "$fail_count" ]]; then
  echo "run-main: FAIL: node --test produced no summary" >&2
  exit 1
fi

if (( fail_count != 0 )); then
  echo "run-main: FAIL: $fail_count test(s) failed" >&2
  exit 1
fi

if ! node tests/run-main.mjs --manifest "$MANIFEST" --check-tap "$TAP_LOG"; then
  echo "run-main: FAIL: a named title was not reported passed" >&2
  exit 1
fi

if [[ "${RUN_MAIN_INTEGRATION:-}" == "1" ]]; then
  echo "run-main: RUN_MAIN_INTEGRATION=1"
  INT_PLAN="$WORK/integration.txt"
  if ! node tests/run-main.mjs --manifest "$MANIFEST" --integration >"$INT_PLAN"; then
    echo "run-main: cannot read the integration plan" >&2
    exit 1
  fi
  int_pass=0
  int_fail=0
  int_skip=0
  int_failed_names=()
  while IFS=$'\t' read -r kind file reason; do
    [[ -n "${kind:-}" ]] || continue
    if [[ "$kind" == "MANUAL" ]]; then
      echo "run-main: manual $file: $reason"
      continue
    fi
    if [[ "$kind" != "RUN" ]]; then
      echo "run-main: bad integration plan line: $kind" >&2
      exit 1
    fi
    echo "run-main: integration $file"
    set +e
    bash "$file"
    int_status=$?
    set -e
    if [[ $int_status -eq 0 ]]; then
      int_pass=$((int_pass + 1))
    elif [[ $int_status -eq 77 ]]; then
      int_skip=$((int_skip + 1))
      echo "run-main: SKIP $file"
    else
      int_fail=$((int_fail + 1))
      int_failed_names+=("$file")
      echo "run-main: FAIL $file (exit $int_status)" >&2
    fi
  done <"$INT_PLAN"
  echo "run-main integration summary: pass=$int_pass fail=$int_fail skip=$int_skip"
  if (( int_fail > 0 )); then
    echo "run-main: FAIL integration: ${int_failed_names[*]}" >&2
    exit 1
  fi
fi

#!/usr/bin/env bash
# Herdr-only suite. These tests need a live Herdr session, so the suite skips
# outside one. Test files are *.test.mjs / *.test.js in this directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  echo "skipping Herdr suite: HERDR_ENV is not 1"
  exit 0
fi

shopt -s nullglob
test_files=(tests/herdr/*.test.mjs tests/herdr/*.test.js)
shopt -u nullglob

if (( ${#test_files[@]} == 0 )); then
  echo "no Herdr tests yet"
  exit 0
fi

echo "Herdr tests: ${test_files[*]}"
node --test "${test_files[@]}"

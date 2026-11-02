#!/usr/bin/env bash
# Core suite: builds the test tree and runs the tests that do not need Herdr.
# A throwaway HUD_HOME keeps the suite away from ~/.hud; HERDR_ENV is unset so
# the Herdr integration never loads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HUD_HOME="$(mktemp -d "${TMPDIR:-/tmp}/hud-core.XXXXXX")"
export HUD_HOME
unset HERDR_ENV

cleanup() {
  local status=$?
  if [[ -n "${HUD_HOME:-}" && -d "$HUD_HOME" ]]; then
    if rm -rf -- "$HUD_HOME"; then
      echo "removed temporary HUD_HOME: $HUD_HOME"
    else
      echo "failed to remove temporary HUD_HOME: $HUD_HOME" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

echo "using temporary HUD_HOME: $HUD_HOME"

node ./node_modules/typescript/bin/tsc -p tsconfig.test.json

test_files=()
while IFS= read -r file; do
  [[ -n "$file" ]] && test_files+=("$file")
done < <(
  {
    printf '%s\n' dist-test/tests/unit/contracts.test.js
    compgen -G 'dist-test/tests/unit/core-*.test.js' || true
    compgen -G 'dist-test/tests/unit/ledger-*.test.js' || true
    compgen -G 'dist-test/tests/unit/codex-facade.test.js' || true
  } | sort -u
)

if (( ${#test_files[@]} == 0 )); then
  echo "no core test files found" >&2
  exit 1
fi

for file in "${test_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "missing core test file: $file" >&2
    exit 1
  fi
done

echo "core tests: ${test_files[*]}"
node --test "${test_files[@]}"

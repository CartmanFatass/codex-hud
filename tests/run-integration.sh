#!/usr/bin/env bash
# Runs the shell-level suites: wrapper behaviour, tmux toggling, installer
# guidance. These touch tmux and the real filesystem, so they are kept out of
# `npm test` and run on demand.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

pass=0
fail=0
skipped=0
failed_names=()

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found: tmux-dependent suites will report their own skips."
fi

for script in tests/integration/*.sh; do
  [[ -f "$script" ]] || continue
  name="$(basename "$script")"
  printf '\n=== %s ===\n' "$name"
  if bash "$script"; then
    pass=$((pass + 1))
  else
    status=$?
    if [[ $status -eq 77 ]]; then
      skipped=$((skipped + 1))
      echo "SKIP $name"
    else
      fail=$((fail + 1))
      failed_names+=("$name")
      echo "FAIL $name (exit $status)"
    fi
  fi
done

printf '\n--- integration summary ---\n'
printf 'passed: %d  failed: %d  skipped: %d\n' "$pass" "$fail" "$skipped"
if ((fail > 0)); then
  printf 'failing: %s\n' "${failed_names[*]}"
  exit 1
fi

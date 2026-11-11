#!/usr/bin/env bash
# Fails when public fixtures or docs contain real home paths, email addresses
# or API-key-like strings. Synthetic data only: the repo is public.
#
# Scanned directories default to the repo's fixture/doc trees and can be
# overridden with CHECK_FIXTURES_DIRS (space-separated, relative to the repo root or absolute).
#
# Exit codes: 0 clean, 1 hits found, 2 scan error (grep could not finish).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

dirs=()
if [[ -n "${CHECK_FIXTURES_DIRS:-}" ]]; then
  # A single existing path (which may contain spaces) wins; otherwise treat
  # the value as a space-separated list.
  if [[ -d "$CHECK_FIXTURES_DIRS" ]]; then
    dirs=("$CHECK_FIXTURES_DIRS")
  else
    read -r -a dirs <<< "$CHECK_FIXTURES_DIRS"
  fi
else
  for dir in tests/fixtures tests/prototypes docs/probes docs/design; do
    [[ -d "$dir" ]] && dirs+=("$dir")
  done
fi

if (( ${#dirs[@]} == 0 )); then
  echo "check-fixtures: no fixture directories found"
  exit 0
fi

errfile="$(mktemp "${TMPDIR:-/tmp}/check-fixtures.XXXXXX")" || {
  echo "check-fixtures: cannot create a temporary file" >&2
  exit 2
}
trap 'rm -f -- "$errfile"' EXIT

found=0
scan_error=0

scan_dir() {
  local dir="$1" label="$2" pattern="$3"
  local matches status lines
  matches="$(grep -rInE -- "$pattern" "$dir" 2>"$errfile")"
  status=$?
  if (( status > 1 )); then
    printf 'check-fixtures: scan error (grep exit %d) in %s while scanning for %s\n' \
      "$status" "$dir" "$label" >&2
    if [[ -s "$errfile" ]]; then
      lines="$(wc -l < "$errfile")"
      head -n 3 "$errfile" | sed 's/^/  /' >&2
      if (( lines > 3 )); then
        printf '  ... (%d more lines)\n' "$((lines - 3))" >&2
      fi
    fi
    scan_error=1
    return
  fi
  if [[ -n "$matches" ]]; then
    found=1
    printf '%s:\n%s\n\n' "$label" "$matches"
  fi
}

scan() {
  local label="$1" pattern="$2" dir
  for dir in "${dirs[@]}"; do
    scan_dir "$dir" "$label" "$pattern"
  done
}

# Match the whole directory component after /home/ or /Users/ (spaces and
# non-ASCII included) and file:///home|Users URLs, but not nested paths such
# as /synthetic/home/dev/x.
scan "absolute home paths" '(^|file:/{2,3}|[^A-Za-z0-9._/-])(/home/[^/]+(/|$)|/Users/[^/]+(/|$))'
scan "email addresses" '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
scan "API-key-like strings" 'sk-[A-Za-z0-9_-]{20,}'

if (( scan_error )); then
  echo "check-fixtures: ERROR (scan incomplete; see diagnostics above)" >&2
  exit 2
fi

if (( found )); then
  echo "check-fixtures: FAILED (see hits above)"
  exit 1
fi

echo "check-fixtures: OK (${dirs[*]})"

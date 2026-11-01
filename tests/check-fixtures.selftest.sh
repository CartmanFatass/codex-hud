#!/usr/bin/env bash
# Self-test for tests/check-fixtures.sh: builds a temporary tree of sample
# files and checks that the scanner flags, accepts or errors on each case.
# The temporary tree is removed on exit; the repo is never modified.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCANNER="$ROOT/tests/check-fixtures.sh"

if [[ ! -f "$SCANNER" ]]; then
  echo "check-fixtures selftest: missing scanner at $SCANNER" >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-fixtures-selftest.XXXXXX")" || {
  echo "check-fixtures selftest: cannot create a temporary directory" >&2
  exit 1
}

cleanup() {
  chmod -R u+rwX "$tmp" 2>/dev/null
  rm -rf -- "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

failures=0
total=0
skipped=0

pass() {
  total=$((total + 1))
  printf 'ok   - %s\n' "$1"
}

fail() {
  total=$((total + 1))
  failures=$((failures + 1))
  printf 'FAIL - %s\n' "$1"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" | sed 's/^/       /'
  fi
}

skip() {
  skipped=$((skipped + 1))
  printf 'skip - %s\n' "$1"
}

# run_case <name> <flagged|ok|error> <file content> <expected substring> [chmod]
run_case() {
  local name="$1" expectation="$2" content="$3" expect="$4" mode="${5:-}"
  local dir="$tmp/$name"
  mkdir -p "$dir" || {
    fail "$name: mkdir failed"
    return
  }
  printf '%s\n' "$content" > "$dir/sample.txt" || {
    fail "$name: write failed"
    return
  }
  [[ -n "$mode" ]] && chmod "$mode" "$dir/sample.txt"

  local out status
  out="$(CHECK_FIXTURES_DIRS="$dir" bash "$SCANNER" 2>&1)"
  status=$?

  local ok=1
  case "$expectation" in
    flagged)
      (( status == 1 )) || ok=0
      [[ "$out" == *"check-fixtures: FAILED"* ]] || ok=0
      [[ "$out" == *"$expect"* ]] || ok=0
      ;;
    ok)
      (( status == 0 )) || ok=0
      [[ "$out" == *"check-fixtures: OK"* ]] || ok=0
      ;;
    error)
      (( status == 2 )) || ok=0
      [[ "$out" != *"check-fixtures: OK"* ]] || ok=0
      [[ "$out" == *"scan error"* ]] || ok=0
      [[ "$out" == *"$expect"* ]] || ok=0
      ;;
    *)
      ok=0
      ;;
  esac

  if (( ok )); then
    pass "$name"
  else
    fail "$name (expected $expectation, exit $status)" "$out"
  fi
}

run_case "users-home-with-space" flagged 'cwd: /Users/Jane Doe/project' '/Users/Jane Doe/'
run_case "home-with-non-ascii" flagged 'cwd: /home/élodie/project' '/home/élodie/'
run_case "file-url-home" flagged 'source: file:///home/someone/x' 'file:///home/someone/x'
run_case "email-address" flagged 'contact: dev@example.com' 'dev@example.com'
run_case "api-key" flagged 'key: sk-aaaaaaaaaaaaaaaaaaaa' 'sk-aaaaaaaaaaaaaaaaaaaa'
run_case "nested-synthetic-home" ok 'cwd: /synthetic/home/dev/x' ''
if (( EUID == 0 )); then
  # Root ignores chmod 000, so grep would read the file and the case cannot fail.
  skip "unreadable-file (running as root; chmod 000 is not enforced)"
else
  run_case "unreadable-file" error 'cwd: /synthetic/home/dev/x' "$tmp/unreadable-file" 000
fi

if (( failures > 0 )); then
  printf 'check-fixtures selftest: FAIL (%d/%d cases)\n' "$((total - failures))" "$total"
  exit 1
fi

if (( skipped > 0 )); then
  printf 'check-fixtures selftest: PASS (%d/%d cases, %d skipped)\n' "$total" "$total" "$skipped"
else
  printf 'check-fixtures selftest: PASS (%d/%d cases)\n' "$total" "$total"
fi

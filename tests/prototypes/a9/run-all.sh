#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
repo=$PWD
export HUD_HOME
HUD_HOME=$(mktemp -d "${TMPDIR:-/tmp}/myhud-a9.XXXXXXXX")
printf 'isolated synthetic A9 prototype\n' > "$HUD_HOME/.a9-isolated"
mkdir -p tmp/tasks/A4b
export A9_EVIDENCE
A9_EVIDENCE=$(mktemp -d "$repo/tmp/tasks/A4b/run-XXXXXXXX")
export A9_REGISTRY="$HUD_HOME/processes.jsonl"
export NODE_NO_WARNINGS=1
cleanup() {
  node tests/prototypes/a9/cleanup.mjs
  rm -rf -- "$HUD_HOME"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
printf 'A9 isolated SQLite / synthetic processes; evidence=%s\n' "${A9_EVIDENCE#"$repo/"}"
result=0
for group in identity execution recovery; do
  if ! node "tests/prototypes/a9/$group.mjs" 2>&1 | tee "$A9_EVIDENCE/$group.log"; then
    result=1
  fi
done
node tests/prototypes/a9/count-ids.mjs "$A9_EVIDENCE" || result=1
exit "$result"

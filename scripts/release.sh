#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  printf 'Release requires a clean worktree; commit changes first.\n' >&2
  exit 1
fi
version="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][a-zA-Z0-9.-]+)?$ ]] || { printf 'Invalid release version\n' >&2; exit 1; }
archive="hud-$version.tar.gz"
git archive --format=tar.gz --prefix="hud-$version/" --output="$archive" HEAD
printf '%s\n' "$archive"

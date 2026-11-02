#!/usr/bin/env bash
# No live-instance mutations: fake transport + a newly spawned private server only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
npm run build
npm run build:test
node --test dist-test/tests/unit/b7-*.test.js
if command -v herdr >/dev/null 2>&1 && [[ "$(uname -s)" == Linux ]]; then
  node --test tests/herdr/*.test.mjs
else
  echo 'private Herdr process tests skipped: Linux and Herdr 0.9.5 required'
fi

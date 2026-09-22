#!/usr/bin/env bash
set -euo pipefail
command -v tmux >/dev/null && command -v python3 >/dev/null || exit 77
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
python3 "$repo/tests/integration/test-input-events-real-tmux.py"

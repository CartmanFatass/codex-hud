#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/test-narrow-panel-real-tmux.py"
